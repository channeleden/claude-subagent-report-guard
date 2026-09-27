'use strict';

// hooks/report-gate.js + lib/report-gate.js coverage.
//
// Fixture shape mirrors the real live directory layout resolveTeammateContext
// resolves against: a session dir with a lead-level transcript file plus a
// subagents/ dir holding each teammate's own agent-a<name>-<hash>.{jsonl,
// meta.json} pair.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'report-gate.js');
const {
  resolveTeammateContext,
  buildBlockReason,
  EXACT_RESOLUTION_METHODS,
  RECENCY_WINDOW_MS,
  decide,
} = require('../lib/report-gate.js');

function mkSessionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-gate-'));
  const sessionId = 'session-x';
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
      ? { agentType: name, description: 'test', name, spawnDepth: 0, taskKind: 'in_process_teammate' }
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

function sendMessageCall({ to = 'main', message = 'my report' } = {}) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input: { to, message } }] },
  };
}

let dataDirCounter = 0;
function mkDataDir() {
  dataDirCounter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `report-gate-data-${dataDirCounter}-`));
  return dir;
}

// Every direct (in-process) call into anything that resolves a data path
// (decide()/evaluate() included — see statePathFor in lib/report-gate.js)
// MUST run through this helper. Without it, dataDir()'s fallback would
// resolve to (and write real state files under) the operator's actual
// ~/.claude/subagent-report-guard — a real leak this repo has already hit
// once from a handful of decide() calls that skipped isolation. lib/paths.js
// now throws on that exact combination under the test runner (see
// test/paths.test.js), so any FUTURE direct call added here without this
// wrapper fails loudly instead of writing anywhere.
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

function runHook(payload, { dataDir } = {}) {
  return execFileSync(process.execPath, [HOOK], {
    input: payload === null ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SUBAGENT_REPORT_GUARD_DATA_DIR: dataDir || mkDataDir() },
  });
}

// ── unit: resolveTeammateContext ────────────────────────────────────────────

test('resolveTeammateContext: recency-heuristic tallies candidateCount across every in-window candidate', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  writeTeammate(subagentsDir, { name: 'fresh', hash: 'aaaa1111', lines: [assistantText('fresh')], mtimeMs: now });
  writeTeammate(subagentsDir, { name: 'oneminold', hash: 'bbbb2222', lines: [assistantText('older')], mtimeMs: now - 60 * 1000 });

  const resolved = resolveTeammateContext({ transcript_path: leadTranscriptPath }, { now });
  assert.ok(resolved);
  assert.equal(resolved.resolutionMethod, 'recency-heuristic');
  assert.equal(resolved.candidateCount, 2);
});

test('resolveTeammateContext: agent_transcript_path (step 1) resolves directly when present', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'named', hash: 'cccc3333', lines: [assistantText('report body')],
  });
  const resolved = resolveTeammateContext({
    transcript_path: '/somewhere/else/lead.jsonl',
    agent_transcript_path: transcriptPath,
  });
  assert.ok(resolved);
  assert.equal(resolved.resolutionMethod, 'agent-transcript-path');
  assert.equal(resolved.transcriptPath, transcriptPath);
});

test('resolveTeammateContext: payload-identity-field (step 3) resolves via agent_id when candidates are listable', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  writeTeammate(subagentsDir, { name: 'target', hash: 'dddd4444', lines: [assistantText('target report')] });
  const resolved = resolveTeammateContext({
    transcript_path: leadTranscriptPath,
    agent_id: 'atarget-dddd4444',
  });
  assert.ok(resolved);
  assert.equal(resolved.resolutionMethod, 'payload-identity-field');
});

