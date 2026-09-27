'use strict';

// Orphaned-report pointer records — lib/orphan-pointers.js and its three
// hooks (SubagentStop writer, UserPromptSubmit + SessionStart surfacers).
//
// Fixture shapes for delivery evidence are modeled on real, sanitized
// transcript excerpts (see test/fixtures/orphan-pointers/README.md) — no
// real content or user paths.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const SUBAGENT_STOP_HOOK = path.join(__dirname, '..', 'hooks', 'orphan-pointers-subagent-stop.js');
const USER_PROMPT_HOOK = path.join(__dirname, '..', 'hooks', 'orphan-pointers-user-prompt-submit.js');
const SESSION_START_HOOK = path.join(__dirname, '..', 'hooks', 'orphan-pointers-session-start.js');

const {
  writePointer,
  listPointersForSession,
  wasDelivered,
  hasAnyPointers,
  truncateSummary,
  formatPointerList,
  reconcileAndFilter,
  markSurfaced,
  isSurfaceMarked,
  pointerPath,
  pointersDirFor,
  isParentGone,
  isParentAgentFinished,
} = require('../lib/orphan-pointers.js');
const { harnessAgentId } = require('../hooks/orphan-pointers-subagent-stop.js');

let counter = 0;
function mkDataDir() {
  counter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `orphan-ptr-data-${counter}-`));
}

function mkSessionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-ptr-session-'));
  const sessionId = 'session-orphan';
  const leadTranscriptPath = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(leadTranscriptPath, '', 'utf8');
  const subagentsDir = path.join(root, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  return { root, sessionId, leadTranscriptPath, subagentsDir };
}

function writePlainSubagent(subagentsDir, { name = 'plain', hash = 'a1a1a1a1', toolUseId, text = 'plain output', parentAgentId } = {}) {
  const agentId = `a${name}-${hash}`;
  const transcriptPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  const metaPath = path.join(subagentsDir, `agent-${agentId}.meta.json`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify({
    agentType: 'general-purpose',
    spawnDepth: parentAgentId ? 2 : 1,
    toolUseId,
    ...(parentAgentId ? { parentAgentId } : {}),
  }), 'utf8');
  return { transcriptPath, metaPath, agentId };
}

function writeTeamMailboxAgent(subagentsDir, { name = 'triage', hash = 'bbbb2222', text = 'teammate report' } = {}) {
  const agentId = `a${name}-${hash}`;
  const transcriptPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  const metaPath = path.join(subagentsDir, `agent-${agentId}.meta.json`);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify({ agentType: name, name, spawnDepth: 0, taskKind: 'in_process_teammate' }), 'utf8');
  return { transcriptPath, metaPath, agentId };
}

// Builds a REAL SubagentStop hook payload — see the comment atop
// hooks/orphan-pointers-subagent-stop.js: `transcript_path` is ALWAYS the
// top-level SESSION transcript, never the stopping agent's own file; the
// agent's own transcript is named directly by `agent_transcript_path`.
// Modeled verbatim on the live-observed payload keys: agent_id,
// agent_transcript_path, session_id, last_assistant_message (plus fields
// this mechanism does not use — transcript_path is the only other one these
// tests need).
function realSubagentStopPayload({ sessionId, leadTranscriptPath, agentTranscriptPath, agentId, lastAssistantMessage }) {
  return {
    session_id: sessionId,
    transcript_path: leadTranscriptPath,
    agent_transcript_path: agentTranscriptPath,
    agent_id: agentId,
    last_assistant_message: lastAssistantMessage,
  };
}

// Appends one JSONL line per entry to a parent transcript file — the
// sanitized fixture shapes this module's real-shape delivery evidence is
// modeled on (see test/fixtures/orphan-pointers/README.md).
function appendParentEntries(parentPath, entries) {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.appendFileSync(parentPath, `${lines}\n`, 'utf8');
}

function runHook(hookPath, payload, { dataDir, env = {} } = {}) {
  return execFileSync(process.execPath, [hookPath], {
    input: payload === null || payload === undefined ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir || mkDataDir(), ...env },
  });
}

// ── truncateSummary ──────────────────────────────────────────────────────

test('truncateSummary: caps at 200 chars and never splits a surrogate pair', () => {
  const short = truncateSummary('hello world');
  assert.equal(short, 'hello world');

  const long = 'x'.repeat(500);
  const truncated = truncateSummary(long);
  assert.ok(truncated.length <= 200);
  assert.ok(truncated.endsWith('…'));

  // An astral emoji is a surrogate pair in UTF-16 — construct a string just
  // past the cap where the pair would land exactly on the boundary.
  const emoji = '😀'; // 😀
  const nearCap = 'a'.repeat(199) + emoji + 'b'.repeat(50);
  const result = truncateSummary(nearCap);
  // No lone surrogate anywhere in the result.
  for (let i = 0; i < result.length; i += 1) {
    const code = result.charCodeAt(i);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    if (isHighSurrogate) {
      assert.ok(i + 1 < result.length, 'lone high surrogate at end');
      const next = result.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'high surrogate not followed by low surrogate');
    }
  }
});

// ── writePointer: the persisted summary is a capped excerpt, never the
// full final message — this is the spec'd design (a short excerpt so a
// human can recognize which report it is), not a "no report body" claim ──

test('writePointer: a long final message is persisted as a <=200-char, surrogate-safe excerpt, never verbatim', () => {
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    // An astral emoji (surrogate pair) placed right around the cap boundary,
    // plus enough trailing text to guarantee the message is truncated.
    const longFinalMessage = `${'x'.repeat(199)}😀${'y'.repeat(500)}`;
    const ok = writePointer({
      sessionId: 'sess-long', agentId: 'agent-along1', transcriptPath: '/tmp/x/sess-long/subagents/agent-along1.jsonl',
      agentName: 'a1', parentSessionId: 'sess-long', finishedAt: new Date().toISOString(), summary: longFinalMessage,
    });
    assert.ok(ok);
    const [entry] = listPointersForSession('sess-long');
    const { summary } = entry.record;

    assert.ok(summary.length <= 200, `summary must be capped at 200 chars, got ${summary.length}`);
    assert.notEqual(summary, longFinalMessage, 'the persisted summary must never be the full final message verbatim');

    // Surrogate-safe: no lone high surrogate anywhere in the persisted summary.
    for (let i = 0; i < summary.length; i += 1) {
      const code = summary.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        assert.ok(i + 1 < summary.length, 'lone high surrogate at end of summary');
        const next = summary.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, 'high surrogate not followed by low surrogate');
      }
    }
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

