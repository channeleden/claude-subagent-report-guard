#!/usr/bin/env node
'use strict';

/**
 * hooks/orphan-pointers-user-prompt-submit.js — `UserPromptSubmit` hook,
 * the orphaned-report pointer mechanism's within-session surfacing side.
 * For the CURRENT session, surfaces any pointer whose subagent finished
 * but whose normal delivery cannot be confirmed from transcript evidence
 * after a grace period. Each pointer is
 * surfaced at most once via this hook (a persisted flag, not a re-check
 * every prompt). Never blocking — outputs additionalContext or nothing.
 *
 * Fast no-op path: when this plugin has never written a pointer, returns
 * immediately without touching any transcript.
 *
 * DELIVERY-RACE FIX: delivering a background-agent task-notification (or a
 * team-mailbox agent/teammate message) to the parent IS ITSELF the prompt
 * that fires this hook — the harness has not yet appended that delivery
 * entry to the transcript by the time this process runs, so a
 * transcript-only check would still see "no evidence" and wrongly report an
 * undelivered result at the exact moment it is being delivered. This hook
 * therefore checks its own raw `prompt` payload text for that delivery
 * FIRST (`claimPointersDeliveredByPrompt`), then applies a grace period
 * before ever surfacing what's left (`isEligibleForUserPromptSubmitSurfacing`)
 * — see lib/orphan-pointers.js's "SURFACING POLICY" section for the full
 * rationale.
 */

const path = require('path');
const {
  hasAnyPointers,
  reconcileAndFilter,
  markSurfaced,
  formatPointerList,
  pointersRootDir,
  claimPointersDeliveredByPrompt,
  isEligibleForUserPromptSubmitSurfacing,
} = require('../lib/orphan-pointers.js');
const { subagentSessionDir } = require('../lib/subagent-transcript.js');
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

function sessionIdFromPayload(payload) {
  if (payload && typeof payload.session_id === 'string' && payload.session_id) return payload.session_id;
  if (payload && typeof payload.transcript_path === 'string') {
    const base = path.basename(subagentSessionDir(payload.transcript_path) || '');
    if (base) return base;
    // A top-level transcript path for the lead session itself has no
    // `subagents/` marker to strip past — its own basename minus `.jsonl`
    // IS the session id.
    const b2 = path.basename(payload.transcript_path, '.jsonl');
    if (b2) return b2;
  }
  return null;
}

function main() {
  try {
    if (!hasAnyPointers()) return process.exit(0); // empty case: no transcript reads at all

    const payload = readPayload();
    const sessionId = sessionIdFromPayload(payload);
    // Same safe-path-segment rule the lane drop-box uses — a session_id of
    // e.g. "../../etc" must never reach a pointer-dir read. Fail open
    // (no-op), never throw or attempt the read.
    if (!sessionId || !isSafePathSegment(sessionId)) return process.exit(0);

    const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : '';
    // The task-notification / agent-message delivering a pointer's result
    // can BE this very prompt (see the file header's "DELIVERY-RACE FIX") —
    // claim straight from its raw text before any surfacing decision below,
    // so it is never mistaken for undelivered.
    claimPointersDeliveredByPrompt(sessionId, prompt);

    const now = Date.now();
    const reconciled = reconcileAndFilter(sessionId, 'userPromptSubmit', { now });
    const eligible = reconciled.filter((entry) => isEligibleForUserPromptSubmitSurfacing(entry, { now }));
    if (!eligible.length) return process.exit(0);

    // `markSurfaced` returns true only for the entries THIS process actually
    // claimed (wins an atomic wx-created marker file) — a concurrent
    // SessionStart/UserPromptSubmit hook racing on the same pointer loses
    // the claim and is filtered out here, so the same pointer is never
    // surfaced twice.
    const claimed = eligible.filter((entry) => markSurfaced(entry, 'userPromptSubmit'));
    if (!claimed.length) return process.exit(0);

    const additionalContext =
      `${claimed.length} subagent report${claimed.length === 1 ? '' : 's'} from this session may not have reached you ` +
      `(normal delivery could not be confirmed):\n${formatPointerList(claimed, pointersRootDir())}`;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
    }));
  } catch {
    /* fail open, unconditionally */
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { main, sessionIdFromPayload };