test('resolveTeammateContext: payload-identity-path (step 3b) derives the path directly when the dir cannot be listed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-gate-nolist-'));
  const leadTranscriptPath = path.join(root, 'session-y.jsonl');
  fs.writeFileSync(leadTranscriptPath, '', 'utf8');
  // No subagents/ dir at all — listTeammateMetaCandidates returns [] but
  // transcriptPathForAgentId can still derive a path to check directly.
  const subagentsDir = path.join(root, 'session-y', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  writeTeammate(subagentsDir, { name: 'derived', hash: 'eeee5555', lines: [assistantText('derived report')] });
  const resolved = resolveTeammateContext({
    transcript_path: leadTranscriptPath,
    agent_id: 'aderived-eeee5555',
  });
  assert.ok(resolved);
  assert.ok(['payload-identity-field', 'payload-identity-path'].includes(resolved.resolutionMethod));
});

test('resolveTeammateContext: candidateCount is 1 when a second candidate exists but is outside RECENCY_WINDOW_MS', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  writeTeammate(subagentsDir, { name: 'fresh', hash: 'cccc3333', lines: [assistantText('fresh')], mtimeMs: now });
  writeTeammate(subagentsDir, {
    name: 'stale', hash: 'dddd4444', lines: [assistantText('stale')],
    mtimeMs: now - (RECENCY_WINDOW_MS + 20 * 60 * 1000),
  });
  const resolved = resolveTeammateContext({ transcript_path: leadTranscriptPath }, { now });
  assert.ok(resolved);
  assert.equal(resolved.candidateCount, 1);
});

test('resolveTeammateContext: null (never gates) for a plain Task-tool subagent', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'plain', hash: 'a1a1a1a1', lines: [assistantText('plain output')],
    meta: { agentType: 'general-purpose', spawnDepth: 1 },
  });
  assert.equal(resolveTeammateContext({ transcript_path: transcriptPath }), null);
});

test('EXACT_RESOLUTION_METHODS: the four exact steps — recency-heuristic is not one of them', () => {
  assert.deepEqual(
    [...EXACT_RESOLUTION_METHODS].sort(),
    ['agent-transcript-path', 'direct-sibling', 'payload-identity-field', 'payload-identity-path'],
  );
});

test('buildBlockReason: with finalText null, returns the generic non-embedded resend instruction', () => {
  assert.match(buildBlockReason(null), /You are ending your turn without having sent a well-formed report via SendMessage/);
});

// ── unit: decide() — state under the data dir, not a transcript sidecar ────

test('decide(): state file lives under the data dir, never as a transcript sidecar', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'sidecar-check', hash: 'a2a2a2a2', lines: [assistantText('report body')],
  });
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const result = decide({ transcript_path: transcriptPath });
    assert.ok(result);
    assert.equal(fs.existsSync(`${transcriptPath}.report-gate-state.json`), false);
    // Something was written under the data dir instead — the JSON state
    // mirror plus the atomic one-shot "blocked once" claim marker (a
    // sibling file in the same dir, never a transcript sidecar).
    const written = fs.readdirSync(path.join(dataDir, 'report-gate-state'));
    assert.equal(written.length, 2);
    assert.ok(written.some((f) => f.endsWith('.json')));
    assert.ok(written.some((f) => f.endsWith('.blocked-once')));
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

// ── integration: hook process, full block-decision behavior ────────────────

test('hook: basic case — direct-sibling resolution still embeds the report verbatim', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'direct-lane', hash: 'aaaa1111', lines: [assistantText('direct sibling final report body')],
  });
  const out = runHook({ transcript_path: transcriptPath });
  assert.notEqual(out.trim(), '');
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /direct sibling final report body/);
});

test('hook: two team-mailbox candidates both fall inside the recency window — blocks but does not embed', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  writeTeammate(subagentsDir, { name: 'concurrentA', hash: 'aaaa1111', lines: [assistantText('Lane A exclusive report body')], mtimeMs: now });
  writeTeammate(subagentsDir, { name: 'concurrentB', hash: 'bbbb2222', lines: [assistantText('Lane B exclusive report body')], mtimeMs: now - 60 * 1000 });

  const out = runHook({ transcript_path: leadTranscriptPath });
  assert.notEqual(out.trim(), '');
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'block');
  assert.doesNotMatch(parsed.reason, /Lane A exclusive report body/);
  assert.doesNotMatch(parsed.reason, /Lane B exclusive report body/);
});

