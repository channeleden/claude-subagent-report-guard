'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { maybeRun, readConfiguredCommand, markerPathFor } = require('../lib/post-report-command.js');

let counter = 0;
function mkDataDir() {
  counter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `post-report-cmd-${counter}-`));
}

test('off by default: maybeRun does nothing and returns false with no config at all', () => {
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  delete process.env.SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND;
  try {
    const ran = maybeRun('/tmp/some/transcript.jsonl');
    assert.equal(ran, false);
    assert.equal(fs.existsSync(path.join(dataDir, 'post-report-command')), false, 'no marker dir created when nothing fires');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('readConfiguredCommand: env var takes precedence over config.json', () => {
  const dataDir = mkDataDir();
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ postReportCommand: 'echo from-config' }));
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  process.env.SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND = 'echo from-env';
  try {
    assert.equal(readConfiguredCommand(), 'echo from-env');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
    delete process.env.SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND;
  }
});

test('readConfiguredCommand: reads config.json when no env var is set', () => {
  const dataDir = mkDataDir();
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ postReportCommand: 'echo hi' }));
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  delete process.env.SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND;
  try {
    assert.equal(readConfiguredCommand(), 'echo hi');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});

test('maybeRun: fires the configured command exactly once per transcript path', async () => {
  const dataDir = mkDataDir();
  const marker = path.join(dataDir, 'fired.txt');
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  process.env.SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND = `node -e "require('fs').writeFileSync('${marker}', 'ran')"`;
  try {
    const first = maybeRun('/tmp/agent-x.jsonl', { agentId: 'agent-x' });
    assert.equal(first, true);
    const second = maybeRun('/tmp/agent-x.jsonl', { agentId: 'agent-x' });
    assert.equal(second, false, 'must not fire twice for the same transcript path');

    // Give the detached child a brief moment to actually write the marker.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(marker), true);
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
    delete process.env.SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND;
  }
});

test('maybeRun: two concurrent attempts for the same transcript path — exactly one spawns', () => {
  const dataDir = mkDataDir();
  const marker = path.join(dataDir, 'fired-concurrent.txt');
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  process.env.SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND = `node -e "require('fs').appendFileSync('${marker}', 'ran\\n')"`;
  try {
    // Both calls race on the SAME transcript path with no delay between
    // them — the atomic `wx`-created marker file is what guarantees only
    // one can ever win, not timing.
    const results = [
      maybeRun('/tmp/agent-race.jsonl', { agentId: 'agent-race' }),
      maybeRun('/tmp/agent-race.jsonl', { agentId: 'agent-race' }),
    ];
    assert.deepEqual(results.filter(Boolean).length, 1, 'exactly one of the two concurrent attempts must have spawned');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
    delete process.env.SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND;
  }
});

test('markerPathFor: lives under the data dir, keyed deterministically by transcript path', () => {
  const dataDir = mkDataDir();
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  try {
    const p1 = markerPathFor('/tmp/agent-a.jsonl');
    const p2 = markerPathFor('/tmp/agent-a.jsonl');
    const p3 = markerPathFor('/tmp/agent-b.jsonl');
    assert.equal(p1, p2);
    assert.notEqual(p1, p3);
    assert.ok(p1.startsWith(dataDir));
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});
