#!/usr/bin/env node
'use strict';

/**
 * SubagentStop hook — lane-dropbox-checkpoint.js
 *
 * Non-blocking checkpoint writer for the lane drop-box mechanism (see
 * ../README.md for the full picture). Extracts a stopping lane's
 * newly-appeared transcript content and appends one `checkpoint` record
 * (report text + lane-accountability fields) to that lane's own
 * `~/.claude/teams/<session_id>/dropbox/<lane_id>.jsonl`.
 *
 * Identity resolution is entirely delegated to `resolveTeammateContext`
 * (`../lib/report-gate-identity.js`) — the 3-step resolution
 * (direct-sibling meta.json lookup -> explicit agent_id field -> bounded
 * recency heuristic) documented in that module's own header. Requiring it
 * here creates zero coupling to any other hook's own registration state — a
 * plain CommonJS require never executes `main()` (guarded by
 * `require.main === module`).
 *
 * `lane_id` derivation: `resolved.agentName || resolved.meta?.name` — the
 * top-level `agentName` field is present only on the candidate-resolution
 * paths (payload-identity-field, recency-heuristic); the direct-sibling
 * path's return shape has no top-level `agentName` at all, so falls back to
 * the meta.json content field `.name`.
 *
 * Invariants (this hook only, matching the rest of this hooks/ dir):
 *  - ALWAYS exits 0. Never writes a `{decision: ...}` field to stdout — this
 *    hook has nothing to gate; silence on stdout is correct here, not an
 *    oversight (unlike the blocking `legacy-gate/hook.js`, which this hook
 *    does not replace or interact with beyond reusing the same identity
 *    resolution logic).
 *  - Every failure mode fails open — this hook must never be the reason a
 *    legitimate subagent turn cannot end. All of `checkpoint()`'s own
 *    internal failure handling (locking, offset tracking, transcript reads)
 *    lives in `lane-dropbox.js`, not here — this file's own logic stops
 *    once `checkpoint()` is called; the hook ignores the exact shape of its
 *    return value beyond best-effort logging.
 *  - This file imports ONLY `resolveTeammateContext` (identity) and
 *    `checkpoint` (the writer) — it never imports `readTranscriptFromOffset`
 *    / `lastAssistantText` from `subagent-transcript.js` directly; that
 *    module is required exclusively inside `lane-dropbox.js`. This hook only
 *    ever passes `resolved.transcriptPath` (a string) into `checkpoint()` —
 *    it never reads transcript content itself.
 */

const fs = require('fs');

const { resolveTeammateContext } = require('../lib/report-gate-identity.js');
const { checkpoint } = require('../lib/lane-dropbox.js');

function readPayload() {
  try {
    const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Extraction precedence — try the top-level (candidate-path) field first
// (present only on steps 2/3 of resolveTeammateContext), then fall back to
// the meta-content field for step 1 (the primary, direct-sibling path,
// where no top-level field exists). Returns null (never guesses) when
// neither yields a non-empty string.
function deriveLaneId(resolved) {
  const candidate = resolved.agentName || (resolved.meta && resolved.meta.name);
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

function main() {
  const payload = readPayload();
  if (!payload) process.exit(0); // missing/unparseable stdin — fail open

  const resolved = resolveTeammateContext(payload);
  if (!resolved) process.exit(0); // not a team-mailbox lane — expected common case

  const laneId = deriveLaneId(resolved);
  if (!laneId) process.exit(0); // cannot derive a stable lane_id — fail open, never guess

  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !sessionId) process.exit(0); // never guess a session directory

  try {
    checkpoint({
      transcriptPath: resolved.transcriptPath,
      sessionId,
      laneId,
      resolutionMethod: resolved.resolutionMethod,
    });
  } catch {
    /* checkpoint() itself never throws by contract, but this hook must never
       be the reason a subagent turn cannot end regardless */
  }

  process.exit(0);
}

if (require.main === module) main();

module.exports = { readPayload, deriveLaneId, main };
