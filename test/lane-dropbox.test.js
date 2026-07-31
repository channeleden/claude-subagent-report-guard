'use strict';

// lane-dropbox.js coverage.
//
// Covers: scaffold/checkpoint/touch schema + return contracts, the
// first-vs-latest scaffold precedence, transcript-offset dedupe, the
// filelock-guarded sidecars (including deliberate contention against both
// locks), the claim-probe stub (isolation, fallback, latency), the CLI
// subcommand argv contract, and a portability grep.

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const {
  scaffold,
  checkpoint,
  touch,
  parseCliArgs,
  teamDirFor,
  readLaneRecords,
  resolveProvider,
  latestScaffoldMeta,
  laneFileFacts,
  writeStateAtomic,
  SCHEMA_VERSION,
  VALID_RESOLUTION_METHODS,
  HEARTBEAT_THROTTLE_MS,
} = require('../lib/lane-dropbox.js');

const { acquireLock, releaseLock } = require('../lib/filelock.js');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'lane-dropbox.js');
const CHECKPOINT_MODULE_PATH = path.join(__dirname, '..', 'lib', 'lane-dropbox.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-'));
}

// Every real invocation of an exported function resolves its root off
// process.env.HOME lazily (never cached at module load) — this test-seam
// convention is shared with the two hook test files in this same directory.
// Save/restore around each test so tests never leak state into each other.
function withHome(home, fn) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
}

function laneFilePath(home, sessionId, laneId) {
  return path.join(home, '.claude', 'teams', sessionId, 'dropbox', `${laneId}.jsonl`);
}

function writeTranscript(p, lines) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((l) => `${JSON.stringify(l)}\n`).join(''), 'utf8');
}

