'use strict';

/**
 * orphan-pointers.js — a fallback safety net for a subagent whose result
 * never reached the conversation that dispatched it.
 *
 * NORMAL DELIVERY IS UNTOUCHED BY THIS MODULE. When the parent session is
 * alive, Claude Code injects a dispatched subagent's result automatically —
 * a `task-notification` for a background `Agent` dispatch, a `tool_result`
 * for a foreground/synchronous one, or a `<teammate-message>` /
 * `<agent-message>` for a team-mailbox `SendMessage`. This module NEVER
 * intercepts, replaces, or blocks any of that — it only writes a small
 * pointer record for every subagent that finishes. That record stores a
 * pointer plus a short excerpt (at most 200 characters) of the subagent's
 * final message, never the full report; the full report stays in the
 * transcript the harness already keeps. It then checks — deterministically,
 * from transcript evidence, never a guess — whether normal delivery already happened before ever
 * surfacing that pointer to a human.
 *
 * This whole mechanism is Claude-Code-specific by nature: it depends on the
 * exact on-disk transcript layout and JSONL entry shapes this harness
 * writes (see below), not on any behavior a plugin could assume portably
 * across other agent surfaces.
 *
 * WHAT GETS WRITTEN
 * ------------------
 * One small JSON file per finished subagent, at
 * `<data dir>/pointers/<sessionId>/<agentId>.json`:
 *   {
 *     transcriptPath, agentId, agentName, toolUseId, parentSessionId,
 *     finishedAt,
 *     summary,        // <=200 chars, surrogate-safe truncation
 *     claimed: false,
 *     surfaced: { userPromptSubmit: false, sessionStart: false }
 *   }
 * `agentId` is the harness's own agent id (leading `a`, "agent-" prefix
 * stripped — e.g. `a3a2ad2af148bcfcb`, derived from the transcript
 * filename), used both as this pointer's storage key and, unmodified, as
 * the exact string a background dispatch's `<task-id>` tag carries.
 *
 * DELIVERY EVIDENCE (real shapes, verified against real, sanitized local
 * transcripts before being reduced to the fixtures in test/fixtures/ —
 * see that directory's README for which shapes were directly observed vs.
 * inferred from documented/generic harness behavior)
 * -------------------------------------------------------------------------
 * The check is ENTRY-AWARE, not a raw-text scan: the tail is parsed as one
 * JS object per JSONL line (`parseTailEntries`), and any `queue-operation`
 * entry (`operation: "enqueue" | "dequeue" | "remove"`) is skipped outright
 * before any marker check runs, for every evidence type below — an
 * `enqueue` alone means QUEUED, not delivered (if the parent session died
 * between the enqueue and the harness dequeuing it, the notification never
 * reaches the conversation, and this pointer must still be surfaced).
 *
 * A finished subagent's result was already delivered to its parent when a
 * NON-`queue-operation` entry, at or after the subagent's own finish time,
 * matches one of:
 *   - foreground/synchronous dispatch (the pointer carries `toolUseId`): a
 *     `type: "user"` entry whose message content includes a `tool_result`
 *     block with that exact `tool_use_id` — EXCLUDING a background `Agent`
 *     spawn's immediate launch acknowledgment, whose text starts with
 *     "Async agent launched successfully." and which carries the SAME
 *     `tool_use_id` as the spawn call itself (not the eventual real
 *     result). Matching on `tool_use_id` alone, with no ack exclusion, was
 *     this module's original bug: it marked every background lane
 *     "delivered" the instant it launched — exactly the orphan case this
 *     module exists to catch.
 *   - background `Agent` dispatch completion (the pointer carries
 *     `agentId`): a non-`queue-operation` entry whose (re-serialized) text
 *     contains the literal substring `<task-id><agentId></task-id>` — e.g.
 *     a `type: "attachment"` entry with `attachment.type ===
 *     "queued_command"`, or a plain `type: "user"` entry whose message
 *     content is the task-notification text itself. Both shapes are real,
 *     directly observed.
 *   - team-mailbox dispatch (the pointer carries `agentName`): a
 *     non-`queue-operation` entry containing `<agent-message from="<name>"`
 *     or `<teammate-message teammate_id="<name>"`.
 * The scan is bounded — it tail-reads only the last `TAIL_SCAN_BYTES` (2 MB
 * default) of the parent transcript, never the whole file — so this stays
 * cheap even against a very large long-running session. A bounded read can
 * start mid-line; that partial first line is dropped, never fed to
 * `JSON.parse` (see `tailRead`'s `truncated` flag).
 *
 * "PARENT GONE"
 * -------------
 * A pointer's parent is considered gone (eligible for cross-session
 * surfacing at the next SessionStart) when the parent transcript's mtime is
 * older than `finishedAt + PARENT_GONE_GRACE_MS` (default 10 minutes) with
 * no delivery marker found, OR the current session differs from the
 * pointer's own `parentSessionId` (a prior/dead session's leftover pointer).
 *
 * FAIL-OPEN
 * ---------
 * Every function here is safe to call from a hook that must never block or
 * throw: a missing/unreadable file, a malformed JSON line, or any other
 * error is swallowed and treated as "no evidence either way" — callers
 * default to NOT surfacing rather than guessing.
 */