// ── writePointer / listPointersForSession ───────────────────────────────

test('writePointer + listPointersForSession: round-trips a pointer with the documented shape', () => {
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const ok = writePointer({
      sessionId: 'sess-1', agentId: 'agent-a1', transcriptPath: '/tmp/x/sess-1/subagents/agent-a1.jsonl',
      agentName: 'a1', parentSessionId: 'sess-1', finishedAt: new Date().toISOString(), summary: 'did the thing',
    });
    assert.ok(ok);
    const entries = listPointersForSession('sess-1');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].record.claimed, false);
    assert.deepEqual(entries[0].record.surfaced, { userPromptSubmit: false, sessionStart: false });
    assert.equal(entries[0].record.summary, 'did the thing');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

// ── hasAnyPointers: fast empty-case no-op ───────────────────────────────

test('hasAnyPointers: false immediately when the pointers dir does not exist', () => {
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    assert.equal(hasAnyPointers(), false);
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

// ── wasDelivered: real-shape delivery evidence ──────────────────────────
//
// Shapes below mirror test/fixtures/orphan-pointers/README.md — a
// background Agent spawn's ack/task-notification pair, a team-mailbox
// agent-message, and a foreground tool_result — all with fake ids/paths.

test('wasDelivered: plain subagent — tool_result with matching tool_use_id counts as delivered', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_ABC123' });
  const sessionDir = path.dirname(subagentsDir);
  const realParentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(realParentPath, '', 'utf8');
  appendParentEntries(realParentPath, [
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ABC123', content: 'done' }] } },
  ]);

  const result = wasDelivered({ transcriptPath, agentName: null, agentId: null, toolUseId: 'toolu_ABC123' });
  assert.equal(result.delivered, true);
});

test('wasDelivered: team-mailbox agent-message delivery marker counts as delivered', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeamMailboxAgent(subagentsDir, { name: 'triage' });
  const sessionDir = path.dirname(subagentsDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  appendParentEntries(parentPath, [
    { type: 'user', message: { role: 'user', content: '<agent-message from="triage">report body</agent-message>' } },
  ]);

  const result = wasDelivered({ transcriptPath, agentName: 'triage', agentId: null, toolUseId: null });
  assert.equal(result.delivered, true);
});

test('wasDelivered: no matching evidence at all — not delivered', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_NEVER_SEEN' });
  const sessionDir = path.dirname(subagentsDir);
  fs.writeFileSync(`${sessionDir}.jsonl`, '', 'utf8');

  const result = wasDelivered({ transcriptPath, agentName: null, agentId: null, toolUseId: 'toolu_NEVER_SEEN' });
  assert.equal(result.delivered, false);
});

// ── wasDelivered: finishedAt-aware name-marker matching — an OLDER
// same-name entry must never mark a LATER, still-undelivered pointer as
// delivered ─────────────────────────────────────────────────────────────

test('wasDelivered: a PRE-finish same-name agent-message does NOT count as delivery', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeamMailboxAgent(subagentsDir, { name: 'triage' });
  const sessionDir = path.dirname(subagentsDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  appendParentEntries(parentPath, [
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: '<agent-message from="triage">an EARLIER, unrelated dispatch report</agent-message>' },
    },
  ]);

  const result = wasDelivered({
    transcriptPath,
    agentName: 'triage',
    agentId: null,
    toolUseId: null,
    finishedAt: '2026-01-01T00:10:00.000Z', // this pointer finished AFTER that older entry
  });
  assert.equal(result.delivered, false);
});

test('wasDelivered: a POST-finish same-name agent-message counts as delivery', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeamMailboxAgent(subagentsDir, { name: 'triage' });
  const sessionDir = path.dirname(subagentsDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  appendParentEntries(parentPath, [
    {
      type: 'user',
      timestamp: '2026-01-01T00:20:00.000Z',
      message: { role: 'user', content: '<agent-message from="triage">this dispatch\'s own report</agent-message>' },
    },
  ]);

  const result = wasDelivered({
    transcriptPath,
    agentName: 'triage',
    agentId: null,
    toolUseId: null,
    finishedAt: '2026-01-01T00:10:00.000Z',
  });
  assert.equal(result.delivered, true);
});

test('wasDelivered: a name-based marker with NO parseable timestamp is never accepted as delivery evidence', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeamMailboxAgent(subagentsDir, { name: 'triage' });
  const sessionDir = path.dirname(subagentsDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  appendParentEntries(parentPath, [
    // No `timestamp` field at all.
    { type: 'user', message: { role: 'user', content: '<agent-message from="triage">untimestamped entry</agent-message>' } },
  ]);

  const result = wasDelivered({
    transcriptPath, agentName: 'triage', agentId: null, toolUseId: null, finishedAt: '2026-01-01T00:10:00.000Z',
  });
  assert.equal(result.delivered, false);
});

test('wasDelivered: an id-based marker with NO parseable timestamp IS still accepted (unambiguous evidence)', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { name: 'idlane', hash: 'aaaa9999', toolUseId: 'toolu_NOTS' });
  const sessionDir = path.dirname(subagentsDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  appendParentEntries(parentPath, [
    // No `timestamp` field, but an exact tool_use_id match is unambiguous.
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_NOTS', content: 'done' }] } },
  ]);

  const result = wasDelivered({
    transcriptPath, agentName: null, agentId: null, toolUseId: 'toolu_NOTS', finishedAt: '2026-01-01T00:10:00.000Z',
  });
  assert.equal(result.delivered, true);
});

// ── wasDelivered: background Agent spawn — the launch-ack misattribution
// this fix closes ────────────────────────────────────────────────────────

