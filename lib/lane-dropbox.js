#!/usr/bin/env node
'use strict';

/**
 * lane-dropbox.js — dispatch-time manifest + hook-time drop-box writer for a
 * dispatched lane (a Claude in-process teammate, or a third-party
 * `codex exec`/`gemini` subprocess).
 *
 * Part of the lane drop-box mechanism in this repo — see ../README.md for
 * the full picture (the `lane-record/v1` schema, dedupe/throttle mechanics,
 * and how the two hooks in `../hooks/` call into this module).
 *
 * WHY: a dispatched lane's only durable liveness/report evidence today is
 * whichever dispatcher happens to be watching live. This module writes an
 * append-only, per-lane JSONL record (`~/.claude/teams/<session_id>/dropbox/
 * <lane_id>.jsonl`) so a crashed or stalled lane is detectable even when no
 * one is watching.
 *
 * THREE EXPORTED FUNCTIONS, one per record type — all synchronous,
 * non-throwing, side-effecting, never async (both hooks that call these run
 * on a hot path with a hard time budget).
 *
 *   scaffold({ sessionId, laneId, provider, taskId, worktree, branch, pid,
 *              outputLog, agentName })
 *     -> { written, claimAttempted, reason? }
 *   checkpoint({ transcriptPath, sessionId, laneId, resolutionMethod })
 *     -> { written, sidecarUpdated, reason? }
 *   touch({ sessionId, laneId, resolutionMethod })
 *     -> { written, sidecarUpdated, reason? }
 *
 * `written`/`sidecarUpdated` CONTRACT: these are two INDEPENDENT truths, never conflated.
 * `written` reflects only whether the `.jsonl` record itself was appended
 * (the durable, O_APPEND-atomic fact). `sidecarUpdated` reflects only
 * whether the offset/throttle sidecar (`.state/<laneId>.{checkpoint,
 * heartbeat}.json`) was itself successfully persisted THIS call. A prior
 * design reported a single `written` boolean that silently went true even
 * when the sidecar write failed — misleadingly implying full success while
 * a failed checkpoint sidecar could cause a duplicate offset re-consume, or
 * a failed heartbeat sidecar could defeat the ≥60s throttle. Two structural
 * fixes, not just more honest reporting: (1) the two facts are now separate
 * fields, so neither is ever misrepresented as the other; (2) both
 * `runCheckpointLocked`/`runHeartbeatLocked` additionally derive a FALLBACK
 * ground truth from the lane's own already-durable dropbox records (see
 * `laneFileFacts`) and take the max against the sidecar's own value — so a
 * prior call's silently-failed sidecar write can only ever cause the NEXT
 * call to under-report progress (safe — at worst a slightly later than
 * necessary resume/throttle-clear), never over-report it (the duplicate/
 * throttle-defeat failure mode), not merely reporting the failure more
 * accurately.
 *
 * `resolutionMethod` on `checkpoint`/`touch` is a REQUIRED param, supplied by
 * the calling hook — identity resolution (`resolveTeammateContext`) happens
 * exclusively in the two hook files (`../hooks/lane-dropbox-checkpoint.js`,
 * `../hooks/lane-dropbox-heartbeat.js`); this module never calls it and
 * never requires `report-gate-identity.js`. Restricted to
 * the three specified enum values (`direct-sibling` | `payload-identity-field`
 * | `recency-heuristic`) — an unrecognized value is a caller contract
 * violation, mapped to the closed `reason` enum like any other, never a
 * silent pass-through of an arbitrary string.
 *
 * Also runs as an invocable CLI (`node lane-dropbox.js scaffold|checkpoint|
 * touch ...`) for callers with no `require()` path of their own — e.g. a
 * third-party CLI lane (a `codex exec`/`gemini` subprocess) that has no
 * Node `require()` boundary to call `scaffold()` through directly.
 *
 * Portability: every filesystem location here is derived, never
 * hand-hardcoded — the dropbox/state root resolves via `HOME`/`os.homedir()`,
 * and every intra-repo `require()` is relative to this module's own
 * location. Zero Claude-specific dependency, zero external npm package.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { withLock } = require('./filelock.js');
const { readTranscriptFromOffset, lastAssistantText } = require('./subagent-transcript.js');

const SCHEMA_VERSION = 'lane-record/v1';
const VALID_PROVIDERS = new Set(['claude', 'codex', 'gemini']);
const VALID_RESOLUTION_METHODS = new Set(['direct-sibling', 'payload-identity-field', 'recency-heuristic']);
const HEARTBEAT_THROTTLE_MS = 60_000;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function describeError(err) {
  return (err && err.message) || String(err);
}

// Best-effort, single-line, human-readable stderr diagnostic on any write
// failure — purely for
// debuggability; never affects the fail-open return contract of any caller,
// and a failure to write this line itself must never throw back out.
function warnStderr(message) {
  try {
    process.stderr.write(`lane-dropbox: ${message}\n`);
  } catch {
    /* best-effort only */
  }
}

