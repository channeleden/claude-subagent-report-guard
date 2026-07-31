'use strict';

// lane-dropbox-heartbeat.js coverage.
//
// Same fixture shape as lane-dropbox-checkpoint.test.js. This hook's own
// live PostToolUse wiring should only be enabled after a live-payload
// verification pass (not this test suite alone) — these tests cover the
// hook's OWN behavior: identity resolution reuse, throttle, fail-open
// paths, and the hard "never reads a transcript, never shells out to git"
// constraint at the source level.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'lane-dropbox-heartbeat.js');
const { deriveLaneId, recencyResolutionIsSafe, RECENCY_EPSILON_MS } = require('../hooks/lane-dropbox-heartbeat.js');
const { readLaneRecords, HEARTBEAT_THROTTLE_MS } = require('../lib/lane-dropbox.js');

function mkSessionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-heartbeat-'));
  const sessionId = 'team-session-hb';
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

function runHook(payload, env = {}) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: payload === null ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return out;
}

function teamDirForHome(home, sessionId) {
  return path.join(home, '.claude', 'teams', sessionId);
}

// ── unit: deriveLaneId (same precedence as the checkpoint hook) ─────────

test('deriveLaneId: prefers top-level agentName, falls back to meta.name, else null', () => {
  assert.equal(deriveLaneId({ agentName: 'a', meta: { name: 'b' } }), 'a');
  assert.equal(deriveLaneId({ meta: { name: 'b' } }), 'b');
  assert.equal(deriveLaneId({}), null);
});

// ── integration: hook process ────────────────────────────────────────────

