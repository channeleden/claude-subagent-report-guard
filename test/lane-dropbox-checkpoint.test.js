'use strict';

// lane-dropbox-checkpoint.js coverage.
//
// Fixture shape mirrors the real live directory layout
// resolveTeammateContext resolves against: a session dir with a
// lead-level transcript file plus a subagents/ dir holding each teammate's
// own agent-a<name>-<hash>.{jsonl, meta.json} pair.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'lane-dropbox-checkpoint.js');
const { deriveLaneId } = require('../hooks/lane-dropbox-checkpoint.js');
const { readLaneRecords } = require('../lib/lane-dropbox.js');

function mkSessionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-checkpoint-'));
  const sessionId = 'team-session-x';
  const leadTranscriptPath = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(leadTranscriptPath, '', 'utf8');
  const subagentsDir = path.join(root, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  return { root, sessionId, leadTranscriptPath, subagentsDir };
}

function writeTeammate(subagentsDir, { name, hash, meta, lines, mtimeMs }) {
  const transcriptPath = path.join(subagentsDir, `agent-a${name}-${hash}.jsonl`);
  const metaPath = path.join(subagentsDir, `agent-a${name}-${hash}.meta.json`);
  fs.writeFileSync(transcriptPath, `${(lines || []).map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  fs.writeFileSync(
    metaPath,
    JSON.stringify(meta === undefined
      ? { agentType: name, description: 'test', name, spawnDepth: 0, model: 'sonnet', taskKind: 'in_process_teammate', teamName: 'session-test', color: 'green', planModeRequired: false, permissionMode: 'bypassPermissions' }
      : meta),
    'utf8',
  );
  if (typeof mtimeMs === 'number') {
    const t = new Date(mtimeMs);
    fs.utimesSync(transcriptPath, t, t);
    fs.utimesSync(metaPath, t, t);
  }
  return { transcriptPath, metaPath };
}

function assistantText(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function runHook(payload, env = {}) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: payload === null ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return out;
}

// ── unit: deriveLaneId ──────────────────────────────────────────────────

test('deriveLaneId: prefers the top-level candidate agentName field when present', () => {
  assert.equal(deriveLaneId({ agentName: 'candidate-name', meta: { name: 'meta-name' } }), 'candidate-name');
});

test('deriveLaneId: falls back to meta.name when no top-level agentName exists (direct-sibling shape)', () => {
  assert.equal(deriveLaneId({ meta: { name: 'meta-name' } }), 'meta-name');
});

test('deriveLaneId: returns null when neither field is a non-empty string', () => {
  assert.equal(deriveLaneId({}), null);
  assert.equal(deriveLaneId({ agentName: '', meta: {} }), null);
});

// ── integration: hook process, both resolution shapes ────────────────────

test('hook: direct-sibling resolution — payload.transcript_path already points at the teammate file', () => {
  const { subagentsDir, sessionId } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'direct-lane', hash: 'aaaa1111',
    lines: [assistantText('direct sibling final report')],
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-checkpoint-home-'));

  const out = runHook(
    { transcript_path: transcriptPath, session_id: sessionId },
    { HOME: home },
  );
  assert.equal(out, '', 'this hook must never write a decision/stdout payload — silence is correct');

  const records = readLaneRecords(path.join(teamDirForHome(home, sessionId), 'dropbox', 'direct-lane.jsonl'));
  assert.equal(records.length, 1);
  assert.equal(records[0].record_type, 'checkpoint');
  assert.equal(records[0].report_text, 'direct sibling final report');
  assert.equal(records[0].resolution_method, 'direct-sibling');
});

test('hook: candidate-resolution (recency-heuristic) — payload.transcript_path is the LEAD file (live production shape)', () => {
  const { leadTranscriptPath, subagentsDir, sessionId } = mkSessionFixture();
  writeTeammate(subagentsDir, {
    name: 'recency-lane', hash: 'bbbb2222',
    lines: [assistantText('recency heuristic final report')],
    mtimeMs: Date.now(),
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-checkpoint-home-'));

  const out = runHook(
    { transcript_path: leadTranscriptPath, session_id: sessionId },
    { HOME: home },
  );
  assert.equal(out, '');

  const records = readLaneRecords(path.join(teamDirForHome(home, sessionId), 'dropbox', 'recency-lane.jsonl'));
  assert.equal(records.length, 1);
  assert.equal(records[0].report_text, 'recency heuristic final report');
  assert.equal(records[0].resolution_method, 'recency-heuristic');
});

test('hook: not a team-mailbox lane (plain Task-tool subagent) — exit 0, no-op, no dropbox file created', () => {
  const { subagentsDir, sessionId } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'plain-subagent', hash: 'cccc3333',
    lines: [assistantText('plain task-tool subagent output')],
    meta: { agentType: 'general-purpose', spawnDepth: 1 }, // no taskKind: 'in_process_teammate'
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-checkpoint-home-'));

  const out = runHook({ transcript_path: transcriptPath, session_id: sessionId }, { HOME: home });
  assert.equal(out, '');
  assert.equal(fs.existsSync(path.join(teamDirForHome(home, sessionId), 'dropbox')), false);
});

test('hook: missing/unparseable stdin payload fails open, no throw, no write', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-checkpoint-home-'));
  assert.doesNotThrow(() => runHook(null, { HOME: home }));
  const out = execFileSync(process.execPath, [HOOK], { input: 'not json {{{', encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(out, '');
});

test('hook: missing session_id fails open (never guesses a session directory)', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'no-session', hash: 'dddd4444',
    lines: [assistantText('report')],
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-checkpoint-home-'));
  const out = runHook({ transcript_path: transcriptPath }, { HOME: home });
  assert.equal(out, '');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'teams')), false);
});

test('hook: repeat firing with no new transcript content produces zero duplicate checkpoint records', () => {
  const { subagentsDir, sessionId } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'dedupe-lane', hash: 'eeee5555',
    lines: [assistantText('one and only report')],
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-checkpoint-home-'));

  runHook({ transcript_path: transcriptPath, session_id: sessionId }, { HOME: home });
  runHook({ transcript_path: transcriptPath, session_id: sessionId }, { HOME: home });

  const records = readLaneRecords(path.join(teamDirForHome(home, sessionId), 'dropbox', 'dedupe-lane.jsonl'));
  assert.equal(records.filter((r) => r.record_type === 'checkpoint').length, 1);
});

test('hook: two concurrently dispatched lanes each get their own <lane_id>.jsonl', () => {
  const { subagentsDir, sessionId } = mkSessionFixture();
  const laneA = writeTeammate(subagentsDir, { name: 'multi-a', hash: 'f0f0f0f0', lines: [assistantText('report A')] });
  const laneB = writeTeammate(subagentsDir, { name: 'multi-b', hash: 'e0e0e0e0', lines: [assistantText('report B')] });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-checkpoint-home-'));

  runHook({ transcript_path: laneA.transcriptPath, session_id: sessionId }, { HOME: home });
  runHook({ transcript_path: laneB.transcriptPath, session_id: sessionId }, { HOME: home });

  const dropboxDir = path.join(teamDirForHome(home, sessionId), 'dropbox');
  const [recA] = readLaneRecords(path.join(dropboxDir, 'multi-a.jsonl'));
  const [recB] = readLaneRecords(path.join(dropboxDir, 'multi-b.jsonl'));
  assert.equal(recA.report_text, 'report A');
  assert.equal(recB.report_text, 'report B');
});

function teamDirForHome(home, sessionId) {
  return path.join(home, '.claude', 'teams', sessionId);
}

// ── source guards ─────────────────────────────────────────────────────────

test('source guard: this hook never imports subagent-transcript.js directly (that import lives only in lane-dropbox.js)', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  // Scoped to actual require() calls, not doc-comment prose describing the
  // constraint (this file's own header explains the rule by name).
  assert.equal(/require\([^)]*subagent-transcript/.test(src), false);
});

test('source guard: no operator-specific hardcoded /Users/<name> path in this hook file', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.equal(/\/Users\/[^/'"` ]+/.test(src), false);
});
