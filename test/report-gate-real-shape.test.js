'use strict';

// Real-shape regression coverage for hooks/report-gate.js + lib/report-gate.js,
// built from the ACTUAL live meta.json + transcript.jsonl shapes observed on
// 2026-09-27 during the `gate-live-test` incident (see README's "Plugin
// hooks load at session START" note and CHANGELOG's Unreleased entry).
//
// The fixtures under test/fixtures/real-shape-2026-09-27/ are SANITIZED: all
// system-prompt text, real home paths, emails, and session ids were stripped
// and replaced with generic placeholders before being committed to this
// public repo (verified by `node scripts/hygiene-check.js`, run as part of
// this test file's own coverage in report-gate.test.js's "source guard" and
// this repo's CI). Only the entry TYPES, ORDER, and the identity-relevant
// fields (isSidechain/agentId/parentUuid/uuid/timestamp, the taskKind
// sidecar field, the final assistant text + stop_reason) are preserved
// faithfully.
//
// Every test here isolates its own data dir via SUBAGENT_REPORT_GUARD_DATA_DIR
// (see lib/paths.js' NODE_TEST_CONTEXT guard) and writes fixture-derived
// session/subagent trees only under a fresh os.tmpdir() prefix — never into
// the real HOME.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'report-gate.js');
const { evaluate } = require('../lib/report-gate.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'real-shape-2026-09-27');
const AGENT_ID = 'agate-live-test-2af58222c03b1047'; // real, non-sensitive id — see agent.meta.json
const PLAIN_AGENT_ID = 'a0123456789abcdef0'; // unnamed-lane shape: agent-a<17 hex>.jsonl

function readFixtureLines(name) {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function readFixtureJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function sendMessageEntry({ to = 'main', message = 'gate-live-test report: done' } = {}) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input: { to, message } }] },
  };
}

// Builds a fresh <tmp>/<sessionId>.jsonl (lead, empty) + <tmp>/<sessionId>/
// subagents/agent-<agentId>.{jsonl,meta.json} tree from the real-shape
// fixtures, mirroring the live directory layout resolveTeammateContext
// resolves against.
function mkRealShapeSession({ extraLines = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-gate-real-shape-'));
  const sessionId = 'session-00000000';
  const leadTranscriptPath = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(leadTranscriptPath, '', 'utf8');
  const subagentsDir = path.join(root, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });

  const transcriptPath = path.join(subagentsDir, `agent-${AGENT_ID}.jsonl`);
  const metaPath = path.join(subagentsDir, `agent-${AGENT_ID}.meta.json`);
  const lines = [...readFixtureLines('agent-transcript.jsonl'), ...extraLines];
  fs.writeFileSync(transcriptPath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify(readFixtureJson('agent.meta.json')), 'utf8');

  return { root, sessionId, leadTranscriptPath, subagentsDir, transcriptPath, metaPath };
}

function mkPlainSubagentSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-gate-real-shape-plain-'));
  const sessionId = 'session-00000000';
  const leadTranscriptPath = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(leadTranscriptPath, '', 'utf8');
  const subagentsDir = path.join(root, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });

  const transcriptPath = path.join(subagentsDir, `agent-${PLAIN_AGENT_ID}.jsonl`);
  const metaPath = path.join(subagentsDir, `agent-${PLAIN_AGENT_ID}.meta.json`);
  fs.writeFileSync(transcriptPath, fs.readFileSync(path.join(FIXTURE_DIR, 'plain-agent-transcript.jsonl'), 'utf8'));
  fs.writeFileSync(metaPath, JSON.stringify(readFixtureJson('plain-agent.meta.json')), 'utf8');

  return { root, sessionId, leadTranscriptPath, subagentsDir, transcriptPath, metaPath };
}

let dataDirCounter = 0;
function mkDataDir() {
  dataDirCounter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `report-gate-real-shape-data-${dataDirCounter}-`));
}

function withDataDir(fn) {
  const dataDir = mkDataDir();
  const prevOverride = process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    return fn(dataDir);
  } finally {
    if (prevOverride === undefined) delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
    else process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = prevOverride;
  }
}

function runHook(payload, { dataDir, logPath } = {}) {
  const env = { ...process.env, SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir || mkDataDir() };
  if (logPath) env.SUBAGENT_REPORT_GUARD_LOG_PATH = logPath;
  return execFileSync(process.execPath, [HOOK], {
    input: payload === null ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
}

function readLogLines(logPath) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// The real payload key set observed live for a teammate SubagentStop firing
// (per the orchestrator's root-cause writeup) — everything except the two
// deliberately varied per test: agent_transcript_path (present/absent) and
// last_assistant_message (mirrors the fixture's own final text).
function realShapePayload({ transcriptPath, agentTranscriptPath, leadTranscriptPath }) {
  return {
    agent_id: AGENT_ID,
    agent_transcript_path: agentTranscriptPath === undefined ? transcriptPath : agentTranscriptPath,
    agent_type: null,
    background_tasks: [],
    cwd: '/workspace/project',
    effort: 'low',
    hook_event_name: 'SubagentStop',
    last_assistant_message: 'gate test done',
    permission_mode: 'bypassPermissions',
    prompt_id: 'prompt-0000',
    scratchpad_dir: '/workspace/scratchpad',
    session_crons: [],
    session_id: 'session-00000000',
    stop_hook_active: false,
    transcript_path: leadTranscriptPath,
  };
}

// ── (a) first SubagentStop on the real shape → block, embeds "gate test done" ──

test('real-shape: first SubagentStop on the live gate-live-test shape blocks and embeds "gate test done" verbatim', () => {
  withDataDir(() => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession();
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });
    const result = evaluate(payload);
    assert.ok(result);
    assert.equal(result.delivered, false);
    assert.ok(result.gateResult);
    assert.equal(result.gateResult.decision, 'block');
    assert.match(result.gateResult.reason, /gate test done/);
    assert.equal(result.resolutionMethod, 'agent-transcript-path');
  });
});

