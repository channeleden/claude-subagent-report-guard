#!/usr/bin/env node
'use strict';

/**
 * PostToolUse hook — lane-dropbox-heartbeat.js
 *
 * Supplementary, throttled (>=60s) write-only liveness heartbeat for the
 * lane drop-box mechanism (see ../README.md for the full picture). Exists
 * alongside the `SubagentStop` checkpoint hook (`lane-dropbox-checkpoint.js`)
 * because turns-since-last-stop cannot distinguish a long-running live turn
 * from a dead lane — this hook's `heartbeat_at` gives a future watchdog
 * consumer a wall-clock-time-since-last-touch signal instead.
 *
 * Same identity-resolution reuse as the checkpoint hook (`resolveTeammateContext`
 * from `../lib/report-gate-identity.js`) and the same hook-layer/export-internal
 * split — this file's own logic stops once `touch()` is called.
 *
 * HEARTBEAT RESOLUTION RULE (live-verification-driven revision). A real live
 * multi-lane dispatch proved `resolveTeammateContext`'s `recency-heuristic`
 * path is UNSAFE to trust as-is for `PostToolUse`: it picks the single
 * most-recently-touched team-mailbox candidate SESSION-WIDE, with no way to
 * confirm that candidate is the one whose OWN tool call triggered THIS
 * firing. Live testing showed unrelated tool calls (a different lane's own
 * follow-up work) getting silently misattributed to a lane that had already
 * stopped seconds earlier, because that lane's transcript remained the
 * freshest candidate within the (10-minute) `RECENCY_WINDOW_MS` used inside
 * `resolveTeammateContext` itself. `SubagentStop` (the checkpoint hook) does
 * not share this exposure to the same degree — it fires once, at each
 * lane's own natural end-of-turn moment, when that lane's own file is very
 * likely freshest right then; `PostToolUse` fires continuously, for every
 * tool call, from every participant, all session long.
 *
 * The fix, applied ONLY to `recency-heuristic` results (direct-sibling and
 * payload-identity-field are exact matches — unaffected, still trusted
 * as-is): re-verify the winning candidate independently, against a MUCH
 * tighter bound than the 10-minute window `resolveTeammateContext` itself
 * used. Accept it only if BOTH hold:
 *   (i)  its transcript mtime is within `RECENCY_EPSILON_MS` (500ms) of the
 *        firing's own `now` timestamp, AND
 *   (ii) it is the SOLE team-mailbox candidate within that same epsilon.
 * Two or more candidates within epsilon, or zero, means the firing is
 * genuinely ambiguous — resolve to a no-op (exit 0, no touch() call), never
 * a best-effort guess. Rationale, stated once here because it governs the
 * whole design: **the asymmetry is absolute.** A skipped heartbeat is
 * harmless — checkpoint records are the accountability floor; heartbeat is
 * supplementary liveness, not the sole signal. A wrong-lane heartbeat
 * poisons a watchdog consumer into trusting a dead lane's freshness based on
 * a DIFFERENT lane's activity. Refuse to guess, always.
 *
 * HARD CONSTRAINT, not a suggestion: this file — and `touch()` itself, in
 * `lane-dropbox.js` — may NEVER call `readTranscriptEntries`,
 * `readTranscriptFromOffset`, or `lastAssistantText`, and may NEVER shell
 * out to `git`. This hook imports `subagentSessionDir`/
 * `listTeammateMetaCandidates` from `subagent-transcript.js` for the epsilon
 * re-verification above — this is NOT a violation of the constraint: those
 * two functions only list sibling `meta.json` files and `fs.statSync` their
 * transcript paths (the exact same bounded, cheap operations
 * `resolveTeammateContext`'s own step 3 already performs internally) —
 * neither reads transcript CONTENT, and neither is one of the three
 * explicitly forbidden functions. Every operation on this path remains a
 * stat/read/append of small, bounded local files plus one `withLock`
 * acquire/release pair tuned to fail fast on contention (`retries: 0`) — a
 * tight time budget depends on this hook never touching a potentially-large
 * `.jsonl` transcript's CONTENT or spawning a subprocess, not on avoiding
 * this module entirely. The epsilon re-verification roughly doubles the
 * identity-resolution cost on the `recency-heuristic` path (it repeats an
 * equivalent candidate scan) — worth re-measuring if you tune the epsilon.
 *
 * LIVE-WIRING NOTE: `payload.session_id` presence, `PostToolUse` firing for
 * subagent tool calls, and `resolveTeammateContext`'s resolution (gated by
 * the epsilon rule above) were all independently confirmed against a REAL
 * live multi-lane `PostToolUse` payload with GENUINELY CONCURRENT active
 * lanes before this hook shipped — sequential-only testing is not
 * sufficient on its own; correct attribution AND refuse-on-ambiguity had to
 * be proven under real concurrency. If you modify the identity-resolution
 * logic this hook depends on, re-verify against a real live payload before
 * trusting the change — unit tests against synthetic fixtures alone missed
 * the exact misattribution this rule exists to close (see above).
 *
 * Invariants: ALWAYS exits 0. Never writes a `{decision: ...}` field to
 * stdout. Every failure mode fails open.
 */