const fs = require('fs');
const path = require('path');
const { ensureSubPath, subPath } = require('./paths.js');
const { isSafePathSegment, isPathContainedIn } = require('./path-safety.js');

const TAIL_SCAN_BYTES = Number(process.env.SUBAGENT_REPORT_GUARD_TAIL_SCAN_BYTES) || 2 * 1024 * 1024;
const PARENT_GONE_GRACE_MS = Number(process.env.SUBAGENT_REPORT_GUARD_PARENT_GONE_GRACE_MS) || 10 * 60 * 1000;
// Small tolerance so a delivery entry timestamped a hair before the
// pointer's own `finishedAt` (clock skew between the two writes, not a
// genuinely older entry) is not wrongly excluded. Deliberately small — see
// `isTimestampAcceptable` below for why this is never widened to cover a
// truly pre-finish entry.
const DELIVERY_TIMESTAMP_SKEW_MS = Number(process.env.SUBAGENT_REPORT_GUARD_DELIVERY_SKEW_MS) || 2000;
const MAX_SUMMARY_CHARS = 200;
const MAX_ITEMS_PER_INJECTION = 5;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function safeWriteJson(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

// Surrogate-safe truncation to at most `max` UTF-16 code UNITS, without
// splitting an astral character's surrogate pair in half. Iterating by
// Unicode code point (`Array.from`) and rejoining keeps every emitted
// character whole even though the final string's .length may then be
// slightly under `max`.
function truncateSummary(text, max = MAX_SUMMARY_CHARS) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const codePoints = Array.from(trimmed);
  let out = '';
  for (const ch of codePoints) {
    if ((out + ch).length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

// `sessionId`/`agentId` are hook-payload-derived, therefore
// attacker-influenceable — a `session_id` of `../../etc` (or similar) must
// never be allowed to walk a pointer write or read outside this plugin's
// own `pointers/` dir. Validated with the exact same safe-path-segment rule
// the lane drop-box uses (`isSafePathSegment`, now shared via
// `./path-safety.js`), PLUS an explicit containment check that the
// resolved path actually lands under `pointersRootDir()` — defense in
// depth, so a future change that stops validating a segment still fails
// closed rather than silently escaping the data dir. Returns `null` on any
// invalid input; every caller below treats `null` as "fail open, no-op",
// never a thrown exception, matching this module's own never-throw
// contract.
function pointerPath(sessionId, agentId) {
  if (!isSafePathSegment(sessionId) || !isSafePathSegment(agentId)) return null;
  const p = ensureSubPath('pointers', sessionId, `${agentId}.json`);
  return isPathContainedIn(p, pointersRootDir()) ? p : null;
}

function pointersDirFor(sessionId) {
  if (!isSafePathSegment(sessionId)) return null;
  const p = subPath('pointers', sessionId);
  return isPathContainedIn(p, pointersRootDir()) ? p : null;
}

function pointersRootDir() {
  return subPath('pointers');
}

// Fast, cheap check for the common case: no pointers dir at all means
// nothing to do, ever — callers use this to skip transcript reads entirely
// when the plugin has never written a pointer.
function hasAnyPointers() {
  try {
    return fs.readdirSync(pointersRootDir()).length > 0;
  } catch {
    return false;
  }
}

function writePointer({ sessionId, agentId, transcriptPath, agentName, toolUseId, parentSessionId, finishedAt, summary }) {
  if (!sessionId || !agentId || !transcriptPath) return false;
  const targetPath = pointerPath(sessionId, agentId);
  if (!targetPath) return false; // unsafe sessionId/agentId (e.g. path traversal) -> fail open, no write
  const record = {
    transcriptPath,
    agentId,
    agentName: agentName || null,
    // Stored so delivery can be re-checked LATER (a later hook invocation,
    // possibly in a different process) without re-reading the subagent's
    // own meta.json sidecar — the pointer record is self-contained evidence
    // for `wasDelivered` below.
    toolUseId: toolUseId || null,
    parentSessionId: parentSessionId || sessionId,
    finishedAt: finishedAt || new Date().toISOString(),
    summary: truncateSummary(summary || ''),
    claimed: false,
    surfaced: { userPromptSubmit: false, sessionStart: false },
  };
  return safeWriteJson(targetPath, record);
}

function listPointersForSession(sessionId) {
  const dir = pointersDirFor(sessionId);
  if (!dir) return []; // unsafe sessionId -> fail open, empty list, never a directory read attempt
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const p = path.join(dir, name);
    const record = safeReadJson(p);
    if (record) out.push({ path: p, sessionId, agentId: name.slice(0, -'.json'.length), record });
  }
  return out;
}

function listAllPointers() {
  let sessionDirs;
  try {
    sessionDirs = fs.readdirSync(pointersRootDir());
  } catch {
    return [];
  }
  const out = [];
  for (const sessionId of sessionDirs) {
    out.push(...listPointersForSession(sessionId));
  }
  return out;
}

function markClaimed(entry) {
  entry.record.claimed = true;
  return safeWriteJson(entry.path, entry.record);
}

// The per-pointer, per-hook "already surfaced" state used to live SOLELY as
// a field inside the pointer's own JSON record, mutated via a plain
// read-modify-write (`markSurfaced` below). That has no lock: concurrent
// UserPromptSubmit/SessionStart hook processes (a real possibility — both
// fire from independent harness events with no ordering guarantee) can both
// read the record before either writes back, so one process's write
// silently clobbers the other's — either double-surfacing the same pointer
// (lost update) or, less likely but just as possible, losing a `claimed`
// flag set concurrently.
//
// Fixed with the simpler of the two options the audit allows: a lock-free,
// atomic per-hook marker file, created with `fs.openSync(path, 'wx')` right
// next to the pointer's own JSON file. `wx` fails with `EEXIST` when the
// file already exists, so exactly one process's create call can ever
// succeed for a given (pointer, hook) pair — the creator wins, unconditionally,
// with no read-modify-write race window at all. The JSON record's own
// `surfaced` field is still written for human-readability, but is NEVER the
// source of truth for "already surfaced" — see `isSurfaceMarked`, which
// every caller must use instead of reading `record.surfaced` directly.
function surfaceMarkerPath(entry, hookName) {
  return `${entry.path}.surfaced-${hookName}`;
}

// Non-destructive existence check — the race-safe "already surfaced via
// this hook" answer every caller (both hooks, plus `reconcileAndFilter`)
// must use in place of `entry.record.surfaced[hookName]`.
function isSurfaceMarked(entry, hookName) {
  try {
    fs.accessSync(surfaceMarkerPath(entry, hookName));
    return true;
  } catch {
    return false;
  }
}

// Atomically claims "surfaced via hookName" for this pointer. Returns
// `true` only when THIS call is the one that won the race (the marker file
// did not exist yet) — `false` when another process already claimed it, or
// when the marker could not be created for any other reason (fail-safe
// against double-surfacing: an ambiguous/failed claim must never be treated
// as "go ahead and surface").
function markSurfaced(entry, hookName) {
  let fd;
  try {
    fd = fs.openSync(surfaceMarkerPath(entry, hookName), 'wx');
  } catch {
    return false;
  }
  try {
    fs.closeSync(fd);
  } catch {
    /* best-effort close only — the marker file already exists either way */
  }
  // Best-effort mirror into the JSON record, purely for introspection
  // (`listAllPointers` output, debugging) — losing this write can never
  // cause double-surfacing, since the marker file above is the sole
  // race-safe source of truth going forward.
  entry.record.surfaced = entry.record.surfaced || {};
  entry.record.surfaced[hookName] = true;
  safeWriteJson(entry.path, entry.record);
  return true;
}

// Bounded tail-read of a transcript file: at most the last `maxBytes`,
// never the whole file. Returns '' when the file cannot be read at all.
// `truncated: true` means this read started at a nonzero byte offset (the
// file is bigger than `maxBytes`), so the first line in `text` may be a
// partial JSONL record — callers that parse `text` line-by-line must drop
// that first line rather than feed it to `JSON.parse`.
function tailRead(filePath, maxBytes = TAIL_SCAN_BYTES) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { text: '', mtimeMs: null, exists: false, truncated: false };
  }
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  if (length <= 0) return { text: '', mtimeMs: stat.mtimeMs, exists: true, truncated: false };
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), mtimeMs: stat.mtimeMs, exists: true, truncated: start > 0 };
  } catch {
    return { text: '', mtimeMs: stat.mtimeMs, exists: true, truncated: false };
  }
}

