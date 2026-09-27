'use strict';

// Integration coverage for the "unread-message drop" gate: a lead sends a
// teammate a message via SendMessage while the teammate is on its final
// turn. SendMessage reports success, but if the teammate ends its turn
// with no further tool round, the message is never drained this
// session — this is lib/report-gate.js's `computeUnreadInboxOutcome` +
// lib/inbox-gate.js's `readUnreadInboxMessages`, wired into the same
// SubagentStop gate that already blocks a missing report.
//
// Builds on the SAME real-shape fixture tree
// test/report-gate-real-shape.test.js uses (agent.meta.json carries
// `name: "gate-live-test"`, `teamName: "session-00000000"` — see that
// file's own header for provenance), with an added team inbox file under
// SUBAGENT_REPORT_GUARD_TEAMS_ROOT (never the real HOME/~/.claude/teams).

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'report-gate.js');
const UPS_HOOK = path.join(__dirname, '..', 'hooks', 'orphan-pointers-user-prompt-submit.js');
const { evaluate } = require('../lib/report-gate.js');
const { listUnreadInboxNoticesForSession } = require('../lib/orphan-pointers.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'real-shape-2026-09-27');
const AGENT_ID = 'agate-live-test-2af58222c03b1047';
const SESSION_ID = 'session-00000000';
const TEAM_NAME = 'session-00000000'; // matches agent.meta.json's teamName
const TEAMMATE_NAME = 'gate-live-test'; // matches agent.meta.json's name

function readFixtureLines(name) {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
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

function mkRealShapeSession({ extraLines = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-gate-unread-inbox-'));
  const leadTranscriptPath = path.join(root, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(leadTranscriptPath, '', 'utf8');
  const subagentsDir = path.join(root, SESSION_ID, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });

  const transcriptPath = path.join(subagentsDir, `agent-${AGENT_ID}.jsonl`);
  const metaPath = path.join(subagentsDir, `agent-${AGENT_ID}.meta.json`);
  const lines = [...readFixtureLines('agent-transcript.jsonl'), ...extraLines];
  fs.writeFileSync(transcriptPath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify(readFixtureJson('agent.meta.json')), 'utf8');

  return { root, leadTranscriptPath, transcriptPath, metaPath };
}

function realShapePayload({ transcriptPath, leadTranscriptPath }) {
  return {
    agent_id: AGENT_ID,
    agent_transcript_path: transcriptPath,
    agent_type: null,
    hook_event_name: 'SubagentStop',
    last_assistant_message: 'gate test done',
    session_id: SESSION_ID,
    transcript_path: leadTranscriptPath,
  };
}

let dataDirCounter = 0;
function mkDataDir() {
  dataDirCounter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `report-gate-unread-inbox-data-${dataDirCounter}-`));
}

function mkTeamsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'report-gate-unread-inbox-teams-'));
}

function writeInbox(teamsRoot, fixtureName) {
  const dir = path.join(teamsRoot, TEAM_NAME, 'inboxes');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_DIR, fixtureName), path.join(dir, `${TEAMMATE_NAME}.json`));
}

function withEnv(overrides, fn) {
  const prev = {};
  for (const k of Object.keys(overrides)) prev[k] = process.env[k];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ── (a) unread inbox -> block once ──────────────────────────────────────

test('unread inbox: a well-formed report AND an unread, unrelated inbox message -> still blocks once (inbox check is independent)', () => {
  const dataDir = mkDataDir();
  const teamsRoot = mkTeamsRoot();
  writeInbox(teamsRoot, 'team-inbox-unread.json');
  withEnv({ SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir, SUBAGENT_REPORT_GUARD_TEAMS_ROOT: teamsRoot }, () => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession({ extraLines: [sendMessageEntry()] });
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });
    const result = evaluate(payload);
    assert.ok(result);
    assert.equal(result.delivered, true, 'the report itself WAS delivered');
    assert.ok(result.gateResult, 'but the stop is still blocked, for the unread inbox');
    assert.equal(result.gateResult.decision, 'block');
    assert.match(result.gateResult.reason, /unread message/);
    assert.match(result.gateResult.reason, /team-lead/);
    assert.equal(result.unreadCount, 1);
    assert.equal(result.inboxOutcome, 'block-unread-inbox');
  });
});

// ── (b) same unread set again -> allow ──────────────────────────────────

