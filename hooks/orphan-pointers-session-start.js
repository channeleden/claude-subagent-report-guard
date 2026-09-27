#!/usr/bin/env node
'use strict';

/**
 * hooks/orphan-pointers-session-start.js — `SessionStart` hook, the
 * orphaned-report pointer mechanism's cross-session surfacing side. Lists
 * unclaimed, undelivered pointers left
 * behind by a PRIOR or dead session — the case the UserPromptSubmit hook
 * (same-session, still-live) cannot cover, because there is no "next
 * prompt" left in that old session to attach to. Each pointer is surfaced
 * at most once via this hook. Also opportunistically prunes pointers older
 * than 7 days. Never blocking.
 *
 * Fast no-op path: when this plugin has never written a pointer, returns
 * immediately without touching any transcript.
 */

const {
  hasAnyPointers,
  listAllPointers,
  isParentGone,
  wasDelivered,
  markClaimed,
  markSurfaced,
  isSurfaceMarked,
  formatPointerList,
  pointersRootDir,
  pruneOld,
  pointerIdentityConsistent,
} = require('../lib/orphan-pointers.js');
const { isSafePathSegment } = require('../lib/path-safety.js');
const { readStdinSync } = require('../lib/read-stdin.js');

// See lib/read-stdin.js for why this is not a direct fs.readFileSync call —
// a naive single-shot stdin read is reliable on macOS but can throw EAGAIN
// on Linux, which this catch would otherwise silently mistake for "no
// payload" (a real Linux-CI-only failure mode, not theoretical).
function readPayload() {
  try {
    const raw = readStdinSync().trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function main() {
  try {
    if (!hasAnyPointers()) return process.exit(0); // empty case: no transcript reads at all

    const payload = readPayload();
    const rawSessionId = (payload && payload.session_id) || null;
    // Same safe-path-segment rule the lane drop-box uses. `currentSessionId`
    // here is only ever compared for equality (never joined into a path),
    // but an unsafe value is still never trusted — falls back to null (no
    // cross-session comparison at all) rather than propagating a
    // traversal-shaped string any further.
    const currentSessionId = isSafePathSegment(rawSessionId) ? rawSessionId : null;

    pruneOld();

    const eligible = [];
    for (const entry of listAllPointers()) {
      if (entry.record.claimed) continue;
      // Corrupt (misattributed) pointer — never surface its bogus summary.
      // See lib/orphan-pointers.js's `pointerIdentityConsistent` doc
      // comment for the real, observed corruption shape this backstops.
      if (!pointerIdentityConsistent(entry.record, entry.agentId)) continue;
      // Computed once and threaded into `isParentGone` below (it needs the
      // same delivery evidence) rather than recomputed — `wasDelivered`
      // does a bounded tail-read of the parent transcript, and doing it
      // twice per pointer on every SessionStart was pure waste.
      const deliveryResult = wasDelivered(entry.record);
      if (deliveryResult.delivered) {
        markClaimed(entry);
        continue;
      }
      if (isSurfaceMarked(entry, 'sessionStart')) continue;
      if (!isParentGone(entry, { currentSessionId, deliveryResult })) continue; // still within this same live session — leave it to UserPromptSubmit
      eligible.push(entry);
    }
    if (!eligible.length) return process.exit(0);

    // `markSurfaced` returns true only for the entries THIS process actually
    // claimed (wins an atomic wx-created marker file) — a concurrent
    // SessionStart/UserPromptSubmit hook racing on the same pointer loses
    // the claim and is filtered out here, so the same pointer is never
    // surfaced twice.
    const claimed = eligible.filter((entry) => markSurfaced(entry, 'sessionStart'));
    if (!claimed.length) return process.exit(0);

    const additionalContext =
      `${claimed.length} subagent report${claimed.length === 1 ? '' : 's'} from a prior session may not have been ` +
      `delivered (normal delivery could not be confirmed and the dispatching session is gone):\n` +
      formatPointerList(claimed, pointersRootDir());

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    }));
  } catch {
    /* fail open, unconditionally */
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { main };
