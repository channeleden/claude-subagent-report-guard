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

// Privacy-minimal trace fields, present on EVERY log line regardless of
// outcome. Deliberately excludes anything that could carry message content
// (no `last_assistant_message`, no transcript text) and any full filesystem
// path (a resolved transcript path, if ever logged, is basename-level only)
// — this log exists so a "did the gate even fire" question (see README's
// install note on plugin hooks loading only at session start) can be
// answered from the log alone, without ever needing to open a real
// transcript.
//
// This trace was added after a real incident (2026-09-27) where the plugin's
// hooks had never loaded for a session (installed mid-session), and the only
// visible evidence — four `not-team-mailbox-or-unresolvable` log lines with
// no further detail — looked identical to a resolution failure. Those lines
// turned out to be unrelated manual empty-payload smoke runs. `reason` and
// this trace exist so the two cases are distinguishable from the log alone.
//
// `agent_id` prefers the raw payload field (present on every real
// SubagentStop firing observed live), falling back to `resolvedAgentId` —
// the value `evaluate()` itself resolved via the other identity-field
// candidates (`agentId`/`subagent_id`/`subagentId`) — only when the payload
// carried none of those under `agent_id` itself.
function traceFields(payload, resolvedAgentId) {
  const isObj = payload && typeof payload === 'object';
  const payloadKeys = isObj ? Object.keys(payload).sort() : [];
  const agentTranscriptPath = isObj && typeof payload.agent_transcript_path === 'string'
    ? payload.agent_transcript_path
    : null;
  return {
    hook_event_name: (isObj && payload.hook_event_name) || null,
    session_id: (isObj && payload.session_id) || null,
    agent_id: (isObj && payload.agent_id) || resolvedAgentId || null,
    agent_type: isObj ? (payload.agent_type ?? null) : null,
    payload_keys: payloadKeys,
    has_agent_transcript_path: Boolean(agentTranscriptPath),
  };
}

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
  const trace = traceFields(payload, result ? result.agentId : null);

  if (!result) {
    // 'no-payload' — stdin was empty or unparseable, so there was never a
    // payload to evaluate at all. 'not-team-mailbox' — a payload DID parse,
    // but `evaluate()` returned null (not a team-mailbox participant, or
    // genuinely unresolvable). These were previously indistinguishable
    // under one outcome string; see the note above `traceFields`.
    logInvocation({
      outcome: 'not-team-mailbox-or-unresolvable',
      reason: payload ? 'not-team-mailbox' : 'no-payload',
      ...trace,
    });
    process.exit(0);
    return;
  }

  if (result.delivered) {
    logInvocation({
      outcome: 'delivered',
      ...trace,
      resolutionMethod: result.resolutionMethod || null,
    });
    try {
      maybeRun(result.transcriptPath, { agentId: result.agentId || '' });
    } catch {
      /* never affects the gate's decision */
    }
    process.exit(0);
    return;
  }

  if (result.gateResult) {
    logInvocation({
      outcome: 'block',
      ...trace,
      resolutionMethod: result.resolutionMethod || null,
    });
    process.stdout.write(JSON.stringify(result.gateResult));
    process.exit(0);
    return;
  }

  logInvocation({
    outcome: 'allow',
    ...trace,
    resolutionMethod: result.resolutionMethod || null,
  });
  process.exit(0);
}

if (require.main === module) main();

module.exports = { main, traceFields };