const fs = require('fs');
const path = require('path');

const { resolveTeammateContext } = require('../lib/report-gate-identity.js');
const { touch } = require('../lib/lane-dropbox.js');
const {
  subagentSessionDir,
  listTeammateMetaCandidates,
} = require('../lib/subagent-transcript.js');

// Deliberately much tighter than resolveTeammateContext's own 10-minute
// RECENCY_WINDOW_MS — this is a re-verification bound, not a resolution
// window.
const RECENCY_EPSILON_MS = 500;

function readPayload() {
  try {
    const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Same precedence rule as the checkpoint hook — kept as an
// independent copy rather than a shared import, matching how small each hook
// file's own logic is meant to stay (both hooks' entire own-file logic is a
// few lines; a shared helper module for one four-line function would be more
// indirection than the duplication it removes).
function deriveLaneId(resolved) {
  const candidate = resolved.agentName || (resolved.meta && resolved.meta.name);
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

// Epsilon + sole-candidate re-verification (see file header). Never
// re-implements resolveTeammateContext's own selection logic — only
// re-checks whether ITS ALREADY-CHOSEN winner survives a much tighter,
// independent bound. Returns false (refuse) on any error, missing session
// dir, or ambiguous/stale candidate set — never throws, never guesses.
function recencyResolutionIsSafe(resolved, payload, now) {
  try {
    const sessionDir = subagentSessionDir(payload && payload.transcript_path);
    if (!sessionDir) return false;
    const candidates = listTeammateMetaCandidates(path.join(sessionDir, 'subagents'));
    let withinEpsilonCount = 0;
    let winnerIsWithinEpsilon = false;
    for (const c of candidates) {
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(c.transcriptPath).mtimeMs;
      } catch {
        continue; // vanished/unreadable — not a candidate, matches resolveTeammateContext's own posture
      }
      if (Math.abs(now - mtimeMs) > RECENCY_EPSILON_MS) continue;
      withinEpsilonCount += 1;
      if (c.transcriptPath === resolved.transcriptPath) winnerIsWithinEpsilon = true;
    }
    // Exactly one candidate within epsilon, and it must be the SAME one
    // resolveTeammateContext already chose (it always will be, since
    // anything within a 500ms epsilon is trivially "more recent" than
    // anything outside it — asserted explicitly rather than trusted blindly).
    return withinEpsilonCount === 1 && winnerIsWithinEpsilon;
  } catch {
    return false;
  }
}

function main() {
  const now = Date.now();
  const payload = readPayload();
  if (!payload) process.exit(0); // missing/unparseable stdin — fail open

  const resolved = resolveTeammateContext(payload, { now });
  if (!resolved) process.exit(0); // the expected common case for main's own PostToolUse firings

  // recency-heuristic results MUST survive the tighter epsilon +
  // sole-candidate re-check before being trusted. direct-sibling and
  // payload-identity-field are exact matches — unaffected, unchanged.
  if (resolved.resolutionMethod === 'recency-heuristic' && !recencyResolutionIsSafe(resolved, payload, now)) {
    process.exit(0); // ambiguous or stale — refuse to guess, no-op
  }

  const laneId = deriveLaneId(resolved);
  if (!laneId) process.exit(0); // cannot derive a stable lane_id — fail open, never guess

  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !sessionId) process.exit(0); // never guess a session directory

  try {
    touch({ sessionId, laneId, resolutionMethod: resolved.resolutionMethod });
  } catch {
    /* touch() itself never throws by contract, but this hook must never be
       the reason a tool call cannot complete regardless */
  }

  process.exit(0);
}

if (require.main === module) main();

module.exports = { readPayload, deriveLaneId, recencyResolutionIsSafe, main, RECENCY_EPSILON_MS };