// ── (b) second stop on the same transcript → allow (one-shot) ──────────────

test('real-shape: a second SubagentStop on the identical unchanged transcript allows (one-shot, no wake-loop)', () => {
  withDataDir((dataDir) => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession();
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });

    const first = evaluate(payload);
    assert.equal(first.gateResult.decision, 'block');

    const second = evaluate(payload);
    assert.equal(second.gateResult, null, 'the same stale transcript must not re-block on its own');
    void dataDir;
  });
});

// ── (c) same shape + a well-formed SendMessage appended → delivered, no block ──

test('real-shape: appending a well-formed SendMessage tool_use to the real shape resolves to delivered, never a block', () => {
  withDataDir(() => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession({ extraLines: [sendMessageEntry()] });
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });
    const result = evaluate(payload);
    assert.ok(result);
    assert.equal(result.delivered, true);
    assert.equal(result.gateResult, null);
    assert.equal(result.resolutionMethod, 'agent-transcript-path');
  });
});

// ── (d) plain subagent (no taskKind, unnamed transcript file) → never gated ──

test('real-shape: a plain Task-tool subagent (no taskKind, unnamed agent-a<hash>.jsonl) is never gated', () => {
  withDataDir(() => {
    const { transcriptPath } = mkPlainSubagentSession();
    // A plain subagent's own transcript_path DOES point directly at its own
    // file (no agent_transcript_path at all — that field is a team-mailbox-
    // only harness behavior per lib/report-gate.js's header).
    const result = evaluate({
      hook_event_name: 'SubagentStop',
      session_id: 'session-00000000',
      agent_id: PLAIN_AGENT_ID,
      agent_type: 'general-purpose',
      transcript_path: transcriptPath,
      last_assistant_message: 'Plain subagent final report body — never delivered via SendMessage, and correctly never gated.',
    });
    assert.equal(result, null, 'a plain subagent must resolve to null — never blocked, never logged as resolved');
  });
});

// ── (e) payload WITHOUT agent_transcript_path still resolves via payload-identity-field ──

test('real-shape: payload without agent_transcript_path (only transcript_path + agent_id) still resolves the teammate and blocks', () => {
  withDataDir(() => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession();
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath, agentTranscriptPath: null });
    delete payload.agent_transcript_path;
    assert.equal('agent_transcript_path' in payload, false);

    const result = evaluate(payload);
    assert.ok(result);
    assert.equal(result.resolutionMethod, 'payload-identity-field');
    assert.equal(result.gateResult.decision, 'block');
    assert.match(result.gateResult.reason, /gate test done/);
  });
});

// ── (f) end-to-end: spawn hooks/report-gate.js as a real child process ─────

test('real-shape E2E: spawning hooks/report-gate.js with the real payload on stdin blocks, and the log line never leaks message content', () => {
  const { transcriptPath, leadTranscriptPath } = mkRealShapeSession();
  const payload = realShapePayload({ transcriptPath, leadTranscriptPath });
  const dataDir = mkDataDir();
  const logPath = path.join(mkDataDir(), 'invocations.log');

  const stdout = runHook(payload, { dataDir, logPath });
  assert.notEqual(stdout.trim(), '');
  const decision = JSON.parse(stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /gate test done/);

  const [line] = readLogLines(logPath);
  assert.ok(line, 'exactly one invocation log line must have been written');
  assert.equal(line.outcome, 'block');
  assert.equal(line.reason, undefined, '"reason" is only set on the unresolved not-team-mailbox-or-unresolvable outcome');
  assert.equal(line.resolutionMethod, 'agent-transcript-path');
  assert.equal(line.hook_event_name, 'SubagentStop');
  assert.equal(line.session_id, 'session-00000000');
  assert.equal(line.agent_id, AGENT_ID);
  assert.equal(line.agent_type, null);
  assert.deepEqual(
    line.payload_keys,
    Object.keys(payload).sort(),
  );
  assert.equal(line.has_agent_transcript_path, true);

  const rawLine = fs.readFileSync(logPath, 'utf8');
  assert.doesNotMatch(rawLine, /gate test done/, 'the log line must never contain the embedded report text');
  assert.doesNotMatch(rawLine, new RegExp(payload.last_assistant_message), 'the log line must never contain last_assistant_message');
});