// Lazily resolved (never cached at module scope) so a test-seam override of
// HOME/os.homedir() set after this module is first required still takes
// effect — see test/lane-dropbox.test.js's own `withHome()` helper for the
// save/restore pattern this enables.
function homeDir() {
  return process.env.HOME || os.homedir() || '';
}

function teamDirFor(sessionId) {
  return path.join(homeDir(), '.claude', 'teams', sessionId);
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Write-temp-then-rename — same atomicity pattern `filelock.js`'s own
// token-publish uses internally. Returns whether the sidecar was actually
// persisted — callers MUST treat a `false` return as "the sidecar did not
// durably update" and combine it with the lane-file-derived fallback in
// `laneFileFacts` rather than trusting it blindly. Never throws.
function writeStateAtomic(p, obj) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup only */ }
    warnStderr(`sidecar write failed for ${p}: ${describeError(err)}`);
    return false;
  }
}

function readLaneRecords(laneFile) {
  let raw;
  try {
    raw = fs.readFileSync(laneFile, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return records;
}

function scaffoldRecords(laneFile) {
  return readLaneRecords(laneFile).filter((r) => r && r.record_type === 'scaffold');
}

// provider is first-scaffold-authoritative — never latest-wins, unlike
// task_id/worktree/branch below. Defaults to 'claude' when no scaffold record
// exists yet for this lane (checkpoint/heartbeat are only ever written by the
// Claude-side hooks). Exported standalone (also used internally by
// `laneFileFacts` conceptually, though that function re-derives in one pass
// for efficiency rather than calling this a second time).
function resolveProvider(laneFile) {
  const records = scaffoldRecords(laneFile);
  if (records.length && typeof records[0].provider === 'string') return records[0].provider;
  return 'claude';
}

// task_id/worktree/branch are latest-scaffold-wins (a re-dispatch under
// the same lane_id may represent a genuinely new assignment). Absent any
// scaffold record at all, all three are null — expected, fails open, not an
// error (expected, not a bug).
function latestScaffoldMeta(laneFile) {
  const records = scaffoldRecords(laneFile);
  if (!records.length) return { task_id: null, worktree: null, branch: null };
  const latest = records[records.length - 1];
  return {
    task_id: latest.task_id ?? null,
    worktree: latest.worktree ?? null,
    branch: latest.branch ?? null,
  };
}

// Single-pass read of a lane's own dropbox file, deriving everything
// `checkpoint()`/`touch()` need in one `fs.readFileSync` + one loop rather
// than three separate scans (`resolveProvider`/`latestScaffoldMeta` stay
// exported standalone for external/test use and are unchanged — this is an
// additional, internal-only aggregate reader).
//
// `lastCheckpointOffsetEnd`/`lastHeartbeatAt` exist specifically as the
// FALLBACK ground truth for sidecar-write-failure recovery (see the file
// header's "written/sidecarUpdated CONTRACT" note): both are derived from
// records that are already durably on disk (a successful `fs.appendFileSync`
// already happened before either sidecar write is even attempted), so they
// remain trustworthy even when a THIS-call-or-a-prior-call's own sidecar
// write silently failed.
function laneFileFacts(laneFile) {
  const records = readLaneRecords(laneFile);
  let firstScaffoldProvider = null;
  let latestScaffold = null;
  let lastCheckpointOffsetEnd = null;
  let lastHeartbeatAt = null;

  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (r.record_type === 'scaffold') {
      if (firstScaffoldProvider === null && typeof r.provider === 'string') firstScaffoldProvider = r.provider;
      latestScaffold = r; // append-only order — the last one seen is the latest
    } else if (r.record_type === 'checkpoint' || r.record_type === 'heartbeat') {
      if (r.record_type === 'checkpoint' && Number.isInteger(r.transcript_offset_end)) {
        lastCheckpointOffsetEnd = r.transcript_offset_end;
      }
      if (typeof r.heartbeat_at === 'string') {
        const t = Date.parse(r.heartbeat_at);
        if (!Number.isNaN(t) && (lastHeartbeatAt === null || t > lastHeartbeatAt)) lastHeartbeatAt = t;
      }
    }
  }

  return {
    provider: firstScaffoldProvider || 'claude',
    scaffoldMeta: latestScaffold
      ? { task_id: latestScaffold.task_id ?? null, worktree: latestScaffold.worktree ?? null, branch: latestScaffold.branch ?? null }
      : { task_id: null, worktree: null, branch: null },
    lastCheckpointOffsetEnd,
    lastHeartbeatAt,
  };
}

// ── claim coupling at the scaffold call site (optional extension point) ────
//
// This is a pluggable integration point, not a required part of the
// mechanism: if you drop a module at `lib/claim-emitter.js` (relative to
// this file) exporting a `claim({ agent, task_id, worktree, timestamp,
// held })` function, scaffold() will call it once per scaffold. No such
// module ships in this repo — with nothing present at that path,
// `fs.existsSync` short-circuits false and this is a no-op (one cheap stat
// call). This exists for consumers who track lane/task ownership in their
// own system and want scaffold() to notify it, without having to fork this
// file to add the call site. Discovery path is constructed via
// `path.join(__dirname, ...)`, never a hardcoded absolute string.
// Overridable ONLY via the LANE_DROPBOX_CLAIM_EMITTER_PATH test-seam env var
// (never for real invocations) so tests can exercise the probe against a
// stub without needing a real file at the default location.
function claimEmitterPath() {
  return process.env.LANE_DROPBOX_CLAIM_EMITTER_PATH
    || path.join(__dirname, 'claim-emitter.js');
}

// Returns `claimAttempted` (boolean) — true iff discovery found the emitter
// AND invocation was actually reached (even if claim() itself then threw;
// "attempted" means "we called it," not "it succeeded"). Discovery is a
// single fs.existsSync stat — with no emitter module present (the default,
// out of the box), this always short-circuits false, so the only cost this
// pays by default is that one stat call. Catch-all: ANY exception anywhere
// in this sequence is swallowed silently and never affects scaffold()'s own
// record write or return value.
function attemptClaimProbe({ laneId, taskId, worktree, dispatchedAt }) {
  let attempted = false;
  try {
    const emitterPath = claimEmitterPath();
    if (!fs.existsSync(emitterPath)) return false;
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(emitterPath);
    if (!mod || typeof mod.claim !== 'function') return false;
    attempted = true;
    mod.claim({ agent: laneId, task_id: taskId, worktree, timestamp: dispatchedAt, held: true });
    return true;
  } catch {
    return attempted;
  }
}

/**
 * scaffold({ sessionId, laneId, provider, taskId, worktree, branch, pid,
 *            outputLog, agentName }) -> { written, claimAttempted, reason? }
 *
 * Appends one `scaffold` record to `<lane_id>.jsonl`. Idempotent-safe,
 * not idempotent-deduped: a repeat call for the same lane_id appends a second
 * scaffold record rather than erroring or overwriting (an accepted
 * residual). Also emits the lane's scope claim as part of this same
 * invocation — a second, independent side effect of the record write,
 * never a separate call the caller must remember to make.
 *
 * Also creates `.state/` alongside `dropbox/` — a lane whose first-ever
 * contact is a `scaffold` call should
 * not depend on a LATER `checkpoint`/`touch` call to lazily create the
 * sidecar directory; both roots are established at dispatch time.
 *
 * Schema invariants are enforced by
 * DETERMINISTIC COERCION, not validate-and-reject: `pid`/`output_log` are
 * forced `null` for `provider: 'claude'` (meaningful only for third-party
 * lanes); `agent_name` is forced `null` for `provider: 'codex'|'gemini'`
 * (meaningful only for Claude lanes) — a caller that harmlessly passes an
 * irrelevant field never gets a confusing rejection; the WRITTEN record's
 * own invariant holds regardless of what was passed in.
 *
 * written: true iff the scaffold record itself was appended.
 * claimAttempted: forced false when written is false (the probe is never
 * attempted when there's no record for a claim signal to degrade alongside);
 * otherwise independently determined by the probe.
 * Never throws.
 */
function scaffold({
  sessionId, laneId, provider, taskId = null, worktree = null, branch = null,
  pid = null, outputLog = null, agentName = null,
} = {}) {
  try {
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(laneId) || !VALID_PROVIDERS.has(provider)) {
      return { written: false, claimAttempted: false, reason: 'invalid-args' };
    }

    const teamDir = teamDirFor(sessionId);
    const dropboxDir = path.join(teamDir, 'dropbox');
    const stateDir = path.join(teamDir, '.state');
    try {
      fs.mkdirSync(dropboxDir, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
    } catch (err) {
      warnStderr(`scaffold: unable to create dropbox/state dirs for lane "${laneId}": ${describeError(err)}`);
      return { written: false, claimAttempted: false, reason: 'unwritable-dir' };
    }

    const ts = new Date().toISOString();
    const isClaude = provider === 'claude';
    const record = {
      schema_version: SCHEMA_VERSION,
      record_type: 'scaffold',
      lane_id: laneId,
      session_id: sessionId,
      ts,
      provider,
      task_id: taskId ?? null,
      worktree: worktree ?? null,
      branch: branch ?? null,
      dispatched_at: ts,
      agent_name: isClaude ? (agentName ?? null) : null,
      pid: isClaude ? null : (Number.isInteger(pid) ? pid : null),
      output_log: isClaude ? null : (outputLog ?? null),
    };

    const laneFile = path.join(dropboxDir, `${laneId}.jsonl`);
    try {
      fs.appendFileSync(laneFile, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (err) {
      warnStderr(`scaffold: record append failed for lane "${laneId}": ${describeError(err)}`);
      return { written: false, claimAttempted: false, reason: 'unwritable-file' };
    }

    const claimAttempted = attemptClaimProbe({
      laneId, taskId: record.task_id, worktree: record.worktree, dispatchedAt: record.dispatched_at,
    });
    return { written: true, claimAttempted };
  } catch (err) {
    warnStderr(`scaffold: unexpected error for lane "${laneId}": ${describeError(err)}`);
    return { written: false, claimAttempted: false, reason: 'unresolvable' };
  }
}

// ── checkpoint() — the hook itself resolves identity; this module takes it
// from there ─────────────────────────────────────────────────────────────

function runCheckpointLocked({ transcriptPath, sessionId, laneId, resolutionMethod, stateDir, dropboxDir }) {
  const offsetStatePath = path.join(stateDir, `${laneId}.checkpoint.json`);
  const laneFile = path.join(dropboxDir, `${laneId}.jsonl`);
  const facts = laneFileFacts(laneFile);

  const prior = readJsonSafe(offsetStatePath);
  const sidecarOffset = (prior && Number.isInteger(prior.transcriptOffset) && prior.transcriptOffset >= 0)
    ? prior.transcriptOffset
    : 0;
  // Sidecar-write-failure fallback (see file header): a prior call's already
  // durably-appended checkpoint record is itself authoritative evidence of
  // how far this lane has been consumed, independent of whether that call's
  // OWN sidecar write actually landed. Taking the max means a stale/failed
  // sidecar can only ever under-report progress (safe), never cause a
  // duplicate re-consume of already-recorded content — the guarantee this
  // closes.
  const transcriptOffset = facts.lastCheckpointOffsetEnd !== null
    ? Math.max(sidecarOffset, facts.lastCheckpointOffsetEnd)
    : sidecarOffset;

  let entries;
  let nextOffset;
  try {
    ({ entries, nextOffset } = readTranscriptFromOffset(transcriptPath, transcriptOffset));
  } catch {
    return { written: false, sidecarUpdated: false, reason: 'unresolvable' };
  }
  if (!entries || !entries.length) {
    return { written: false, sidecarUpdated: false, reason: 'no-new-content' };
  }

  let reportText = null;
  try {
    reportText = lastAssistantText(entries);
  } catch {
    reportText = null;
  }

  const { task_id: taskId, worktree, branch } = facts.scaffoldMeta;

  let lastVerifiedSha = null;
  if (worktree) {
    try {
      lastVerifiedSha = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch {
      lastVerifiedSha = null;
    }
  }

  const ts = new Date().toISOString();
  const dedupeKey = crypto.createHash('sha256')
    .update(`${transcriptPath}:${transcriptOffset}-${nextOffset}`)
    .digest('hex');

  const record = {
    schema_version: SCHEMA_VERSION,
    record_type: 'checkpoint',
    lane_id: laneId,
    session_id: sessionId,
    ts,
    provider: facts.provider,
    task_id: taskId,
    worktree,
    branch,
    report_text: reportText,
    transcript_offset_start: transcriptOffset,
    transcript_offset_end: nextOffset,
    dedupe_key: dedupeKey,
    resolution_method: resolutionMethod,
    last_verified_sha: lastVerifiedSha,
    heartbeat_at: ts,
  };

  try {
    fs.appendFileSync(laneFile, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    warnStderr(`checkpoint: record append failed for lane "${laneId}": ${describeError(err)}`);
    return { written: false, sidecarUpdated: false, reason: 'unresolvable' };
  }

  const sidecarUpdated = writeStateAtomic(offsetStatePath, { transcriptOffset: nextOffset });
  return sidecarUpdated
    ? { written: true, sidecarUpdated: true }
    : { written: true, sidecarUpdated: false, reason: 'sidecar-write-failed' };
}

/**
 * checkpoint({ transcriptPath, sessionId, laneId, resolutionMethod })
 *   -> { written, sidecarUpdated, reason? }
 *
 * `resolutionMethod` is a required param the calling hook already obtained
 * from `resolveTeammateContext` — never computed or re-derived here, and
 * restricted to the three specified enum values.
 * Dedupes by transcript byte offset: a repeat firing with no new
 * content since the last checkpoint returns `written: false, sidecarUpdated:
 * false, reason: 'no-new-content'`, never a duplicate record. `written` and
 * `sidecarUpdated` are independent facts (see the file header) —
 * `sidecarUpdated: false` alongside `written: true` means the record landed
 * but the offset sidecar itself failed to persist THIS call; the next call
 * still cannot duplicate-consume, because `runCheckpointLocked` derives its
 * resume offset from the max of the sidecar AND the lane's own last
 * checkpoint record. Sidecar read-modify-write is serialized via
 * `filelock.js`'s `withLock` at its DEFAULT retry budget —
 * correctness (no duplicate checkpoint) matters more here than latency.
 * `reason` values: `"no-new-content"` | `"lock-unavailable"` |
 * `"sidecar-write-failed"` | `"unresolvable"`. Never throws.
 */
function checkpoint({ transcriptPath, sessionId, laneId, resolutionMethod } = {}) {
  try {
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(laneId) || !VALID_RESOLUTION_METHODS.has(resolutionMethod)
      || !isNonEmptyString(transcriptPath)) {
      // Caller contract violation: the calling hook always has a
      // valid resolutionMethod by the time it calls checkpoint() —
      // resolveTeammateContext already returned non-null. Asserted
      // defensively, mapped to the closed 'unresolvable' reason rather than
      // a new enum value, since checkpoint() never throws.
      return { written: false, sidecarUpdated: false, reason: 'unresolvable' };
    }

    const teamDir = teamDirFor(sessionId);
    const stateDir = path.join(teamDir, '.state');
    const dropboxDir = path.join(teamDir, 'dropbox');
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(dropboxDir, { recursive: true });
    } catch (err) {
      warnStderr(`checkpoint: unable to create state/dropbox dirs for lane "${laneId}": ${describeError(err)}`);
      return { written: false, sidecarUpdated: false, reason: 'unresolvable' };
    }

    const lockPath = path.join(stateDir, `${laneId}.checkpoint.lock`);
    const result = withLock(lockPath, () => runCheckpointLocked({
      transcriptPath, sessionId, laneId, resolutionMethod, stateDir, dropboxDir,
    }));
    if (!result.locked) return { written: false, sidecarUpdated: false, reason: 'lock-unavailable' };
    return result.value;
  } catch (err) {
    warnStderr(`checkpoint: unexpected error for lane "${laneId}": ${describeError(err)}`);
    return { written: false, sidecarUpdated: false, reason: 'unresolvable' };
  }
}

// ── touch() — the hook itself resolves identity; this module takes it from
// there ─────────────────────────────────────────────────────────────────

function runHeartbeatLocked({ sessionId, laneId, resolutionMethod, stateDir, dropboxDir }) {
  const throttleStatePath = path.join(stateDir, `${laneId}.heartbeat.json`);
  const laneFile = path.join(dropboxDir, `${laneId}.jsonl`);
  const facts = laneFileFacts(laneFile);

  const prior = readJsonSafe(throttleStatePath);
  const sidecarLastHeartbeatAt = (prior && Number.isInteger(prior.lastHeartbeatAt)) ? prior.lastHeartbeatAt : null;
  // Same sidecar-write-failure fallback rationale as checkpoint's offset
  // above (file header): a prior call's already durably-appended
  // checkpoint/heartbeat record is itself authoritative evidence of when
  // this lane was last heard from, independent of whether that call's OWN
  // throttle-sidecar write actually landed. Taking the max means a stale/
  // failed sidecar can only ever make the NEXT call see a MORE recent
  // last-heartbeat time (safe — the throttle stays intact or gets stricter),
  // never a less recent one (the throttle-defeat failure mode this closes).
  const candidates = [sidecarLastHeartbeatAt, facts.lastHeartbeatAt].filter((v) => v !== null);
  const effectiveLastHeartbeatAt = candidates.length ? Math.max(...candidates) : null;

  const now = Date.now();
  if (effectiveLastHeartbeatAt !== null && (now - effectiveLastHeartbeatAt) < HEARTBEAT_THROTTLE_MS) {
    return { written: false, sidecarUpdated: false, reason: 'throttled' };
  }

  const ts = new Date(now).toISOString();
  const record = {
    schema_version: SCHEMA_VERSION,
    record_type: 'heartbeat',
    lane_id: laneId,
    session_id: sessionId,
    ts,
    provider: facts.provider,
    heartbeat_at: ts,
    liveness_source: 'posttooluse-touch',
    resolution_method: resolutionMethod,
  };

  try {
    fs.appendFileSync(laneFile, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    warnStderr(`touch: record append failed for lane "${laneId}": ${describeError(err)}`);
    return { written: false, sidecarUpdated: false, reason: 'unresolvable' };
  }

  const sidecarUpdated = writeStateAtomic(throttleStatePath, { lastHeartbeatAt: now });
  return sidecarUpdated
    ? { written: true, sidecarUpdated: true }
    : { written: true, sidecarUpdated: false, reason: 'sidecar-write-failed' };
}

/**
 * touch({ sessionId, laneId, resolutionMethod }) -> { written, sidecarUpdated, reason? }
 *
 * Throttled ≥60s write-only heartbeat. The throttle check and the append run
 * inside the SAME `withLock(..., { retries: 0 })` call — by
 * construction, not a probabilistically-argued last-write-wins, two
 * concurrent callers can never both observe "due" and both write. On
 * contention, fails immediately (no spin-retry, no sleepSync) — the whole
 * point is staying inside the ~15ms-class budget. NEVER reads a transcript or
 * shells out to git — this function's only I/O
 * is the lock acquire/release pair, one small JSON sidecar read+write, and
 * (new) one small read of the lane's own dropbox file for the sidecar-
 * failure fallback (`laneFileFacts`) — never the potentially-large
 * transcript. `written`/`sidecarUpdated` are independent facts; see the file
 * header and `checkpoint()`'s own doc comment for the full rationale.
 * `reason` values: `"throttled"` | `"contended"` | `"sidecar-write-failed"`
 * | `"unresolvable"`. Never throws.
 */
function touch({ sessionId, laneId, resolutionMethod } = {}) {
  try {
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(laneId) || !VALID_RESOLUTION_METHODS.has(resolutionMethod)) {
      // Same caller-contract-violation posture as checkpoint() above — mapped
      // to the closed 'unresolvable' reason; touch() never throws.
      return { written: false, sidecarUpdated: false, reason: 'unresolvable' };
    }

    const teamDir = teamDirFor(sessionId);
    const stateDir = path.join(teamDir, '.state');
    const dropboxDir = path.join(teamDir, 'dropbox');
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(dropboxDir, { recursive: true });
    } catch (err) {
      warnStderr(`touch: unable to create state/dropbox dirs for lane "${laneId}": ${describeError(err)}`);
      return { written: false, sidecarUpdated: false, reason: 'unresolvable' };
    }

    const lockPath = path.join(stateDir, `${laneId}.heartbeat.lock`);
    const result = withLock(lockPath, () => runHeartbeatLocked({
      sessionId, laneId, resolutionMethod, stateDir, dropboxDir,
    }), { retries: 0 });
    if (!result.locked) return { written: false, sidecarUpdated: false, reason: 'contended' };
    return result.value;
  } catch (err) {
    warnStderr(`touch: unexpected error for lane "${laneId}": ${describeError(err)}`);
    return { written: false, sidecarUpdated: false, reason: 'unresolvable' };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const sub = args[0] || null;
  const opts = {};
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      opts[a.slice(2)] = args[i + 1];
      i += 1;
    }
  }
  return { sub, opts };
}

function toIntOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function printAndExit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0); // fails open — a scaffold/checkpoint/touch write failure must never fail the dispatch itself
}