// Parses a tail-read's raw text into one JS object per JSONL line,
// entry-aware rather than a raw-text regex scan — this is what lets
// `wasDelivered` below tell a `queue-operation` bookkeeping line apart from
// the real delivery entry that follows it. Unparseable lines (a truncated
// first line from a bounded tail-read, or any other non-JSON line) are
// skipped rather than thrown on. When `droppedPartialFirstLine` is true
// (the tail read started at a nonzero offset — see `tailRead`), the first
// line is discarded outright without even attempting to parse it, since it
// is known-partial rather than merely unparseable-by-chance.
function parseTailEntries(text, { droppedPartialFirstLine = false } = {}) {
  const lines = text.split('\n');
  if (droppedPartialFirstLine && lines.length) lines.shift();
  const entries = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch {
      /* skip — not evidence either way, never a hard failure */
    }
  }
  return entries;
}

function parentTranscriptPathFor(record) {
  // Mirrors subagentSessionDir's derivation without importing it here (kept
  // dependency-free / testable in isolation): a subagent's transcript lives
  // at `<session-dir>/subagents/<file>.jsonl`; its parent's own top-level
  // transcript is `<session-dir>.jsonl`.
  const marker = `${path.sep}subagents${path.sep}`;
  const idx = record.transcriptPath.lastIndexOf(marker);
  if (idx === -1) return null;
  return `${record.transcriptPath.slice(0, idx)}.jsonl`;
}

