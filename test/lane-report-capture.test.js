'use strict';

// captureReport() coverage — the provider-neutral terminal report-evidence
// leg of lane-dropbox.js. Companion to lane-dropbox.test.js, kept as its own
// file because it exercises a different guarantee: not "was the lane's
// progress checkpointed" but "did the lane leave recoverable report evidence
// behind before it terminated", for a third-party CLI lane (codex/gemini)
// that has no Claude-side hook available to it at all.
//
// Conventions mirror lane-dropbox.test.js exactly (tmpHome + withHome
// save/restore, laneFilePath helper, record-shape assertions on the raw
// JSONL).

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const {
  scaffold,
  captureReport,
  countReportCaptures,
  readLaneRecords,
  laneCaptureFacts,
  readOutputLogTail,
  SCHEMA_VERSION,
  MAX_CAPTURED_REPORT_CHARS,
} = require('../lib/lane-dropbox.js');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'lane-dropbox.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lane-report-capture-'));
}

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

function captureRecords(home, sessionId, laneId) {
  return readLaneRecords(laneFilePath(home, sessionId, laneId))
    .filter((r) => r && r.record_type === 'report-capture');
}

function writeLog(home, name, contents) {
  const p = path.join(home, name);
  fs.writeFileSync(p, contents, 'utf8');
  return p;
}

// ── The core guarantee, on every third-party provider ───────────────────────

test('captures the output-log tail as terminal evidence for every third-party provider', () => {
  const home = tmpHome();
  withHome(home, () => {
    for (const provider of ['codex', 'gemini']) {
      const laneId = `lane-${provider}`;
      const log = writeLog(home, `${provider}.log`, `report body from ${provider}\n`);
      scaffold({
        sessionId: 's', laneId, provider, pid: 4242, outputLog: log,
      });

      const result = captureReport({ sessionId: 's', laneId, terminalReason: 'child-exit:0' });
      assert.deepEqual(result, { written: true, reportAvailable: true });

      const records = captureRecords(home, 's', laneId);
      assert.equal(records.length, 1);
      assert.equal(records[0].schema_version, SCHEMA_VERSION);
      assert.equal(records[0].record_type, 'report-capture');
      assert.equal(records[0].provider, provider);
      assert.equal(records[0].lane_id, laneId);
      assert.equal(records[0].session_id, 's');
      assert.equal(records[0].terminal_reason, 'child-exit:0');
      assert.equal(records[0].capture_source, 'output-log-tail');
      assert.equal(records[0].report_available, true);
      assert.equal(records[0].report_text, `report body from ${provider}`);
      assert.equal(records[0].truncated, false);
      assert.equal(records[0].output_log, log);
      assert.match(records[0].output_log_sha256, /^[0-9a-f]{64}$/);
      assert.equal(
        records[0].output_log_sha256,
        crypto.createHash('sha256').update(fs.readFileSync(log)).digest('hex'),
      );
    }
  });
});

// ── Never overloads the checkpoint hook's delivery contract ─────────────────

test('never writes the report_delivered fields the checkpoint reader rule owns', () => {
  const home = tmpHome();
  withHome(home, () => {
    const log = writeLog(home, 'a.log', 'tail text\n');
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'codex', pid: 1, outputLog: log,
    });
    captureReport({ sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0' });

    const [record] = captureRecords(home, 's', 'l');
    // A scraped log tail is evidence, not a report the lane chose to send.
    // Claiming otherwise would silently corrupt every existing reader of
    // the module header's READER RULE.
    assert.equal(Object.hasOwn(record, 'report_delivered'), false);
    assert.equal(Object.hasOwn(record, 'delivered_report_text'), false);
    assert.equal(Object.hasOwn(record, 'delivered_report_to'), false);
  });
});

