'use strict';

// scripts/hygiene-check.js self-test: builds a scratch git repo, plants one
// tracked file per rule, and asserts each rule fires — plus a clean-tree
// pass with none of them.
//
// The private-vocabulary rule is hashed (see scripts/hygiene-check.js's own
// header): this test never uses the real, private denylist terms. Instead
// it points the script at a scratch denylist file (via --denylist) built
// from NEUTRAL fake terms (zebracorn, quux-widget) so the rule's mechanics
// are proven without this test file itself becoming a place the real terms
// leak from.
//
// NO WHOLE-FILE EXEMPTION: this file is scanned by hygiene-check.js like
// any other tracked file (see scripts/hygiene-check.js's own header). Every
// fixture literal below that would otherwise be a real trigger shape is
// therefore assembled from fragments at runtime (plain string
// concatenation) rather than written as one contiguous literal, so the
// rule fires against the runtime content without a matching literal ever
// sitting in this file's own source.

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'hygiene-check.js');
const REAL_DENYLIST = path.join(__dirname, '..', 'scripts', 'hygiene-denylist.sha256');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-check-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', `test${'@'}example.com`], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function writeAndAdd(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  // -f: a scratch repo's ambient global gitignore may exclude fixtures like
  // .DS_Store; the test explicitly wants it tracked regardless.
  execFileSync('git', ['add', '-f', relPath], { cwd: dir });
}