// Every literal substring that counts as positive delivery evidence for a
// team-mailbox agent's name. Matched against `JSON.stringify(entry)` of one
// ALREADY-PARSED transcript entry (see `parseTailEntries`), which always
// re-serializes an embedded quote as exactly one level of `\"` — unlike a
// raw-text regex scan (which has to guess how many encoding layers deep a
// given occurrence is), so one escaped form per marker is enough; the
// unescaped form is kept too, purely as a defensive fallback in case a
// future harness shape carries the marker as a bare unquoted attribute.
function deliveryMarkersForName(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`<agent-message from=\\\\"${escaped}\\\\"`),
    new RegExp(`<agent-message from="${escaped}"`),
    new RegExp(`<teammate-message teammate_id=\\\\"${escaped}\\\\"`),
    new RegExp(`<teammate-message teammate_id="${escaped}"`),
  ];
}

// The exact text a background `Agent` spawn's IMMEDIATE launch-acknowledgment
// tool_result starts with — see the file header. A tool_result carrying only
// this text is the spawn confirmation, not the eventual real result, even
// though it shares the SAME `tool_use_id` as the real result will later
// (when one ever arrives via this channel at all — a background dispatch's
// real result instead arrives as a task-notification, matched separately by
// `taskIdDelivered` below).
const ASYNC_LAUNCH_ACK_PREFIX = 'Async agent launched successfully.';