test('defers to an existing delivered-report checkpoint instead of appending a weaker answer', () => {
  // This repo's checkpoint() (unlike a fuller Claude-only delivery gate)
  // does not itself parse the transcript for a SendMessage call, so this
  // constructs the delivered checkpoint record directly — the same
  // synthetic-record pattern the adjacent REUSED-lane test below uses —
  // rather than relying on a real checkpoint() call to produce it.
  const home = tmpHome();
  withHome(home, () => {
    scaffold({ sessionId: 's', laneId: 'l', provider: 'claude', agentName: 'worker' });
    fs.appendFileSync(laneFilePath(home, 's', 'l'), `${JSON.stringify({
      schema_version: SCHEMA_VERSION,
      record_type: 'checkpoint',
      lane_id: 'l',
      session_id: 's',
      report_delivered: true,
      delivered_report_text: 'done',
      delivered_report_to: 'main',
    })}\n`, 'utf8');

    const result = captureReport({ sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0' });
    assert.deepEqual(result, { written: false, reportAvailable: true, reason: 'already-delivered' });
    assert.equal(captureRecords(home, 's', 'l').length, 0);
  });
});

test('a stale delivered checkpoint on a REUSED lane file never starves an identified new run', () => {
  const home = tmpHome();
  withHome(home, () => {
    const log = writeLog(home, 'b2.log', 'new run output\n');
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'claude', pid: 1, outputLog: log,
    });
    fs.appendFileSync(laneFilePath(home, 's', 'l'), `${JSON.stringify({
      schema_version: SCHEMA_VERSION,
      record_type: 'checkpoint',
      lane_id: 'l',
      session_id: 's',
      report_delivered: true,
      delivered_report_text: 'a PRIOR run delivered this',
      delivered_report_to: 'main',
    })}\n`, 'utf8');

    // A run that identifies itself must still land its terminal record —
    // the checkpoint carries no run identity, so it cannot prove THIS run
    // already answered. The count > after:<N> wait contract depends on it.
    const result = captureReport({
      sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0', runId: 'run-fresh-1',
    });
    assert.equal(result.written, true);
    const records = captureRecords(home, 's', 'l');
    assert.equal(records.length, 1);
    assert.equal(records[0].run_id, 'run-fresh-1');
    assert.equal(records[0].prior_delivered_checkpoint, true);

    // Same run captured twice still dedupes on run identity.
    const dup = captureReport({
      sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0', runId: 'run-fresh-1',
    });
    assert.equal(dup.written, false);
    assert.equal(dup.reason, 'duplicate-run');
    assert.equal(captureRecords(home, 's', 'l').length, 1);
  });
});

// ── The expensive case is stated, never silent ───────────────────────────────

test('records an explicit unavailable verdict when the lane had no output log', () => {
  const home = tmpHome();
  withHome(home, () => {
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'gemini', pid: 1, outputLog: null,
    });
    const result = captureReport({ sessionId: 's', laneId: 'l', terminalReason: 'child-timeout' });
    assert.deepEqual(result, { written: true, reportAvailable: false });

    const [record] = captureRecords(home, 's', 'l');
    assert.equal(record.report_available, false);
    assert.equal(record.report_text, null);
    assert.equal(record.capture_source, 'none');
    assert.equal(record.unavailable_reason, 'no-output-log');
    assert.equal(record.terminal_reason, 'child-timeout');
  });
});

test('records an explicit unavailable verdict when the output log cannot be read', () => {
  const home = tmpHome();
  withHome(home, () => {
    scaffold({
      sessionId: 's',
      laneId: 'l',
      provider: 'gemini',
      pid: 1,
      outputLog: path.join(home, 'never-created.log'),
    });
    const result = captureReport({ sessionId: 's', laneId: 'l', terminalReason: 'spawn-error' });
    assert.deepEqual(result, { written: true, reportAvailable: false });
    assert.equal(captureRecords(home, 's', 'l')[0].unavailable_reason, 'unreadable-output-log');
  });
});