function assistantText(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

// Rewrites every `ts`/`heartbeat_at` field in an existing lane dropbox file
// to `now - ageMs`, in place. Needed because the sidecar-write-failure
// fallback (laneFileFacts) now derives an effective
// last-heartbeat/last-offset floor from the lane's own already-durable
// records, not just the sidecar — so a test simulating "time has passed"
// must age BOTH the sidecar AND the record it's paired with, or the
// record-derived fallback correctly (by design) refuses to let a
// unilaterally-aged sidecar alone bypass the throttle/dedupe guarantee.
function ageLaneFileTimestamps(laneFile, ageMs) {
  const agedTs = new Date(Date.now() - ageMs).toISOString();
  const records = readLaneRecords(laneFile).map((r) => {
    const aged = { ...r };
    if ('ts' in aged) aged.ts = agedTs;
    if ('heartbeat_at' in aged) aged.heartbeat_at = agedTs;
    return aged;
  });
  fs.writeFileSync(laneFile, records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
}

// ── teamDirFor / home resolution ────────────────────────────────────────

test('teamDirFor resolves under HOME/.claude/teams/<session>', () => {
  withHome('/tmp/fake-home', () => {
    assert.equal(teamDirFor('sess-1'), path.join('/tmp/fake-home', '.claude', 'teams', 'sess-1'));
  });
});

// ── scaffold() ───────────────────────────────────────────────────────────

test('scaffold: writes a schema-complete scaffold record and creates the dropbox dir', () => {
  const home = tmpHome();
  withHome(home, () => {
    const result = scaffold({
      sessionId: 'sess-a', laneId: 'lane-a', provider: 'claude',
      taskId: 'task-42', worktree: '/repo/worktree', branch: 'task/x',
      pid: null, outputLog: null, agentName: 'lane-a',
    });
    assert.equal(result.written, true);
    assert.equal(typeof result.claimAttempted, 'boolean');

    const records = readLaneRecords(laneFilePath(home, 'sess-a', 'lane-a'));
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.schema_version, SCHEMA_VERSION);
    assert.equal(r.record_type, 'scaffold');
    assert.equal(r.lane_id, 'lane-a');
    assert.equal(r.session_id, 'sess-a');
    assert.equal(r.provider, 'claude');
    assert.equal(r.task_id, 'task-42');
    assert.equal(r.worktree, '/repo/worktree');
    assert.equal(r.branch, 'task/x');
    assert.equal(r.dispatched_at, r.ts);
    assert.equal(r.agent_name, 'lane-a');
    assert.equal(r.pid, null);
    assert.equal(r.output_log, null);
    assert.ok(!Number.isNaN(Date.parse(r.ts)));
  });
});

test('scaffold: creates .state/ alongside dropbox/', () => {
  const home = tmpHome();
  withHome(home, () => {
    scaffold({ sessionId: 'sess-state', laneId: 'lane-state', provider: 'claude' });
    const teamDir = teamDirFor('sess-state');
    assert.equal(fs.existsSync(path.join(teamDir, 'dropbox')), true);
    assert.equal(fs.existsSync(path.join(teamDir, '.state')), true);
    assert.ok(fs.statSync(path.join(teamDir, '.state')).isDirectory());
  });
});

test('scaffold: schema invariants enforced by coercion — claude lanes never carry pid/output_log, third-party lanes never carry agent_name', () => {
  const home = tmpHome();
  withHome(home, () => {
    scaffold({
      sessionId: 'sess-coerce', laneId: 'lane-claude', provider: 'claude',
      agentName: 'lane-claude', pid: 4242, outputLog: '/tmp/should-be-dropped.log',
    });
    const [claudeRecord] = readLaneRecords(laneFilePath(home, 'sess-coerce', 'lane-claude'));
    assert.equal(claudeRecord.agent_name, 'lane-claude', 'agent_name is meaningful for a Claude lane and must be kept');
    assert.equal(claudeRecord.pid, null, 'pid must be forced null for a Claude lane even if the caller passed one');
    assert.equal(claudeRecord.output_log, null, 'output_log must be forced null for a Claude lane even if the caller passed one');

    scaffold({
      sessionId: 'sess-coerce', laneId: 'lane-codex', provider: 'codex',
      agentName: 'should-be-dropped', pid: 4242, outputLog: '/tmp/real.log',
    });
    const [codexRecord] = readLaneRecords(laneFilePath(home, 'sess-coerce', 'lane-codex'));
    assert.equal(codexRecord.agent_name, null, 'agent_name must be forced null for a third-party lane even if the caller passed one');
    assert.equal(codexRecord.pid, 4242, 'pid is meaningful for a third-party lane and must be kept');
    assert.equal(codexRecord.output_log, '/tmp/real.log', 'output_log is meaningful for a third-party lane and must be kept');
  });
});

test('scaffold: idempotent-safe, not deduped — a repeat call appends a second record', () => {
  const home = tmpHome();
  withHome(home, () => {
    scaffold({ sessionId: 'sess-b', laneId: 'lane-b', provider: 'codex', worktree: '/w1' });
    scaffold({ sessionId: 'sess-b', laneId: 'lane-b', provider: 'codex', worktree: '/w2' });
    const records = readLaneRecords(laneFilePath(home, 'sess-b', 'lane-b'));
    assert.equal(records.length, 2);
    assert.equal(records[0].worktree, '/w1');
    assert.equal(records[1].worktree, '/w2');
  });
});

test('scaffold: rejects an invalid provider without throwing', () => {
  const home = tmpHome();
  withHome(home, () => {
    const result = scaffold({ sessionId: 'sess-c', laneId: 'lane-c', provider: 'not-a-real-provider' });
    assert.equal(result.written, false);
    assert.equal(result.claimAttempted, false);
    assert.equal(result.reason, 'invalid-args');
  });
});

test('scaffold: missing sessionId/laneId fails open (never throws)', () => {
  assert.doesNotThrow(() => scaffold({ provider: 'claude' }));
  const result = scaffold({ provider: 'claude' });
  assert.equal(result.written, false);
});

test('scaffold: an unwritable dropbox root fails open with claimAttempted forced false', () => {
  const home = tmpHome();
  withHome(home, () => {
    // Create a FILE where the dropbox dir needs to be created, so mkdirSync throws.
    const teamDir = teamDirFor('sess-d');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'dropbox'), 'not a directory', 'utf8');

    const result = scaffold({ sessionId: 'sess-d', laneId: 'lane-d', provider: 'gemini' });
    assert.equal(result.written, false);
    assert.equal(result.claimAttempted, false, 'claim probe must never be attempted when the record write itself never happens');
    assert.ok(result.reason);
  });
});

// ── stderr diagnostics on write failure ─────────────────────────────────

function captureStderr(fn) {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test('scaffold: emits a one-line human-readable stderr diagnostic on a record-append failure', () => {
  const home = tmpHome();
  withHome(home, () => {
    const teamDir = teamDirFor('sess-stderr-scaffold');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'dropbox'), 'not a directory', 'utf8');
    const stderrOutput = captureStderr(() => {
      scaffold({ sessionId: 'sess-stderr-scaffold', laneId: 'lane-x', provider: 'claude' });
    });
    assert.match(stderrOutput, /lane-dropbox:/);
    assert.match(stderrOutput, /scaffold/);
  });
});

test('checkpoint: emits a one-line stderr diagnostic specifically on the sidecar write failure path', () => {
  const home = tmpHome();
  withHome(home, () => {
    const transcriptPath = path.join(home, 'transcript-stderr.jsonl');
    writeTranscript(transcriptPath, [assistantText('x')]);
    const stateDir = path.join(teamDirFor('sess-stderr-cp'), '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'lane-y.checkpoint.json'));
    const stderrOutput = captureStderr(() => {
      checkpoint({ transcriptPath, sessionId: 'sess-stderr-cp', laneId: 'lane-y', resolutionMethod: 'direct-sibling' });
    });
    assert.match(stderrOutput, /lane-dropbox:/);
    assert.match(stderrOutput, /sidecar write failed/);
  });
});

test('writeStateAtomic: returns false and never throws when the target path is unwritable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-writestate-'));
  const targetPath = path.join(dir, 'occupied.json');
  fs.mkdirSync(targetPath); // occupy the path as a directory
  const stderrOutput = captureStderr(() => {
    assert.doesNotThrow(() => {
      const ok = writeStateAtomic(targetPath, { x: 1 });
      assert.equal(ok, false);
    });
  });
  assert.match(stderrOutput, /sidecar write failed/);
});