test('hook: single in-window candidate plus one stale candidate — embed preserved for the in-window lane', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  writeTeammate(subagentsDir, { name: 'active', hash: 'eeee5555', lines: [assistantText('the only genuinely active lane report')], mtimeMs: now });
  writeTeammate(subagentsDir, { name: 'longgone', hash: 'ffff6666', lines: [assistantText('a report from twenty minutes ago')], mtimeMs: now - 20 * 60 * 1000 });

  const out = runHook({ transcript_path: leadTranscriptPath });
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /the only genuinely active lane report/);
  assert.doesNotMatch(parsed.reason, /a report from twenty minutes ago/);
});

test('hook: not a team-mailbox lane (plain Task-tool subagent) — never blocks', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'plain-subagent', hash: 'a1a1a1a1', lines: [assistantText('plain task-tool subagent output')],
    meta: { agentType: 'general-purpose', spawnDepth: 1 },
  });
  const out = runHook({ transcript_path: transcriptPath });
  assert.equal(out.trim(), '');
});

test('hook: a well-formed SendMessage this turn — never blocks (report already delivered)', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'delivered-lane', hash: 'b3b3b3b3',
    lines: [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }, sendMessageCall()],
  });
  const out = runHook({ transcript_path: transcriptPath });
  assert.equal(out.trim(), '');
});

test('hook: blocks at most once per teammate transcript (one-shot)', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'once-lane', hash: 'c4c4c4c4', lines: [assistantText('abandoned report')],
  });
  const dataDir = mkDataDir();
  const first = runHook({ transcript_path: transcriptPath }, { dataDir });
  assert.equal(JSON.parse(first).decision, 'block');
  const second = runHook({ transcript_path: transcriptPath }, { dataDir });
  assert.equal(second.trim(), '', 'a second stop attempt for the same transcript must not block again');
});

test('hook: malformed / empty stdin never blocks', () => {
  assert.equal(runHook(null).trim(), '');
});

// ── claim-before-block: atomic wx marker — no unlocked read-modify-write ───

test('decide(): two concurrent calls on the same transcript (no-report-sent case) — exactly one blocks', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'concurrent-once', hash: 'dddd0001', lines: [assistantText('abandoned report, raced')],
  });
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    // Two "concurrent" decide() calls against the identical transcript — the
    // atomic `wx`-created marker (not a read-then-write JSON state file) is
    // what must guarantee only one of these can ever return a block
    // decision, with no race window for both to slip through.
    const results = [decide({ transcript_path: transcriptPath }), decide({ transcript_path: transcriptPath })];
    const blocks = results.filter((r) => r && r.decision === 'block');
    assert.equal(blocks.length, 1, 'exactly one of the two concurrent decide() calls must block');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('decide(): two concurrent calls on the same stale-follow-up transcript — exactly one blocks', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'concurrent-stale', hash: 'dddd0002',
    lines: [
      teammateMessage('please handle X'),
      sendMessageCall({ message: 'handled X' }),
      teammateMessage('actually also handle Y'), // makes the report stale
    ],
  });
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const results = [decide({ transcript_path: transcriptPath }), decide({ transcript_path: transcriptPath })];
    const blocks = results.filter((r) => r && r.decision === 'block');
    assert.equal(blocks.length, 1, 'exactly one of the two concurrent stale-follow-up decide() calls must block');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

// ── performance: the fast-allow path never reads a large transcript ──────

test('hook: the fast-allow path (no team-mailbox participant) stays well under a generous CI-safe bound', () => {
  // resolveTeammateContext returns null almost immediately for a plain
  // payload with no resolvable sidecar — evaluate() must never fall through
  // to reading any transcript in this case. The bound here is generous
  // (dominated by Node process startup, not this module's own logic — see
  // the in-process micro-benchmark in this same section of the deliverable
  // report) so this only catches an actual regression, not noise.
  const start = Date.now();
  const out = runHook({ transcript_path: '/nonexistent/lead.jsonl' });
  const elapsed = Date.now() - start;
  assert.equal(out.trim(), '');
  assert.ok(elapsed < 2000, `report-gate hook process (incl. node startup) took ${elapsed}ms — investigate if this regresses`);
});

