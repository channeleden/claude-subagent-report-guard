# Claude Code subagent report guard

A Claude Code plugin that closes a real, reproduced gap in how dispatched
subagents report back:

- [anthropics/claude-code#74113](https://github.com/anthropics/claude-code/issues/74113)
  — "Background agents frequently go idle without delivering their final
  SendMessage report (re-ping recovers it)"
- [anthropics/claude-code#76500](https://github.com/anthropics/claude-code/issues/76500)
  — "Agent Teams mailbox: 5-62 min turn-boundary delays, lost final reports
  (`idle_notification` arrives instead), `/clear` queue leak, shutdown
  handshake never completes"

**This plugin is Claude-Code-specific by nature.** Everything here depends
on the exact hook events, on-disk transcript layout, and JSONL entry shapes
this particular harness writes — it is not a portable pattern for other
agent surfaces.

## The problem, in one sentence

A background "team-mailbox" teammate's plain final assistant text is never
delivered to whoever dispatched it — only an explicit `SendMessage` tool
call delivers content upstream — and if a teammate finishes (or crashes, or
gets throttled) without calling it, the dispatcher receives only a
content-free idle notification; the report exists, if at all, only in that
teammate's own transcript file on disk.

## What this plugin does

Three independent, composable mechanisms, all shipped as first-class plugin
hooks (wired only through `hooks/hooks.json`, nothing else):

| Mechanism | Hook event(s) | What it does |
|---|---|---|
| **Report gate** (`hooks/report-gate.js`) | `SubagentStop` | **Blocks** a team-mailbox teammate's turn from ending until it has sent a well-formed `SendMessage`, once. Embeds the agent's own abandoned final text verbatim in the block reason so resending is a copy, not a regeneration. Also re-checks a delivered report for staleness; that re-check can block again, but only for a genuinely new follow-up message, never the same one twice. Never gates a plain (non-team-mailbox) subagent. |
| **Lane drop-box** (`hooks/lane-dropbox-checkpoint.js`, `hooks/lane-dropbox-heartbeat.js`) | `SubagentStop`, `PostToolUse` | **Non-blocking** durable record of every dispatched lane's progress — a `checkpoint` with the report text verbatim at each stop, a throttled `heartbeat` on every tool call — written independently of whether `SendMessage` ever succeeds. |
| **Orphaned-report pointers** (`hooks/orphan-pointers-*.js`) | `SubagentStop`, `UserPromptSubmit`, `SessionStart` | A **fallback safety net**, not a replacement for normal delivery. Records, for every finished subagent, a pointer plus a short excerpt (at most 200 characters) of the subagent's final message, never the full report — the full report stays in the transcript the harness already keeps; later, deterministically checks the parent transcript for evidence of normal delivery, and only if that evidence is absent does it surface a short pointer list. |

All three fail open by design: every failure mode (missing payload,
unreadable transcript, unwritable state file, ambiguous identity
resolution) is swallowed, logged best-effort, and treated as "allow" —
installing this plugin is never the reason a legitimate subagent turn can't
end or a tool call can't complete.

### Report gate — the details

`resolveTeammateContext` identifies the real per-teammate transcript with a
four-step, decreasing-certainty fallback (an explicit harness-supplied
path, a direct sibling `.meta.json`, an explicit identity field, then a
bounded recency heuristic among candidates in the session's `subagents/`
directory) — see the header comment in `lib/report-gate.js` for the full
mechanism and the live-observed `transcript_path` mismatch this exists to
work around.

**What the report gate includes, and what it deliberately leaves out:**

- **Included** — a background-vs-foreground spawn-ledger correlation
  (`lib/spawn-ledger.js`'s `classifyBackgroundSpawn` /
  `findBackgroundAgentSpawn`): correlates the stopping teammate back to the
  parent's own `Agent` tool_use call and reads that call's
  `run_in_background` input as a three-valued verdict —
  `confirmed`/`contradicted`/`unknown` — rather than a boolean, because an
  ABSENT flag is the harness's own default (background) and must not be
  read as a contradiction. Only an explicit `run_in_background: false`
  (`contradicted`) suppresses gating.
- **Included** — a peer-acknowledgment-aware stale-report check
  (`lib/pending-followup.js`'s `evaluatePendingFollowup`, plus this file's
  own `lastReportableBoundary`): blocks when a teammate follow-up was
  delivered after the agent's latest `SendMessage`, while exempting a
  message the SENDER explicitly marked as needing no reply (a
  `terminal="true"` envelope attribute or an in-body `[[terminal]]` token)
  from that comparison — closing an infinite loop two peer-acking agents
  would otherwise create by re-triggering each other's gate on every ack.
  See each module's header for the full mechanism and the loop-safety
  argument for why this check cannot itself introduce an unbounded loop.
- **Left out** — any nudge toward a specific post-report command or
  follow-up automation after a report is confirmed sent. Replaced by the
  generic, off-by-default `postReportCommand` hook below, which has no
  opinion on what, if anything, should happen next.

#### Report gate — invocation log

Every firing of `hooks/report-gate.js` appends one JSON line to
`<data dir>/logs/report-gate-invocations.log` (override via
`SUBAGENT_REPORT_GUARD_LOG_PATH`), regardless of outcome — this is the
first place to look if a gate you expected to fire didn't (see the
"Plugin hooks load at session START" install note above). Every line
carries:

- `ts` — ISO timestamp of the log write.
- `outcome` — one of `block` / `allow` / `delivered` /
  `not-team-mailbox-or-unresolvable` (unchanged names, for back-compat with
  any existing log-scraping).
- `reason` — present only on `not-team-mailbox-or-unresolvable`:
  `no-payload` (stdin was empty or unparseable — the hook never even had a
  payload to evaluate) or `not-team-mailbox` (a payload DID parse, but
  `evaluate()` returned null — not a team-mailbox participant, or genuinely
  unresolvable). These were previously indistinguishable under one outcome
  string, which is exactly what made a real "hooks never loaded" incident
  (2026-09-27) look identical to ordinary non-team-mailbox traffic in the
  log — a handful of manual empty-payload smoke-test lines and a genuine
  resolution gap were both just `not-team-mailbox-or-unresolvable` with no
  further detail.
- `resolutionMethod` — present on every RESOLVED outcome (`block` / `allow`
  / `delivered`): the same value `resolveTeammateContext` returned
  (`agent-transcript-path` / `direct-sibling` / `payload-identity-field` /
  `payload-identity-path` / `recency-heuristic`). Absent on
  `not-team-mailbox-or-unresolvable`, since nothing was resolved.
- A privacy-minimal trace, on EVERY line regardless of outcome:
  `hook_event_name`, `session_id`, `agent_id`, `agent_type`, `payload_keys`
  (the incoming payload's own top-level key NAMES only, sorted — never its
  values), and `has_agent_transcript_path` (boolean).

**Never logged, on any line, under any outcome:** message content
(`last_assistant_message`, or any transcript text embedded in a block
reason), or any full filesystem path beyond a basename. This log is safe to
read, grep, or attach to a bug report without redaction.

### Lane drop-box — the details

Two hooks write append-only JSONL records to
`<data dir>/teams/<session_id>/dropbox/<lane_id>.jsonl` by default —
INSIDE this plugin's own data dir, so uninstalling stays a one-directory
delete with zero configuration (see "Where state lives" and the
`dropboxRoot` option below for pointing this at a shared directory
instead):

- **`lane-dropbox-checkpoint.js`** (`SubagentStop`) — once per stop, a
  `checkpoint` record with the lane's report text verbatim plus
  accountability fields (task, worktree, branch, a verified git SHA when
  available). Also carries `report_delivered` / `delivered_report_text` /
  `delivered_report_to`: the trailing assistant text is exactly backwards as
  a "was this delivered" signal (a lane that delivers correctly usually
  trails off with a preamble, while a lane that fails leaves the real
  report sitting there), so a well-formed `SendMessage` call's own payload
  is captured separately — the last one in the checkpoint's window wins.
- **`lane-dropbox-heartbeat.js`** (`PostToolUse`, with a POSIX `sh`
  prefilter so the common no-active-lanes case never even spawns node) — a
  throttled (≥60s apart), payload-free `heartbeat` record — pure liveness.

`sessionId`/`laneId` are validated as safe, single path segments (no
slash, dot-traversal, control characters, or unbounded length) before
either is interpolated into a filesystem path; an unsafe value is treated
as a caller-contract violation, mapped to this module's existing closed
`'invalid-args'`/`'unresolvable'` reason enum, never a thrown exception.

**Left out:** any claim/provider-roster machinery that would notify a
cross-project ownership tracker. This plugin ships its own, simpler,
already-existing equivalent instead — `attemptClaimProbe()`, a pluggable
extension point that is a complete no-op unless you drop a
`lib/claim-emitter.js` module of your own next to it — rather than
depending on a provider roster this public plugin has no way to validate
against.

Read a lane's file directly (`tail`, `jq`, or the module's own
`readLaneRecords()`) any time you want to check in on it — no database, no
queue.