// ── claim-probe stub coverage ───────────────────────────────────────────

test('claim-probe: absent emitter (real state today) — claimAttempted false, fallback fields present', () => {
  const home = tmpHome();
  withHome(home, () => {
    const prev = process.env.LANE_DROPBOX_CLAIM_EMITTER_PATH;
    delete process.env.LANE_DROPBOX_CLAIM_EMITTER_PATH; // real resolved path — no emitter module exists yet
    try {
      const result = scaffold({
        sessionId: 'sess-e', laneId: 'lane-e', provider: 'claude', taskId: 't-1', worktree: '/w', branch: 'b',
      });
      assert.equal(result.written, true);
      assert.equal(result.claimAttempted, false);
      const [record] = readLaneRecords(laneFilePath(home, 'sess-e', 'lane-e'));
      assert.equal(record.task_id, 't-1');
      assert.equal(record.worktree, '/w');
      assert.equal(record.branch, 'b');
    } finally {
      if (prev !== undefined) process.env.LANE_DROPBOX_CLAIM_EMITTER_PATH = prev;
    }
  });
});

test('claim-probe: a claim() that throws is isolated — never propagates, never affects written', () => {
  const home = tmpHome();
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-claim-stub-'));
  const stubPath = path.join(stubDir, 'throwing-claim.js');
  fs.writeFileSync(stubPath, 'module.exports = { claim() { throw new Error("boom"); } };', 'utf8');
  withHome(home, () => {
    process.env.LANE_DROPBOX_CLAIM_EMITTER_PATH = stubPath;
    try {
      let threw = false;
      let result;
      try {
        result = scaffold({ sessionId: 'sess-f', laneId: 'lane-f', provider: 'claude', taskId: 't', worktree: '/w', branch: 'b' });
      } catch {
        threw = true;
      }
      assert.equal(threw, false, 'a throwing claim() must never propagate out of scaffold()');
      assert.equal(result.written, true, 'the record write already completed before the probe runs');
      assert.equal(result.claimAttempted, true, '"attempted" means invocation was reached, regardless of the throw');
      // fallback: the scaffold record's own fields remain readable
      const [record] = readLaneRecords(laneFilePath(home, 'sess-f', 'lane-f'));
      assert.equal(record.task_id, 't');
      assert.equal(record.worktree, '/w');
    } finally {
      delete process.env.LANE_DROPBOX_CLAIM_EMITTER_PATH;
    }
  });
});

test('claim-probe: a present, callable claim() is invoked and reflected in claimAttempted', () => {
  const home = tmpHome();
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-claim-stub-'));
  const stubPath = path.join(stubDir, 'ok-claim.js');
  const callLogPath = path.join(stubDir, 'calls.json');
  fs.writeFileSync(
    stubPath,
    `const fs = require('fs');
     module.exports = { claim(args) { fs.writeFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(args)); } };`,
    'utf8',
  );
  withHome(home, () => {
    process.env.LANE_DROPBOX_CLAIM_EMITTER_PATH = stubPath;
    try {
      const result = scaffold({ sessionId: 'sess-g', laneId: 'lane-g', provider: 'claude', taskId: 't-g', worktree: '/wg' });
      assert.equal(result.written, true);
      assert.equal(result.claimAttempted, true);
      const call = JSON.parse(fs.readFileSync(callLogPath, 'utf8'));
      assert.equal(call.agent, 'lane-g');
      assert.equal(call.task_id, 't-g');
      assert.equal(call.worktree, '/wg');
      assert.equal(call.held, true);
    } finally {
      delete process.env.LANE_DROPBOX_CLAIM_EMITTER_PATH;
    }
  });
});

test('claim-probe: the full probe against a stub stays within a bound consistent with the <10ms-class target', () => {
  const home = tmpHome();
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dropbox-claim-stub-'));
  const stubPath = path.join(stubDir, 'fast-claim.js');
  fs.writeFileSync(stubPath, 'module.exports = { claim() {} };', 'utf8');
  withHome(home, () => {
    process.env.LANE_DROPBOX_CLAIM_EMITTER_PATH = stubPath;
    try {
      const start = process.hrtime.bigint();
      scaffold({ sessionId: 'sess-h', laneId: 'lane-h', provider: 'claude' });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      // Generous CI-safe bound (target is <10ms for the probe itself
      // contract; this asserts the caller-side probe overhead doesn't blow an
      // order of magnitude past that under real filesystem I/O + module load).
      assert.ok(elapsedMs < 100, `scaffold()+probe took ${elapsedMs}ms, expected well under 100ms`);
    } finally {
      delete process.env.LANE_DROPBOX_CLAIM_EMITTER_PATH;
    }
  });
});

