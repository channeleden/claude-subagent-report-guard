'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

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

test('dataDir(): falls back to ~/.claude/subagent-report-guard when nothing is set', () => {
  const prevOverride = process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  const prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    const { dataDir } = freshPathsModule();
    assert.equal(dataDir(), path.join(os.homedir(), '.claude', 'subagent-report-guard'));
  } finally {
    if (prevOverride === undefined) delete process.env.SUBAGENT_REPORT_GUARD_DATA_DIR; else process.env.SUBAGENT_REPORT_GUARD_DATA_DIR = prevOverride;
    if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
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