test('records an explicit unavailable verdict for an empty output log', () => {
  const home = tmpHome();
  withHome(home, () => {
    const log = writeLog(home, 'empty.log', '');
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'codex', pid: 1, outputLog: log,
    });
    const result = captureReport({ sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0' });
    assert.deepEqual(result, { written: true, reportAvailable: false });

    const [record] = captureRecords(home, 's', 'l');
    assert.equal(record.report_available, false);
    assert.equal(record.unavailable_reason, 'empty-output-log');
  });
});

// ── Idempotence + truncation ─────────────────────────────────────────────────

test('a repeat call for the SAME run appends no duplicate record; a distinct run always appends', () => {
  // Idempotence is keyed on `runId`, never on log content.
  const home = tmpHome();
  withHome(home, () => {
    const log = writeLog(home, 'c.log', 'only report\n');
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'codex', pid: 1, outputLog: log,
    });

    assert.equal(captureReport({ sessionId: 's', laneId: 'l', runId: 'run-1' }).written, true);
    const second = captureReport({ sessionId: 's', laneId: 'l', runId: 'run-1' });
    assert.deepEqual(second, { written: false, reportAvailable: true, reason: 'duplicate-run' });
    assert.equal(captureRecords(home, 's', 'l').length, 1);

    // A later, distinct run (new runId) always gets its own record, whether
    // or not the log content actually changed.
    fs.appendFileSync(log, 'a later, fuller report\n', 'utf8');
    assert.equal(captureReport({ sessionId: 's', laneId: 'l', runId: 'run-2' }).written, true);
    const records = captureRecords(home, 's', 'l');
    assert.equal(records.length, 2);
    assert.match(records[1].report_text, /a later, fuller report$/);
  });
});

test('a same-size/different-content re-dispatch, AND a same-content re-dispatch, both append their own run record', () => {
  const home = tmpHome();
  withHome(home, () => {
    // Two five-byte payloads, same byte length, different content — a
    // content-hash dedupe would previously suppress the second terminal
    // record entirely, so a caller polling for a NEW report-capture record
    // would read the FIRST run's record and believe the SECOND run had
    // finished. The SHA is still computed and recorded as informational
    // evidence, but run identity — never content — gates the append.
    const log = writeLog(home, 'reuse.log', 'AAAAA');
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'codex', pid: 1, outputLog: log,
    });
    const first = captureReport({
      sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0', runId: 'run-1',
    });
    assert.equal(first.written, true);

    // Orchestrator truncates and rewrites the same output-log path on a
    // re-dispatch under the same lane id — simulate that here directly.
    fs.writeFileSync(log, 'BBBBB', 'utf8');
    const second = captureReport({
      sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0', runId: 'run-2',
    });
    assert.equal(second.written, true, 'a same-size, different-content re-dispatch must append a NEW terminal record');
    assert.notEqual(second.reason, 'duplicate-run');

    // The harder case: a THIRD run (reused lane id again) whose captured
    // tail is IDENTICAL to the prior run's ("BBBBB" again — the tool
    // legitimately reported the same final line twice). Content-hash
    // dedupe would swallow this; run-identity dedupe must not, because
    // run-3 never captured anything before.
    fs.writeFileSync(log, 'BBBBB', 'utf8');
    const third = captureReport({
      sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0', runId: 'run-3',
    });
    assert.equal(third.written, true, 'a distinct run with IDENTICAL captured content to a prior run must still append its own terminal record');
    assert.notEqual(third.reason, 'duplicate-run');

    const records = captureRecords(home, 's', 'l');
    assert.equal(records.length, 3, 'all three runs must have their own terminal record on disk');
    assert.equal(records[0].report_text, 'AAAAA');
    assert.equal(records[1].report_text, 'BBBBB');
    assert.equal(records[2].report_text, 'BBBBB');
    assert.notEqual(records[0].output_log_sha256, records[1].output_log_sha256);
    assert.equal(records[1].output_log_sha256, records[2].output_log_sha256, 'run-2 and run-3 legitimately captured identical content');
    assert.equal(records[0].output_log_bytes, records[1].output_log_bytes, 'the repro requires equal byte length across records');
    assert.equal(records[2].content_unchanged_from_prior_capture, true, 'still surfaced informationally, just never used to suppress the append');

    // A genuine repeat call for run-3's OWN runId is still correctly
    // deduped — the fix must not turn every capture into a duplicate.
    const repeat = captureReport({
      sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0', runId: 'run-3',
    });
    assert.deepEqual(repeat, { written: false, reportAvailable: true, reason: 'duplicate-run' });
    assert.equal(captureRecords(home, 's', 'l').length, 3);
  });
});