// ── first-vs-latest scaffold precedence ─────────────────────────────────

test('latestScaffoldMeta: task_id/worktree/branch are latest-scaffold-wins', () => {
  const home = tmpHome();
  withHome(home, () => {
    scaffold({ sessionId: 'sess-i', laneId: 'lane-i', provider: 'claude', taskId: 't-1', worktree: '/w1', branch: 'b1' });
    scaffold({ sessionId: 'sess-i', laneId: 'lane-i', provider: 'claude', taskId: 't-2', worktree: '/w2', branch: 'b2' });
    const meta = latestScaffoldMeta(laneFilePath(home, 'sess-i', 'lane-i'));
    assert.deepEqual(meta, { task_id: 't-2', worktree: '/w2', branch: 'b2' });
  });
});

test('resolveProvider: first-scaffold-authoritative, never latest-wins', () => {
  const home = tmpHome();
  withHome(home, () => {
    scaffold({ sessionId: 'sess-j', laneId: 'lane-j', provider: 'codex' });
    // A second scaffold under the same lane_id would legitimately never carry
    // a different provider in practice — but the READER mechanism itself
    // must still prefer the first, not the latest.
    const laneFile = laneFilePath(home, 'sess-j', 'lane-j');
    fs.appendFileSync(laneFile, `${JSON.stringify({
      schema_version: SCHEMA_VERSION, record_type: 'scaffold', lane_id: 'lane-j',
      session_id: 'sess-j', ts: new Date().toISOString(), provider: 'gemini',
    })}\n`, 'utf8');
    assert.equal(resolveProvider(laneFile), 'codex');
  });
});

test('resolveProvider: defaults to claude when no scaffold record exists', () => {
  const home = tmpHome();
  withHome(home, () => {
    assert.equal(resolveProvider(laneFilePath(home, 'sess-none', 'lane-none')), 'claude');
  });
});

test('VALID_RESOLUTION_METHODS: exactly the three enumerated values', () => {
  assert.deepEqual(
    [...VALID_RESOLUTION_METHODS].sort(),
    ['direct-sibling', 'payload-identity-field', 'recency-heuristic'],
  );
});

test('laneFileFacts: derives provider (first-scaffold-wins), scaffold meta (latest-wins), last checkpoint offset, and last heartbeat_at in one pass', () => {
  const home = tmpHome();
  withHome(home, () => {
    scaffold({ sessionId: 'sess-facts', laneId: 'lane-facts', provider: 'codex', taskId: 't1', worktree: '/w1' });
    checkpoint({
      transcriptPath: (() => {
        const p = path.join(home, 'transcript-facts.jsonl');
        writeTranscript(p, [assistantText('one')]);
        return p;
      })(),
      sessionId: 'sess-facts', laneId: 'lane-facts', resolutionMethod: 'direct-sibling',
    });
    const laneFile = laneFilePath(home, 'sess-facts', 'lane-facts');
    const facts = laneFileFacts(laneFile);
    assert.equal(facts.provider, 'codex');
    assert.equal(facts.scaffoldMeta.task_id, 't1');
    assert.equal(facts.scaffoldMeta.worktree, '/w1');
    assert.ok(Number.isInteger(facts.lastCheckpointOffsetEnd) && facts.lastCheckpointOffsetEnd > 0);
    assert.ok(Number.isInteger(facts.lastHeartbeatAt));
  });
});

test('laneFileFacts: empty/absent lane file returns safe defaults, never throws', () => {
  const home = tmpHome();
  withHome(home, () => {
    assert.doesNotThrow(() => laneFileFacts(laneFilePath(home, 'sess-empty', 'lane-empty')));
    const facts = laneFileFacts(laneFilePath(home, 'sess-empty', 'lane-empty'));
    assert.equal(facts.provider, 'claude');
    assert.deepEqual(facts.scaffoldMeta, { task_id: null, worktree: null, branch: null });
    assert.equal(facts.lastCheckpointOffsetEnd, null);
    assert.equal(facts.lastHeartbeatAt, null);
  });
});

// ── checkpoint() ─────────────────────────────────────────────────────────