function main() {
  const { sub, opts } = parseCliArgs(process.argv);

  if (sub === 'scaffold') {
    printAndExit(scaffold({
      sessionId: opts.session,
      laneId: opts['lane-id'],
      provider: opts.provider,
      taskId: opts['task-id'] ?? null,
      worktree: opts.worktree ?? null,
      branch: opts.branch ?? null,
      pid: toIntOrNull(opts.pid),
      outputLog: opts['output-log'] ?? null,
      agentName: opts['agent-name'] ?? null,
    }));
    return;
  }

  if (sub === 'checkpoint') {
    if (!opts['resolution-method']) {
      process.stderr.write('checkpoint: --resolution-method is required (direct-sibling|payload-identity-field|recency-heuristic)\n');
      process.exit(1);
    }
    printAndExit(checkpoint({
      transcriptPath: opts['transcript-path'],
      sessionId: opts.session,
      laneId: opts['lane-id'],
      resolutionMethod: opts['resolution-method'],
    }));
    return;
  }

  if (sub === 'touch') {
    if (!opts['resolution-method']) {
      process.stderr.write('touch: --resolution-method is required (direct-sibling|payload-identity-field|recency-heuristic)\n');
      process.exit(1);
    }
    printAndExit(touch({
      sessionId: opts.session,
      laneId: opts['lane-id'],
      resolutionMethod: opts['resolution-method'],
    }));
    return;
  }

  process.stderr.write(
    'Usage: lane-dropbox.js scaffold|checkpoint|touch ...\n'
    + '  scaffold --session <id> --lane-id <id> --provider claude|codex|gemini [--task-id <id>] [--worktree <path>] [--branch <branch>] [--pid <n>] [--output-log <path>] [--agent-name <name>]\n'
    + '  checkpoint --session <id> --lane-id <id> --transcript-path <path> --resolution-method <method>\n'
    + '  touch --session <id> --lane-id <id> --resolution-method <method>\n',
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  scaffold,
  checkpoint,
  touch,
  // internals exported for test coverage only
  parseCliArgs,
  teamDirFor,
  readLaneRecords,
  scaffoldRecords,
  resolveProvider,
  latestScaffoldMeta,
  laneFileFacts,
  claimEmitterPath,
  attemptClaimProbe,
  writeStateAtomic,
  SCHEMA_VERSION,
  VALID_PROVIDERS,
  VALID_RESOLUTION_METHODS,
  HEARTBEAT_THROTTLE_MS,
};
