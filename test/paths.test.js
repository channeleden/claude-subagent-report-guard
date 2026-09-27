'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

function freshPathsModule() {
  delete require.cache[require.resolve('../lib/paths.js')];
  return require('../lib/paths.js');
}

test('dataDir(): SUBAGENT_REPORT_GUARD_DATA_DIR override wins over everything', () => {
  const prevOverride = process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  const prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = '/tmp/override-dir';
  process.env.CLAUDE_PLUGIN_DATA = '/tmp/plugin-data-dir';
  try {
    const { dataDir } = freshPathsModule();
    assert.equal(dataDir(), '/tmp/override-dir');
  } finally {
    if (prevOverride === undefined) delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR; else process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = prevOverride;
    if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
  }
});

test('dataDir(): CLAUDE_PLUGIN_DATA is used when no override is set', () => {
  const prevOverride = process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  const prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  process.env.CLAUDE_PLUGIN_DATA = '/tmp/plugin-data-dir';
  try {
    const { dataDir } = freshPathsModule();
    assert.equal(dataDir(), '/tmp/plugin-data-dir');
  } finally {
    if (prevOverride === undefined) delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR; else process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = prevOverride;
    if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
  }
});

// Exercises the fallback branch against a FAKED HOME, never the real one —
// see the "refuses to fall back to the real HOME under the test runner"
// test below for why a real, un-isolated fallback call is not just
// untested but actively refused.
test('dataDir(): falls back to <HOME>/.claude/subagent-report-guard when nothing is set (faked HOME, NODE_TEST_CONTEXT forced on)', () => {
  const prevOverride = process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  const prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const prevHome = process.env.HOME;
  const prevTestContext = process.env.NODE_TEST_CONTEXT;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-fallback-home-'));
  delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  delete process.env.CLAUDE_PLUGIN_DATA;
  process.env.HOME = fakeHome;
  process.env.NODE_TEST_CONTEXT = '1';
  try {
    assert.notEqual(fakeHome, os.userInfo().homedir, 'faked HOME must actually differ from the real OS home for this test to prove anything');
    const { dataDir } = freshPathsModule();
    assert.equal(dataDir(), path.join(fakeHome, '.claude', 'subagent-report-guard'));
  } finally {
    if (prevOverride === undefined) delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR; else process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = prevOverride;
    if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevTestContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevTestContext;
  }
});

// ── dataDir(): the real-HOME test-isolation guard ────────────────────────
//
// Regression coverage for a real leak: a handful of lib/report-gate.js
// tests called decide() directly with no SUBAGENT_REPORT_GUARD_DATA_DIR
// override and no faked HOME, so dataDir()'s fallback branch resolved to
// (and wrote real state files under) the operator's actual
// ~/.claude/subagent-report-guard. dataDir() now refuses that combination
// outright whenever node --test's own NODE_TEST_CONTEXT env var is set AND
// os.homedir() resolves to the real, OS-level home — see lib/paths.js's own
// comment for why this can never fire outside a test run.
//
// This test does NOT rely on the ambient environment `node --test` already
// gave this process to happen to already be "real NODE_TEST_CONTEXT, real
// un-faked HOME" — that assumption is false in a sandboxed harness, where
// the ambient HOME is routinely already something other than
// os.userInfo().homedir (the real, OS-level home), which would make the
// guard's own precondition false and this test prove nothing. Instead it
// spawns an isolated child process with the exact condition the guard is
// built to catch made EXPLICIT: HOME forced to the real OS home
// (os.userInfo().homedir, which — unlike os.homedir() — ignores any HOME
// override and reads the OS user database directly), NODE_TEST_CONTEXT
// forced on, and both data-dir overrides explicitly unset. A throw from
// that child is the actual proof the guard fires under its real trigger
// condition, regardless of what this test file's own ambient env happens
// to be.
test('dataDir(): refuses to fall back to the real HOME under the test runner (spawned child, explicit HOME + NODE_TEST_CONTEXT, no override)', () => {
  const realHome = os.userInfo().homedir;
  const pathsModulePath = path.join(__dirname, '..', 'lib', 'paths.js');
  const script = [
    `const { dataDir } = require(${JSON.stringify(pathsModulePath)});`,
    'try {',
    '  dataDir();',
    "  process.stdout.write('NO_THROW');",
    '} catch (e) {',
    "  process.stdout.write('THREW:' + e.message);",
    '}',
  ].join('\n');

  const env = { ...process.env, HOME: realHome, NODE_TEST_CONTEXT: '1' };
  delete env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  delete env.CLAUDE_PLUGIN_DATA;

  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
  assert.match(out, /^THREW:/, `expected dataDir() to throw under real HOME + NODE_TEST_CONTEXT, got: ${out}`);
  assert.match(out, /refusing to fall back to the real home directory/);
});