test('checkpoint: writes a schema-complete record, copying forward the scaffold worktree/branch/task_id', () => {
  const home = tmpHome();
  withHome(home, () => {
    scaffold({ sessionId: 'sess-k', laneId: 'lane-k', provider: 'claude', taskId: 't-k', worktree: '/repo', branch: 'main' });
    const transcriptPath = path.join(home, 'transcript-k.jsonl');
    writeTranscript(transcriptPath, [assistantText('final report body')]);

    const result = checkpoint({
      transcriptPath, sessionId: 'sess-k', laneId: 'lane-k', resolutionMethod: 'direct-sibling',
    });
    assert.equal(result.written, true);

    const records = readLaneRecords(laneFilePath(home, 'sess-k', 'lane-k'));
    const cp = records.find((r) => r.record_type === 'checkpoint');
    assert.ok(cp);
    assert.equal(cp.schema_version, SCHEMA_VERSION);
    assert.equal(cp.task_id, 't-k');
    assert.equal(cp.worktree, '/repo');
    assert.equal(cp.branch, 'main');
    assert.equal(cp.report_text, 'final report body');
    assert.equal(cp.transcript_offset_start, 0);
    assert.ok(cp.transcript_offset_end > 0);
    assert.equal(cp.resolution_method, 'direct-sibling');
    assert.equal(cp.heartbeat_at, cp.ts);
    assert.equal(
      cp.dedupe_key,
      crypto.createHash('sha256').update(`${transcriptPath}:0-${cp.transcript_offset_end}`).digest('hex'),
    );
    // last_verified_sha is best-effort against a non-git dir — must degrade to null, not throw
    assert.equal(cp.last_verified_sha, null);
  });
});

test('checkpoint: no scaffold record — task_id/worktree/branch null, not an error', () => {
  const home = tmpHome();
  withHome(home, () => {
    const transcriptPath = path.join(home, 'transcript-l.jsonl');
    writeTranscript(transcriptPath, [assistantText('orphan lane report')]);
    const result = checkpoint({ transcriptPath, sessionId: 'sess-l', laneId: 'lane-l', resolutionMethod: 'recency-heuristic' });
    assert.equal(result.written, true);
    const [cp] = readLaneRecords(laneFilePath(home, 'sess-l', 'lane-l'));
    assert.equal(cp.task_id, null);
    assert.equal(cp.worktree, null);
    assert.equal(cp.branch, null);
    assert.equal(cp.provider, 'claude'); // default
  });
});

test('checkpoint: dedupes by transcript offset — a repeat firing with no new content writes nothing', () => {
  const home = tmpHome();
  withHome(home, () => {
    const transcriptPath = path.join(home, 'transcript-m.jsonl');
    writeTranscript(transcriptPath, [assistantText('first turn')]);
    const first = checkpoint({ transcriptPath, sessionId: 'sess-m', laneId: 'lane-m', resolutionMethod: 'direct-sibling' });
    assert.equal(first.written, true);

    const second = checkpoint({ transcriptPath, sessionId: 'sess-m', laneId: 'lane-m', resolutionMethod: 'direct-sibling' });
    assert.equal(second.written, false);
    assert.equal(second.reason, 'no-new-content');

    const records = readLaneRecords(laneFilePath(home, 'sess-m', 'lane-m'));
    assert.equal(records.filter((r) => r.record_type === 'checkpoint').length, 1, 'no duplicate checkpoint record');
  });
});

test('checkpoint: a real multi-lane test — two lanes each get their own file, no cross-writes', () => {
  const home = tmpHome();
  withHome(home, () => {
    const tA = path.join(home, 'transcript-nA.jsonl');
    const tB = path.join(home, 'transcript-nB.jsonl');
    writeTranscript(tA, [assistantText('lane A report')]);
    writeTranscript(tB, [assistantText('lane B report')]);

    checkpoint({ transcriptPath: tA, sessionId: 'sess-n', laneId: 'lane-nA', resolutionMethod: 'direct-sibling' });
    checkpoint({ transcriptPath: tB, sessionId: 'sess-n', laneId: 'lane-nB', resolutionMethod: 'direct-sibling' });

    const [recA] = readLaneRecords(laneFilePath(home, 'sess-n', 'lane-nA'));
    const [recB] = readLaneRecords(laneFilePath(home, 'sess-n', 'lane-nB'));
    assert.equal(recA.report_text, 'lane A report');
    assert.equal(recB.report_text, 'lane B report');
    assert.equal(recA.lane_id, 'lane-nA');
    assert.equal(recB.lane_id, 'lane-nB');
  });
});

test('checkpoint: a new checkpoint only consumes the NEW byte range (offset-resumable, not whole-file re-extract)', () => {
  const home = tmpHome();
  withHome(home, () => {
    const transcriptPath = path.join(home, 'transcript-o.jsonl');
    writeTranscript(transcriptPath, [assistantText('turn one')]);
    const first = checkpoint({ transcriptPath, sessionId: 'sess-o', laneId: 'lane-o', resolutionMethod: 'direct-sibling' });
    assert.equal(first.written, true);

    fs.appendFileSync(transcriptPath, `${JSON.stringify(assistantText('turn two'))}\n`, 'utf8');
    const second = checkpoint({ transcriptPath, sessionId: 'sess-o', laneId: 'lane-o', resolutionMethod: 'direct-sibling' });
    assert.equal(second.written, true);

    const checkpoints = readLaneRecords(laneFilePath(home, 'sess-o', 'lane-o')).filter((r) => r.record_type === 'checkpoint');
    assert.equal(checkpoints.length, 2);
    assert.equal(checkpoints[0].report_text, 'turn one');
    assert.equal(checkpoints[1].report_text, 'turn two');
    assert.equal(checkpoints[1].transcript_offset_start, checkpoints[0].transcript_offset_end);
  });
});

