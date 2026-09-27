'use strict';

// lib/read-stdin.js — the shared stdin-drain helper every hook uses instead
// of a direct `fs.readFileSync('/dev/stdin', ...)` call (see that module's
// own header for why: a naive single-shot read is reliable on macOS but can
// throw EAGAIN on Linux when stdin is a pipe, which is exactly what every
// hook always sees — this is what broke every hook-subprocess integration
// test in this repo on Linux CI while leaving pure-library tests untouched).
//
// These tests run `readStdinSync()` inside a genuinely spawned child
// process (never in-process) so they exercise the real pipe-backed stdin a
// hook actually sees, on whichever platform this suite runs on — the same
// shape every hook test in this repo already uses via `execFileSync`.

const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'read-stdin.js');

// -e can't require a relative path portably across invocation dirs, so this
// resolves the module by absolute path baked into the -e script itself.
function runReadStdin(input) {
  return execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(require(${JSON.stringify(MODULE_PATH)}).readStdinSync())`],
    { input, encoding: 'utf8' },
  );
}

test('readStdinSync: drains a small piped payload verbatim', () => {
  const payload = JSON.stringify({ transcript_path: '/x/y.jsonl', session_id: 'abc' });
  assert.equal(runReadStdin(payload), payload);
});

test('readStdinSync: empty stdin returns an empty string, never throws', () => {
  assert.equal(runReadStdin(''), '');
});

test('readStdinSync: a payload larger than one internal read chunk (65536 bytes) is drained in full', () => {
  const big = `{"padding":"${'x'.repeat(200_000)}"}`;
  const out = runReadStdin(big);
  assert.equal(out.length, big.length);
  assert.equal(out, big);
});

test('readStdinSync: never throws even when invoked with no piped input at all (inherited stdin)', () => {
  // stdio: 'ignore' for stdin gives the child a closed/empty fd 0 rather than
  // a pipe — this must still resolve (to '') rather than hang or throw.
  const out = execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(require(${JSON.stringify(MODULE_PATH)}).readStdinSync())`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(out, '');
});