test('hook: direct-sibling resolution writes one heartbeat record with omitted heavy fields', () => {
  const { subagentsDir, sessionId } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, { name: 'hb-direct', hash: 'aaaa0001' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-heartbeat-home-'));

  const out = runHook({ transcript_path: transcriptPath, session_id: sessionId, tool_name: 'Bash' }, { HOME: home });
  assert.equal(out, '', 'never writes a decision/stdout payload');

  const [rec] = readLaneRecords(path.join(teamDirForHome(home, sessionId), 'dropbox', 'hb-direct.jsonl'));
  assert.equal(rec.record_type, 'heartbeat');
  assert.equal(rec.resolution_method, 'direct-sibling');
  assert.equal('report_text' in rec, false);
  assert.equal('task_id' in rec, false);
});

test('hook: recency-heuristic resolution (payload.transcript_path is the lead file) also succeeds', () => {
  const { leadTranscriptPath, subagentsDir, sessionId } = mkSessionFixture();
  writeTeammate(subagentsDir, { name: 'hb-recency', hash: 'bbbb0002', mtimeMs: Date.now() });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-heartbeat-home-'));

  runHook({ transcript_path: leadTranscriptPath, session_id: sessionId, tool_name: 'Read' }, { HOME: home });

  const [rec] = readLaneRecords(path.join(teamDirForHome(home, sessionId), 'dropbox', 'hb-recency.jsonl'));
  assert.equal(rec.resolution_method, 'recency-heuristic');
});

test('hook: not a team-mailbox firing (e.g. main\'s own tool call) is a silent no-op — the expected common case', () => {
  const { subagentsDir, sessionId } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, {
    name: 'plain', hash: 'cccc0003', meta: { agentType: 'general-purpose', spawnDepth: 1 },
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-heartbeat-home-'));
  const out = runHook({ transcript_path: transcriptPath, session_id: sessionId, tool_name: 'Bash' }, { HOME: home });
  assert.equal(out, '');
  assert.equal(fs.existsSync(path.join(teamDirForHome(home, sessionId), 'dropbox')), false);
});

test('hook: missing/unparseable payload fails open, no throw', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-heartbeat-home-'));
  assert.doesNotThrow(() => runHook(null, { HOME: home }));
  const out = execFileSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(out, '');
});

test('hook: throttle holds at >=60s across repeated firings within the same lane', () => {
  const { subagentsDir, sessionId } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, { name: 'hb-throttle', hash: 'dddd0004' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-heartbeat-home-'));

  runHook({ transcript_path: transcriptPath, session_id: sessionId, tool_name: 'Bash' }, { HOME: home });
  runHook({ transcript_path: transcriptPath, session_id: sessionId, tool_name: 'Read' }, { HOME: home });
  runHook({ transcript_path: transcriptPath, session_id: sessionId, tool_name: 'Edit' }, { HOME: home });

  const laneFile = path.join(teamDirForHome(home, sessionId), 'dropbox', 'hb-throttle.jsonl');
  const records = readLaneRecords(laneFile);
  assert.equal(records.length, 1, 'three rapid firings under the same lane within 60s must produce exactly one heartbeat');

  // Age BOTH the sidecar AND the already-written record's own heartbeat_at
  // (the sidecar-write-failure fallback now derives an
  // effective last-heartbeat floor from the lane's own durable records too —
  // ageing only the sidecar would correctly, by design, no longer be enough
  // to simulate elapsed time).
  const throttlePath = path.join(teamDirForHome(home, sessionId), '.state', 'hb-throttle.heartbeat.json');
  fs.writeFileSync(throttlePath, JSON.stringify({ lastHeartbeatAt: Date.now() - (HEARTBEAT_THROTTLE_MS + 1000) }), 'utf8');
  const agedTs = new Date(Date.now() - (HEARTBEAT_THROTTLE_MS + 1000)).toISOString();
  fs.writeFileSync(
    laneFile,
    records.map((r) => `${JSON.stringify({ ...r, ts: agedTs, heartbeat_at: agedTs })}\n`).join(''),
    'utf8',
  );
  runHook({ transcript_path: transcriptPath, session_id: sessionId, tool_name: 'Bash' }, { HOME: home });
  const after = readLaneRecords(laneFile);
  assert.equal(after.length, 2);
});

test('hook wall-clock cost stays comfortably inside a generous CI-safe bound', () => {
  const { subagentsDir, sessionId } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, { name: 'hb-perf', hash: 'eeee0005' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-heartbeat-home-'));

  const start = process.hrtime.bigint();
  runHook({ transcript_path: transcriptPath, session_id: sessionId, tool_name: 'Bash' }, { HOME: home });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  // This measures a full `node` subprocess spawn + module load + hook run, not
  // just the in-process withLock cost this hook targets — subprocess spawn
  // overhead alone regularly exceeds a tight in-process budget. This is a
  // regression smoke bound (catches an accidental O(n) transcript read or
  // blocking retry loop), not a substitute for a live, in-hook wall-clock
  // measurement.
  assert.ok(elapsedMs < 2000, `heartbeat hook subprocess took ${elapsedMs}ms`);
});

// ── heartbeat resolution rule (live-verification-driven revision) ────────
//
// Fixtures derived directly from live-verification evidence: a lane that
// stopped 13s earlier must no longer match (it did, live, before this fix —
// that was the failure this rule closes); a sole genuinely-fresh candidate
// must still match; two simultaneously-fresh candidates must resolve to
// ambiguous/null.

test('recencyResolutionIsSafe: sole candidate well within epsilon (200ms fresh) is accepted', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  const { transcriptPath } = writeTeammate(subagentsDir, { name: 'sole-fresh', hash: 'f0000001', mtimeMs: now - 200 });
  const resolved = { transcriptPath, resolutionMethod: 'recency-heuristic' };
  const payload = { transcript_path: leadTranscriptPath };
  assert.equal(recencyResolutionIsSafe(resolved, payload, now), true);
});

test('recencyResolutionIsSafe: a stopped-lane candidate 13s stale (the live-evidence specimen shape) is REFUSED, not guessed', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  // Mirrors the live evidence exactly: the stopped lane's transcript was
  // 13.3s old at the first misattributed firing — well outside the 500ms
  // epsilon, but still well inside resolveTeammateContext's own 10-minute
  // RECENCY_WINDOW_MS (which is why it was chosen as the "winner" live).
  const { transcriptPath } = writeTeammate(subagentsDir, { name: 'stopped-lane', hash: 'f0000002', mtimeMs: now - 13_300 });
  const resolved = { transcriptPath, resolutionMethod: 'recency-heuristic' };
  const payload = { transcript_path: leadTranscriptPath };
  assert.equal(recencyResolutionIsSafe(resolved, payload, now), false);
});

test('recencyResolutionIsSafe: two candidates both within epsilon resolve to ambiguous — refused, sole-candidate rule', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const now = Date.now();
  const alpha = writeTeammate(subagentsDir, { name: 'concurrent-alpha', hash: 'f0000003', mtimeMs: now - 100 });
  writeTeammate(subagentsDir, { name: 'concurrent-beta', hash: 'f0000004', mtimeMs: now - 150 });
  // Even though alpha is the objectively freshest (and is what
  // resolveTeammateContext's own step 3 would have picked), this rule
  // refuses because it is NOT the sole candidate within epsilon.
  const resolved = { transcriptPath: alpha.transcriptPath, resolutionMethod: 'recency-heuristic' };
  const payload = { transcript_path: leadTranscriptPath };
  assert.equal(recencyResolutionIsSafe(resolved, payload, now), false);
});

test('recencyResolutionIsSafe: exactly at the epsilon boundary is still accepted (<=, not <)', () => {
  const { leadTranscriptPath, subagentsDir } = mkSessionFixture();
  const { transcriptPath } = writeTeammate(subagentsDir, { name: 'boundary', hash: 'f0000005', mtimeMs: Date.now() });
  // Derive `now` FROM the file's own actually-stored mtime (read back via
  // fs.statSync), rather than assuming fs.utimesSync round-trips an input
  // millisecond value exactly — some filesystems/Node versions round or
  // truncate sub-millisecond precision on write, which made an
  // assumed-exact boundary flaky (observed intermittently in CI-equivalent
  // runs). Deriving `now` from the real stored value guarantees the
  // difference is EXACTLY RECENCY_EPSILON_MS, with zero rounding risk,
  // which is what this test is actually asserting (<=, not <).
  const actualMtimeMs = fs.statSync(transcriptPath).mtimeMs;
  const now = actualMtimeMs + RECENCY_EPSILON_MS;
  const resolved = { transcriptPath, resolutionMethod: 'recency-heuristic' };
  const payload = { transcript_path: leadTranscriptPath };
  assert.equal(recencyResolutionIsSafe(resolved, payload, now), true);
});

