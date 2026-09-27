'use strict';

/**
 * path-safety.js — shared "is this string safe to interpolate into a
 * filesystem path" rule, extracted so every module in this repo that turns
 * an external identifier (a `session_id`, an `agent_id`/`lane_id`, ...) into
 * a directory or file name component uses the exact same, once-reviewed
 * check rather than each maintaining its own copy.
 *
 * `lib/lane-dropbox.js` defined this rule first (for `sessionId`/`laneId`);
 * `lib/orphan-pointers.js` needs the identical guarantee for `sessionId`/
 * `agentId` (both hook-payload-derived, therefore attacker-influenceable —
 * e.g. a `session_id` of `../../etc` must never be allowed to walk a
 * pointer write or read outside this plugin's own data dir). Both modules
 * require this one file instead of each declaring their own version.
 */

const path = require('path');

// No slash/backslash, no dot-traversal, no control characters, no
// leading/trailing whitespace, no unbounded length. Deliberately does not
// throw — every caller treats an unsafe id as a caller-contract violation
// mapped to its own closed reason enum (e.g. 'invalid-args'/'unresolvable'),
// never a thrown exception, matching this repo's fail-open posture.
function isSafePathSegment(v) {
  return typeof v === 'string'
    && v === v.trim()
    && v.length > 0
    && v.length <= 240
    && v !== '.'
    && v !== '..'
    && /^[A-Za-z0-9_.:@-]+$/.test(v);
}

// True iff `candidatePath`, once resolved, is `rootDir` itself or strictly
// beneath it. A defense-in-depth containment check to run ALONGSIDE (never
// instead of) `isSafePathSegment` on every user-influenceable path segment:
// with every segment already validated safe, a path built by joining them
// under a known root cannot actually escape that root — this check exists
// so a future refactor that stops validating a segment, or that joins an
// already-resolved absolute path in by mistake, fails closed rather than
// silently writing outside the intended root.
function isPathContainedIn(candidatePath, rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

module.exports = { isSafePathSegment, isPathContainedIn };