test('checkpoint: requires resolutionMethod/transcriptPath — invalid args fail open, never throw', () => {
  assert.doesNotThrow(() => checkpoint({ sessionId: 's', laneId: 'l' }));
  const result = checkpoint({ sessionId: 's', laneId: 'l' });
  assert.equal(result.written, false);
  assert.equal(result.sidecarUpdated, false);
  // Mapped to the closed reason enum ("no-new-content" | "lock-unavailable" |
  // "sidecar-write-failed" | "unresolvable") rather than a new
  // value — checkpoint() never throws.
  assert.equal(result.reason, 'unresolvable');
});

test('checkpoint: an out-of-enum resolutionMethod is a caller contract violation, not a silent pass-through', () => {
  const transcriptPath = path.join(tmpHome(), 'transcript-badmethod.jsonl');
  writeTranscript(transcriptPath, [assistantText('x')]);
  const result = checkpoint({ transcriptPath, sessionId: 's', laneId: 'l', resolutionMethod: 'made-up-method' });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'unresolvable');
});

test('checkpoint: sidecar write failure — record still lands (written:true), sidecarUpdated:false, reason sidecar-write-failed, and a repeat call still avoids a duplicate re-consume via the record-derived fallback', () => {
  const home = tmpHome();
  withHome(home, () => {
    const transcriptPath = path.join(home, 'transcript-sidecar-fail.jsonl');
    writeTranscript(transcriptPath, [assistantText('first turn')]);

    // Inject a sidecar-write failure: occupy the sidecar's own path with a
    // DIRECTORY, so writeStateAtomic's fs.renameSync(tmp, sidecarPath) fails
    // (a file cannot be renamed onto an existing directory) — a real,
    // reproducible fs error, not a mocked one.
    const stateDir = path.join(teamDirFor('sess-sf'), '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const sidecarPath = path.join(stateDir, 'lane-sf.checkpoint.json');
    fs.mkdirSync(sidecarPath);

    const result = checkpoint({ transcriptPath, sessionId: 'sess-sf', laneId: 'lane-sf', resolutionMethod: 'direct-sibling' });
    assert.equal(result.written, true, 'the record itself must still land even when the sidecar write fails');
    assert.equal(result.sidecarUpdated, false);
    assert.equal(result.reason, 'sidecar-write-failed');

    const records = readLaneRecords(laneFilePath(home, 'sess-sf', 'lane-sf'));
    assert.equal(records.length, 1);
    assert.equal(records[0].transcript_offset_start, 0);

    // Second call: the sidecar is STILL a directory (readJsonSafe fails ->
    // sidecarOffset defaults to 0), but laneFileFacts' own record-derived
    // fallback (lastCheckpointOffsetEnd, from the record that DID land)
    // floors the resume offset — no duplicate re-consume despite a
    // permanently broken sidecar. This is the durability guarantee this design closes.
    const second = checkpoint({ transcriptPath, sessionId: 'sess-sf', laneId: 'lane-sf', resolutionMethod: 'direct-sibling' });
    assert.equal(second.written, false);
    assert.equal(second.reason, 'no-new-content', 'the record-derived fallback must prevent a duplicate re-consume even with a permanently broken sidecar');
  });
});

test('checkpoint: contended checkpoint lock — held by "another" writer, returns lock-unavailable fast-failing within budget', () => {
  const home = tmpHome();
  withHome(home, () => {
    const teamDir = teamDirFor('sess-p');
    const stateDir = path.join(teamDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, 'lane-p.checkpoint.lock');
    // Simulate another live holder of this exact lock (our own live pid, so
    // it can never be judged stale/stolen).
    assert.equal(acquireLock(lockPath), true);
    try {
      const transcriptPath = path.join(home, 'transcript-p.jsonl');
      writeTranscript(transcriptPath, [assistantText('should not be recorded while contended')]);
      const result = checkpoint({
        transcriptPath, sessionId: 'sess-p', laneId: 'lane-p', resolutionMethod: 'direct-sibling',
      });
      assert.equal(result.written, false);
      assert.equal(result.reason, 'lock-unavailable');
    } finally {
      releaseLock(lockPath);
    }
  });
});

// ── touch() ──────────────────────────────────────────────────────────────

test('touch: requires resolutionMethod — missing args fail open, never throw, mapped to the closed reason enum', () => {
  assert.doesNotThrow(() => touch({ sessionId: 's', laneId: 'l' }));
  const result = touch({ sessionId: 's', laneId: 'l' });
  assert.equal(result.written, false);
  assert.equal(result.sidecarUpdated, false);
  assert.equal(result.reason, 'unresolvable');
});

test('touch: an out-of-enum resolutionMethod is a caller contract violation, not a silent pass-through', () => {
  const result = touch({ sessionId: 's', laneId: 'l', resolutionMethod: 'made-up-method' });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'unresolvable');
});