test('an oversized log is tail-captured, flagged truncated, and never returns a partial first line', () => {
  const home = tmpHome();
  withHome(home, () => {
    const filler = `${'x'.repeat(200)}\n`.repeat(Math.ceil(MAX_CAPTURED_REPORT_CHARS / 200) + 20);
    const log = writeLog(home, 'big.log', `${filler}FINAL LINE OF REPORT\n`);
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'gemini', pid: 1, outputLog: log,
    });

    assert.equal(captureReport({ sessionId: 's', laneId: 'l' }).written, true);
    const [record] = captureRecords(home, 's', 'l');
    assert.equal(record.truncated, true);
    assert.equal(record.report_available, true);
    assert.match(record.report_text, /FINAL LINE OF REPORT$/);
    assert.ok(record.report_text.length < MAX_CAPTURED_REPORT_CHARS);
    // The byte seek can land mid-line; that partial head line is dropped,
    // so every retained line is a whole line.
    assert.ok(record.report_text.split('\n').every((line) => line === '' || line.length === 200 || /FINAL LINE OF REPORT/.test(line)));
    assert.equal(record.output_log_bytes, fs.statSync(log).size);
  });
});

// ── Contract violations are closed reasons, never throws ────────────────────

test('invalid identifiers return the closed invalid-args reason and never throw', () => {
  const home = tmpHome();
  withHome(home, () => {
    for (const args of [
      {},
      { sessionId: '', laneId: 'l' },
      { sessionId: 's', laneId: '' },
      { sessionId: 's' },
    ]) {
      assert.deepEqual(
        captureReport(args),
        { written: false, reportAvailable: false, reason: 'invalid-args' },
      );
    }
  });
});

// ── Internal readers ─────────────────────────────────────────────────────────

test('laneCaptureFacts takes the latest scaffold output log and any delivered checkpoint', () => {
  const home = tmpHome();
  withHome(home, () => {
    const first = writeLog(home, 'first.log', 'one\n');
    const second = writeLog(home, 'second.log', 'two\n');
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'codex', pid: 1, outputLog: first,
    });
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'gemini', pid: 2, outputLog: second,
    });

    const facts = laneCaptureFacts(laneFilePath(home, 's', 'l'));
    // Provider is the FIRST scaffold's (matching laneFileFacts); the
    // output log is the LATEST scaffold's, since a re-scaffold redirects
    // the log.
    assert.equal(facts.provider, 'codex');
    assert.equal(facts.outputLog, second);
    assert.equal(facts.reportDelivered, false);
    assert.equal(facts.lastCapturedBytes, null);
    assert.equal(facts.lastCapturedSha256, null);
    assert.equal(facts.capturedRunIds.size, 0);
  });
});

test('laneCaptureFacts collects every distinct run_id seen among report-capture records, each with its own reportAvailable', () => {
  const home = tmpHome();
  withHome(home, () => {
    const log = writeLog(home, 'runs.log', 'payload');
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'codex', pid: 1, outputLog: log,
    });
    captureReport({
      sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0', runId: 'run-a',
    });
    fs.writeFileSync(log, '', 'utf8');
    captureReport({
      sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0', runId: 'run-b',
    });

    const facts = laneCaptureFacts(laneFilePath(home, 's', 'l'));
    assert.equal(facts.capturedRunIds.size, 2);
    assert.equal(facts.capturedRunIds.get('run-a'), true);
    assert.equal(facts.capturedRunIds.get('run-b'), false, 'an empty output log captures with reportAvailable: false');
    assert.equal(facts.capturedRunIds.has('run-c'), false);
  });
});