// Every `type: 'text'` string (or the bare string) inside one `tool_result`
// content block, in whichever of the two real shapes it was authored as.
function toolResultBlockTexts(block) {
  const content = block && block.content;
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) {
    return content.filter((b) => b && typeof b.text === 'string').map((b) => b.text);
  }
  return [];
}

// True only when EVERY text part of this tool_result is the launch ack —
// a block with no text content at all is not an ack (never suppress a
// genuinely empty synchronous result on that basis alone).
function isAsyncLaunchAckOnly(block) {
  const parts = toolResultBlockTexts(block);
  if (!parts.length) return false;
  return parts.every((t) => typeof t === 'string' && t.trimStart().startsWith(ASYNC_LAUNCH_ACK_PREFIX));
}

// Foreground/synchronous delivery: a `type: 'user'` entry carrying a
// `tool_result` block whose `tool_use_id` matches AND whose content is NOT
// the background-launch acknowledgment (see the file header's point 1 — the
// bug this closes: a background spawn's launch ack shares the spawn call's
// own `tool_use_id`, so matching on `tool_use_id` alone marks every
// background lane "delivered" the instant it launches).
function foregroundDelivered(entry, toolUseId) {
  if (!toolUseId || !entry || entry.type !== 'user') return false;
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && b.type === 'tool_result' && b.tool_use_id === toolUseId && !isAsyncLaunchAckOnly(b));
}

// Background-completion delivery: the task-notification actually reached
// the conversation, not merely got queued for it. Matched against the
// re-serialized entry so it is tolerant of whatever escaping depth the
// notification's own text happens to carry (see the file header's point 2)
// — a `queue-operation` entry is EXCLUDED by the caller before this is ever
// reached, since an `enqueue` alone (never dequeued) is exactly the "queued, not
// delivered" case a dead parent session can leave behind forever.
function taskIdDelivered(entry, agentId) {
  if (!agentId || !entry) return false;
  let text;
  try {
    text = JSON.stringify(entry);
  } catch {
    return false;
  }
  return text.includes(`<task-id>${agentId}</task-id>`);
}

