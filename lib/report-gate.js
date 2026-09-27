'use strict';

/**
 * report-gate.js — the SubagentStop delivery gate's decision logic.
 *
 * WHY THIS EXISTS
 * ----------------
 * A background teammate dispatched via the Agent tool (a "team-mailbox"
 * participant, addressable with `SendMessage`) does NOT have its plain final
 * assistant text delivered to whoever dispatched it. Only an explicit
 * `SendMessage` tool call delivers content upstream; a separate,
 * content-free idle notification is all the dispatcher otherwise sees when
 * that agent goes idle. If a teammate finishes its work and ends its turn
 * with plain text only (no `SendMessage`), that text is effectively lost —
 * visible only inside that teammate's own transcript file on disk, never
 * surfaced to the conversation that dispatched it. Reported and reproduced
 * upstream, independent of this repo — see README.md.
 *
 * This module is this plugin's deterministic backstop for that failure
 * mode: called from every `SubagentStop` event (see `../hooks/report-gate.js`),
 * for team-mailbox participants only, it blocks the stop (forcing the
 * harness to give the agent another turn) unless a well-formed `SendMessage`
 * call already occurred this turn.
 *
 * A plain synchronous Task-tool subagent (`agentType: "general-purpose"` /
 * `"Explore"`, no `taskKind` field on its sidecar) is never gated — it
 * reports back via its own plain-text return value and has no `SendMessage`
 * tool to call. Gating it would be a false positive. The `.meta.json`
 * sidecar next to a team-mailbox teammate's transcript reliably carries
 * `"taskKind":"in_process_teammate"`; a plain subagent's sidecar (when one
 * exists at all) never does. Gate on that field.
 *
 * THE `transcript_path` CAVEAT (read this before changing identity resolution)
 * ------------------------------------------------------------------------------
 * The most natural implementation reads `payload.transcript_path` from the
 * SubagentStop event, looks for a sibling `<path>.meta.json`, and gates on
 * that. In practice, `payload.transcript_path` on a SubagentStop firing for
 * a NAMED background teammate has been observed, live, to resolve to the
 * LEAD session's own top-level transcript file — NOT to the teammate's own
 * dedicated transcript. No sibling `.meta.json` exists next to the lead's
 * own transcript, so a naive direct-sibling lookup always misses.
 *
 * The teammate's REAL transcript + meta.json sidecar live one directory
 * down, at `<session-dir>/subagents/agent-a<name>-<hash>.{jsonl,meta.json}`
 * (the literal `a` right after `agent-` is part of Claude Code's own naming
 * scheme, not part of the dispatched agent's own name — see
 * `lib/subagent-transcript.js`).
 *
 * `resolveTeammateContext` below resolves the real per-teammate context with
 * a four-step fallback, in decreasing order of certainty:
 *
 *   1. `payload.agent_transcript_path` — the stopping agent's own transcript,
 *      named directly by the harness, when present. Not confirmed present on
 *      every Claude Code build; used when present, skipped when absent.
 *   2. Direct sibling of `payload.transcript_path` — exact, not a heuristic.
 *      Also correctly exempts a plain Task-tool subagent (whose
 *      transcript_path DOES point at its own file, but which never carries
 *      `taskKind` at all).
 *   3. An explicit agent-identity field on the payload itself
 *      (`agent_id`/`agentId`/`subagent_id`/`subagentId`), matched against
 *      every team-mailbox candidate under the session's `subagents/`
 *      directory — or, if that directory could not be listed, derived
 *      directly from the id via `transcriptPathForAgentId`.
 *   4. A bounded recency heuristic: among every team-mailbox candidate under
 *      that session's `subagents/` dir, pick the one whose transcript has
 *      the most recent mtime, bounded to a time window (default 10 minutes,
 *      overridable via `SUBAGENT_REPORT_GUARD_RECENCY_WINDOW_MS`). Reached
 *      ONLY when the payload carries NO identity field at all — see the
 *      guard right before step 4 in the code: a payload that DOES carry an
 *      explicit identity field but failed to match any candidate at step 3
 *      returns null outright instead, since that is positive evidence this
 *      event belongs to a DIFFERENT (non-team-mailbox, or not-yet-visible)
 *      agent, not "no evidence at all". Fixed after a real, observed
 *      misattribution: a plain subagent's SubagentStop (its own `agent_id`
 *      present, matching no team-mailbox candidate) fell through to this
 *      heuristic and got matched to an unrelated named teammate's transcript
 *      purely because it was the freshest team-mailbox candidate at that
 *      instant.
 *
 * KNOWN LIMITATION of step 4, and how it's contained: two teammates that
 * both write within the same tight recency window cannot be told apart by
 * mtime alone. `resolveTeammateContext` counts how many candidates fell
 * inside the window (`candidateCount`) and refuses a near-tie
 * (`AMBIGUITY_EPSILON_MS`); the block decision itself never depends on this
 * (a genuinely stuck agent is still blocked either way) — what depends on it
 * is whether it is safe to quote a resolved transcript's text verbatim (see
 * `EXACT_RESOLUTION_METHODS`'s use below).
 *
 * THE REGENERATION-DRIFT PROBLEM
 * -------------------------------
 * A block `reason` can only ask the model to call `SendMessage` — it cannot
 * force a tool call's arguments directly. Composing that call is itself a
 * fresh model generation; simply telling an agent "resend your report" after
 * it already produced a long or structured report can result in a
 * paraphrase, a reformat, or a table silently collapsing into a prose list —
 * fluent, plausible, and wrong relative to the original. This module reduces
 * that risk structurally: it reads the stopping agent's OWN transcript,
 * extracts its actual final assistant text, and embeds that text DIRECTLY
 * inside the block reason, verbatim — reproducing it on the agent's next
 * turn is then a copy, not a reconstruction from memory. The embed is
 * size-bounded (`MAX_EMBEDDED_REPORT_CHARS`); past that bound, the reason
 * still includes as much as fits plus an explicit instruction to reproduce
 * the COMPLETE original message, not just the shown excerpt.
 *
 * INVARIANTS
 * ----------
 *  - `decide()` never throws; every failure mode (missing payload, unreadable
 *    transcript/meta, unwritable state file, ambiguous identity resolution)
 *    fails OPEN (returns `null`, meaning "allow") — this gate must never be
 *    the reason a legitimate subagent turn cannot end.
 *  - Blocks a given teammate transcript at most once per DISTINCT stale
 *    follow-up (a marker under this plugin's data dir, keyed to both the
 *    transcript and the specific inbound follow-up message that triggered
 *    the block — never a sidecar next to the transcript file itself, so
 *    nothing is ever written outside the data dir; see `lib/paths.js`). The
 *    same stale transcript can therefore never wake-loop on ITS OWN: a
 *    second SubagentStop firing against the identical follow-up is a no-op
 *    allow. A genuinely NEW, later follow-up may block once more, but that
 *    requires a fresh inbound message to arrive first — the block is always
 *    bounded by external input, never by this module re-triggering itself.
 *    The unrelated "no report sent at all this turn" path keeps its own
 *    separate one-shot marker, `reportBlockedOnce`.
 *  - Never gates a subagent whose sidecar does not carry
 *    `taskKind: "in_process_teammate"`.
 *
 * ALSO INCLUDED, beyond the core identity resolution and blocking logic
 * above (see README.md's "Report gate — the details" section for the
 * user-facing version of this list):
 *  - The three-valued "confirm this is really a background dispatch, not a
 *    deliberately synchronous one" spawn-ledger correlation
 *    (`classifyBackgroundSpawn` / `findBackgroundAgentSpawn`, in
 *    `lib/spawn-ledger.js`) — protects against an explicit
 *    `run_in_background: false` spawn, whose plain return value IS delivered
 *    to its parent through the ordinary tool_result channel.
 *  - The "pending inbound follow-up" freshness re-check (did a newer,
 *    non-terminal-marked message arrive after the last report was sent) and
 *    its peer-acknowledgment exemption (`evaluatePendingFollowup`, in
 *    `lib/pending-followup.js`) plus this file's own matching
 *    `lastReportableBoundary`, which excludes a terminal-marked teammate
 *    message from Stage 1's SEPARATE "was a report sent this turn" boundary
 *    check — both halves are needed together to close the peer-ack-loop
 *    failure mode; see each module's own header for the full mechanism and
 *    loop-safety argument.
 *
 * NOT INCLUDED:
 *  - Any nudge toward a specific post-report command or follow-up automation
 *    after a report is confirmed sent. Replaced by a generic, OFF-by-default
 *    `postReportCommand` hook (see `lib/post-report-command.js`) — this
 *    plugin has no opinion on what, if anything, should happen after a
 *    report lands.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const {
  metaPathFor,
  transcriptPathForAgentId,
  subagentSessionDir,
  listTeammateMetaCandidates,
  readTranscriptEntries,
  lastAssistantText,
  isNonActionableUserEntry,
} = require('./subagent-transcript.js');
const { ensureSubPath } = require('./paths.js');
const { classifyBackgroundSpawn } = require('./spawn-ledger.js');
const { isTerminalTeammateMessage, evaluatePendingFollowup } = require('./pending-followup.js');

const RECENCY_WINDOW_MS =
  Number(process.env.SUBAGENT_REPORT_GUARD_RECENCY_WINDOW_MS) || 10 * 60 * 1000;

// How far apart two candidates' mtimes must be before "the freshest one"
// counts as an answer rather than a coin flip.
const AMBIGUITY_EPSILON_MS = Number(process.env.SUBAGENT_REPORT_GUARD_AMBIGUITY_EPSILON_MS) || 500;

// Size bound for the verbatim copy embedded directly in the block reason.
const MAX_EMBEDDED_REPORT_CHARS =
  Number(process.env.SUBAGENT_REPORT_GUARD_MAX_EMBEDDED_REPORT_CHARS) || 10000;

// Resolution methods that identify the RIGHT teammate transcript with
// certainty, as opposed to `recency-heuristic`, which is a best guess.
const EXACT_RESOLUTION_METHODS = new Set([
  'agent-transcript-path',
  'direct-sibling',
  'payload-identity-field',
  'payload-identity-path',
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Resolves the REAL per-teammate {transcriptPath, metaPath, meta,
// resolutionMethod} for a SubagentStop firing. Returns null when no
// team-mailbox participant can be identified with reasonable confidence —
// callers MUST treat null exactly like "not a team-mailbox participant"
// (allow, never block). See the file header for the four-step order.
function resolveTeammateContext(payload, { now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const identityFieldCandidates = [
    payload.agent_id,
    payload.agentId,
    payload.subagent_id,
    payload.subagentId,
  ].filter((v) => typeof v === 'string' && v);

  // Step 1 — the harness naming the stopping agent's own transcript outright.
  const ownTranscriptPath = nonEmptyString(payload.agent_transcript_path);
  if (ownTranscriptPath) {
    const ownMetaPath = metaPathFor(ownTranscriptPath);
    const ownMeta = ownMetaPath && readJsonSafe(ownMetaPath);
    if (ownMeta) {
      if (ownMeta.taskKind !== 'in_process_teammate') return null;
      return {
        agentId: identityFieldCandidates[0] || null,
        transcriptPath: ownTranscriptPath,
        metaPath: ownMetaPath,
        meta: ownMeta,
        resolutionMethod: 'agent-transcript-path',
      };
    }
  }

  const rawTranscriptPath = payload.transcript_path;
  if (typeof rawTranscriptPath !== 'string' || !rawTranscriptPath) return null;

  // Step 2 — direct sibling. Exact, not a heuristic, so tried before
  // anything that has to search.
  const directMetaPath = metaPathFor(rawTranscriptPath);
  const directMeta = directMetaPath && readJsonSafe(directMetaPath);
  if (directMeta && directMeta.taskKind === 'in_process_teammate') {
    return {
      agentId: identityFieldCandidates[0] || null,
      transcriptPath: rawTranscriptPath,
      metaPath: directMetaPath,
      meta: directMeta,
      resolutionMethod: 'direct-sibling',
    };
  }
  const sessionDir = subagentSessionDir(rawTranscriptPath);
  const candidates = sessionDir ? listTeammateMetaCandidates(path.join(sessionDir, 'subagents')) : [];

  // Step 3 — exact match on an explicit agent-identity field. Runs before
  // the directMeta-non-team short-circuit below: a payload that DOES carry
  // a valid identity field can still resolve correctly even when directMeta
  // is a definitive non-match.
  for (const id of identityFieldCandidates) {
    const hit = candidates.find((c) => c.agentId === id);
    if (hit) return { ...hit, agentId: id, resolutionMethod: 'payload-identity-field' };
  }
  if (sessionDir && !candidates.length) {
    for (const id of identityFieldCandidates) {
      const derivedPath = transcriptPathForAgentId(path.join(sessionDir, 'subagents'), id);
      const derivedMetaPath = derivedPath && metaPathFor(derivedPath);
      const derivedMeta = derivedMetaPath && readJsonSafe(derivedMetaPath);
      if (derivedMeta && derivedMeta.taskKind === 'in_process_teammate') {
        return {
          agentId: id,
          transcriptPath: derivedPath,
          metaPath: derivedMetaPath,
          meta: derivedMeta,
          resolutionMethod: 'payload-identity-path',
        };
      }
    }
  }

  // The payload named a SPECIFIC agent (an explicit identity field —
  // `agent_id`/`agentId`/`subagent_id`/`subagentId`), and step 3 above
  // could not match that exact id to ANY team-mailbox candidate under this
  // session's `subagents/` dir. That is POSITIVE evidence this SubagentStop
  // belongs to a DIFFERENT agent than whichever team-mailbox transcript
  // happens to be freshest — falling through to step 4's session-wide
  // recency heuristic here would misattribute this event to an unrelated
  // agent. REAL, OBSERVED CONSEQUENCE of not having this guard: a plain,
  // non-team-mailbox subagent's SubagentStop (`agent_id` present,
  // `agent_type` empty, no matching team-mailbox candidate) fell through
  // all the way to the recency heuristic and got matched to a named
  // teammate's transcript purely because it was the only/freshest
  // team-mailbox candidate at that instant — the resolved
  // `resolutionMethod` logged as `recency-heuristic` for an event whose own
  // payload named a specific, non-matching agent id. The recency heuristic
  // is a last resort reserved for when there is NO identity signal at all;
  // a stated-but-unmatched identity must never fall through to it.
  if (identityFieldCandidates.length) return null;

  // A sibling meta.json that was found AND successfully read, but does not
  // claim team-mailbox membership, is DEFINITIVE negative evidence about
  // THIS specific calling agent — e.g. a plain Task-tool subagent whose
  // transcript_path correctly points at its own file. Must return null
  // rather than fall through to step 4's session-wide recency heuristic:
  // that heuristic exists only when we have NO direct evidence about the
  // caller at all.
  if (directMeta) return null;

  if (!candidates.length) return null;

  // Step 4 — bounded recency heuristic, genuine last resort.
  let best = null;
  let runnerUpMs = null;
  let windowCount = 0;
  for (const c of candidates) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(c.transcriptPath).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs > RECENCY_WINDOW_MS) continue;
    windowCount += 1;
    if (!best || mtimeMs > best.mtimeMs) {
      if (best) runnerUpMs = best.mtimeMs;
      best = { ...c, mtimeMs };
    } else if (runnerUpMs === null || mtimeMs > runnerUpMs) {
      runnerUpMs = mtimeMs;
    }
  }
  if (!best) return null;
  if (runnerUpMs !== null && best.mtimeMs - runnerUpMs < AMBIGUITY_EPSILON_MS) return null;
  return {
    ...best,
    agentId: identityFieldCandidates[0] || null,
    resolutionMethod: 'recency-heuristic',
    candidateCount: windowCount,
  };
}

function assistantToolUses(entry) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool_use');
}

// Requires a non-empty `to` plus a non-empty `message` or `summary` in the
// call's own input — deliberately does NOT trust a SendMessage tool_result's
// success status as proof of a well-formed delivery. SendMessage has been
// observed live to still return `{"success": true}` even when called with
// extra/stray fields instead of the real `to`/`message`.
function hasWellFormedSendMessage(block) {
  if (!block || block.type !== 'tool_use' || block.name !== 'SendMessage') return false;
  const input = block.input || {};
  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
  return nonEmpty(input.to) && (nonEmpty(input.message) || nonEmpty(input.summary));
}

function wellFormedSendMessageInRange(entries, fromIdx) {
  for (let i = Math.max(fromIdx, 0); i < entries.length; i += 1) {
    const e = entries[i];
    if (!e || e.type !== 'assistant') continue;
    if (assistantToolUses(e).some(hasWellFormedSendMessage)) return true;
  }
  return false;
}

// The last REAL inbound turn boundary — skips both a tool_result echo of the
// agent's own preceding call and a harness-synthetic `isMeta: true` entry
// (a Skill-tool load, a system reminder, or this gate's own re-injected
// block reason on the agent's next stop attempt) — neither is a genuine new
// turn, and treating either as one can make a hook's own prior feedback
// self-amplify into a fresh "boundary" forever.
function lastUserBoundary(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e || e.type !== 'user') continue;
    if (isNonActionableUserEntry(e)) continue;
    return i;
  }
  return -1;
}

// Stage 1's own "did a report happen since this turn began" boundary must
// not be reset by a purely terminal (sender-marked no-reply-needed) peer
// acknowledgment — see `pending-followup.js`'s header for the full
// peer-ack-loop rationale this closes. Without this, a trailing chain of
// pure acks independently re-triggers Stage 1's own "no report sent this
// turn" block via THIS separate boundary check, even once the pending-
// followup check above (which runs first) has correctly stopped firing on
// them — the same infinite-ack-loop symptom, reached a second way. A
// standalone boundary-finder, not a mutation of `lastUserBoundary` above:
// that function has its own narrow, separately-tested "skip
// tool_result-only/isMeta echoes" contract, and folding a
// team-mailbox-specific sender-intent concern into it would widen its
// meaning for every other consumer, not just this one.
function lastReportableBoundary(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e || e.type !== 'user') continue;
    if (isNonActionableUserEntry(e)) continue;
    if (isTerminalTeammateMessage(e)) continue;
    return i;
  }
  return -1;
}

// A stable identity for "which specific inbound follow-up" made the report
// stale — the uuid of that transcript entry when present, else its
// timestamp, else its (append-only, therefore stable across repeated calls
// against an unchanged transcript) index. Used to key the one-shot stale-
// follow-up block marker below, so the SAME follow-up can block at most
// once, while a genuinely NEW later follow-up (which necessarily lands at a
// different index/uuid/timestamp) still blocks again.
function staleFollowupKey(entries, index) {
  const entry = Array.isArray(entries) && Number.isInteger(index) ? entries[index] : null;
  if (entry) {
    const uuid = nonEmptyString(entry.uuid);
    if (uuid) return `uuid:${uuid}`;
    const timestamp = nonEmptyString(entry.timestamp);
    if (timestamp) return `ts:${timestamp}`;
  }
  return `index:${index}`;
}

const STALE_REPORT_REASON =
  'A teammate follow-up arrived after your latest SendMessage, so that report is stale. Read and ' +
  'incorporate the pending follow-up, then send an updated well-formed SendMessage before going ' +
  'idle. This check covers delivered transcript messages only; it does not claim the provider\'s ' +
  'opaque queue is empty.';

function buildBlockReason(finalText) {
  const genericTail =
    'Use exactly these three fields on the call — "to" (main, or your dispatcher if different), ' +
    '"message", and "summary" (a short preview) — no other fields. Plain final text is not ' +
    'visible to whoever dispatched you — only SendMessage delivers it, and a malformed call can ' +
    'silently return success without actually landing. If you are genuinely blocked, send that ' +
    'via SendMessage too instead of going idle silently.';

  if (typeof finalText !== 'string' || !finalText.length) {
    return (
      'You are ending your turn without having sent a well-formed report via SendMessage (no call ' +
      'with both a non-empty "to" and a non-empty "message" or "summary" found this turn). Call ' +
      `SendMessage now with your report. ${genericTail}`
    );
  }

  // `finalText.slice(0, N)` indexes by raw UTF-16 code unit, so it can land
  // exactly between the two halves of an astral-plane character's surrogate
  // pair, corrupting the embedded excerpt. `Array.from(str)` iterates by
  // Unicode code point (surrogate pairs never split), so slicing THAT array
  // is always code-point-safe.
  const codePoints = Array.from(finalText);
  const truncated = codePoints.length > MAX_EMBEDDED_REPORT_CHARS;
  const snippet = truncated ? codePoints.slice(0, MAX_EMBEDDED_REPORT_CHARS).join('') : finalText;
  const truncationNote = truncated
    ? `\n\n[...embedded copy truncated at ${MAX_EMBEDDED_REPORT_CHARS} of ${codePoints.length} characters. ` +
      'Your full final message was longer than this excerpt — reproduce your COMPLETE final ' +
      'message from your own last turn, not just the text shown above.]'
    : '';
  const messageFieldNote = truncated
    ? 'The "message" field should be your complete final message (the excerpt above plus ' +
      'everything after it), reproduced verbatim — do not summarize or re-render any of it.'
    : 'The "message" field should be exactly the text above, reproduced verbatim — do not ' +
      'summarize or re-render it.';

  return (
    'Your final text was not delivered. Call SendMessage now with EXACTLY this content, ' +
    `verbatim:\n\n${snippet}${truncationNote}\n\n${messageFieldNote} ${genericTail}`
  );
}

// State lives under this plugin's data dir, keyed by a hash of the resolved
// transcript path — never as a sidecar next to the transcript file itself,
// so nothing this module writes can ever land outside the data dir (see
// `lib/paths.js` and `test/uninstall.test.js`).
function statePathFor(transcriptPath) {
  const key = crypto.createHash('sha256').update(transcriptPath).digest('hex');
  return ensureSubPath('report-gate-state', `${key}.json`);
}

function writeStateSafe(p, obj) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup only */
    }
    return false;
  }
}

