#!/usr/bin/env node
'use strict';

/**
 * hooks/report-gate.js — the `SubagentStop` hook entry point.
 *
 * Thin wrapper around `lib/report-gate.js`'s `evaluate()`. See that module's
 * header for the full mechanism, identity-resolution order, and what this
 * gate intentionally does not do.
 *
 * Also fires the optional `postReportCommand` (see
 * `lib/post-report-command.js`) exactly once per teammate transcript, the
 * first time a report is confirmed delivered — a complete no-op unless
 * explicitly configured.
 *
 * Invariants: always exits 0; communicates a block decision via the
 * `decision` field on stdout only. Every failure mode fails open.
 */

const path = require('path');
const { evaluate } = require('../lib/report-gate.js');
const { maybeRun } = require('../lib/post-report-command.js');
const { appendRotating } = require('../lib/log-rotation.js');
const { subPath } = require('../lib/paths.js');
const { readStdinSync } = require('../lib/read-stdin.js');

const INVOCATION_LOG_PATH = process.env.SUBAGENT_REPORT_GUARD_LOG_PATH || subPath('logs', 'report-gate-invocations.log');

function logInvocation(fields) {
  try {
    appendRotating(INVOCATION_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...fields }));
  } catch {
    /* best-effort only; must never affect the gate's decision */
  }
}

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
  const payload = readPayload();
  const result = payload ? evaluate(payload) : null;

  if (!result) {
    logInvocation({ outcome: 'not-team-mailbox-or-unresolvable' });
    process.exit(0);
    return;
  }

  if (result.delivered) {
    logInvocation({ outcome: 'delivered', agent_id: result.agentId });
    try {
      maybeRun(result.transcriptPath, { agentId: result.agentId || '' });
    } catch {
      /* never affects the gate's decision */
    }
    process.exit(0);
    return;
  }

  if (result.gateResult) {
    logInvocation({ outcome: 'block', agent_id: result.agentId });
    process.stdout.write(JSON.stringify(result.gateResult));
    process.exit(0);
    return;
  }

  logInvocation({ outcome: 'allow', agent_id: result.agentId });
  process.exit(0);
}

if (require.main === module) main();

module.exports = { main };
