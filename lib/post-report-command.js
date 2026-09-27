'use strict';

/**
 * post-report-command.js — an OFF-by-default, generic "run something after
 * a subagent's report lands" hook.
 *
 * This plugin has no opinion on what, if anything, should happen after a
 * report is confirmed delivered. Configure a command once and it is fired
 * (fully detached, fire-and-forget, at most once per agent transcript) the
 * first time this plugin sees a well-formed SendMessage from a team-mailbox
 * teammate whose report was NOT blocked (i.e. it delivered cleanly, or it
 * delivered after being nudged once). With no config, this is a complete
 * no-op — no process is spawned, no file is touched beyond the check for
 * whether one is configured.
 *
 * Configuration (either works; the env var wins if both are set):
 *   - `SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND` environment variable, or
 *   - `{ "postReportCommand": "..." }` in `<data dir>/config.json`
 *     (see `lib/paths.js` for where the data dir resolves to).
 *
 * The configured command is run via a shell (`sh -c`), detached from this
 * hook's own process (so it can never block or slow down the subagent's
 * turn), with these environment variables added to its own inherited
 * environment:
 *   - `SUBAGENT_REPORT_GUARD_AGENT_TRANSCRIPT_PATH`
 *   - `SUBAGENT_REPORT_GUARD_AGENT_ID` (empty string if unknown)
 *
 * Never throws. A malformed config file, an unspawnable command, or any
 * other failure is swallowed silently — this is a convenience hook, never a
 * blocking one.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { dataDir, ensureSubPath } = require('./paths.js');

function readConfiguredCommand() {
  const fromEnv = process.env.SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv;
  try {
    const configPath = path.join(dataDir(), 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    const command = config && config.postReportCommand;
    return typeof command === 'string' && command.trim() ? command : null;
  } catch {
    return null;
  }
}

function markerPathFor(transcriptPath) {
  const key = crypto.createHash('sha256').update(transcriptPath).digest('hex');
  return ensureSubPath('post-report-command', `${key}.json`);
}

// Fires the configured command at most once for a given transcript path.
// Returns true if a command was actually spawned this call, false otherwise
// (nothing configured, already fired, or a failure) — used only by tests.
//
// AT-MOST-ONCE IS CLAIMED ATOMICALLY. The marker is created with
// `fs.openSync(marker, 'wx')` — `wx` fails with `EEXIST` when the file
// already exists, so exactly one concurrent caller can ever win the create
// for a given transcript path, with no read-then-write race window in
// between (the prior `fs.existsSync` + `fs.writeFileSync` pair had exactly
// that window: two callers could both pass the existence check before
// either's write landed, and both would then spawn). The command is only
// ever spawned by the caller that won the `wx` create. `EEXIST` (another
// caller already claimed it) and any other open failure (e.g. an
// unwritable dir) both take the same fail-open path — never spawn without a
// durable marker backing the claim, since an unpersisted "fired" state
// could re-fire without bound.
function maybeRun(transcriptPath, { agentId = '' } = {}) {
  try {
    const command = readConfiguredCommand();
    if (!command) return false;
    if (typeof transcriptPath !== 'string' || !transcriptPath) return false;

    const marker = markerPathFor(transcriptPath);
    let fd;
    try {
      fd = fs.openSync(marker, 'wx');
    } catch {
      // EEXIST -> already claimed by this call or a concurrent one; any
      // other error -> could not durably claim the slot. Either way, never
      // spawn.
      return false;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ firedAt: new Date().toISOString() }));
    } catch {
      /* best-effort content only — the marker's mere EXISTENCE, not its
         content, is what claims the at-most-once slot */
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort close only */
      }
    }

    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        SUBAGENT_REPORT_GUARD_AGENT_TRANSCRIPT_PATH: transcriptPath,
        SUBAGENT_REPORT_GUARD_AGENT_ID: agentId || '',
      },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { readConfiguredCommand, markerPathFor, maybeRun };