### Orphaned-report pointers — the details

**Normal delivery is untouched.** When the parent session is alive, Claude
Code injects a dispatched subagent's result automatically — a
`task-notification` for a background dispatch, a `tool_result` for a
foreground/synchronous one, or a `<teammate-message>`/`<agent-message>` for
a `SendMessage`. This mechanism never intercepts any of that.

On every `SubagentStop`, a small pointer is written for **every** finished
subagent (team-mailbox or plain). It stores a pointer plus a short excerpt
(at most 200 characters) of the subagent's final message, never the full
report — the full report stays in the transcript the harness already keeps:

```json
{
  "transcriptPath": "...", "agentId": "...", "agentName": "...",
  "parentSessionId": "...", "finishedAt": "...", "summary": "<=200 chars",
  "claimed": false,
  "surfaced": { "userPromptSubmit": false, "sessionStart": false }
}
```

Before ever surfacing a pointer, delivery is checked deterministically —
a bounded tail-read (2 MB cap) of the parent's own transcript, matched
against the real evidence shapes documented in `lib/orphan-pointers.js`'s
header (a `tool_use_id` match for a foreground dispatch's sidecar-recorded
`toolUseId`, or an `<agent-message from="...">` / `<teammate-message
teammate_id="...">` / `task-notification` marker for a team-mailbox one).
If found, the pointer is marked `claimed` and never surfaced.