function commit(dir, message = 'test commit') {
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

function runScript(dir, args = []) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

// A scratch denylist built from neutral fake terms, never the real private
// vocabulary this repo actually cares about hiding.
function mkNeutralDenylist(dir, terms = ['zebracorn', 'quux-widget', 'fizzbuzz gadget']) {
  const denylistPath = path.join(dir, 'fake-denylist.sha256');
  fs.writeFileSync(denylistPath, `${terms.map(sha256).join('\n')}\n`, 'utf8');
  return denylistPath;
}

test('hygiene-check: a clean tree passes with exit 0', () => {
  const dir = mkRepo();
  writeAndAdd(dir, 'README.md', '# hello\n\nnothing suspicious here.\n');
  commit(dir);
  const { code, out } = runScript(dir);
  assert.equal(code, 0);
  assert.match(out, /clean/);
});

test('hygiene-check: absolute user path triggers and fails', () => {
  const dir = mkRepo();
  writeAndAdd(dir, 'notes.md', `the file lives at ${'/Users/'}${'exampleuser/project/file.txt'}\n`);
  commit(dir);
  const { code, out } = runScript(dir);
  assert.equal(code, 1);
  assert.match(out, /absolute-user-path/);
});

test('hygiene-check: private vocabulary (hashed) triggers on a single-word term', () => {
  const dir = mkRepo();
  const denylist = mkNeutralDenylist(dir);
  writeAndAdd(dir, 'notes.md', 'the zebracorn ran across the field\n');
  commit(dir);
  const { code, out } = runScript(dir, [`--denylist=${denylist}`]);
  assert.equal(code, 1);
  assert.match(out, /private-vocabulary \(hashed\)/);
  // Never the matched term itself in the report.
  assert.doesNotMatch(out, /zebracorn/);
});

test('hygiene-check: private vocabulary (hashed) triggers on a hyphenated term', () => {
  const dir = mkRepo();
  const denylist = mkNeutralDenylist(dir);
  writeAndAdd(dir, 'notes.md', 'ship the quux-widget by friday\n');
  commit(dir);
  const { code, out } = runScript(dir, [`--denylist=${denylist}`]);
  assert.equal(code, 1);
  assert.match(out, /private-vocabulary \(hashed\)/);
  assert.doesNotMatch(out, /quux-widget/);
});

test('hygiene-check: private vocabulary (hashed) triggers on a multi-word phrase', () => {
  const dir = mkRepo();
  const denylist = mkNeutralDenylist(dir);
  writeAndAdd(dir, 'notes.md', 'order the fizzbuzz gadget today\n');
  commit(dir);
  const { code, out } = runScript(dir, [`--denylist=${denylist}`]);
  assert.equal(code, 1);
  assert.match(out, /private-vocabulary \(hashed\)/);
  assert.doesNotMatch(out, /fizzbuzz/);
});

test('hygiene-check: a per-line hygiene-allow escape suppresses that rule for that line only', () => {
  const dir = mkRepo();
  const denylist = mkNeutralDenylist(dir);
  writeAndAdd(dir, 'notes.md', 'the zebracorn ran across the field <!-- hygiene-allow: private-vocabulary (hashed) -->\n');
  commit(dir);
  const { code, out } = runScript(dir, [`--denylist=${denylist}`]);
  assert.equal(code, 0);
  assert.match(out, /hygiene-allow used:/);
});

test('hygiene-check: internal task id triggers', () => {
  const dir = mkRepo();
  writeAndAdd(dir, 'notes.md', `tracked under ${'as'}${'-1234'} for reference\n`);
  commit(dir);
  const { code, out } = runScript(dir);
  assert.equal(code, 1);
  assert.match(out, /internal-task-id/);
});

test('hygiene-check: a non-allowlisted email triggers, but the anthropic co-author line does not', () => {
  const dir = mkRepo();
  writeAndAdd(dir, 'notes.md', `contact ${'someone'}${'@'}${'example.com'} for details\n`);
  commit(dir);
  const { code, out } = runScript(dir);
  assert.equal(code, 1);
  assert.match(out, /email-address/);

  const dir2 = mkRepo();
  writeAndAdd(dir2, 'notes.md', 'Co-Authored-By: Someone <noreply@anthropic.com>\n');
  commit(dir2);
  const clean = runScript(dir2);
  assert.equal(clean.code, 0);
});

test('hygiene-check: secret-shaped strings trigger', () => {
  const dir = mkRepo();
  writeAndAdd(dir, 'notes.md', `token: sk-${'a'.repeat(24)}\n`);
  commit(dir);
  const { code, out } = runScript(dir);
  assert.equal(code, 1);
  assert.match(out, /secret-pattern/);
});

test('hygiene-check: OS junk files trigger', () => {
  const dir = mkRepo();
  writeAndAdd(dir, '.DS_Store', 'binary junk');
  commit(dir);
  const { code, out } = runScript(dir);
  assert.equal(code, 1);
  assert.match(out, /os-junk-file/);
});

test('hygiene-check: the real repo tree (no whole-file exemption) stays clean, including this script and its own test file', () => {
  // No SELF_EXEMPT allowlist exists anymore — this script and its own test
  // file are scanned like any other tracked file. This passes because
  // every fixture trigger example above is fragment-assembled at runtime
  // (see the file header), never a contiguous literal in the source.
  const { code, out } = runScript(path.join(__dirname, '..'));
  assert.equal(code, 0, `the real repo tree must stay clean with no whole-file exemption:\n${out}`);
});

test('hygiene-check --history: reports findings without modifying anything, and always exits 0', () => {
  const dir = mkRepo();
  writeAndAdd(dir, 'notes.md', `the file lives at ${'/Users/'}${'exampleuser/project/file.txt'}\n`);
  commit(dir, 'first');
  writeAndAdd(dir, 'notes.md', 'cleaned up now\n');
  commit(dir, 'second');

  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const { code, out } = runScript(dir, ['--history']);
  assert.equal(code, 0);
  assert.match(out, /absolute-user-path/);
  const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(before, after, 'history scan must never modify the repo');
});

test('hygiene-check --history: the hashed private-vocabulary rule works in history mode too', () => {
  const dir = mkRepo();
  const denylist = mkNeutralDenylist(dir);
  writeAndAdd(dir, 'notes.md', 'the zebracorn ran across the field\n');
  commit(dir, 'first');
  writeAndAdd(dir, 'notes.md', 'cleaned up now\n');
  commit(dir, 'second');

  const { code, out } = runScript(dir, ['--history', `--denylist=${denylist}`]);
  assert.equal(code, 0);
  assert.match(out, /private-vocabulary \(hashed\)/);
  assert.doesNotMatch(out, /zebracorn/);
});

test('the real hygiene-denylist.sha256 contains only 64-hex lines and comments', () => {
  const raw = fs.readFileSync(REAL_DENYLIST, 'utf8');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.length > 0, 'denylist must not be empty');
  for (const line of lines) {
    const isComment = line.startsWith('#');
    const isHash = /^[0-9a-f]{64}$/.test(line);
    assert.ok(isComment || isHash, `unexpected non-hash, non-comment line in denylist: ${line}`);
  }
});
