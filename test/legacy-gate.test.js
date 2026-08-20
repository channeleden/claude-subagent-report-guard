'use strict';

// legacy-gate/hook.js coverage.
//
// Fixture shape mirrors the real live directory layout resolveTeammateContext
// resolves against (same convention as test/lane-dropbox-checkpoint.test.js):
// a session dir with a lead-level transcript file plus a subagents/ dir
// holding each teammate's own agent-a<name>-<hash>.{jsonl, meta.json} pair.
//
// Focus of this file: the concurrent-lane embed guard. `resolveTeammateContext`'s
// step 3 (recency heuristic) now tallies how many candidates land inside the
// recency window, not just which one wins, and `main()` only embeds the
// resolved transcript's text verbatim in the block reason when that count is
// exactly 1 — the ordinary case, where nothing else could be confused with
// the winner. With 2+ in-window candidates, the hook still blocks the stop,
// it just falls back to the generic, non-embedded resend instruction instead
// of risking a verbatim quote from the wrong lane.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'legacy-gate', 'hook.js');
const {
  resolveTeammateContext,
  buildStage1Reason,
  EXACT_RESOLUTION_METHODS,
  RECENCY_WINDOW_MS,
} = require('../legacy-gate/hook.js');

function mkSessionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-gate-'));
  const sessionId = 'legacy-session-x';
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

function runHook(payload) {
  return execFileSync(process.execPath, [HOOK], {
    input: payload === null ? '' : JSON.stringify(payload),
    encoding: 'utf8',
  });
}

// ── unit: resolveTeammateContext's candidateCount tally ────────────────────

test('resolveTeammateContext: recency-heuristic tallies candidateCount across every in-window candidate, not just the winner', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  writeTeammate(subagentsDir, {
    name: 'fresh', hash: 'aaaa1111', lines: [assistantText('fresh lane report')], mtimeMs: now,
  });
  writeTeammate(subagentsDir, {
    name: 'oneminold', hash: 'bbbb2222', lines: [assistantText('one-minute-old lane report')], mtimeMs: now - 60 * 1000,
  });

  const resolved = resolveTeammateContext({ transcript_path: leadTranscriptPath }, { now });
  assert.ok(resolved, 'expected a resolution — both candidates are well within the recency window');
  assert.equal(resolved.resolutionMethod, 'recency-heuristic');
  assert.equal(resolved.candidateCount, 2, 'both in-window candidates must be counted, not just the mtime winner');
});

test('resolveTeammateContext: candidateCount is 1 when a second candidate exists but is outside RECENCY_WINDOW_MS', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  writeTeammate(subagentsDir, {
    name: 'fresh', hash: 'cccc3333', lines: [assistantText('fresh lane report')], mtimeMs: now,
  });
  writeTeammate(subagentsDir, {
    name: 'stale', hash: 'dddd4444', lines: [assistantText('stale lane report')], mtimeMs: now - (RECENCY_WINDOW_MS + 20 * 60 * 1000),
  });

  const resolved = resolveTeammateContext({ transcript_path: leadTranscriptPath }, { now });
  assert.ok(resolved);
  assert.equal(resolved.resolutionMethod, 'recency-heuristic');
  assert.equal(resolved.candidateCount, 1, 'a candidate outside the recency window must not inflate the count');
});

test('EXACT_RESOLUTION_METHODS: exactly the two exact steps for this file\'s 3-step model — recency-heuristic is not exact', () => {
  assert.deepEqual(
    [...EXACT_RESOLUTION_METHODS].sort(),
    ['direct-sibling', 'payload-identity-field'],
  );
});

test('buildStage1Reason: with finalText null, returns the generic non-embedded resend instruction', () => {
  const reason = buildStage1Reason(null);
  assert.match(reason, /You are ending your turn without having sent a well-formed report via SendMessage/);
});

// ── integration: hook process, full block-decision behavior ────────────────

test('hook: basic case — direct-sibling resolution still embeds the report verbatim (regression guard)', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'direct-lane', hash: 'aaaa1111',
    lines: [assistantText('direct sibling final report body')],
  });

  const out = runHook({ transcript_path: transcriptPath });
  assert.notEqual(out.trim(), '', 'a genuinely undelivered report from a team-mailbox lane must block');
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /direct sibling final report body/, 'exact-resolution (direct-sibling) must still embed verbatim');
});

test('hook: two team-mailbox candidates both fall inside the recency window — still blocks, but does NOT embed either transcript verbatim', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  writeTeammate(subagentsDir, {
    name: 'concurrentA', hash: 'aaaa1111',
    lines: [assistantText('Lane A exclusive report body')],
    mtimeMs: now,
  });
  writeTeammate(subagentsDir, {
    name: 'concurrentB', hash: 'bbbb2222',
    lines: [assistantText('Lane B exclusive report body')],
    mtimeMs: now - 60 * 1000, // one minute old — well under the 10-minute window, NOT a near-tie
  });

  const out = runHook({ transcript_path: leadTranscriptPath });
  assert.notEqual(out.trim(), '', 'genuinely concurrent lanes must still be blocked — the decision does not need certainty about identity');
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'block');
  assert.doesNotMatch(parsed.reason, /Lane A exclusive report body/, 'must not guess-embed lane A\'s text');
  assert.doesNotMatch(parsed.reason, /Lane B exclusive report body/, 'must not guess-embed lane B\'s text');
  assert.match(
    parsed.reason,
    /You are ending your turn without having sent a well-formed report via SendMessage/,
    'must fall back to the generic, non-embedded instruction instead of guessing which lane the text belongs to',
  );
});

test('hook: single in-window candidate plus one stale (outside RECENCY_WINDOW_MS) candidate — embed is preserved for the in-window lane', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  writeTeammate(subagentsDir, {
    name: 'active', hash: 'eeee5555',
    lines: [assistantText('the only genuinely active lane report')],
    mtimeMs: now,
  });
  writeTeammate(subagentsDir, {
    name: 'longgone', hash: 'ffff6666',
    lines: [assistantText('a report from twenty minutes ago')],
    mtimeMs: now - 20 * 60 * 1000, // 20 minutes old vs the default 10-minute window
  });

  const out = runHook({ transcript_path: leadTranscriptPath });
  assert.notEqual(out.trim(), '');
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'block');
  assert.match(
    parsed.reason,
    /the only genuinely active lane report/,
    'a single genuinely in-window candidate has no real ambiguity — the embed must still be preserved',
  );
  assert.doesNotMatch(parsed.reason, /a report from twenty minutes ago/, 'the stale, out-of-window candidate must not be pulled in at all');
});

test('hook: not a team-mailbox lane (plain Task-tool subagent) — never blocks', () => {
  const { subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'plain-subagent', hash: 'a1a1a1a1',
    lines: [assistantText('plain task-tool subagent output')],
    meta: { agentType: 'general-purpose', spawnDepth: 1 }, // no taskKind: 'in_process_teammate'
  });
  const out = runHook({ transcript_path: transcriptPath });
  assert.equal(out.trim(), '');
});

// ── source guards ────────────────────────────────────────────────────────

test('source guard: no operator-specific hardcoded /Users/<name> path in legacy-gate/hook.js', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.equal(/\/Users\/[^/'"` ]+/.test(src), false);
});
