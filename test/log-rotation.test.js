'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { rotateIfNeeded, appendRotating } = require('../lib/log-rotation.js');
const { main: migrateLegacyLog } = require('../scripts/migrate-legacy-log.js');

function mkFile(size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotation-'));
  const p = path.join(dir, 'log.jsonl');
  fs.writeFileSync(p, 'x'.repeat(size));
  return p;
}

test('rotateIfNeeded: no-op when the file does not exist', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotation-')), 'missing.log');
  assert.equal(rotateIfNeeded(p), false);
});

test('rotateIfNeeded: no-op when the file is under the cap', () => {
  const p = mkFile(100);
  assert.equal(rotateIfNeeded(p, 1000), false);
  assert.ok(fs.existsSync(p));
});

test('rotateIfNeeded: renames to .1 when over the cap, overwriting an existing .1', () => {
  const p = mkFile(2000);
  fs.writeFileSync(`${p}.1`, 'old generation');
  assert.equal(rotateIfNeeded(p, 1000), true);
  assert.equal(fs.existsSync(p), false);
  assert.equal(fs.readFileSync(`${p}.1`, 'utf8').length, 2000);
});

test('appendRotating: rotates before appending, and creates the parent dir lazily', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotation-append-'));
  const p = path.join(dir, 'nested', 'log.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x'.repeat(2000));

  const ok = appendRotating(p, 'new line', { maxBytes: 1000 });
  assert.equal(ok, true);
  assert.equal(fs.existsSync(`${p}.1`), true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'new line\n');
});

test('appendRotating: keeps exactly one prior generation across repeated rotations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotation-repeat-'));
  const p = path.join(dir, 'log.jsonl');
  appendRotating(p, 'gen0'.repeat(500), { maxBytes: 100 }); // triggers no rotation (file didn't exist yet)
  appendRotating(p, 'gen1'.repeat(500), { maxBytes: 100 }); // rotates gen0 -> .1
  appendRotating(p, 'gen2'.repeat(500), { maxBytes: 100 }); // rotates gen1 -> .1 (overwrites gen0's .1)
  assert.equal(fs.existsSync(`${p}.1`), true);
  assert.equal(fs.existsSync(`${p}.2`), false, 'only one prior generation is ever kept');
});

// ── scripts/migrate-legacy-log.js ───────────────────────────────────────

test('migrate-legacy-log: rotates an oversized legacy file once', () => {
  const p = mkFile(3 * 1024 * 1024);
  const code = migrateLegacyLog(['node', 'migrate-legacy-log.js', p]);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(p), false);
  assert.equal(fs.existsSync(`${p}.1`), true);
});

test('migrate-legacy-log: a no-op on an already-small file', () => {
  const p = mkFile(100);
  const code = migrateLegacyLog(['node', 'migrate-legacy-log.js', p]);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(p), true, 'small file is left in place');
});

test('migrate-legacy-log: usage error when no path given', () => {
  const code = migrateLegacyLog(['node', 'migrate-legacy-log.js']);
  assert.equal(code, 1);
});