// Marker path for the `reportBlockedOnce` claim — same state dir as
// `statePath` (a sibling file, never a transcript sidecar).
function blockedOnceMarkerPathFor(statePath) {
  return `${statePath}.blocked-once`;
}

// Marker path for a specific stale-follow-up `key`'s claim — hashed (sha1
// is plenty here; this is a filename component, not a security boundary)
// since `key` can itself carry arbitrary characters (a transcript entry's
// own uuid/timestamp).
function staleMarkerPathFor(statePath, key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return `${statePath}.stale-${hash}`;
}

// Atomically claims a one-shot marker file: creates it with `wx` (fails
// with EEXIST if it already exists), so exactly one of any number of
// concurrent callers can ever win the create for a given marker path, with
// no read-then-write race window in between (the prior `readJsonSafe` ->
// `writeStateSafe` read-modify-write on the shared JSON state file had
// exactly that window: two concurrent `decide()` calls on the same
// transcript could both read the state before either wrote it back, and
// both would then block).
//
// Returns `true` only when THIS call newly created the marker (go ahead and
// block); `false` on EEXIST (another call — concurrent or a prior run —
// already claimed this exact marker; allow) or on any other error
// (unwritable dir, etc. — fail open, allow; never block on a claim that
// could not be durably recorded, since an unpersisted block could re-fire
// without bound).
function claimMarkerOnce(markerPath) {
  let fd;
  try {
    fd = fs.openSync(markerPath, 'wx');
  } catch {
    return false;
  }
  try {
    fs.writeSync(fd, String(Date.now()));
  } catch {
    /* best-effort content only — the marker's mere EXISTENCE, not its
       content, is what claims the one-shot slot */
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort close only */
    }
  }
  return true;
}