test('touch: sidecar write failure — record still lands (written:true), sidecarUpdated:false, reason sidecar-write-failed, and the throttle still holds via the record-derived fallback', () => {
  const home = tmpHome();
  withHome(home, () => {
    // Inject a sidecar-write failure the same way as checkpoint's own test:
    // occupy the throttle sidecar's own path with a directory.
    const stateDir = path.join(teamDirFor('sess-tf'), '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const sidecarPath = path.join(stateDir, 'lane-tf.heartbeat.json');
    fs.mkdirSync(sidecarPath);

    const result = touch({ sessionId: 'sess-tf', laneId: 'lane-tf', resolutionMethod: 'direct-sibling' });
    assert.equal(result.written, true);
    assert.equal(result.sidecarUpdated, false);
    assert.equal(result.reason, 'sidecar-write-failed');

    const records = readLaneRecords(laneFilePath(home, 'sess-tf', 'lane-tf'));
    assert.equal(records.length, 1);

    // Second call, sidecar STILL a directory: the record-derived fallback
    // (lastHeartbeatAt, from the record that DID land) preserves the
    // throttle even though the sidecar never durably recorded it — the
    // guarantee blocker 1 named for the heartbeat side.
    const second = touch({ sessionId: 'sess-tf', laneId: 'lane-tf', resolutionMethod: 'direct-sibling' });
    assert.equal(second.written, false);
    assert.equal(second.reason, 'throttled', 'the record-derived fallback must preserve the throttle even with a permanently broken sidecar');
  });
});

test('touch: writes a schema-complete heartbeat record, omitting report/task fields by design', () => {
  const home = tmpHome();
  withHome(home, () => {
    const result = touch({ sessionId: 'sess-q', laneId: 'lane-q', resolutionMethod: 'recency-heuristic' });
    assert.equal(result.written, true);
    const [rec] = readLaneRecords(laneFilePath(home, 'sess-q', 'lane-q'));
    assert.equal(rec.schema_version, SCHEMA_VERSION);
    assert.equal(rec.record_type, 'heartbeat');
    assert.equal(rec.liveness_source, 'posttooluse-touch');
    assert.equal(rec.resolution_method, 'recency-heuristic');
    assert.equal(rec.heartbeat_at, rec.ts);
    // Deliberately absent — no transcript read, no shell-out on this path
    assert.equal('report_text' in rec, false);
    assert.equal('task_id' in rec, false);
    assert.equal('worktree' in rec, false);
    assert.equal('branch' in rec, false);
    assert.equal('last_verified_sha' in rec, false);
    assert.equal('transcript_offset_start' in rec, false);
    assert.equal('dedupe_key' in rec, false);
  });
});

test('touch: throttles at >=60s by construction (read-check-write inside one lock)', () => {
  const home = tmpHome();
  withHome(home, () => {
    const first = touch({ sessionId: 'sess-r', laneId: 'lane-r', resolutionMethod: 'direct-sibling' });
    assert.equal(first.written, true);

    const second = touch({ sessionId: 'sess-r', laneId: 'lane-r', resolutionMethod: 'direct-sibling' });
    assert.equal(second.written, false);
    assert.equal(second.reason, 'throttled');

    // Age BOTH the throttle sidecar AND the already-written heartbeat
    // record past the 60s window (see ageLaneFileTimestamps) and confirm
    // the next touch is allowed again.
    const throttlePath = path.join(teamDirFor('sess-r'), '.state', 'lane-r.heartbeat.json');
    fs.writeFileSync(throttlePath, JSON.stringify({ lastHeartbeatAt: Date.now() - (HEARTBEAT_THROTTLE_MS + 1000) }), 'utf8');
    ageLaneFileTimestamps(laneFilePath(home, 'sess-r', 'lane-r'), HEARTBEAT_THROTTLE_MS + 1000);
    const third = touch({ sessionId: 'sess-r', laneId: 'lane-r', resolutionMethod: 'direct-sibling' });
    assert.equal(third.written, true);
  });
});

test('touch: deliberately-contended heartbeat lock — fails IMMEDIATELY (retries: 0), no spin-wait', () => {
  const home = tmpHome();
  withHome(home, () => {
    const teamDir = teamDirFor('sess-s');
    const stateDir = path.join(teamDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, 'lane-s.heartbeat.lock');
    assert.equal(acquireLock(lockPath), true);
    try {
      const start = process.hrtime.bigint();
      const result = touch({ sessionId: 'sess-s', laneId: 'lane-s', resolutionMethod: 'direct-sibling' });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      assert.equal(result.written, false);
      assert.equal(result.reason, 'contended');
      assert.ok(elapsedMs < 50, `contended touch() took ${elapsedMs}ms, expected an immediate (no spin-wait) failure`);
    } finally {
      releaseLock(lockPath);
    }
  });
});

test('touch: two concurrent "due" calls against the SAME lock can never both write', () => {
  const home = tmpHome();
  withHome(home, () => {
    // First call establishes the lane and its throttle state.
    const first = touch({ sessionId: 'sess-t', laneId: 'lane-t', resolutionMethod: 'direct-sibling' });
    assert.equal(first.written, true);
    // Age it out (sidecar AND record — see ageLaneFileTimestamps) so the
    // next call is legitimately "due".
    const throttlePath = path.join(teamDirFor('sess-t'), '.state', 'lane-t.heartbeat.json');
    fs.writeFileSync(throttlePath, JSON.stringify({ lastHeartbeatAt: Date.now() - (HEARTBEAT_THROTTLE_MS + 1000) }), 'utf8');
    ageLaneFileTimestamps(laneFilePath(home, 'sess-t', 'lane-t'), HEARTBEAT_THROTTLE_MS + 1000);

    // Simulate a second "concurrent" caller by holding the lock ourselves
    // right as a legitimately-due touch() is attempted.
    const lockPath = path.join(teamDirFor('sess-t'), '.state', 'lane-t.heartbeat.lock');
    assert.equal(acquireLock(lockPath), true);
    try {
      const result = touch({ sessionId: 'sess-t', laneId: 'lane-t', resolutionMethod: 'direct-sibling' });
      assert.equal(result.written, false);
      assert.equal(result.reason, 'contended', 'the read-check-write sequence never runs while the lock is held elsewhere');
    } finally {
      releaseLock(lockPath);
    }
    // Once released, the legitimately-due touch succeeds — exactly one winner.
    const after = touch({ sessionId: 'sess-t', laneId: 'lane-t', resolutionMethod: 'direct-sibling' });
    assert.equal(after.written, true);
  });
});

// ── CLI ──────────────────────────────────────────────────────────────────

test('parseCliArgs: parses subcommand and --flag value pairs', () => {
  assert.deepEqual(
    parseCliArgs(['node', 'lane-dropbox.js', 'scaffold', '--session', 's1', '--lane-id', 'l1', '--provider', 'claude']),
    { sub: 'scaffold', opts: { session: 's1', 'lane-id': 'l1', provider: 'claude' } },
  );
});

test('CLI: scaffold subcommand runs standalone via node (zero Claude-specific dependency)', () => {
  const home = tmpHome();
  const out = execFileSync(process.execPath, [
    MODULE_PATH, 'scaffold', '--session', 'sess-cli', '--lane-id', 'lane-cli', '--provider', 'gemini',
    '--worktree', '/cli-worktree',
  ], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.written, true);
  const [rec] = readLaneRecords(laneFilePath(home, 'sess-cli', 'lane-cli'));
  assert.equal(rec.provider, 'gemini');
  assert.equal(rec.worktree, '/cli-worktree');
});

test('CLI: checkpoint/touch without --resolution-method is a caller usage error (exit 1)', () => {
  assert.throws(() => execFileSync(process.execPath, [CHECKPOINT_MODULE_PATH, 'checkpoint', '--session', 's', '--lane-id', 'l', '--transcript-path', '/x'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.throws(() => execFileSync(process.execPath, [CHECKPOINT_MODULE_PATH, 'touch', '--session', 's', '--lane-id', 'l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
});

test('CLI: an unknown subcommand exits 1 with usage text', () => {
  assert.throws(() => execFileSync(process.execPath, [MODULE_PATH, 'bogus'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
});

// ── portability ──────────────────────────────────────────────────────────

test('portability: no operator-specific hardcoded /Users/<name> path anywhere in this module', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.equal(/\/Users\/[^/'"` ]+/.test(src), false, 'lane-dropbox.js must resolve every path via HOME/os.homedir()/__dirname, never a hardcoded absolute string');
});

test('portability: the filelock and subagent-transcript requires resolve to real, live sibling files', () => {
  // Guards against a stale-path defect class: a require() pointing at a
  // sibling file that doesn't actually exist at that relative location.
  const withLockPath = path.resolve(__dirname, '..', 'lib', 'filelock.js');
  const transcriptPath = path.resolve(__dirname, '..', 'lib', 'subagent-transcript.js');
  assert.equal(fs.existsSync(withLockPath), true, `expected filelock.js at ${withLockPath}`);
  assert.equal(fs.existsSync(transcriptPath), true, `expected subagent-transcript.js at ${transcriptPath}`);
});