// Explicit about BOTH halves of the guard's own trigger condition
// (NODE_TEST_CONTEXT set AND os.homedir() === the real OS home): forces
// NODE_TEST_CONTEXT on itself rather than depending on whatever the ambient
// test-runner env happens to carry, then fakes HOME away from the real OS
// home (os.userInfo().homedir) so the guard's SECOND half is false — proving
// the guard specifically needs BOTH halves, not just NODE_TEST_CONTEXT alone.
test('dataDir(): the guard above does not fire once HOME is faked away from the real one (NODE_TEST_CONTEXT forced on)', () => {
  const prevOverride = process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  const prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const prevHome = process.env.HOME;
  const prevTestContext = process.env.NODE_TEST_CONTEXT;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-guard-home-'));
  delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  delete process.env.CLAUDE_PLUGIN_DATA;
  process.env.HOME = fakeHome;
  process.env.NODE_TEST_CONTEXT = '1';
  try {
    assert.notEqual(fakeHome, os.userInfo().homedir, 'faked HOME must actually differ from the real OS home for this test to prove anything');
    const { dataDir } = freshPathsModule();
    assert.doesNotThrow(() => dataDir());
  } finally {
    if (prevOverride === undefined) delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR; else process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = prevOverride;
    if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevTestContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevTestContext;
  }
});

// Explicit about NODE_TEST_CONTEXT here too, and about HOME being left at
// whatever the real OS home is — the override must win regardless of either.
test('dataDir(): the guard does not fire once SUBAGENT_REPORT_GUARD_DATA_DIR is set, even with a real HOME and NODE_TEST_CONTEXT forced on', () => {
  const prevOverride = process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  const prevTestContext = process.env.NODE_TEST_CONTEXT;
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = '/tmp/some-override-dir';
  process.env.NODE_TEST_CONTEXT = '1';
  try {
    const { dataDir } = freshPathsModule();
    assert.doesNotThrow(() => dataDir());
  } finally {
    if (prevOverride === undefined) delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR; else process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = prevOverride;
    if (prevTestContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevTestContext;
  }
});

// ── dropboxRootDir() ──────────────────────────────────────────────────────

function withDropboxEnv({ dataDir, dropboxRoot } = {}, fn) {
  const keys = ['SUBAGENT_REPORT_GUARD_DATA_DIR', 'CLAUDE_PLUGIN_DATA', 'SUBAGENT_REPORT_GUARD_DROPBOX_ROOT'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.SUBAGENT_REPORT_GUARD_DROPBOX_ROOT;
  if (dataDir) process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = dataDir;
  if (dropboxRoot) process.env.SUBAGENT_REPORT_GUARD_DROPBOX_ROOT = dropboxRoot;
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('dropboxRootDir(): defaults to <dataDir>/teams — fully self-contained with zero configuration', () => {
  withDropboxEnv({ dataDir: '/tmp/plugin-data' }, () => {
    const { dropboxRootDir } = freshPathsModule();
    assert.equal(dropboxRootDir(), path.join('/tmp/plugin-data', 'teams'));
  });
});

test('dropboxRootDir(): env override wins over everything, including config.json', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-dropbox-'));
  fs.writeFileSync(path.join(scratch, 'config.json'), JSON.stringify({ dropboxRoot: '/tmp/from-config' }), 'utf8');
  withDropboxEnv({ dataDir: scratch, dropboxRoot: '/tmp/from-env' }, () => {
    const { dropboxRootDir } = freshPathsModule();
    assert.equal(dropboxRootDir(), '/tmp/from-env');
  });
});

test('dropboxRootDir(): reads dropboxRoot from <dataDir>/config.json when no env override is set', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-dropbox-'));
  fs.writeFileSync(path.join(scratch, 'config.json'), JSON.stringify({ dropboxRoot: '/tmp/from-config' }), 'utf8');
  withDropboxEnv({ dataDir: scratch }, () => {
    const { dropboxRootDir } = freshPathsModule();
    assert.equal(dropboxRootDir(), '/tmp/from-config');
  });
});

test('dropboxRootDir(): a malformed config.json is treated exactly like no override — never throws', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-dropbox-'));
  fs.writeFileSync(path.join(scratch, 'config.json'), 'not valid json{{{', 'utf8');
  withDropboxEnv({ dataDir: scratch }, () => {
    const { dropboxRootDir } = freshPathsModule();
    assert.equal(dropboxRootDir(), path.join(scratch, 'teams'));
  });
});

test('expandTilde(): expands a leading ~/ against the real home directory, leaves other paths untouched', () => {
  const { expandTilde } = freshPathsModule();
  assert.equal(expandTilde('~/somewhere'), path.join(os.homedir(), 'somewhere'));
  assert.equal(expandTilde('~'), os.homedir());
  assert.equal(expandTilde('/already/absolute'), '/already/absolute');
  assert.equal(expandTilde('relative/path'), 'relative/path');
});

test('dropboxRootDir(): SUBAGENT_REPORT_GUARD_DROPBOX_ROOT is tilde-expanded', () => {
  withDropboxEnv({ dataDir: '/tmp/plugin-data', dropboxRoot: '~/custom-teams-root' }, () => {
    const { dropboxRootDir } = freshPathsModule();
    assert.equal(dropboxRootDir(), path.join(os.homedir(), 'custom-teams-root'));
  });
});

test('ensureSubPath(): creates the parent directory lazily and returns the joined path', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
  process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = scratch;
  try {
    const { ensureSubPath } = freshPathsModule();
    const p = ensureSubPath('foo', 'bar.json');
    assert.equal(p, path.join(scratch, 'foo', 'bar.json'));
    assert.ok(fs.existsSync(path.join(scratch, 'foo')));
    assert.equal(fs.existsSync(p), false, 'ensureSubPath creates the DIRECTORY, not the file itself');
  } finally {
    delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  }
});