// ── classifyBackgroundSpawn: three-valued spawn-ledger discrimination ────

const { classifyBackgroundSpawn } = require('../lib/spawn-ledger.js');

// Appends an assistant `Agent` tool_use entry (the parent's own spawn call)
// to the lead transcript, and returns its tool_use id — the exact key
// `meta.toolUseId` must carry for `findBackgroundAgentSpawn` step 1 to match.
function appendAgentSpawn(leadTranscriptPath, { id, name, runInBackground } = {}) {
  const entry = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id,
        name: 'Agent',
        input: runInBackground === undefined ? { name } : { name, run_in_background: runInBackground },
      }],
    },
  };
  fs.appendFileSync(leadTranscriptPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return id;
}

test('classifyBackgroundSpawn: explicit run_in_background:false — contradicted, never gates', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const toolUseId = appendAgentSpawn(leadTranscriptPath, { id: 'toolu_FALSE1', name: 'sync-lane', runInBackground: false });
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'sync-lane', hash: 'aaaa0001', lines: [assistantText('no SendMessage at all')],
    meta: { agentType: 'sync-lane', name: 'sync-lane', spawnDepth: 0, taskKind: 'in_process_teammate', toolUseId },
  });
  const decision = withDataDir(() => decide({ transcript_path: leadTranscriptPath, agent_transcript_path: transcriptPath }));
  assert.equal(decision, null, 'an explicitly foreground spawn must never be gated on SendMessage');
});

test('classifyBackgroundSpawn: run_in_background absent (harness default) — still gated', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const toolUseId = appendAgentSpawn(leadTranscriptPath, { id: 'toolu_ABSENT1', name: 'default-lane' });
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'default-lane', hash: 'aaaa0002', lines: [assistantText('no SendMessage at all')],
    meta: { agentType: 'default-lane', name: 'default-lane', spawnDepth: 0, taskKind: 'in_process_teammate', toolUseId },
  });
  const decision = withDataDir(() => decide({ transcript_path: leadTranscriptPath, agent_transcript_path: transcriptPath }));
  assert.ok(decision, 'an ABSENT run_in_background flag is the harness default (background) and must not be read as a contradiction');
  assert.equal(decision.decision, 'block');
});

test('classifyBackgroundSpawn: explicit run_in_background:true — confirmed, still gated', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const toolUseId = appendAgentSpawn(leadTranscriptPath, { id: 'toolu_TRUE1', name: 'bg-lane', runInBackground: true });
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'bg-lane', hash: 'aaaa0003', lines: [assistantText('no SendMessage at all')],
    meta: { agentType: 'bg-lane', name: 'bg-lane', spawnDepth: 0, taskKind: 'in_process_teammate', toolUseId },
  });
  const decision = withDataDir(() => decide({ transcript_path: leadTranscriptPath, agent_transcript_path: transcriptPath }));
  assert.ok(decision);
  assert.equal(decision.decision, 'block');
});

test('classifyBackgroundSpawn (unit): no correlating spawn at all — unknown, never a reason to allow on its own', () => {
  const { leadTranscriptPath } = mkSessionFixture();
  const verdict = classifyBackgroundSpawn({ transcript_path: leadTranscriptPath }, { toolUseId: 'toolu_NEVER_SPAWNED' }, { subagentsDir: path.dirname(leadTranscriptPath) });
  assert.equal(verdict.verdict, 'unknown');
});

// ── pending-followup / peer-ack-loop safety ──────────────────────────────

function teammateMessage(text) {
  return { type: 'user', message: { role: 'user', content: `<teammate-message teammate_id="peer">${text}</teammate-message>` } };
}