- **`UserPromptSubmit`** — the parent session is alive by definition while
  this hook runs (it is that session's own next prompt), so a
  queued-but-not-yet-delivered notification is normal, not an orphan.
  Delivering a task-notification or team-mailbox agent/teammate message to
  the parent can *be* the very prompt that fires this hook, before the
  harness has appended that delivery entry to the transcript — this hook
  checks its own raw prompt text for that delivery first and claims the
  pointer immediately when found, independent of the transcript scan. Once
  that's ruled out, a **top-level** pointer (dispatched directly by this
  session) surfaces only once undelivered for longer than the grace period
  (`SUBAGENT_REPORT_GUARD_PARENT_GONE_GRACE_MS`, default 10 min); a
  **nested** pointer (spawned by another subagent, whose parent agent has
  itself already finished) surfaces once its own settle time has elapsed
  (`SUBAGENT_REPORT_GUARD_NESTED_SETTLE_MS`, default 30 s) — never on the
  very next prompt, and never twice for the same pointer.
- **`SessionStart`** — surfaces unclaimed, undelivered pointers left behind
  by a prior/dead session (the parent's own transcript has gone quiet past
  a grace period, or the current session id differs from the pointer's
  recorded parent), once per pointer. Unaffected by the `UserPromptSubmit`
  gating above — a dead session can never receive an in-flight delivery, so
  there is nothing to race.

Both surfacing hooks cap the list at 5 items (`+N more at <pointers dir>`)
and are a fast, transcript-read-free no-op whenever no pointer has ever
been written. Pointers older than 7 days are pruned opportunistically. This
mechanism shares no code and no state with any other subagent-observability
tooling you may have installed alongside this plugin.

## Install

