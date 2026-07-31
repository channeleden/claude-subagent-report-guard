# Installing the lane drop-box

Two install paths. Pick whichever fits your setup — both end up running the
same two hook files.

## Path A — Claude Code plugin (recommended)

This repo is a valid Claude Code plugin. If you're using Claude Code's
plugin manager, add this repo as a plugin source and enable it; the
`SubagentStop` and `PostToolUse` hooks in `hooks/hooks.json` register
automatically, resolved via `${CLAUDE_PLUGIN_ROOT}` so the install path never
needs to be hand-edited.

If you're installing from a local clone rather than a marketplace, point
your plugin manager at this repo's root (the directory containing
`.claude-plugin/plugin.json`).

No further configuration is required. On enable, both hooks are live.

## Path B — manual install (no plugin manager)

1. Copy this repo (or just `lib/` and `hooks/`) somewhere permanent — the
   two hook files resolve their `lib/` dependencies via relative
   `require()`, so keep the directory structure intact:

   ```
   subagent-report-guard/
   ├── lib/
   │   ├── lane-dropbox.js
   │   ├── filelock.js
   │   ├── subagent-transcript.js
   │   └── report-gate-identity.js
   └── hooks/
       ├── lane-dropbox-checkpoint.js
       └── lane-dropbox-heartbeat.js
   ```

2. Add both hooks to your Claude Code `settings.json` (merge into any
   existing `hooks` object rather than replacing it):

   ```json
   {
     "hooks": {
       "SubagentStop": [
         {
           "matcher": "",
           "hooks": [
             {
               "type": "command",
               "command": "node /absolute/path/to/subagent-report-guard/hooks/lane-dropbox-checkpoint.js"
             }
           ]
         }
       ],
       "PostToolUse": [
         {
           "matcher": "",
           "hooks": [
             {
               "type": "command",
               "command": "node /absolute/path/to/subagent-report-guard/hooks/lane-dropbox-heartbeat.js"
             }
           ]
         }
       ]
     }
   }
   ```

   Use an absolute path — `settings.json` hook commands are not resolved
   relative to the repo.

3. That's it. Both hooks fail open on every error path (missing payload,
   unreadable transcript, unwritable state file, ambiguous identity
   resolution) — installing them is never the reason a legitimate subagent
   turn can't end or a tool call can't complete.

## What gets written, and where

Records land at `~/.claude/teams/<session_id>/dropbox/<lane_id>.jsonl` (one
append-only file per lane), with small sidecar state under
`~/.claude/teams/<session_id>/.state/`. See `README.md` for the record
schema and how to read it back.

## The heartbeat hook's one honest caveat

`lane-dropbox-heartbeat.js` fires on every tool call, from every
participant, all session long — a much higher-frequency, much
lower-certainty signal than the checkpoint hook's own once-per-stop firing.
Its identity resolution refuses to guess under ambiguity by design: if it
can't independently re-verify, within a tight time window, that exactly one
team-mailbox lane is the plausible source of a given tool call, it writes
nothing rather than risk attributing a heartbeat to the wrong lane. In
practice this means heartbeats are occasionally skipped (harmless — the
checkpoint hook remains the accountability floor) rather than occasionally
wrong (which would poison any downstream consumer that trusts a lane's
last-heartbeat time). If you build a watchdog on top of this signal, treat a
missing heartbeat as "no fresh liveness evidence," never as "lane is dead."

## Optional tuning

- `SUBAGENT_REPORT_GATE_RECENCY_WINDOW_MS` (default `600000`, 10 minutes) —
  bounds how old a candidate teammate transcript can be before identity
  resolution's recency-based fallback will still consider it a match.
- The heartbeat hook's own tighter re-verification epsilon (`500`ms,
  `RECENCY_EPSILON_MS` in `hooks/lane-dropbox-heartbeat.js`) is not
  currently env-overridable — it's deliberately much tighter than the
  window above and tuned against real observed misattribution evidence (see
  the file's own header comment for the full rationale).

## Legacy blocking gate

`legacy-gate/` documents this repo's original, different approach — see
`legacy-gate/README.md`.