// ── countReportCaptures — the after:<N> baseline ─────────────────────────────

test('countReportCaptures reflects only report-capture records and stays 0 for a fresh or absent lane', () => {
  const home = tmpHome();
  withHome(home, () => {
    assert.equal(countReportCaptures({ sessionId: 's', laneId: 'never-dispatched' }), 0);

    const log = writeLog(home, 'count.log', 'first payload');
    scaffold({
      sessionId: 's', laneId: 'l', provider: 'codex', pid: 1, outputLog: log,
    });
    assert.equal(countReportCaptures({ sessionId: 's', laneId: 'l' }), 0, 'a scaffold record is not a report-capture record');

    captureReport({ sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0' });
    assert.equal(countReportCaptures({ sessionId: 's', laneId: 'l' }), 1);

    fs.writeFileSync(log, 'second payload, same lane id reused', 'utf8');
    captureReport({ sessionId: 's', laneId: 'l', terminalReason: 'child-exit:0' });
    assert.equal(countReportCaptures({ sessionId: 's', laneId: 'l' }), 2);
  });
});

test('countReportCaptures fails open to 0 on invalid identifiers rather than throwing', () => {
  assert.equal(countReportCaptures({ sessionId: '', laneId: 'l' }), 0);
  assert.equal(countReportCaptures({ sessionId: 's', laneId: '' }), 0);
  assert.equal(countReportCaptures({}), 0);
});

test('readOutputLogTail returns null on an unreadable path rather than guessing', () => {
  const home = tmpHome();
  assert.equal(readOutputLogTail(path.join(home, 'absent.log')), null);
});

// ── CLI ───────────────────────────────────────────────────────────────────

test('CLI: capture-report subcommand runs standalone via node and reports the same shape as the direct call', () => {
  const home = tmpHome();
  withHome(home, () => {
    const log = writeLog(home, 'cli.log', 'cli-captured report\n');
    scaffold({
      sessionId: 'cli-cr', laneId: 'lane-cli', provider: 'codex', pid: 99, outputLog: log,
    });

    const out = execFileSync(process.execPath, [
      MODULE_PATH, 'capture-report',
      '--session', 'cli-cr', '--lane-id', 'lane-cli',
      '--terminal-reason', 'child-exit:0', '--run-id', 'cli-run-1',
    ], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    const parsed = JSON.parse(out.trim());
    assert.deepEqual(parsed, { written: true, reportAvailable: true });

    const [record] = captureRecords(home, 'cli-cr', 'lane-cli');
    assert.equal(record.report_text, 'cli-captured report');
    assert.equal(record.run_id, 'cli-run-1');
  });
});

test('CLI: count-report-captures subcommand reports the current count as { count }', () => {
  const home = tmpHome();
  withHome(home, () => {
    const log = writeLog(home, 'cli2.log', 'payload\n');
    scaffold({
      sessionId: 'cli-count', laneId: 'lane-cli2', provider: 'gemini', pid: 1, outputLog: log,
    });
    captureReport({ sessionId: 'cli-count', laneId: 'lane-cli2', runId: 'r1' });

    const out = execFileSync(process.execPath, [
      MODULE_PATH, 'count-report-captures', '--session', 'cli-count', '--lane-id', 'lane-cli2',
    ], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.trim()), { count: 1 });
  });
});

// ── Source guards ─────────────────────────────────────────────────────────

test('source guard: no operator-specific hardcoded /Users/<name> path in this repo\'s lane-dropbox.js', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.equal(/\/Users\/[^/'"` ]+/.test(src), false);
});