test('recencyResolutionIsSafe: no team-mailbox candidates at all — refused, not an error', () => {
  const { leadTranscriptPath } = mkSessionFixture();
  const resolved = { transcriptPath: '/does/not/exist.jsonl', resolutionMethod: 'recency-heuristic' };
  const payload = { transcript_path: leadTranscriptPath };
  assert.doesNotThrow(() => recencyResolutionIsSafe(resolved, payload, Date.now()));
  assert.equal(recencyResolutionIsSafe(resolved, payload, Date.now()), false);
});

test('integration: a lane stopped 13s earlier (sole candidate, but outside epsilon) does NOT get a heartbeat written — the exact live-observed failure mode, now refused', () => {
  const { leadTranscriptPath, subagentsDir, sessionId } = mkSessionFixture();
  writeTeammate(subagentsDir, { name: 'hb-stopped-13s', hash: 'aaaa1301', mtimeMs: Date.now() - 13_300 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-heartbeat-home-'));

  const out = runHook({ transcript_path: leadTranscriptPath, session_id: sessionId, tool_name: 'Bash' }, { HOME: home });
  assert.equal(out, '');
  assert.equal(fs.existsSync(path.join(teamDirForHome(home, sessionId), 'dropbox', 'hb-stopped-13s.jsonl')), false,
    'this rule must refuse this exact live-evidence shape, not silently write a heartbeat under the stale lane\'s name');
});

test('integration: two genuinely concurrent fresh candidates — ambiguous, no heartbeat written for either', () => {
  const { leadTranscriptPath, subagentsDir, sessionId } = mkSessionFixture();
  const now = Date.now();
  writeTeammate(subagentsDir, { name: 'hb-concurrent-a', hash: 'bbbb0001', mtimeMs: now - 50 });
  writeTeammate(subagentsDir, { name: 'hb-concurrent-b', hash: 'bbbb0002', mtimeMs: now - 90 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-heartbeat-home-'));

  const out = runHook({ transcript_path: leadTranscriptPath, session_id: sessionId, tool_name: 'Bash' }, { HOME: home });
  assert.equal(out, '');
  assert.equal(fs.existsSync(path.join(teamDirForHome(home, sessionId), 'dropbox', 'hb-concurrent-a.jsonl')), false);
  assert.equal(fs.existsSync(path.join(teamDirForHome(home, sessionId), 'dropbox', 'hb-concurrent-b.jsonl')), false);
});

test('integration: direct-sibling resolution is UNAFFECTED by the epsilon rule — exact match keeps precedence over recency, no epsilon check applied', () => {
  const { subagentsDir, sessionId } = mkSessionFixture();
  // Deliberately stale mtime — if the epsilon rule were wrongly applied to
  // direct-sibling too, this would be refused. It must not be: direct-sibling
  // is an exact match, not a heuristic guess.
  const { transcriptPath } = writeTeammate(subagentsDir, { name: 'hb-direct-stale', hash: 'cccc0001', mtimeMs: Date.now() - 300_000 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-heartbeat-home-'));

  runHook({ transcript_path: transcriptPath, session_id: sessionId, tool_name: 'Bash' }, { HOME: home });
  const [rec] = readLaneRecords(path.join(teamDirForHome(home, sessionId), 'dropbox', 'hb-direct-stale.jsonl'));
  assert.ok(rec, 'a stale-mtime direct-sibling match must still resolve — the epsilon rule only gates recency-heuristic');
  assert.equal(rec.resolution_method, 'direct-sibling');
});

// ── hard constraint: never reads transcript CONTENT or shells out ───────

test('source guard: this hook file never imports the three forbidden transcript-content functions, and never shells out to git', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  // This hook legitimately imports subagentSessionDir/listTeammateMetaCandidates
  // from subagent-transcript.js (file-listing + meta.json + mtime only,
  // never transcript CONTENT) — the hard constraint names three specific
  // functions, not the whole module. Scoped to actual require()/destructure
  // calls, not doc-comment prose describing the constraint.
  assert.equal(/readTranscriptEntries|readTranscriptFromOffset|lastAssistantText/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), false,
    'the heartbeat hook must never import any of the three transcript-CONTENT-reading functions');
  assert.equal(/require\([^)]*child_process/.test(src), false, 'the heartbeat hook must not shell out (e.g. to git)');
});

test('source guard: no operator-specific hardcoded /Users/<name> path in this hook file', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.equal(/\/Users\/[^/'"` ]+/.test(src), false);
});