// Full evaluation for a SubagentStop firing. Returns null when this is not a
// team-mailbox participant (never block, never fire the post-report
// command). Otherwise returns:
//   { transcriptPath, agentId, gateResult, delivered, resolutionMethod }
// `gateResult` is `{ decision: 'block', reason }` or null (allow).
// `delivered` is true iff a well-formed SendMessage was found in range this
// turn — the signal `hooks/report-gate.js` uses to decide whether to fire
// the optional post-report command.
// `resolutionMethod` mirrors `resolveTeammateContext`'s own field (one of
// 'agent-transcript-path' / 'direct-sibling' / 'payload-identity-field' /
// 'payload-identity-path' / 'recency-heuristic') on every non-null return —
// privacy-minimal observability for `hooks/report-gate.js`'s invocation log;
// it never affects the decision itself.
function evaluate(payload, { now = Date.now() } = {}) {
  try {
    if (!payload || typeof payload !== 'object') return null;
    const resolved = resolveTeammateContext(payload, { now });
    if (!resolved) return null;

    const { transcriptPath, meta } = resolved;

    // Spawn-ledger discrimination — see spawn-ledger.js's header for the
    // three-valued verdict. Only a positively CONTRADICTED correlation
    // suppresses the gate (an explicit, deliberately synchronous dispatch);
    // `unknown` (including an absent `run_in_background` flag — the
    // harness's own default, which is background) defers to the
    // `taskKind` evidence `resolveTeammateContext` already established.
    // Run before reading this agent's own transcript so a definitively
    // non-background dispatch never pays that read at all.
    const spawn = classifyBackgroundSpawn(payload, meta, {
      agentId: resolved.agentId,
      subagentsDir: path.dirname(transcriptPath),
    });
    if (spawn.verdict === 'contradicted') {
      return {
        transcriptPath,
        agentId: resolved.agentId || null,
        gateResult: null,
        delivered: false,
        spawnVerdict: spawn.verdict,
        resolutionMethod: resolved.resolutionMethod,
      };
    }

    const entries = readTranscriptEntries(transcriptPath);
    if (!entries || !entries.length) {
      return {
        transcriptPath,
        agentId: resolved.agentId || null,
        gateResult: null,
        delivered: false,
        resolutionMethod: resolved.resolutionMethod,
      };
    }

    const statePath = statePathFor(transcriptPath);
    const state = readJsonSafe(statePath) || {};

    // A follow-up delivered after the latest report invalidates that
    // report — re-derived from the transcript every call (see
    // pending-followup.js's header for the peer-ack-loop safety this is
    // built to survive), but the BLOCK this triggers is bounded: at most
    // once per distinct follow-up, keyed by that follow-up's own identity
    // (`staleFollowupKey`), never once per SubagentStop firing. Without
    // this bound, the identical stale transcript would re-block on every
    // single SubagentStop for as long as the agent keeps stopping without
    // sending a fresh report — a wake-loop risk. A genuinely NEW, later
    // follow-up still blocks once more, since it necessarily carries a new
    // key — the loop stays bounded by external (human/peer) input, never by
    // this module re-triggering on its own output.
    const inboxReceipt = evaluatePendingFollowup(entries);
    if (inboxReceipt.status === 'pending-followup') {
      const key = staleFollowupKey(entries, inboxReceipt.latestActionableInboundIndex);
      // Back-compat: honor a pre-existing JSON field from before the
      // atomic-marker fix rolled out (an old state file already recording
      // this exact key as blocked) exactly as before.
      if (state.staleFollowupBlockedFor === key) {
        return {
          transcriptPath,
          agentId: resolved.agentId || null,
          gateResult: null,
          delivered: false,
          preFinalInbox: inboxReceipt,
          resolutionMethod: resolved.resolutionMethod,
        };
      }
      // Claim-before-block: the atomic `wx`-created marker is the sole
      // source of truth for "did THIS call win the race to block for this
      // key" — see claimMarkerOnce's own doc comment for why the prior
      // read-JSON-then-write-JSON approach allowed two concurrent calls to
      // both block.
      const claimedNew = claimMarkerOnce(staleMarkerPathFor(statePath, key));
      if (!claimedNew) {
        return {
          transcriptPath,
          agentId: resolved.agentId || null,
          gateResult: null,
          delivered: false,
          preFinalInbox: inboxReceipt,
          resolutionMethod: resolved.resolutionMethod,
        };
      }
      // Best-effort JSON mirror for human-readability/introspection only —
      // never re-read as the gating decision (the marker file above already
      // made that decision); a failure to write it never un-claims the
      // marker or changes the block decision already made.
      writeStateSafe(statePath, { ...state, staleFollowupBlockedFor: key });
      return {
        transcriptPath,
        agentId: resolved.agentId || null,
        gateResult: { decision: 'block', reason: STALE_REPORT_REASON },
        delivered: false,
        preFinalInbox: inboxReceipt,
        resolutionMethod: resolved.resolutionMethod,
      };
    }

    const boundary = lastReportableBoundary(entries);
    const delivered = wellFormedSendMessageInRange(entries, boundary);
    if (delivered) {
      return {
        transcriptPath,
        agentId: resolved.agentId || null,
        gateResult: null,
        delivered: true,
        resolutionMethod: resolved.resolutionMethod,
      };
    }

    // One-shot: block at most once per teammate transcript, so a genuinely
    // stuck agent is never trapped in an infinite block loop.
    // Back-compat: honor a pre-existing JSON field from before the
    // atomic-marker fix rolled out, exactly as before.
    if (state.reportBlockedOnce) {
      return {
        transcriptPath,
        agentId: resolved.agentId || null,
        gateResult: null,
        delivered: false,
        resolutionMethod: resolved.resolutionMethod,
      };
    }
    // Claim-before-block: same atomic `wx`-marker mechanism as the
    // stale-follow-up path above — see claimMarkerOnce's own doc comment.
    const claimedBlockOnce = claimMarkerOnce(blockedOnceMarkerPathFor(statePath));
    if (!claimedBlockOnce) {
      return {
        transcriptPath,
        agentId: resolved.agentId || null,
        gateResult: null,
        delivered: false,
        resolutionMethod: resolved.resolutionMethod,
      };
    }
    // Best-effort JSON mirror only — see the stale-follow-up path's own note.
    writeStateSafe(statePath, { ...state, reportBlockedOnce: true });

    const trustedForEmbed =
      EXACT_RESOLUTION_METHODS.has(resolved.resolutionMethod) ||
      (resolved.resolutionMethod === 'recency-heuristic' && resolved.candidateCount === 1);
    const finalText = trustedForEmbed ? lastAssistantText(entries) : null;
    return {
      transcriptPath,
      agentId: resolved.agentId || null,
      gateResult: { decision: 'block', reason: buildBlockReason(finalText) },
      delivered: false,
      resolutionMethod: resolved.resolutionMethod,
    };
  } catch {
    return null; // fail open, unconditionally
  }
}

// Back-compat / simple entry point used directly by tests: returns just the
// gate decision (`{ decision: 'block', reason }` or `null`).
function decide(payload, opts) {
  const result = evaluate(payload, opts);
  return result ? result.gateResult : null;
}

module.exports = {
  resolveTeammateContext,
  hasWellFormedSendMessage,
  wellFormedSendMessageInRange,
  lastUserBoundary,
  lastReportableBoundary,
  buildBlockReason,
  staleFollowupKey,
  STALE_REPORT_REASON,
  statePathFor,
  writeStateSafe,
  blockedOnceMarkerPathFor,
  staleMarkerPathFor,
  claimMarkerOnce,
  evaluate,
  decide,
  RECENCY_WINDOW_MS,
  AMBIGUITY_EPSILON_MS,
  MAX_EMBEDDED_REPORT_CHARS,
  EXACT_RESOLUTION_METHODS,
};