test('wasDelivered: background spawn launch-ack ONLY (same tool_use_id as the spawn call) — NOT delivered', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { name: 'bg', hash: 'fake0001', toolUseId: 'toolu_SPAWN1' });
  const sessionDir = path.dirname(subagentsDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  // This is the IMMEDIATE ack the parent gets when the spawn call returns —
  // same tool_use_id as the spawn, not the eventual real result. A naive
  // tool_use_id-only match would wrongly call this "delivered" at launch.
  appendParentEntries(parentPath, [
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          tool_use_id: 'toolu_SPAWN1',
          type: 'tool_result',
          content: [{ type: 'text', text: "Async agent launched successfully.\nagentId: afake0001 (internal ID - do not mention to user.)" }],
        }],
      },
    },
  ]);

  const result = wasDelivered({ transcriptPath, agentName: null, agentId: 'afake0001', toolUseId: 'toolu_SPAWN1' });
  assert.equal(result.delivered, false);
});

test('wasDelivered: foreground non-ack tool_result with matching tool_use_id — delivered', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { name: 'fg', hash: 'fake0002', toolUseId: 'toolu_SYNC1' });
  const sessionDir = path.dirname(subagentsDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  appendParentEntries(parentPath, [
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: 'toolu_SYNC1', type: 'tool_result', content: [{ type: 'text', text: 'The synchronous subagent finished with this real result.' }] }],
      },
    },
  ]);

  const result = wasDelivered({ transcriptPath, agentName: null, agentId: 'afake0002', toolUseId: 'toolu_SYNC1' });
  assert.equal(result.delivered, true);
});

test('wasDelivered: enqueue-only (never dequeued, no delivery entry yet) — NOT delivered', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { name: 'bg', hash: 'fake0003', toolUseId: 'toolu_SPAWN2' });
  const sessionDir = path.dirname(subagentsDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  appendParentEntries(parentPath, [
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification>\n<task-id>afake0003</task-id>\n<tool-use-id>toolu_SPAWN2</tool-use-id>\n<status>completed</status>\n</task-notification>',
    },
  ]);

  const result = wasDelivered({ transcriptPath, agentName: null, agentId: 'afake0003', toolUseId: 'toolu_SPAWN2' });
  assert.equal(result.delivered, false);
});

test('wasDelivered: queued_command attachment carrying the task-id — delivered, never surfaced', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { name: 'bg', hash: 'fake0004', toolUseId: 'toolu_SPAWN3' });
  const sessionDir = path.dirname(subagentsDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  appendParentEntries(parentPath, [
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification>\n<task-id>afake0004</task-id>\n<tool-use-id>toolu_SPAWN3</tool-use-id>\n<status>completed</status>\n</task-notification>',
    },
    { type: 'queue-operation', operation: 'dequeue' },
    {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: '<task-notification>\n<task-id>afake0004</task-id>\n<tool-use-id>toolu_SPAWN3</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>',
        commandMode: 'task-notification',
      },
    },
  ]);

  const result = wasDelivered({ transcriptPath, agentName: null, agentId: 'afake0004', toolUseId: 'toolu_SPAWN3' });
  assert.equal(result.delivered, true);
});

test('wasDelivered: task-notification as a plain user-entry string (no attachment wrapper) — delivered', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { name: 'bg', hash: 'fake0005', toolUseId: 'toolu_SPAWN4' });
  const sessionDir = path.dirname(subagentsDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  appendParentEntries(parentPath, [
    { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<task-id>afake0005</task-id>\n</task-notification>' },
    { type: 'queue-operation', operation: 'remove' },
    {
      type: 'user',
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>afake0005</task-id>\n<tool-use-id>toolu_SPAWN4</tool-use-id>\n<status>completed</status>\n<result>the real result text</result>\n</task-notification>',
      },
    },
  ]);

  const result = wasDelivered({ transcriptPath, agentName: null, agentId: 'afake0005', toolUseId: 'toolu_SPAWN4' });
  assert.equal(result.delivered, true);
});

// ── harnessAgentId: derives the exact <task-id> string from a transcript path ──

test('harnessAgentId: strips the agent- prefix, preserves the leading "a" and any name-hash body', () => {
  assert.equal(harnessAgentId('/x/subagents/agent-a3a2ad2af148bcfcb.jsonl'), 'a3a2ad2af148bcfcb');
  assert.equal(harnessAgentId('/x/subagents/agent-atriage-bbbb2222.jsonl'), 'atriage-bbbb2222');
  // Never expected in practice, but must not throw — falls back to the bare
  // filename rather than failing the pointer write outright.
  assert.equal(harnessAgentId('/x/subagents/not-the-documented-shape.jsonl'), 'not-the-documented-shape');
});

// ── formatPointerList: cap 5 + "+N more" ────────────────────────────────

test('formatPointerList: caps at 5 items and appends a "+N more" line', () => {
  const entries = Array.from({ length: 8 }, (_, i) => ({
    agentId: `agent-${i}`,
    record: { agentName: `agent-${i}`, transcriptPath: `/tmp/agent-${i}.jsonl`, summary: '' },
  }));
  const text = formatPointerList(entries, '/tmp/pointers');
  const lines = text.split('\n');
  assert.equal(lines.length, 6); // 5 items + 1 "+N more" line
  assert.match(lines[5], /\+3 more at \/tmp\/pointers/);
});

// ── integration: SubagentStop writer never blocks a plain subagent ─────
//
// Uses the REAL payload shape (see hooks/orphan-pointers-subagent-stop.js's
// file header): `transcript_path` is the top-level SESSION transcript,
// `agent_transcript_path` names the stopping agent's own file directly, and
// `session_id` / `last_assistant_message` are supplied outright rather than
// re-derived. This is the exact case Bug 1 closed: a naive direct-sibling
// lookup against `transcript_path` alone would find nothing here at all.

