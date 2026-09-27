'use strict';

/**
 * paths.js — single source of truth for where this plugin writes state.
 *
 * Every hook and script in this repo must resolve its data directory through
 * `dataDir()` below rather than constructing its own path. That is what
 * makes "one dir to delete" true for uninstall (see README's Uninstall
 * section) and what `test/uninstall.test.js` verifies by running every hook
 * with a scratch HOME and asserting nothing lands outside it.
 *
 * Resolution order:
 *   1. `SUBAGENT_REPORT_GUARD_DATA_DIR` — explicit override, used by this
 *      repo's own tests so nothing ever touches a real HOME.
 *   2. `CLAUDE_PLUGIN_DATA` — set by Claude Code for plugin hooks on recent
 *      builds (a per-plugin writable directory owned by the harness). When
 *      present, this is authoritative; the whole point of the harness
 *      supplying it is a plugin-owned directory it manages the lifecycle of.
 *   3. `~/.claude/subagent-report-guard/` — fallback for any Claude Code
 *      version that does not yet set `CLAUDE_PLUGIN_DATA`.
 *
 * Every subdirectory this plugin ever writes to is a documented child of
 * this one directory (see the map in `README.md`'s "Where state lives"
 * section) — never a sibling, never something under a different HOME path.
 * All directories are created lazily (`mkdir -p` on first write), never
 * eagerly, so installing the plugin never creates anything on disk until a
 * hook actually fires.
 *
 * ONE DOCUMENTED EXCEPTION: `dropboxRootDir()` below resolves the lane
 * drop-box's root, which by DEFAULT is `<dataDir()>/teams` — a child of this
 * same directory, so "delete the one data dir" stays exhaustive with no
 * configuration at all. A user with their OWN tooling that already reads a
 * shared `.../teams/<session>/` layout can opt out of that self-containment
 * by pointing `dropboxRootDir()` elsewhere (see its own doc comment) —
 * deliberately, not by omission; files written to an overridden root are
 * then outside this plugin's data dir and the user's own to clean up.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// The real, OS-level home directory — deliberately NOT `os.homedir()`,
// which respects a `HOME` env override (that's exactly why a test fakes
// `HOME` to get isolation). `os.userInfo().homedir` reads the OS user
// database directly on POSIX and ignores `HOME`, so it is the one
// dependable way to tell "the real operator's home" apart from "a test's
// faked one" from inside the process. Never throws: some sandboxed/
// containerized environments have no resolvable passwd entry, in which case
// this degrades to null and the test-isolation guard below simply cannot
// fire (fails open on the DETECTION, never on the guard itself).
function realHomedirSafe() {
  try {
    return os.userInfo().homedir;
  } catch {
    return null;
  }
}

function dataDir() {
  const override = process.env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  if (typeof override === 'string' && override.trim()) return override;

  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (typeof pluginData === 'string' && pluginData.trim()) return pluginData;

  // Deterministic test-isolation guard. `NODE_TEST_CONTEXT` is set by
  // Node's own `--test` runner. Reaching this point under it means neither
  // override above fired — the only remaining question is whether `HOME`
  // was ALSO left un-faked, which would resolve this call to the real
  // operator's actual `~/.claude/subagent-report-guard`. That has happened
  // live: a handful of `lib/report-gate.js` tests called `decide()` directly
  // with no data-dir/HOME isolation at all and wrote real state files under
  // the operator's real home. Refuse instead of writing — this is a
  // TEST-ONLY branch (`NODE_TEST_CONTEXT` is never set outside `node
  // --test`), so it can never fire during a real hook invocation.
  const realHome = realHomedirSafe();
  if (process.env.NODE_TEST_CONTEXT && realHome !== null && os.homedir() === realHome) {
    throw new Error(
      'dataDir(): running under node --test with no SUBAGENT_REPORT_GUARD_DATA_DIR override '
      + 'and no faked HOME — refusing to fall back to the real home directory. Every test '
      + 'must isolate its own data dir: set SUBAGENT_REPORT_GUARD_DATA_DIR (see mkDataDir() '
      + "helpers in this repo's own test files), or fake process.env.HOME, before calling "
      + 'anything that resolves a data path.',
    );
  }

  return path.join(os.homedir(), '.claude', 'subagent-report-guard');
}

function expandTilde(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readConfigSafe() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Resolves the root directory under which the lane drop-box's per-session
// team directories (`<root>/<sessionId>/dropbox/`, `<root>/<sessionId>/
// .state/`) live. Resolution order (first match wins):
//   1. `SUBAGENT_REPORT_GUARD_DROPBOX_ROOT` env var (tilde-expanded).
//   2. `{ "dropboxRoot": "..." }` in `<dataDir()>/config.json`
//      (tilde-expanded) — the env var wins when both are set.
//   3. `<dataDir()>/teams` — fully self-contained under this plugin's own
//      data dir; the default, with zero configuration.
// A configured override (1 or 2) points somewhere OUTSIDE this plugin's own
// data dir ON PURPOSE — see README's "Where state lives" for the resulting
// cleanup caveat. Never throws; a malformed/unreadable config.json is
// treated exactly like "no override configured".
function dropboxRootDir() {
  const fromEnv = process.env.SUBAGENT_REPORT_GUARD_DROPBOX_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return expandTilde(fromEnv.trim());

  const config = readConfigSafe();
  const fromConfig = config && typeof config.dropboxRoot === 'string' && config.dropboxRoot.trim();
  if (fromConfig) return expandTilde(fromConfig.trim());

  return path.join(dataDir(), 'teams');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// Convenience joiners for the documented subdirectories. Each creates its
// parent lazily on first call so no hook has to remember to mkdir itself.
function subPath(...segments) {
  const p = path.join(dataDir(), ...segments);
  return p;
}

function ensureSubPath(...segments) {
  const p = subPath(...segments);
  ensureDir(path.dirname(p));
  return p;
}

module.exports = {
  dataDir,
  ensureDir,
  subPath,
  ensureSubPath,
  expandTilde,
  dropboxRootDir,
};
