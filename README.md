# Claude Code subagent report guard

Two mitigations for the same underlying problem in Claude Code's
background/team-mailbox teammate flow: a dispatched teammate can go idle
without its report ever reaching the dispatcher, and there is no reliable
way to get it back afterward. Publicly reported and reproduced, independent
of this repo:

- [anthropics/claude-code#74113](https://github.com/anthropics/claude-code/issues/74113)
  — "Background agents frequently go idle without delivering their final
  SendMessage report (re-ping recovers it)"
- [anthropics/claude-code#76500](https://github.com/anthropics/claude-code/issues/76500)
  — "Agent Teams mailbox: 5-62 min turn-boundary delays, lost final reports
  (`idle_notification` arrives instead), `/clear` queue leak, shutdown
  handshake never completes"

This repo ships two independent mitigations, in two directories:

- **`hooks/` + `lib/`** — the **lane drop-box**: a non-blocking, durable
  record of every dispatched lane's progress, written out-of-band from
  `SendMessage` entirely. **Start here** — this is the recommended default.
- **`legacy-gate/`** — the original **blocking gate**: refuses to let a
  teammate's turn end without a well-formed `SendMessage` call, with a
  verbatim-recovery fallback. Documented in its own README as a
  complementary, alternative approach.

## The problem, in one sentence

A background teammate's plain final assistant text is never delivered to
whoever dispatched it — only an explicit `SendMessage` tool call delivers
content upstream — and if a teammate finishes (or crashes, or gets
throttled) without calling it, the dispatcher receives only a content-free
`idle_notification`; the report exists, if at all, only in that teammate's
own transcript file on disk.

## The doorbell/payload principle

The lane drop-box treats every dispatched lane the same way you'd treat a
courier: you don't just want to know they rang the doorbell (liveness) —
you want the package they were carrying (the report), and you want both
recorded somewhere durable regardless of whether anyone was home to answer.

Two hooks implement this:

- **`lane-dropbox-checkpoint.js`** (`SubagentStop`) — fires once, at each
  lane's own natural end-of-turn. Extracts whatever new transcript content
  appeared and appends a `checkpoint` record carrying the lane's report text
  verbatim, plus accountability fields (task, worktree, branch, a verified
  git SHA when available). This is the payload delivery.
- **`lane-dropbox-heartbeat.js`** (`PostToolUse`) — fires on every tool
  call, throttled to at most once per 60 seconds per lane. Appends a bare
  `heartbeat` record with no payload — pure liveness, for a lane that's
  still working but hasn't stopped yet. This is the doorbell ring alone.

Both write to the same append-only, per-lane file:
`~/.claude/teams/<session_id>/dropbox/<lane_id>.jsonl`. Neither ever blocks
a turn or a tool call — every failure mode (missing payload, unwritable
disk, lock contention, ambiguous identity) fails open by design — some
failure paths also emit a best-effort, single-line stderr diagnostic
(never required reading, never affects the fail-open behavior itself).
A skipped record is the acceptable worst case; a wrong one never is.

## What gets recorded — `lane-record/v1`

One JSON object per line, one of four `record_type`s:

| record_type      | written by                     | when                          | carries |
|-------------------|----------------------------------|--------------------------------|---------|
| `scaffold`        | orchestrator (CLI or direct `require()`) | once, at dispatch time  | provider, task_id, worktree, branch, agent_name / pid+output_log |
| `checkpoint`       | `lane-dropbox-checkpoint.js`   | once per `SubagentStop`       | `report_text` (verbatim), transcript byte-offset range, a `dedupe_key`, `last_verified_sha` |
| `heartbeat`        | `lane-dropbox-heartbeat.js`    | throttled, ≥60s apart, per `PostToolUse` | `heartbeat_at`, `resolution_method`, `liveness_source` — no report text |
| `report-capture`   | orchestrator (CLI or direct `require()`, via `captureReport()`) | once, on a third-party lane's termination | `report_text` (best-effort tail of `--output-log`), `run_id`, `output_log_sha256`, `terminal_reason` |

Every record carries `schema_version` (`lane-record/v1`), `lane_id`,
`session_id`, `ts`, and `provider` (`claude` \| `codex` \| `gemini` — a
third-party CLI lane scaffolds itself via the same module's CLI subcommands,
since it has no Node `require()` boundary of its own). Checkpoint records
dedupe by transcript byte offset, so a repeat firing with no new content
writes nothing. Full field-level detail is in the doc comments at the top
of `lib/lane-dropbox.js`.

### `report-capture` — terminal evidence for a lane with no hook available to it

`checkpoint`/`heartbeat` above are Claude-shaped: they fire off a Claude
Code hook event (`SubagentStop`/`PostToolUse`) against a Claude in-process
teammate's own JSONL transcript. Neither exists for a third-party CLI lane
(`codex exec`/`gemini`, spawned by your own orchestrator) — by the time any
hook could fire, that process has already exited, and there's no transcript
in this repo's format to parse.

`captureReport({ sessionId, laneId, terminalReason, runId })` closes that
gap: call it yourself, once, on every third-party lane's termination path
(normal exit, timeout, spawn error), after the child has exited and its
`--output-log` is final. It reads the last chunk of that log (capped at
20,000 characters, always trimmed to a whole line) and appends one
`report-capture` record — durable, best-effort evidence of what the lane
was doing when it stopped, independent of whether it ever produced a
structured report. A companion read-only helper, `countReportCaptures()`,
returns how many `report-capture` records already exist for a lane
*before* a new dispatch — call it immediately before a re-dispatch under a
reused `lane_id` and keep the result as an `after:<N>` baseline, then treat
"the count grew past N" (not bare presence) as your signal that the new
run actually finished; bare presence is satisfied instantly by a prior
run's own leftover record and gives the wrong answer on a retried lane.

Passing `runId` (any string unique to that one dispatch) matters: a repeat
`captureReport()` call for the *same* `runId` is recognized as a duplicate
report of the same run and appends nothing new, while two calls with
*different* `runId`s always append as two distinct runs — even when their
captured tails happen to be byte-identical (a tool legitimately reporting
the same final line twice, or a same-length/different-content coincidence
across a re-dispatch). Idempotence is keyed on run identity, never on
content or byte size — a content/size-based dedupe can silently swallow a
second run's genuinely-new terminal record on a reused lane id, which is
exactly the failure mode an `after:<N>` poll exists to detect.

Both functions are also available from the CLI, for an orchestrator with
no Node `require()` boundary of its own:

```
node lib/lane-dropbox.js capture-report --session <id> --lane-id <id> \
  [--terminal-reason <reason>] [--run-id <id>]
node lib/lane-dropbox.js count-report-captures --session <id> --lane-id <id>
```

`report-capture` never writes the `report_delivered`/`delivered_report_text`
fields the checkpoint hook owns — those mean "this Claude lane called
SendMessage with a well-formed payload," a stronger and more specific claim
than "here is a scraped log tail." A reader combining both mechanisms
should prefer an explicitly delivered checkpoint first, and fall back to
the last available `report-capture` only when no delivered checkpoint
exists — see the full reader-order rule in `lib/lane-dropbox.js`'s own
`captureReport` doc comment.

## Quickstart

See `INSTALL.md` for the full walkthrough. Short version:

- **Plugin install** — this repo is a valid Claude Code plugin
  (`.claude-plugin/plugin.json` + `hooks/hooks.json`, using
  `${CLAUDE_PLUGIN_ROOT}`-relative paths). Point your plugin manager at this
  repo and enable it.
- **Manual install** — copy `lib/` and `hooks/` somewhere permanent, then
  register both hook files in your Claude Code `settings.json` under
  `SubagentStop` and `PostToolUse`. Exact JSON snippet in `INSTALL.md`.

No build step, no npm dependencies — plain Node.js built-ins only
(`fs`, `os`, `path`, `crypto`, `child_process`).

## How an orchestrator uses this

1. **At dispatch time**, scaffold the lane — either `require('./lib/lane-dropbox.js').scaffold({...})`
   from Node, or the CLI (`node lib/lane-dropbox.js scaffold --session <id> --lane-id <id> --provider claude ...`)
   for a third-party CLI lane. This writes the first record and establishes
   the lane's file.
2. **While it runs**, do nothing for a Claude lane — the two hooks write
   checkpoints and heartbeats on their own, with zero orchestrator
   involvement. A third-party CLI lane has no hooks available to it at
   all, so there is nothing to do here either way.
3. **When the lane terminates**, for a third-party CLI lane call
   `captureReport({ sessionId, laneId, terminalReason, runId })` (or its
   CLI form) yourself, once, on every termination path — normal exit,
   timeout, spawn error. This is the only leg of the mechanism that isn't
   automatic, because nothing in this repo observes a third-party
   process's exit for you.
4. **When a lane goes idle, stalls, or you just want to check in**, read
   `~/.claude/teams/<session_id>/dropbox/<lane_id>.jsonl` directly. The
   last `checkpoint` record's `report_text` is that lane's last known
   report, verbatim, independent of whether `SendMessage` ever actually
   delivered it; failing that, the last `report-capture` record's
   `report_text` is a best-effort recovery of a third-party lane's last
   output. The last `heartbeat_at` across any record type tells you how
   recently the lane did *anything*, even if it never got as far as a
   checkpoint.
5. **Before re-dispatching under a reused `lane_id`** (a retry), call
   `countReportCaptures({ sessionId, laneId })` first and keep the result
   as your `after:<N>` baseline — then poll for the count growing past
   `N`, not bare presence, so a prior run's own leftover record can't be
   mistaken for the new run having finished.

This is deliberately a plain JSONL file, not a database or a queue — `tail`,
`jq`, or a one-line `readLaneRecords()` call are all you need to consume it.

## Verification

This mechanism was checked against real multi-lane Claude Code sessions
before release, not just unit tests against synthetic fixtures — that live
testing caught a real attribution bug in the heartbeat hook's identity
resolution (a fast-moving `PostToolUse` firing could get misattributed to a
lane that had already stopped several seconds earlier); the bug, the fix,
and the reasoning behind it are documented directly in
`hooks/lane-dropbox-heartbeat.js`'s own header comment — not smoothed over.
This repo was also independently reviewed by the `codex` CLI (a different
model provider than the one that authored it) for publish-safety before
being pushed public — see `git log` for that review's imprint on this
history. The exported tree carries 100 tests (`node --test test/*.test.js`),
covering both hooks and the underlying module: schema/return contracts,
offset dedupe, lock contention, fail-open paths, the live-evidence-derived
heartbeat attribution rule, `report-capture`'s run-identity dedupe (a
content/byte-size dedupe was tried and rejected — see
`test/lane-report-capture.test.js` for the repro it failed on), and a
portability grep against hardcoded paths.

## Known limitations

- Identity resolution's recency-based fallback (used only when no
  direct-sibling meta.json match and no explicit identity field is
  available) is a heuristic, not a certainty — see
  `lib/report-gate-identity.js`'s header for the three-step resolution order
  and its accepted residual.
- Neither mitigation here fixes the underlying platform behavior — they are
  user-side workarounds, not upstream fixes.
- `captureReport()`'s guarantee is only as good as the `--output-log` your
  own orchestrator passes to `scaffold()`: this repo does not spawn your
  third-party lane's process for you, so it cannot itself guarantee that
  log is durably written before the child exits. A `scaffold` call whose
  log path is never actually populated degrades to the stated
  `unavailable_reason: 'unreadable-output-log'`/`'no-output-log'` rather
  than crashing or fabricating content — but making the log real (e.g.
  teeing the child's stdout to that path yourself, before or as you spawn
  it) is on you.
- `legacy-gate/` has its own known limitations — see its own README.

## Contributing

Found a different failure mode, a cleaner identity-resolution heuristic, or
a case where a fail-open path didn't actually fail open? Issues and PRs are
welcome — this is a small, self-contained kit and fixes from other setups
are genuinely useful.

## License

MIT — see `LICENSE`.