test('unread inbox: the SAME unread set on a second stop -> allow (one-shot, no wake-loop)', () => {
  const dataDir = mkDataDir();
  const teamsRoot = mkTeamsRoot();
  writeInbox(teamsRoot, 'team-inbox-unread.json');
  withEnv({ SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir, SUBAGENT_REPORT_GUARD_TEAMS_ROOT: teamsRoot }, () => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession({ extraLines: [sendMessageEntry()] });
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });

    const first = evaluate(payload);
    assert.equal(first.gateResult.decision, 'block');

    const second = evaluate(payload);
    assert.equal(second.gateResult, null, 'the identical unread set must not re-block');
    assert.equal(second.inboxOutcome, 'allow-unread-inbox-already-blocked');
    assert.equal(second.unreadCount, 1);
  });
});

// ── (c) a new unread message -> blocks again ────────────────────────────

test('unread inbox: a genuinely NEW unread message after the first block -> blocks once more', () => {
  const dataDir = mkDataDir();
  const teamsRoot = mkTeamsRoot();
  writeInbox(teamsRoot, 'team-inbox-unread.json');
  withEnv({ SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir, SUBAGENT_REPORT_GUARD_TEAMS_ROOT: teamsRoot }, () => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession({ extraLines: [sendMessageEntry()] });
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });

    const first = evaluate(payload);
    assert.equal(first.gateResult.decision, 'block');

    // A second, genuinely new message lands in the inbox.
    const inboxPath = path.join(teamsRoot, TEAM_NAME, 'inboxes', `${TEAMMATE_NAME}.json`);
    const existing = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    existing.push({
      from: 'team-lead', text: 'One more thing', summary: 'One more thing',
      timestamp: '2026-09-27T09:00:00.000Z', msgV: 1, msg_id: '00000000-0000-4000-8000-000000000002',
      type: 'message', read: false,
    });
    fs.writeFileSync(inboxPath, JSON.stringify(existing), 'utf8');

    const third = evaluate(payload);
    assert.ok(third.gateResult, 'a new unread message must block again');
    assert.equal(third.gateResult.decision, 'block');
    assert.equal(third.unreadCount, 2);
    assert.equal(third.inboxOutcome, 'block-unread-inbox');
  });
});

// ── (d) all read -> no-op ───────────────────────────────────────────────

test('unread inbox: every message already read -> no-op, no block, no unread count', () => {
  const dataDir = mkDataDir();
  const teamsRoot = mkTeamsRoot();
  writeInbox(teamsRoot, 'team-inbox-read.json');
  withEnv({ SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir, SUBAGENT_REPORT_GUARD_TEAMS_ROOT: teamsRoot }, () => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession({ extraLines: [sendMessageEntry()] });
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });
    const result = evaluate(payload);
    assert.equal(result.gateResult, null);
    assert.equal(result.unreadCount, 0);
    assert.equal(result.inboxOutcome, null);
  });
});

// ── (e) malformed / missing inbox -> no-op ──────────────────────────────

test('unread inbox: malformed inbox JSON -> no-op, never throws, never blocks', () => {
  const dataDir = mkDataDir();
  const teamsRoot = mkTeamsRoot();
  const dir = path.join(teamsRoot, TEAM_NAME, 'inboxes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${TEAMMATE_NAME}.json`), 'not valid json{{{', 'utf8');
  withEnv({ SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir, SUBAGENT_REPORT_GUARD_TEAMS_ROOT: teamsRoot }, () => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession({ extraLines: [sendMessageEntry()] });
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });
    const result = evaluate(payload);
    assert.equal(result.gateResult, null);
    assert.equal(result.unreadCount, 0);
  });
});

test('unread inbox: no inbox file at all (teammate never received mail) -> no-op', () => {
  const dataDir = mkDataDir();
  const teamsRoot = mkTeamsRoot(); // empty, no inbox written
  withEnv({ SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir, SUBAGENT_REPORT_GUARD_TEAMS_ROOT: teamsRoot }, () => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession({ extraLines: [sendMessageEntry()] });
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });
    const result = evaluate(payload);
    assert.equal(result.gateResult, null);
    assert.equal(result.unreadCount, 0);
  });
});

// ── (f) combined with the missing-report block -> a single block ───────