This repo is its own marketplace (`.claude-plugin/marketplace.json`) — no
external marketplace wrapper needed:

```
/plugin marketplace add channeleden/claude-subagent-report-guard
/plugin install subagent-report-guard@claude-subagent-report-guard
```

That's it — every hook is wired via `hooks/hooks.json` (using
`${CLAUDE_PLUGIN_ROOT}`, never a hand-edited absolute path), and every
directory this plugin ever writes to is created lazily on first use. No
`settings.json` edit, no symlink, no copy step, anywhere.

**Plugin hooks load at session START.** Claude Code reads a plugin's
`hooks/hooks.json` when a session starts — installing, enabling, or
updating this plugin mid-session does not retroactively wire its hooks into
that already-running session. **Start a new session after
install/enable/update** or none of this plugin's hooks will fire for the
rest of the old one. This is not theoretical: it is the confirmed root
cause of a real "the report gate didn't fire" incident (2026-09-27) — a
session that started before install ran for hours afterward with none of
this plugin's hooks loaded, and the only local evidence was silence (no
invocation log entries at all for that session), not an error. If a gate
you expected to fire didn't, first check whether `hooks/report-gate.js` ran
for that session at all: grep `<data dir>/logs/report-gate-invocations.log`
for the session's `session_id` (every line carries one, even the
unresolved outcome — see "Report gate — invocation log" below) — no
matching lines means the hooks never loaded, not that resolution failed.

**Warning — the plugin CLI can silently corrupt hook wiring in
`settings.json`.** Claude Code's plugin CLI (`claude plugin install` /
`uninstall` / `marketplace add`, observed on 2.1.283) re-serializes the
entire `~/.claude/settings.json` file and has been observed to silently
drop `name` keys from existing hook entries in the process — with no
warning, on an unrelated plugin operation. Back up `~/.claude/settings.json`
before running any `claude plugin ...` command and diff it afterward.

## Configuration

Everything is optional; every default is sensible with zero configuration.

### Environment variables

| Variable | Default | Read by | Notes |
|---|---|---|---|
| `SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND` | unset (no-op) | `lib/post-report-command.js` | Shell command to run once a team-mailbox report is confirmed delivered. Same effect as `{ "postReportCommand": "..." }` in `<data dir>/config.json`; the env var wins if both are set. |
| `SUBAGENT_REPORT_GUARD_RECENCY_WINDOW_MS` | `600000` (10 min) | `lib/report-gate.js` | Bounds how old a candidate teammate transcript can be before the report gate's recency-based identity fallback still considers it a match. |
| `SUBAGENT_REPORT_GATE_RECENCY_WINDOW_MS` | — | `lib/report-gate-identity.js` | **Deprecated alias** of `SUBAGENT_REPORT_GUARD_RECENCY_WINDOW_MS` for the lane drop-box's own identity resolution; still read as a fallback if set, but new configuration should use the `_GUARD_` name. |
| `SUBAGENT_REPORT_GUARD_AMBIGUITY_EPSILON_MS` | `500` | `lib/report-gate.js` | How close two candidates' mtimes must be before the report gate refuses to pick one (falls back to the generic, non-embedded block reason instead of risking a verbatim quote from the wrong lane). |
| `SUBAGENT_REPORT_GUARD_MAX_EMBEDDED_REPORT_CHARS` | `10000` | `lib/report-gate.js` | Size bound for the verbatim copy embedded in a block reason. |
| `SUBAGENT_REPORT_GUARD_LOG_MAX_BYTES` | `2097152` (2 MB) | `lib/log-rotation.js` | Size-capped rotation threshold for this plugin's append-only logs. |
| `SUBAGENT_REPORT_GUARD_LOG_PATH` | `<data dir>/logs/report-gate-invocations.log` | `hooks/report-gate.js` | Override the report gate's invocation log path. |
| `SUBAGENT_REPORT_GUARD_TAIL_SCAN_BYTES` | `2097152` (2 MB) | `lib/orphan-pointers.js` | Cap on the bounded tail-read of the parent transcript used to check for delivery evidence. |
| `SUBAGENT_REPORT_GUARD_PARENT_GONE_GRACE_MS` | `600000` (10 min) | `lib/orphan-pointers.js` | Grace period before a quiet parent transcript is treated as a dead/prior session for cross-session pointer surfacing; also the minimum time a same-session TOP-LEVEL pointer must stay undelivered before `UserPromptSubmit` will ever surface it. |
| `SUBAGENT_REPORT_GUARD_NESTED_SETTLE_MS` | `30000` (30 s) | `lib/orphan-pointers.js` | Minimum time a NESTED pointer (spawned by another subagent) must stay finished before `UserPromptSubmit` will surface it, even once its parent agent is already gone — avoids racing an in-flight notification to a parent agent that just stopped. |
| `SUBAGENT_REPORT_GUARD_DROPBOX_ROOT` | unset | `lib/paths.js` | Same effect as `{ "dropboxRoot": "~/some/path" }` in `<data dir>/config.json`; the env var wins if both are set. See the `dropboxRoot` details below. |
| `SUBAGENT_REPORT_GUARD_DATA_DIR` | unset | `lib/paths.js` | Override this plugin's data dir entirely. **Test-only** — used by this repo's own tests; a real install should not need it. |
| `CLAUDE_PLUGIN_DATA` | unset | `lib/paths.js` | Set by the Claude Code harness itself (not this plugin) on builds that support it; used as the data dir when `SUBAGENT_REPORT_GUARD_DATA_DIR` is unset. |
| `LANE_DROPBOX_CLAIM_EMITTER_PATH` | resolves to `lib/claim-emitter.js` next to `lane-dropbox.js` | `lib/lane-dropbox.js` | **Test-only** seam for overriding the optional claim-emitter module path in tests; a real install should not need it. |
| `SUBAGENT_REPORT_GUARD_HYGIENE_DENYLIST` | `scripts/hygiene-denylist.sha256` | `scripts/hygiene-check.js` | **Dev-tool-only**, not read by any plugin hook — points the hygiene scan's hashed private-vocabulary rule at an alternate denylist file. |