// Parses a transcript entry's own `timestamp` field (Claude Code JSONL
// entries carry an ISO string at the top level) into epoch ms, or null when
// absent/unparseable.
function entryTimestampMs(entry) {
  const raw = entry && typeof entry.timestamp === 'string' ? entry.timestamp : null;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// Guards `wasDelivered` against an OLDER parent-transcript entry (e.g. a
// pre-finish same-name `<agent-message>`/`<teammate-message>` from an
// EARLIER dispatch of the same-named agent) wrongly marking a LATER,
// still-undelivered pointer as delivered. `finishedAtMs` is the pointer's
// own `finishedAt`, parsed once by the caller.
//
//   - No `finishedAtMs` at all (older pointer records / direct unit calls
//     that omit it): no constraint — back-compat, matches prior behavior.
//   - Entry has a parseable `timestamp`: accept only at or after
//     `finishedAtMs - DELIVERY_TIMESTAMP_SKEW_MS`, for EVERY evidence type
//     (id-based or name-based) — an entry timestamped well before the
//     subagent even finished cannot be evidence that its result was
//     delivered.
//   - Entry has NO parseable `timestamp`: accepted only when `requireExact`
//     is false — reserved for the unambiguous id-based markers
//     (`tool_use_id` / `<task-id>`), which cannot be satisfied by a
//     different, unrelated dispatch. A name-based marker on a
//     timestamp-less entry is NEVER accepted — a same-name match is
//     ambiguous by construction, so without a timestamp to order it against
//     `finishedAt` there is no way to rule out exactly the pre-finish-entry
//     case this guards against.
function isTimestampAcceptable(entry, finishedAtMs, { requireExact }) {
  if (!Number.isFinite(finishedAtMs)) return true;
  const ts = entryTimestampMs(entry);
  if (ts === null) return !requireExact;
  return ts >= finishedAtMs - DELIVERY_TIMESTAMP_SKEW_MS;
}

// Deterministic delivery check — see the file header for the exact shapes
// this recognizes. Returns true only on positive evidence; any failure to
// read defaults to false (never claim delivery without evidence). Reads
// evidence entirely from the pointer record itself (`toolUseId`, `agentId`,
// `agentName`) — no dependency on re-reading the subagent's own sidecar.
//
// Entry-aware, not a raw-text scan: every candidate entry in the tail is
// parsed as JSON first (`parseTailEntries`), and any `queue-operation`
// entry is skipped outright before any marker check runs — for EVERY
// evidence type, not just the task-notification one, because the harness's
// queueing mechanism is generic (both a background-agent task-notification
// and a team-mailbox agent-message can appear inside a queue-operation's own
// queued `content` before the real delivery entry lands) and "queued" is
// never "delivered" for any of them.
//
// Also timestamp-aware (see `isTimestampAcceptable`): a name-based marker
// match is discarded outright when it belongs to an entry timestamped
// before this pointer's own `finishedAt` — otherwise an older, unrelated
// same-name dispatch's delivery marker could wrongly mark a LATER,
// still-undelivered report as delivered.
function wasDelivered(record) {
  const parentPath = parentTranscriptPathFor(record);
  if (!parentPath) return { delivered: false, parentMtimeMs: null, parentExists: false };
  const { text, mtimeMs, exists, truncated } = tailRead(parentPath);
  if (!text) return { delivered: false, parentMtimeMs: mtimeMs, parentExists: exists };

  const entries = parseTailEntries(text, { droppedPartialFirstLine: truncated });
  const toolUseId = record.toolUseId;
  const agentId = record.agentId;
  const name = record.agentName;
  const nameMarkers = name ? deliveryMarkersForName(name) : null;
  const finishedAtMs = record.finishedAt ? Date.parse(record.finishedAt) : NaN;

  for (const entry of entries) {
    if (!entry || entry.type === 'queue-operation') continue;

    if (foregroundDelivered(entry, toolUseId) && isTimestampAcceptable(entry, finishedAtMs, { requireExact: false })) {
      return { delivered: true, parentMtimeMs: mtimeMs, parentExists: exists };
    }
    if (taskIdDelivered(entry, agentId) && isTimestampAcceptable(entry, finishedAtMs, { requireExact: false })) {
      return { delivered: true, parentMtimeMs: mtimeMs, parentExists: exists };
    }
    if (nameMarkers && isTimestampAcceptable(entry, finishedAtMs, { requireExact: true })) {
      let entryText;
      try {
        entryText = JSON.stringify(entry);
      } catch {
        entryText = null;
      }
      if (entryText && nameMarkers.some((re) => re.test(entryText))) {
        return { delivered: true, parentMtimeMs: mtimeMs, parentExists: exists };
      }
    }
  }

  return { delivered: false, parentMtimeMs: mtimeMs, parentExists: exists };
}

// `deliveryResult` lets a caller that already ran `wasDelivered(record)`
// itself (e.g. the SessionStart hook's own reconciliation pass) pass that
// result straight through instead of this function recomputing it — the
// same tail-read otherwise happened twice per pointer, once directly and
// once again in here, for no reason. Omit it to have this function compute
// it itself, unchanged from prior behavior.
function isParentGone(entry, { now = Date.now(), currentSessionId = null, deliveryResult = null } = {}) {
  const { record } = entry;
  if (currentSessionId && record.parentSessionId && currentSessionId !== record.parentSessionId) return true;
  const { parentMtimeMs, parentExists } = deliveryResult || wasDelivered(record);
  if (!parentExists) return true;
  const finishedAtMs = Date.parse(record.finishedAt || '') || now;
  return now - Math.max(parentMtimeMs || 0, finishedAtMs) > PARENT_GONE_GRACE_MS && now - finishedAtMs > PARENT_GONE_GRACE_MS;
}

// Reconciles every pointer for `sessionId` against transcript evidence,
// marking claimed ones. Returns the list of entries that are neither
// claimed nor already surfaced via `hookName`.
function reconcileAndFilter(sessionId, hookName, { now = Date.now() } = {}) {
  const entries = listPointersForSession(sessionId);
  const eligible = [];
  for (const entry of entries) {
    if (entry.record.claimed) continue;
    const { delivered } = wasDelivered(entry.record);
    if (delivered) {
      markClaimed(entry);
      continue;
    }
    if (isSurfaceMarked(entry, hookName)) continue;
    eligible.push(entry);
  }
  return eligible;
}

// Every hook name a pointer's surfaced-state marker can be created for —
// used only to clean up a pruned pointer's own marker files alongside it.
const SURFACE_HOOK_NAMES = ['userPromptSubmit', 'sessionStart'];

function pruneOld({ now = Date.now(), maxAgeMs = PRUNE_AFTER_MS } = {}) {
  let pruned = 0;
  for (const entry of listAllPointers()) {
    const finishedAtMs = Date.parse(entry.record.finishedAt || '') || 0;
    if (now - finishedAtMs > maxAgeMs) {
      try {
        fs.unlinkSync(entry.path);
        pruned += 1;
      } catch {
        /* best-effort */
      }
      for (const hookName of SURFACE_HOOK_NAMES) {
        try {
          fs.unlinkSync(surfaceMarkerPath(entry, hookName));
        } catch {
          /* marker may never have been created — best-effort cleanup only */
        }
      }
    }
  }
  return pruned;
}

function formatPointerList(entries, dirLabel) {
  const shown = entries.slice(0, MAX_ITEMS_PER_INJECTION);
  const lines = shown.map((e) => {
    const label = e.record.agentName || e.agentId;
    const summary = e.record.summary ? ` — ${e.record.summary}` : '';
    return `- ${label} (${e.record.transcriptPath})${summary}`;
  });
  if (entries.length > shown.length) {
    lines.push(`- +${entries.length - shown.length} more at ${dirLabel}`);
  }
  return lines.join('\n');
}

module.exports = {
  TAIL_SCAN_BYTES,
  PARENT_GONE_GRACE_MS,
  MAX_SUMMARY_CHARS,
  MAX_ITEMS_PER_INJECTION,
  PRUNE_AFTER_MS,
  truncateSummary,
  pointerPath,
  pointersDirFor,
  pointersRootDir,
  hasAnyPointers,
  writePointer,
  listPointersForSession,
  listAllPointers,
  markClaimed,
  markSurfaced,
  isSurfaceMarked,
  surfaceMarkerPath,
  tailRead,
  parentTranscriptPathFor,
  wasDelivered,
  isParentGone,
  reconcileAndFilter,
  pruneOld,
  formatPointerList,
  // exported for test coverage only
  parseTailEntries,
  deliveryMarkersForName,
  foregroundDelivered,
  taskIdDelivered,
  ASYNC_LAUNCH_ACK_PREFIX,
  DELIVERY_TIMESTAMP_SKEW_MS,
  entryTimestampMs,
  isTimestampAcceptable,
};