test('unread inbox: combined with the missing-report block -> exactly one gateResult, both reasons present', () => {
  const dataDir = mkDataDir();
  const teamsRoot = mkTeamsRoot();
  writeInbox(teamsRoot, 'team-inbox-unread.json');
  withEnv({ SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir, SUBAGENT_REPORT_GUARD_TEAMS_ROOT: teamsRoot }, () => {
    // No SendMessage appended -> the report-delivery gate also has a reason.
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession();
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });
    const result = evaluate(payload);
    assert.ok(result.gateResult);
    assert.equal(result.gateResult.decision, 'block');
    assert.match(result.gateResult.reason, /gate test done/, 'missing-report reason present');
    assert.match(result.gateResult.reason, /unread message/, 'unread-inbox reason present');
    assert.equal(result.reportBlocked, true);
    assert.equal(result.inboxOutcome, 'block-unread-inbox');

    // Each side's own bookkeeping is independent: a second call with the
    // SAME transcript + SAME inbox allows on BOTH counts, not just one.
    const second = evaluate(payload);
    assert.equal(second.gateResult, null);
  });
});

// ── (g) end-to-end: the hook, outcome logging ───────────────────────────

test('unread inbox E2E hook: outcome "block-unread-inbox" when the inbox is the ONLY reason to block', () => {
  const { transcriptPath, leadTranscriptPath } = mkRealShapeSession({ extraLines: [sendMessageEntry()] });
  const dataDir = mkDataDir();
  const teamsRoot = mkTeamsRoot();
  writeInbox(teamsRoot, 'team-inbox-unread.json');
  const logPath = path.join(mkDataDir(), 'invocations.log');
  const payload = realShapePayload({ transcriptPath, leadTranscriptPath });

  const env = {
    ...process.env,
    SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir,
    SUBAGENT_REPORT_GUARD_TEAMS_ROOT: teamsRoot,
    SUBAGENT_REPORT_GUARD_LOG_PATH: logPath,
  };
  const stdout = execFileSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env });
  const decision = JSON.parse(stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /unread message/);

  const [line] = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.equal(line.outcome, 'block-unread-inbox');
  assert.equal(line.unread_count, 1);
  assert.equal(line.inbox_outcome, 'block-unread-inbox');
});

// ── (h) lead surfacing after the one-shot block was already used ───────

test('unread inbox: a stop with unread messages AFTER the one-shot block was used surfaces a line to the lead exactly once', () => {
  const dataDir = mkDataDir();
  const teamsRoot = mkTeamsRoot();
  writeInbox(teamsRoot, 'team-inbox-unread.json');

  withEnv({ SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir, SUBAGENT_REPORT_GUARD_TEAMS_ROOT: teamsRoot }, () => {
    const { transcriptPath, leadTranscriptPath } = mkRealShapeSession({ extraLines: [sendMessageEntry()] });
    const payload = realShapePayload({ transcriptPath, leadTranscriptPath });

    // First stop: blocks once (uses up the one-shot marker).
    const first = evaluate(payload);
    assert.equal(first.gateResult.decision, 'block');

    // Second stop, same unread set: allowed, but still unread -> the hook
    // (not evaluate() directly) is what writes the lead notice, so run it
    // as a real child process exactly like the harness would.
    const logPath = path.join(mkDataDir(), 'invocations.log');
    const env = {
      ...process.env,
      SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir,
      SUBAGENT_REPORT_GUARD_TEAMS_ROOT: teamsRoot,
      SUBAGENT_REPORT_GUARD_LOG_PATH: logPath,
    };
    const stdout = execFileSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env });
    assert.equal(stdout.trim(), '', 'an allow decision writes no stdout payload');

    const notices = listUnreadInboxNoticesForSession(SESSION_ID);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].record.agentName, TEAMMATE_NAME);
    assert.equal(notices[0].record.unreadCount, 1);

    // Now the lead's own UserPromptSubmit hook must surface it, exactly once.
    const upsPayload = { session_id: SESSION_ID, prompt: 'what is the status?' };
    const upsStdout1 = execFileSync(process.execPath, [UPS_HOOK], {
      input: JSON.stringify(upsPayload), encoding: 'utf8', env,
    });
    assert.notEqual(upsStdout1.trim(), '');
    const parsed1 = JSON.parse(upsStdout1);
    assert.match(parsed1.hookSpecificOutput.additionalContext, /unread inbox messages/);
    assert.match(parsed1.hookSpecificOutput.additionalContext, new RegExp(TEAMMATE_NAME));
    assert.match(parsed1.hookSpecificOutput.additionalContext, /re-send or follow up/);

    // A second UserPromptSubmit must NOT surface the same notice again.
    const upsStdout2 = execFileSync(process.execPath, [UPS_HOOK], {
      input: JSON.stringify(upsPayload), encoding: 'utf8', env,
    });
    assert.equal(upsStdout2.trim(), '', 'the same notice must never surface twice');
  });
});