- **`postReportCommand`** (off by default) — this plugin has no opinion on
  what, if anything, should happen after a report is delivered; configure a
  shell command once (env var above, or `{ "postReportCommand": "..." }` in
  `<data dir>/config.json`) and it runs detached, fire-and-forget, at most
  once per agent transcript, with `SUBAGENT_REPORT_GUARD_AGENT_TRANSCRIPT_PATH`
  / `SUBAGENT_REPORT_GUARD_AGENT_ID` added to its environment. With nothing
  configured, this is a complete no-op.
- **`dropboxRoot`** (default: unset — the lane drop-box lives inside this
  plugin's own data dir) — point the lane drop-box's `teams/<session_id>/`
  directory at a directory of your own choosing instead (env var above, or
  `{ "dropboxRoot": "~/some/path" }` in `<data dir>/config.json`; `~` is
  expanded). Use this only if you have your own tooling that already reads
  a shared `.../teams/<session>/dropbox/` layout (e.g. co-located with
  Claude Code's own per-session team-mailbox directory,
  `~/.claude/teams/<session_id>/inboxes/`) and want this plugin to write
  into the same place. **Caveat:** once set, everything the lane drop-box
  writes lands OUTSIDE this plugin's data dir — those files are then yours
  to manage and clean up; the one-directory uninstall below no longer
  covers them.

## Where state lives

Everything this plugin writes lives under exactly one directory, resolved
by `lib/paths.js`:

1. `SUBAGENT_REPORT_GUARD_DATA_DIR`, if set (test override), else
2. `CLAUDE_PLUGIN_DATA`, if the harness sets it for plugin hooks (recent
   Claude Code builds do; **not independently confirmed as set on every
   installed version** — this plugin works correctly either way), else
3. `~/.claude/subagent-report-guard/`.

Documented children of that one directory: `report-gate-state/`,
`post-report-command/`, `pointers/<sessionId>/<agentId>.json`,
`teams/<session_id>/dropbox/` + `teams/<session_id>/.state/` (the lane
drop-box — see the `dropboxRoot` option above for redirecting this
specific subtree elsewhere), and `logs/report-gate-invocations.log` (+ its
`.1` rotation).

With **default configuration and zero setup**, this is exhaustive: nothing
this plugin ever writes lands anywhere else.

## Uninstall

```
/plugin uninstall subagent-report-guard@claude-subagent-report-guard
```

(or just disable the plugin) — every hook is wired only through
`hooks/hooks.json`, so uninstalling/disabling stops all of them
immediately; nothing else on your system references this plugin. Optionally
follow with `/plugin marketplace remove claude-subagent-report-guard` to
also drop this repo's own marketplace registration.

To also remove every byte of state this plugin ever wrote (default
configuration — see the `dropboxRoot` caveat above if you configured it):

```sh
rm -rf ~/.claude/subagent-report-guard
```

That one directory is the whole of it — `test/uninstall.test.js` proves
this is exhaustive: it runs every hook against a scratch `HOME` with
nothing pre-existing, and asserts nothing is ever written outside
`<HOME>/.claude/subagent-report-guard/`. A separate test in that same file
proves the opposite, opt-in case: an explicitly configured `dropboxRoot`
is honored and writes land there instead, outside the data dir — the
escape hatch above, exercised so it's provably not accidental.

## Tests

```sh
node --test test/*.test.js
```

A full test suite covers: the report gate's identity
resolution (all four steps + the ambiguity/embed-trust rules),
block-once/allow-plain behavior, the spawn-ledger discrimination
(explicit-false/absent/true) and the peer-ack-loop-safe stale-report check;
the lane drop-box's checkpoint/heartbeat hooks (offset dedupe, lock
contention, fail-open paths, the heartbeat attribution rule, the
terminal-record discrimination fields, and `isSafePathSegment`
path-traversal rejection); the orphaned-pointer mechanism (written for
every subagent, never surfaced when delivered — including the
background-Agent-spawn launch-ack and enqueue-only cases that would
otherwise be misattributed — surfaced once per hook type on both the
same-session and prior-session paths, capped at 5 + "+N more", fast no-op
when empty); the `dropboxRoot` self-containment default and its opt-in
override; log rotation and its one-shot legacy migration script; the
post-report command hook (off by default, fires at most once); the
data-dir resolver; a self-install/uninstall round-trip against this repo's
own `.claude-plugin/marketplace.json` via the `claude` CLI (skipped, not
failed, when that CLI's non-interactive plugin support is unavailable);
and the hygiene-check script's own self-test. A `.githooks/pre-commit` hook
(enable with `git config core.hooksPath .githooks`) and
`.github/workflows/ci.yml` both run the full suite plus the hygiene scan.

The orphaned-pointer delivery-evidence shapes are modeled on sanitized
excerpts of real local transcripts (see
`test/fixtures/orphan-pointers/README.md`), matching the actual marker
shapes Claude Code writes rather than shapes assumed from documentation
alone.

## Known limitations

- Identity resolution's recency-based fallback (reached only when no exact
  step matches) is a heuristic, not a certainty — see `lib/report-gate.js`'s
  header for the full four-step order and its accepted residual.
- The orphaned-pointer mechanism's delivery check is real-evidence-based but
  necessarily incomplete: a harness change to any of the recognized marker
  shapes could make a genuinely-delivered report look undelivered (it would
  then be surfaced once, redundantly — harmless, just noisy) or, in
  principle, the reverse (silently over-claiming delivery) if a future
  shape happens to collide with one of these patterns by coincidence; no
  such collision has been observed.
- Neither the report gate nor the lane drop-box fixes the underlying
  platform behavior — they are user-side mitigations, not upstream fixes.
- `CLAUDE_PLUGIN_DATA` support is unconfirmed on every Claude Code version;
  the `~/.claude/subagent-report-guard/` fallback is exercised by every
  test in this repo, so this plugin works correctly whether or not the
  harness sets it.

## Contributing

Found a different failure mode, a cleaner identity-resolution heuristic, or
a case where a fail-open path didn't actually fail open? Issues and PRs are
welcome.

## License

MIT — see `LICENSE`.