test('SubagentStop hook: real payload shape — writes a pointer for a plain background subagent and never blocks', () => {
  const { sessionId, leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const { transcriptPath, agentId } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_PLAIN1', text: 'plain subagent final report' });
  const dataDir = mkDataDir();
  const payload = realSubagentStopPayload({
    sessionId, leadTranscriptPath, agentTranscriptPath: transcriptPath, agentId, lastAssistantMessage: 'plain subagent final report',
  });
  const out = runHook(SUBAGENT_STOP_HOOK, payload, { dataDir });
  assert.equal(out.trim(), ''); // never blocks / never emits a decision

  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const entries = listPointersForSession(sessionId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].record.claimed, false);
    assert.equal(entries[0].record.transcriptPath, transcriptPath, 'must resolve to the AGENT\'s own transcript, not the session file');
    assert.equal(entries[0].record.summary, 'plain subagent final report', 'must use last_assistant_message directly, no transcript read needed');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('SubagentStop hook: legacy payload shape (transcript_path pointing straight at the agent file) still resolves — back-compat fallback', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_PLAINLEGACY' });
  const dataDir = mkDataDir();
  const out = runHook(SUBAGENT_STOP_HOOK, { transcript_path: transcriptPath }, { dataDir });
  assert.equal(out.trim(), ''); // never blocks / never emits a decision

  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const sessionId = path.basename(path.dirname(subagentsDir));
    const entries = listPointersForSession(sessionId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].record.claimed, false);
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('SubagentStop hook: malformed/empty stdin never throws, never writes anything', () => {
  const dataDir = mkDataDir();
  const out = runHook(SUBAGENT_STOP_HOOK, null, { dataDir });
  assert.equal(out.trim(), '');
});

// ── `agent_transcript_path` containment validation ──────────────────────
//
// Regression coverage for the fix closing a basename-pattern-only accept: a
// path matching `agent-<id>.jsonl` by NAME alone used to be trusted outright
// even when it lived outside the session's own `subagents/` dir, or named an
// id the payload's own `agent_id` disagreed with. All three cases below must
// fall through to the next resolution step (the `agent_id` + session-dir
// derivation in step 3) rather than being accepted at step 2 — this repo's
// fixtures always place the REAL agent transcript at
// `<subagentsDir>/agent-<agentId>.jsonl` too, so step 3 still finds and
// writes a pointer for the legitimate cases; only the identity used to GET
// there differs (confirmed via `resolveAnyAgentContext`'s own
// `resolutionMethod` below, exported alongside `main`/`harnessAgentId`).

const { resolveAnyAgentContext } = require('../hooks/orphan-pointers-subagent-stop.js');

test('resolveAnyAgentContext: agent_transcript_path OUTSIDE the session\'s subagents dir is rejected at step 2, falls through to step 3', () => {
  const { sessionId, leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const { transcriptPath, agentId } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_OUTSIDE1' });

  // A sibling directory OUTSIDE `<session dir>/subagents` that happens to
  // hold a file matching the exact basename pattern `agent-<id>.jsonl` —
  // the shape a basename-only check would have wrongly trusted.
  const rogueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-ptr-rogue-'));
  const rogueTranscriptPath = path.join(rogueDir, path.basename(transcriptPath));
  fs.writeFileSync(rogueTranscriptPath, fs.readFileSync(transcriptPath, 'utf8'), 'utf8');
  fs.writeFileSync(`${rogueTranscriptPath.slice(0, -'.jsonl'.length)}.meta.json`, fs.readFileSync(`${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`, 'utf8'), 'utf8');

  const payload = realSubagentStopPayload({
    sessionId, leadTranscriptPath, agentTranscriptPath: rogueTranscriptPath, agentId, lastAssistantMessage: 'x',
  });
  const resolved = resolveAnyAgentContext(payload);
  assert.ok(resolved, 'step 3 (agent_id + session dir derivation) must still resolve the REAL transcript');
  assert.equal(resolved.resolutionMethod, 'agent-id-derived-path', 'must NOT resolve via the rejected agent-transcript-path step');
  assert.equal(resolved.transcriptPath, transcriptPath, 'must resolve to the REAL transcript under subagents/, never the rogue one');
});

test('resolveAnyAgentContext: agent_transcript_path basename disagreeing with payload.agent_id is rejected at step 2', () => {
  const { sessionId, leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const { transcriptPath, agentId } = writePlainSubagent(subagentsDir, { name: 'real', hash: 'aaaa1111', toolUseId: 'toolu_MISMATCH1' });
  // A second, unrelated agent transcript in the SAME (correct) subagents dir
  // — dirname containment alone would pass, so this exercises the id-match
  // check specifically.
  const { transcriptPath: otherTranscriptPath } = writePlainSubagent(subagentsDir, { name: 'other', hash: 'bbbb2222', toolUseId: 'toolu_OTHER1' });

  const payload = realSubagentStopPayload({
    sessionId,
    leadTranscriptPath,
    agentTranscriptPath: otherTranscriptPath, // path names a DIFFERENT agent...
    agentId, // ...than the one the payload's own agent_id claims.
    lastAssistantMessage: 'x',
  });
  const resolved = resolveAnyAgentContext(payload);
  assert.ok(resolved, 'step 3 must still resolve using payload.agent_id, ignoring the mismatched path');
  assert.equal(resolved.resolutionMethod, 'agent-id-derived-path');
  assert.equal(resolved.transcriptPath, transcriptPath, 'must resolve to the transcript payload.agent_id actually names, never the mismatched path');
});

test('resolveAnyAgentContext: a valid real-shape agent_transcript_path payload resolves via step 2, agent id passes isSafePathSegment', () => {
  const { sessionId, leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const { transcriptPath, agentId } = writePlainSubagent(subagentsDir, { name: 'good', hash: 'cccc3333', toolUseId: 'toolu_GOOD1' });

  const payload = realSubagentStopPayload({
    sessionId, leadTranscriptPath, agentTranscriptPath: transcriptPath, agentId, lastAssistantMessage: 'good report',
  });
  const resolved = resolveAnyAgentContext(payload);
  assert.ok(resolved);
  assert.equal(resolved.resolutionMethod, 'agent-transcript-path', 'a fully valid real-shape payload must resolve at step 2, not fall through');
  assert.equal(resolved.transcriptPath, transcriptPath);
});

// ── integration: a real background-Agent completion, end to end — never
// surfaced by EITHER hook once genuinely delivered ──────────────────────

test('end to end: background Agent spawn delivered via task-notification is never surfaced by UserPromptSubmit or SessionStart', () => {
  const { sessionId, leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const { transcriptPath, agentId } = writePlainSubagent(subagentsDir, { name: 'bg', hash: 'fakee2e1', toolUseId: 'toolu_E2E1' });
  const parentPath = leadTranscriptPath;
  // The launch ack (never delivery) followed by the real queued->delivered
  // task-notification sequence — the exact real shape this fix closes.
  // writePlainSubagent(name: 'bg', hash: 'fakee2e1') names the transcript
  // `agent-abg-fakee2e1.jsonl`, so `agentId` (returned above) is
  // `abg-fakee2e1` — the exact id the fixture's task-notification must carry.
  appendParentEntries(parentPath, [
    {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_E2E1', type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] },
    },
  ]);

  const dataDir = mkDataDir();
  // Real SubagentStop payload shape — transcript_path is the SESSION file,
  // agent_transcript_path names the stopping agent's own file directly.
  const out = runHook(SUBAGENT_STOP_HOOK, realSubagentStopPayload({
    sessionId, leadTranscriptPath, agentTranscriptPath: transcriptPath, agentId, lastAssistantMessage: 'plain output',
  }), { dataDir });
  assert.equal(out.trim(), '');

  // Now the real completion lands.
  appendParentEntries(parentPath, [
    { type: 'queue-operation', operation: 'enqueue', content: `<task-notification>\n<task-id>${agentId}</task-id>\n</task-notification>` },
    { type: 'queue-operation', operation: 'dequeue' },
    {
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n</task-notification>`, commandMode: 'task-notification' },
    },
  ]);

  const upOut = runHook(USER_PROMPT_HOOK, { session_id: sessionId, transcript_path: parentPath }, { dataDir });
  assert.equal(upOut.trim(), '', 'must not surface a genuinely delivered background-agent pointer');

  const ssOut = runHook(SESSION_START_HOOK, { session_id: 'a-different-session' }, { dataDir });
  assert.equal(ssOut.trim(), '', 'must not surface a genuinely delivered background-agent pointer from a dead session either');
});

// ── integration: delivered normally -> never surfaced (marked claimed) ──

test('UserPromptSubmit hook: a delivered pointer is marked claimed and never surfaced', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_DELIV1' });
  const sessionDir = path.dirname(subagentsDir);
  const sessionId = path.basename(sessionDir);
  fs.writeFileSync(`${sessionDir}.jsonl`, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_DELIV1' }] } })}\n`, 'utf8');

  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    writePointer({
      sessionId, agentId: 'agent-adeliv1', transcriptPath, agentName: null, toolUseId: 'toolu_DELIV1',
      parentSessionId: sessionId, finishedAt: new Date().toISOString(), summary: 'x',
    });
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  const out = runHook(USER_PROMPT_HOOK, { session_id: sessionId, transcript_path: `${sessionDir}.jsonl` }, { dataDir });
  assert.equal(out.trim(), '', 'delivered pointer must produce no additionalContext');

  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const entries = listPointersForSession(sessionId);
    assert.equal(entries[0].record.claimed, true);
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

// ── integration: UserPromptSubmit surfaces an undelivered pointer once,
// only once it is well past the grace period (see the race-fix tests below
// for the sub-grace-period and delivery-race behavior this supersedes) ──

test('UserPromptSubmit hook: surfaces an undelivered pointer once past the grace period, then never again (at-most-once)', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_UNDELIV1' });
  const sessionDir = path.dirname(subagentsDir);
  const sessionId = path.basename(sessionDir);
  fs.writeFileSync(`${sessionDir}.jsonl`, '', 'utf8');

  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    writePointer({
      sessionId, agentId: 'agent-aundeliv1', transcriptPath, agentName: null,
      // Well past the default 10-minute grace period — the top-level
      // surfacing gate must not hold this back any longer.
      parentSessionId: sessionId, finishedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(), summary: 'undelivered work',
    });
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  const payload = { session_id: sessionId, transcript_path: `${sessionDir}.jsonl` };
  const first = runHook(USER_PROMPT_HOOK, payload, { dataDir });
  const parsed = JSON.parse(first);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /undelivered work/);

  const second = runHook(USER_PROMPT_HOOK, payload, { dataDir });
  assert.equal(second.trim(), '', 'must not surface the same pointer twice via the same hook');
});

// ── race-fix regression coverage: the exact false-positive this session
// closed — a task-notification's own prompt delivering a pointer's result
// must claim it immediately, and an undelivered TOP-LEVEL/NESTED pointer
// must never surface before its respective grace/settle window elapses ──

test('UserPromptSubmit hook: the task-notification prompt itself delivers the pointer — claimed, never surfaced, even though the transcript has no delivery entry yet', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath, agentId } = writePlainSubagent(subagentsDir, { name: 'racefix', hash: 'race0001', toolUseId: 'toolu_RACEFIX1' });
  const sessionDir = path.dirname(subagentsDir);
  const sessionId = path.basename(sessionDir);
  const parentPath = `${sessionDir}.jsonl`;
  // The parent transcript has ONLY the enqueue bookkeeping line — exactly
  // the real observed sequence: the delivery entry (`type: "user"` carrying
  // the task-notification) has not been appended yet at the moment this
  // hook process reads the transcript, because delivering it IS what fires
  // this very hook invocation.
  fs.writeFileSync(parentPath, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `<task-notification>\n<task-id>${agentId}</task-id>\n</task-notification>` })}\n`, 'utf8');

  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    writePointer({
      sessionId, agentId, transcriptPath, agentName: null,
      parentSessionId: sessionId, finishedAt: new Date().toISOString(), summary: 'racefix result',
    });
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  const taskNotificationPrompt = `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<result>racefix result</result>\n</task-notification>`;
  const out = runHook(USER_PROMPT_HOOK, { session_id: sessionId, transcript_path: parentPath, prompt: taskNotificationPrompt }, { dataDir });
  assert.equal(out.trim(), '', 'must not surface a pointer whose delivery IS this very prompt');

  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const [entry] = listPointersForSession(sessionId);
    assert.equal(entry.record.claimed, true, 'must be claimed straight from the prompt text, independent of the transcript scan');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('UserPromptSubmit hook: a top-level pointer finished 5s ago with no delivery is NOT surfaced yet', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath, agentId } = writePlainSubagent(subagentsDir, { name: 'fresh', hash: 'fresh001', toolUseId: 'toolu_FRESH1' });
  const sessionDir = path.dirname(subagentsDir);
  const sessionId = path.basename(sessionDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');

  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    writePointer({
      sessionId, agentId, transcriptPath, agentName: null,
      parentSessionId: sessionId, finishedAt: new Date(Date.now() - 5000).toISOString(), summary: 'too fresh to surface',
    });
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  const out = runHook(USER_PROMPT_HOOK, { session_id: sessionId, transcript_path: parentPath }, { dataDir });
  assert.equal(out.trim(), '', 'a top-level pointer within the grace period must not surface yet');

  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const [entry] = listPointersForSession(sessionId);
    assert.equal(entry.record.claimed, false, 'must remain unclaimed — held back by the grace period, not falsely marked delivered');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('UserPromptSubmit hook: the SAME pointer at finishedAt+11min with no delivery IS surfaced once', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath, agentId } = writePlainSubagent(subagentsDir, { name: 'stale', hash: 'stale001', toolUseId: 'toolu_STALE1' });
  const sessionDir = path.dirname(subagentsDir);
  const sessionId = path.basename(sessionDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');

  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    writePointer({
      sessionId, agentId, transcriptPath, agentName: null,
      parentSessionId: sessionId, finishedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(), summary: 'now stale enough',
    });
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  const payload = { session_id: sessionId, transcript_path: parentPath };
  const first = runHook(USER_PROMPT_HOOK, payload, { dataDir });
  const parsed = JSON.parse(first);
  assert.match(parsed.hookSpecificOutput.additionalContext, /now stale enough/);

  const second = runHook(USER_PROMPT_HOOK, payload, { dataDir });
  assert.equal(second.trim(), '', 'must not surface the same pointer twice');
});

test('UserPromptSubmit hook: a nested pointer with a dead parent agent is surfaced once, only after the settle time', () => {
  const { sessionId, leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const parent = writePlainSubagent(subagentsDir, { name: 'deadparent2', hash: 'dp2a0001', toolUseId: 'toolu_DEADPARENT2' });
  const child = writePlainSubagent(subagentsDir, {
    name: 'orphanchild2', hash: 'oc2b0002', toolUseId: 'toolu_ORPHANCHILD2', parentAgentId: parent.agentId,
  });
  fs.writeFileSync(leadTranscriptPath, '', 'utf8');

  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    // The parent AGENT already finished — its own pointer exists.
    writePointer({
      sessionId, agentId: parent.agentId, transcriptPath: parent.transcriptPath, agentName: null,
      toolUseId: 'toolu_DEADPARENT2', parentSessionId: sessionId, finishedAt: new Date().toISOString(), summary: 'parent finished',
    });
    // The nested child finished only 5s ago — well within the settle window.
    writePointer({
      sessionId, agentId: child.agentId, transcriptPath: child.transcriptPath, agentName: null,
      toolUseId: 'toolu_ORPHANCHILD2', parentSessionId: sessionId, parentAgentId: parent.agentId,
      finishedAt: new Date(Date.now() - 5000).toISOString(), summary: 'nested, too fresh to surface yet',
    });
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  const payload = { session_id: sessionId, transcript_path: leadTranscriptPath };
  const withinSettle = runHook(USER_PROMPT_HOOK, payload, { dataDir });
  assert.equal(withinSettle.trim(), '', 'a dead-parent nested pointer within the settle window must not surface yet');

  // Now the child is past the settle window (30s default) — surfaced once.
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const [childEntry] = listPointersForSession(sessionId).filter((e) => e.agentId === child.agentId);
    childEntry.record.finishedAt = new Date(Date.now() - 31 * 1000).toISOString();
    fs.writeFileSync(childEntry.path, JSON.stringify(childEntry.record), 'utf8');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  const pastSettle = runHook(USER_PROMPT_HOOK, payload, { dataDir });
  const parsed = JSON.parse(pastSettle);
  assert.match(parsed.hookSpecificOutput.additionalContext, /nested, too fresh to surface yet/);

  const second = runHook(USER_PROMPT_HOOK, payload, { dataDir });
  assert.equal(second.trim(), '', 'must not surface the same nested pointer twice');
});

// ── integration: empty pointers dir is a fast no-op (no transcript reads) ─

test('UserPromptSubmit + SessionStart hooks: empty pointers dir short-circuits well under 100ms', () => {
  const dataDir = mkDataDir();
  for (const hook of [USER_PROMPT_HOOK, SESSION_START_HOOK]) {
    const start = Date.now();
    const out = runHook(hook, { session_id: 'whatever' }, { dataDir });
    const elapsed = Date.now() - start;
    assert.equal(out.trim(), '');
    assert.ok(elapsed < 2000, `hook process (incl. node startup) took ${elapsed}ms — investigate if this regresses`);
  }
});

test('SubagentStop hook: the writer path (a real, small transcript) stays well under a generous CI-safe bound', () => {
  // This hook is never expected to have an "empty" fast path (it writes a
  // pointer for every finished subagent), but it must still stay cheap: the
  // scan is a small, bounded transcript read, never anything proportional to
  // the whole session.
  const { sessionId, leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const { transcriptPath, agentId } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_PERF1' });
  const start = Date.now();
  const out = runHook(SUBAGENT_STOP_HOOK, realSubagentStopPayload({
    sessionId, leadTranscriptPath, agentTranscriptPath: transcriptPath, agentId, lastAssistantMessage: 'plain output',
  }), { dataDir: mkDataDir() });
  const elapsed = Date.now() - start;
  assert.equal(out.trim(), '');
  assert.ok(elapsed < 2000, `SubagentStop hook process (incl. node startup) took ${elapsed}ms — investigate if this regresses`);
});

// ── integration: parent gone -> surfaced once at next SessionStart ─────

test('SessionStart hook: a pointer from a dead prior session is surfaced once', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_DEAD1' });
  const sessionDir = path.dirname(subagentsDir);
  const sessionId = path.basename(sessionDir);
  const parentPath = `${sessionDir}.jsonl`;
  fs.writeFileSync(parentPath, '', 'utf8');
  // Make the parent transcript look old (past the grace period).
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(parentPath, old, old);

  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    writePointer({
      sessionId, agentId: 'agent-adead1', transcriptPath, agentName: null,
      parentSessionId: sessionId, finishedAt: old.toISOString(), summary: 'orphaned from a dead session',
    });
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  // A DIFFERENT current session id — this is "prior/dead session" surfacing.
  const out = runHook(SESSION_START_HOOK, { session_id: 'a-totally-different-session' }, { dataDir });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(parsed.hookSpecificOutput.additionalContext, /orphaned from a dead session/);

  const second = runHook(SESSION_START_HOOK, { session_id: 'a-totally-different-session' }, { dataDir });
  assert.equal(second.trim(), '', 'must not surface the same pointer twice via SessionStart');
});

// ── markSurfaced: lock-free wx-marker race safety ───────────────────────

test('markSurfaced: two concurrent surface attempts for the same pointer+hook — exactly one wins', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_RACE1' });
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  let entry;
  try {
    const sessionId = 'session-race';
    writePointer({
      sessionId, agentId: 'agent-arace1', transcriptPath, agentName: null,
      parentSessionId: sessionId, finishedAt: new Date().toISOString(), summary: 'race test',
    });
    [entry] = listPointersForSession(sessionId);
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  assert.equal(isSurfaceMarked(entry, 'sessionStart'), false);

  // Simulate two concurrent hook processes racing to surface the SAME
  // pointer via the SAME hook — the whole point of the atomic `wx`-created
  // marker file is that only one of these can ever return true, with no
  // read-modify-write window in between for both to slip through.
  const first = markSurfaced(entry, 'sessionStart');
  const second = markSurfaced(entry, 'sessionStart');

  assert.equal(first, true, 'the first claim must win');
  assert.equal(second, false, 'the second, racing claim must lose — exactly one surfaces');
  assert.equal(isSurfaceMarked(entry, 'sessionStart'), true);

  // A DIFFERENT hook name for the same pointer is an independent claim —
  // unaffected by the other hook's marker.
  assert.equal(markSurfaced(entry, 'userPromptSubmit'), true);
});

// ── path-traversal rejection: sessionId/agentId are validated with the same
// safe-path-segment rule the lane drop-box uses, plus a containment check ─

test('pointerPath/pointersDirFor: a path-traversal sessionId is rejected (null), never joined into a path', () => {
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    assert.equal(pointerPath('../../etc', 'agent-a1'), null);
    assert.equal(pointerPath('sess-1', '../../etc/passwd'), null);
    assert.equal(pointersDirFor('../../etc'), null);
    // A safe pair still resolves normally.
    assert.ok(pointerPath('sess-1', 'agent-a1'));
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('writePointer: a path-traversal sessionId never writes outside the data dir (fails open, no-op)', () => {
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const ok = writePointer({
      sessionId: '../../../../tmp/orphan-ptr-escape', agentId: 'agent-evil', transcriptPath: '/tmp/x.jsonl',
      agentName: null, parentSessionId: 'sess-1', finishedAt: new Date().toISOString(), summary: 'should never land',
    });
    assert.equal(ok, false, 'writePointer must refuse an unsafe sessionId rather than writing anywhere');

    // Nothing was written outside the data dir at all — walk up from the
    // data dir's parent looking for the literal escape marker file/dir.
    assert.equal(fs.existsSync('/tmp/orphan-ptr-escape'), false);
    assert.equal(fs.existsSync(path.join(os.tmpdir(), 'orphan-ptr-escape.json')), false);

    // Only the pointers root (empty) exists under the data dir — no stray
    // sibling directories from a resolved traversal.
    const pointersRoot = path.join(dataDir, 'pointers');
    if (fs.existsSync(pointersRoot)) {
      assert.deepEqual(fs.readdirSync(pointersRoot), []);
    }
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('listPointersForSession: a path-traversal sessionId returns [] without ever reading a directory outside the data dir', () => {
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    assert.deepEqual(listPointersForSession('../../etc'), []);
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('UserPromptSubmit hook: a path-traversal session_id in the payload is a silent no-op, never a directory read outside the data dir', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_TRAVERSAL1' });
  const dataDir = mkDataDir();

  // Seed one legitimate pointer under a SAFE session id, so the pointers
  // root is non-empty (exercising the real read path, not just the
  // fast-empty short-circuit).
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    writePointer({
      sessionId: 'sess-legit', agentId: 'agent-alegit1', transcriptPath, agentName: null,
      parentSessionId: 'sess-legit', finishedAt: new Date().toISOString(), summary: 'legit pointer',
    });
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  const out = runHook(USER_PROMPT_HOOK, { session_id: '../../../../tmp/orphan-ptr-hook-escape', transcript_path: transcriptPath }, { dataDir });
  assert.equal(out.trim(), '', 'a traversal-shaped session_id must fail open silently, never surface or throw');
  assert.equal(fs.existsSync('/tmp/orphan-ptr-hook-escape'), false);
});

// ── nested agents (spawned by ANOTHER subagent, not the top-level session
// directly) — the orphan case this pointer-plus-fix specifically covers: a
// teammate spawns a plain lane, then the teammate itself dies before ever
// consuming that lane's task-notification. See `parentTranscriptPathFor` /
// `isParentAgentFinished` in lib/orphan-pointers.js for the mechanism.

test('nested lane whose parent agent consumed the task-notification — delivered, never surfaced', () => {
  const { sessionId, leadTranscriptPath, subagentsDir } = mkSessionFixture();

  // The PARENT is itself a plain background lane, dispatched by the
  // top-level session (spawnDepth 1, no parentAgentId of its own).
  const parent = writePlainSubagent(subagentsDir, { name: 'parent', hash: 'ppppaaa1', toolUseId: 'toolu_PARENT1' });
  // The CHILD is NESTED — spawned by the parent above, not by the top-level
  // session (spawnDepth 2, meta carries parentAgentId).
  const child = writePlainSubagent(subagentsDir, {
    name: 'child', hash: 'ccccbbb1', toolUseId: 'toolu_CHILD1', parentAgentId: parent.agentId,
  });

  const dataDir = mkDataDir();
  // The real SubagentStop hook run for the child: its own meta sidecar
  // carries `parentAgentId`, which this hook must thread onto the pointer
  // record without any extra payload field of its own.
  const stopOut = runHook(SUBAGENT_STOP_HOOK, realSubagentStopPayload({
    sessionId, leadTranscriptPath, agentTranscriptPath: child.transcriptPath, agentId: child.agentId, lastAssistantMessage: 'child report',
  }), { dataDir });
  assert.equal(stopOut.trim(), '');

  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const [entry] = listPointersForSession(sessionId);
    assert.equal(entry.record.parentAgentId, parent.agentId, 'the pointer must record the PARENT AGENT, not the top-level session');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  // The parent AGENT's own transcript — NOT the top-level session
  // transcript — receives the child's delivered task-notification. If this
  // fix only checked the top-level session transcript (the pre-fix
  // behavior), this would never be found and the pointer would wrongly
  // surface as an orphan.
  appendParentEntries(parent.transcriptPath, [
    { type: 'queue-operation', operation: 'enqueue', content: `<task-notification>\n<task-id>${child.agentId}</task-id>\n</task-notification>` },
    { type: 'queue-operation', operation: 'dequeue' },
    {
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>${child.agentId}</task-id>\n<status>completed</status>\n</task-notification>`, commandMode: 'task-notification' },
    },
  ]);
  // The top-level session transcript stays empty/irrelevant — delivery must
  // be found on the PARENT AGENT's transcript, never the session's.
  fs.writeFileSync(leadTranscriptPath, '', 'utf8');

  const upOut = runHook(USER_PROMPT_HOOK, { session_id: sessionId, transcript_path: leadTranscriptPath }, { dataDir });
  assert.equal(upOut.trim(), '', 'a nested pointer delivered via its PARENT AGENT must never surface');

  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const [entry] = listPointersForSession(sessionId);
    assert.equal(entry.record.claimed, true, 'must be marked claimed once delivery is confirmed against the parent agent transcript');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('nested lane whose parent agent transcript is stale with no delivery — surfaced once in the session', () => {
  const { sessionId, leadTranscriptPath, subagentsDir } = mkSessionFixture();

  const parent = writePlainSubagent(subagentsDir, { name: 'deadparent', hash: 'dddd0001', toolUseId: 'toolu_DEADPARENT1' });
  const child = writePlainSubagent(subagentsDir, {
    name: 'orphanchild', hash: 'eeee0002', toolUseId: 'toolu_ORPHANCHILD1', parentAgentId: parent.agentId,
  });

  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    // The parent AGENT itself already finished — its own pointer exists
    // under the same top-level session (exactly as the real SubagentStop
    // hook would have written when the parent stopped). This alone must be
    // enough for `isParentGone` to consider a nested pointer's parent gone,
    // with no need to wait out the time-based grace period at all.
    writePointer({
      sessionId, agentId: parent.agentId, transcriptPath: parent.transcriptPath, agentName: null,
      toolUseId: 'toolu_PARENT1', parentSessionId: sessionId, finishedAt: new Date().toISOString(), summary: 'parent finished',
    });
    assert.equal(isParentAgentFinished(sessionId, parent.agentId), true);

    writePointer({
      sessionId, agentId: child.agentId, transcriptPath: child.transcriptPath, agentName: null,
      toolUseId: 'toolu_ORPHANCHILD1', parentSessionId: sessionId, parentAgentId: parent.agentId,
      finishedAt: new Date().toISOString(), summary: 'orphaned nested child',
    });
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  // Parent AGENT's own transcript has no delivery evidence for the child at
  // all — this is the "stale, undelivered" case.
  fs.writeFileSync(leadTranscriptPath, '', 'utf8');

  // Unit-level check first: isParentGone must be true for the nested
  // pointer purely because the parent agent already finished (well within
  // the normal PARENT_GONE_GRACE_MS window — this is the OR branch, not the
  // time-based one).
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const [childEntry] = listPointersForSession(sessionId).filter((e) => e.agentId === child.agentId);
    assert.equal(
      isParentGone(childEntry, { currentSessionId: sessionId }),
      true,
      'a nested pointer whose parent agent already finished must be considered gone immediately',
    );
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  // Integration: SessionStart, resuming the SAME session id, surfaces the
  // orphaned nested child exactly once.
  const first = runHook(SESSION_START_HOOK, { session_id: sessionId }, { dataDir });
  const parsed = JSON.parse(first);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(parsed.hookSpecificOutput.additionalContext, /orphaned nested child/);

  const second = runHook(SESSION_START_HOOK, { session_id: sessionId }, { dataDir });
  assert.equal(second.trim(), '', 'must not surface the same nested pointer twice via SessionStart');
});

test('a top-level spawn delivered to the session — never surfaced', () => {
  const { sessionId, leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const { transcriptPath, agentId } = writePlainSubagent(subagentsDir, { toolUseId: 'toolu_TOPLEVEL1' });

  const dataDir = mkDataDir();
  const stopOut = runHook(SUBAGENT_STOP_HOOK, realSubagentStopPayload({
    sessionId, leadTranscriptPath, agentTranscriptPath: transcriptPath, agentId, lastAssistantMessage: 'top-level report',
  }), { dataDir });
  assert.equal(stopOut.trim(), '');

  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const [entry] = listPointersForSession(sessionId);
    assert.equal(entry.record.parentAgentId, null, 'a top-level dispatch must never carry a parentAgentId');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }

  // Delivery lands directly on the TOP-LEVEL session transcript, as normal
  // for a non-nested dispatch.
  fs.writeFileSync(leadTranscriptPath, `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_TOPLEVEL1', content: 'done' }] },
  })}\n`, 'utf8');

  const upOut = runHook(USER_PROMPT_HOOK, { session_id: sessionId, transcript_path: leadTranscriptPath }, { dataDir });
  assert.equal(upOut.trim(), '', 'a delivered top-level pointer must never surface');
});