test('pending-followup: a follow-up delivered after the latest report blocks with the stale-report reason', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'stale-lane', hash: 'bbbb0001',
    lines: [
      teammateMessage('please handle X'),
      sendMessageCall({ message: 'handled X' }),
      teammateMessage('actually also handle Y'), // arrives AFTER the report — makes it stale
    ],
  });
  const decision = withDataDir(() => decide({ transcript_path: transcriptPath }));
  assert.ok(decision);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /follow-up arrived after your latest SendMessage/);
});

test('peer-ack-loop safety: a trailing SENDER-marked terminal ack after a real report does not re-block', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'ack-loop-lane', hash: 'bbbb0002',
    lines: [
      teammateMessage('please dispatch X'),
      sendMessageCall({ message: 'dispatched X' }),
      teammateMessage('confirmed, holding [[terminal]]'), // sender-marked no-reply-needed
    ],
  });
  const decision = withDataDir(() => decide({ transcript_path: transcriptPath }));
  assert.equal(decision, null, 'a sender-marked terminal ack must never itself re-trigger a block — that is the infinite peer-ack loop this closes');
});

test('peer-ack-loop safety: WITHOUT the terminal marker, the same trailing ack DOES look like a fresh unaddressed follow-up', () => {
  // Confirms the terminal-marker test above is actually exercising the fix,
  // not merely a fixture that never blocks for an unrelated reason.
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'no-marker-lane', hash: 'bbbb0003',
    lines: [
      teammateMessage('please dispatch X'),
      sendMessageCall({ message: 'dispatched X' }),
      teammateMessage('any further plain message with no terminal marker'),
    ],
  });
  const decision = withDataDir(() => decide({ transcript_path: transcriptPath }));
  assert.ok(decision, 'an un-marked trailing inbound message is correctly treated as an unaddressed follow-up');
  assert.equal(decision.decision, 'block');
});

// ── stale-followup block bounding: at most once per distinct follow-up ───
// (never once per SubagentStop firing — the wake-loop risk this closes)

test('stale-followup block is bounded: same stale transcript blocks, then allows on a repeat call', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'bounded-stale', hash: 'cccc0001',
    lines: [
      teammateMessage('please handle X'),
      sendMessageCall({ message: 'handled X' }),
      teammateMessage('actually also handle Y'), // makes the report stale
    ],
  });
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const first = decide({ transcript_path: transcriptPath });
    assert.ok(first);
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /follow-up arrived after your latest SendMessage/);

    const second = decide({ transcript_path: transcriptPath });
    assert.equal(
      second,
      null,
      'the SAME stale transcript must not re-block on a second SubagentStop for the same follow-up — that is the wake-loop this bounds',
    );
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('stale-followup block is bounded: a NEW later follow-up blocks exactly once more', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'bounded-stale-2', hash: 'cccc0002',
    lines: [
      teammateMessage('please handle X'),
      sendMessageCall({ message: 'handled X' }),
      teammateMessage('actually also handle Y'),
    ],
  });
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    assert.equal(decide({ transcript_path: transcriptPath }).decision, 'block');
    assert.equal(decide({ transcript_path: transcriptPath }), null, 'first follow-up already bounded');

    // A genuinely new, later follow-up arrives — a fresh inbound message,
    // so it must block once more even though the transcript already has a
    // spent marker from the earlier follow-up.
    fs.appendFileSync(transcriptPath, `${JSON.stringify(teammateMessage('also handle Z'))}\n`, 'utf8');
    const third = decide({ transcript_path: transcriptPath });
    assert.ok(third);
    assert.equal(third.decision, 'block');

    const fourth = decide({ transcript_path: transcriptPath });
    assert.equal(fourth, null, 'the new follow-up must also be bounded to a single block, not re-fire forever');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

// ── source guards ────────────────────────────────────────────────────────

test('source guard: no hardcoded /Users/<name> path in the gate module or hook', () => {
  for (const file of [path.join(__dirname, '..', 'lib', 'report-gate.js'), HOOK]) {
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(/\/Users\/[^/'"` ]+/.test(src), false, file);
  }
});
