# Claude Code subagent report guard

A Claude Code plugin that stops dispatched subagents from going idle
without delivering their final report to whoever dispatched them.

## Status

Actively maintained. Two known gaps are being worked on in the open — a
delivered-looking report that was never actually read, and an interrupted agent
being indistinguishable from an undelivered one. Both are described in
[Known limitations](#known-limitations), and work in progress is pushed to a
public branch rather than held back. If you are evaluating this plugin, read that
section first.

## The problem

When you dispatch a Claude Code teammate (a background "team-mailbox"
agent, e.g. via the Agent tool), its plain final assistant text is **not**
automatically delivered upstream — only an explicit `SendMessage` tool call
does that. If the teammate finishes, crashes, or gets throttled before
calling `SendMessage`, the dispatcher receives only a content-free idle
notification. The report exists, if at all, only in that teammate's own
transcript file on disk, and by default nothing tells you it's stuck there.

This is a reproduced gap in the harness itself, tracked upstream. Issue states
below were checked on 2026-09-29; a closed issue does not always mean the
behavior is gone in the version you are running.

- [#74113](https://github.com/anthropics/claude-code/issues/74113) (closed) —
  *"Background agents frequently go idle without delivering their final
  SendMessage report (re-ping recovers it)."*
- [#76500](https://github.com/anthropics/claude-code/issues/76500) (open) —
  *"Agent Teams mailbox: 5-62 min turn-boundary delays, lost final reports
  (idle_notification arrives instead), /clear queue leak, shutdown handshake
  never completes."*
- [#26426](https://github.com/anthropics/claude-code/issues/26426) (closed) —
  *"Agent Teams inbox polling doesn't work in non-interactive/SDK streaming
  mode."*
- [#24108](https://github.com/anthropics/claude-code/issues/24108) (closed) —
  *"Agent teams: teammates stuck at idle prompt in tmux split-pane mode
  (mailbox never polled)."*

The mechanism behind these matters for understanding what this plugin can and
cannot do. The teammate inbox is **file-backed** at
`~/.claude/teams/<session>/inboxes/<agent>.json`. A message can be written
there, drained from the file, and still never be rendered into the recipient's
transcript turn — so **the failure is the render/turn-injection step, not
transport.** A sender can receive `{"success": true}` for a message the
recipient will never see. That step is inside the harness and is not something
a plugin can fix; everything here is mitigation and recovery.

**This plugin is Claude-Code-specific by nature.** It depends on the exact
hook events, on-disk transcript layout, and JSONL shapes this harness
writes — it is not a portable pattern for other agent runtimes.

## What it does

Three independent, composable mechanisms, wired only through
`hooks/hooks.json`:

| Mechanism | Hook event(s) | What it does |
|---|---|---|
| **Report gate** | `SubagentStop` | Blocks a team-mailbox teammate's turn from ending until it has sent a well-formed `SendMessage`, once. Embeds the teammate's own abandoned final text verbatim in the block reason, so resending is a copy, not a regeneration. Re-checks a delivered report for staleness on a genuinely new follow-up, but never blocks twice for the same one. Never gates a plain (non-team-mailbox) subagent. |
| **Lane drop-box** | `SubagentStop`, `PostToolUse` | A non-blocking, durable JSONL record of every dispatched lane's progress — a checkpoint with the report text verbatim at each stop, plus a throttled heartbeat on tool calls — written independently of whether `SendMessage` ever succeeds. |
| **Orphaned-report pointers** | `SubagentStop`, `UserPromptSubmit`, `SessionStart` | A fallback safety net (not a replacement for normal delivery): records a pointer + a short excerpt (≤200 chars) of every finished subagent's final message, and surfaces it later only if the parent transcript shows no evidence the report ever arrived. |

**All three fail open.** Every failure mode — a missing payload, an
unreadable transcript, an unwritable state file, ambiguous identity
resolution — is swallowed, logged best-effort, and treated as "allow."
Installing this plugin should never be the reason a subagent's turn can't
end or a tool call can't complete.

## Before / after

**Without this plugin:** a background teammate finishes its work, writes a
detailed final message as plain assistant text, and never calls
`SendMessage`. The dispatcher's session just sees an idle notification with
no content. The only way to recover the report is to know to go dig through
`~/.claude/projects/<project>/<session>/subagents/*.jsonl` by hand — most
people don't know to look, and the work is effectively lost.

**With this plugin:** the same teammate's `SubagentStop` is blocked. It's
told, with its own abandoned message quoted back verbatim, to call
`SendMessage` with that exact text. It resends, the block clears, and the
dispatcher gets the real report instead of an empty idle event. If it never
comes back at all, a pointer to its last message is waiting for you at your
next prompt or the start of your next session.

## Install

This repo is its own marketplace — no external wrapper needed:

```
/plugin marketplace add channeleden/claude-subagent-report-guard
/plugin install subagent-report-guard@claude-subagent-report-guard
```

Every hook is wired via `hooks/hooks.json` using `${CLAUDE_PLUGIN_ROOT}`
(never a hardcoded path), and every directory this plugin writes to is
created lazily on first use — no `settings.json` edit, no symlink, no copy
step.

**Start a new session after installing, enabling, or updating.** Claude
Code reads a plugin's `hooks/hooks.json` at session start; it does not
retroactively wire hooks into a session that's already running. If a hook
you expected to fire didn't, this is the first thing to check.

**Back up `~/.claude/settings.json` before running any `claude plugin ...`
command.** The plugin CLI (`install` / `uninstall` / `marketplace add`) has
been observed re-serializing that file and silently dropping `name` keys
from existing hook entries (seen on Claude Code 2.1.283), unrelated to
which plugin you're operating on. Diff the file afterward.

## Requirements

- Claude Code with plugin support (hooks + `${CLAUDE_PLUGIN_ROOT}`).
- Node.js, as bundled/used by your Claude Code install (this plugin has no
  npm dependencies — pure Node built-ins only).
- macOS or Linux. The lane drop-box heartbeat hook's fast-path prefilter
  (`hooks/lane-dropbox-heartbeat.sh`) is a POSIX shell script; on a host
  without `sh`, that one hook's throttling optimization won't run — the
  heartbeat itself is not load-bearing for the report gate.

## What each hook does

- `hooks/report-gate.js` (`SubagentStop`) — the blocking gate described
  above. See `lib/report-gate.js`'s header comment for the full four-step
  identity-resolution fallback (exact `agent_transcript_path`, a direct
  sibling `.meta.json`, an explicit identity field, then a bounded recency
  heuristic) and the peer-acknowledgment-aware stale-report check that
  can't loop two peer-acking agents into re-triggering each other forever.
- `hooks/lane-dropbox-checkpoint.js` (`SubagentStop`) — once per stop,
  appends a `checkpoint` record (report text, task/worktree/branch, git SHA
  when available) to `<data dir>/teams/<session_id>/dropbox/<lane_id>.jsonl`.
- `hooks/lane-dropbox-heartbeat.js` / `.sh` (`PostToolUse`) — a throttled
  (≥60s apart), payload-free liveness record for the same file; the `.sh`
  prefilter means the common no-active-lane case never even spawns Node.
- `hooks/orphan-pointers-subagent-stop.js` (`SubagentStop`) — writes a
  pointer + short excerpt for every finished subagent.
- `hooks/orphan-pointers-user-prompt-submit.js` (`UserPromptSubmit`) /
  `hooks/orphan-pointers-session-start.js` (`SessionStart`) — surface any
  pointer whose report was never confirmed delivered, capped at 5 with
  "+N more," and only after a grace period so an in-flight delivery is
  never mistaken for a loss.

## Configuration

Everything is optional; every default works with zero configuration.

| Variable | Default | Notes |
|---|---|---|
| `SUBAGENT_REPORT_GUARD_POST_REPORT_COMMAND` | unset (no-op) | Shell command to run, detached, once a team-mailbox report is confirmed delivered. Same as `{ "postReportCommand": "..." }` in `<data dir>/config.json`; env var wins if both are set. |
| `SUBAGENT_REPORT_GUARD_DROPBOX_ROOT` | unset | Point the lane drop-box's `teams/<session_id>/` directory at a directory of your own instead of inside this plugin's data dir. Same as `{ "dropboxRoot": "~/some/path" }` in `<data dir>/config.json`. Once set, those files are outside this plugin's data dir and yours to clean up. |
| `SUBAGENT_REPORT_GUARD_RECENCY_WINDOW_MS` | `600000` (10 min) | How old a candidate teammate transcript can be before the report gate's recency fallback still considers it a match. |
| `SUBAGENT_REPORT_GUARD_AMBIGUITY_EPSILON_MS` | `500` | How close two candidates' mtimes must be before the gate refuses to pick one (falls back to a generic, non-embedded block reason). |
| `SUBAGENT_REPORT_GUARD_MAX_EMBEDDED_REPORT_CHARS` | `10000` | Size cap on the verbatim copy embedded in a block reason. |
| `SUBAGENT_REPORT_GUARD_LOG_MAX_BYTES` | `2097152` (2 MB) | Rotation threshold for this plugin's append-only logs. |
| `SUBAGENT_REPORT_GUARD_LOG_PATH` | `<data dir>/logs/report-gate-invocations.log` | Override the report gate's invocation log path. |
| `SUBAGENT_REPORT_GUARD_TAIL_SCAN_BYTES` | `2097152` (2 MB) | Cap on the bounded tail-read used to check the parent transcript for delivery evidence. |
| `SUBAGENT_REPORT_GUARD_PARENT_GONE_GRACE_MS` | `600000` (10 min) | Grace period before a same-session top-level pointer is ever surfaced, and before a quiet parent transcript is treated as a dead/prior session. |
| `SUBAGENT_REPORT_GUARD_NESTED_SETTLE_MS` | `30000` (30 s) | Minimum time a nested pointer (spawned by another subagent) must sit finished before it can surface. |
| `SUBAGENT_REPORT_GUARD_DATA_DIR` | unset | Override this plugin's data dir entirely. Intended for tests, not real installs. |
| `CLAUDE_PLUGIN_DATA` | unset | Set by the Claude Code harness itself on builds that support it; used as the data dir when the override above is unset. |

## Where state lives

Everything this plugin writes lives under exactly one directory:

1. `SUBAGENT_REPORT_GUARD_DATA_DIR`, if set, else
2. `CLAUDE_PLUGIN_DATA`, if the harness sets it, else
3. `~/.claude/subagent-report-guard/`.

Documented children: `report-gate-state/`, `post-report-command/`,
`pointers/<sessionId>/<agentId>.json`, `teams/<session_id>/dropbox/` +
`teams/<session_id>/.state/` (see `dropboxRoot` above to redirect this
subtree), and `logs/report-gate-invocations.log`. With default
configuration this is exhaustive — nothing lands anywhere else.

## Uninstall

```
/plugin uninstall subagent-report-guard@claude-subagent-report-guard
```

Every hook is wired only through `hooks/hooks.json`, so this stops all of
them immediately. To also remove every byte of state (default
configuration — see the `dropboxRoot` caveat above if you configured it):

```sh
rm -rf ~/.claude/subagent-report-guard
```

`test/uninstall.test.js` proves that directory is exhaustive by running
every hook against a scratch `HOME` and asserting nothing lands outside it.

## Troubleshooting

- **A hook I expected to fire didn't.** Check whether it loaded for this
  session at all: grep `<data dir>/logs/report-gate-invocations.log` for
  the session's `session_id` — no matching lines at all means the hooks
  never loaded for that session (see the session-start note under
  Install), not that resolution failed.
- **The gate embedded the wrong text, or refused to embed anything.** This
  happens when two teammate transcripts are ambiguously close in recency
  (within `SUBAGENT_REPORT_GUARD_AMBIGUITY_EPSILON_MS`) — the gate
  deliberately falls back to a generic instruction rather than risk quoting
  the wrong lane. Increasing the ambiguity window won't help; it's a signal
  two agents finished almost simultaneously.
- **`hooks/report-gate.js` never blocks anything.** Confirm the dispatched
  agent is actually a team-mailbox teammate (`taskKind:
  "in_process_teammate"` in its `.meta.json`) — a plain `Task`-tool subagent
  is never gated, by design.

## Known limitations

Read this section before relying on the plugin. These are real, and two of them
are actively being worked on.

### The root cause is upstream and not fixable here

The render/turn-injection failure described in "The problem" happens inside the
harness. This plugin cannot make a message render. Everything it provides is
mitigation — force a resend, capture durably, surface later. If your reports are
going missing, this plugin improves your odds of recovering them; it does not
stop the underlying behavior.

### A delivered-looking report may not have been read (confirmed, being fixed)

Since 2.0.4, delivery is confirmed partly from the plugin's **own invocation
log** — a recorded `outcome: "delivered"` for that agent. That is **sender-side**
evidence: it proves the agent called `SendMessage` successfully, not that the
recipient ever rendered it.

Observed on a live session 2026-09-28: three teammates each got
`{"success": true}` from `SendMessage`. One addressed `main` and its report
appeared in the parent transcript three times. Two addressed the session's lead
agent by name; their inbox files drained to `[]` and **no message envelope ever
appeared in the parent transcript.** All three pointers were marked delivered, so
the orphan-report path never surfaced anything, and roughly 23,000 characters of
completed analysis sat unread until it was recovered by hand from the subagents'
own transcripts.

The fix is to require receiver-side evidence before treating a pointer as
delivered, letting sender-side evidence lower confidence but never satisfy it.
Until that lands, **treat "no orphan report surfaced" as weak assurance**, and if
a dispatched agent's result never appears, check
`~/.claude/subagent-report-guard/pointers/<session>/` and the agent's own
transcript directly.

### `main` and a named lead agent behaved differently

In the same session, `SendMessage` to `main` rendered into the parent transcript
while sends to the lead agent's teammate name did not — both being valid
addresses. This is observed, not explained. Addressing `main` from a background
agent is the more reliable choice meanwhile.

### An interrupted agent looks like an undelivered report

A pointer records the agent's final assistant text whatever that text is. An
agent killed mid-task leaves something like *"Now making the edits…"* — 87
characters of narration, not a report. The plugin does not currently distinguish
*interrupted* from *finished but undelivered*, so a recovered pointer may contain
no report at all.

### Identity resolution has an accepted residual

The recency-based identity fallback — reached only when no exact step matches —
is a heuristic. See `lib/report-gate.js`'s header for the four-step order and
its accepted residual.

### Marker shapes are version-coupled

The orphaned-pointer delivery check matches specific envelope shapes. A harness
change to any of them could make a delivered report look undelivered (surfaced
redundantly — noisy but harmless) or, as described above, the reverse.

### Environment

`CLAUDE_PLUGIN_DATA` support is unconfirmed across every Claude Code version;
the `~/.claude/subagent-report-guard/` fallback is exercised by every test in
this repo either way. The plugin is Claude-Code-specific by nature — it depends
on this harness's hook events, on-disk transcript layout and JSONL shapes.

## Tests

```sh
node --test test/*.test.js
```

Run `node scripts/hygiene-check.js` to check the working tree for anything
that shouldn't ship (absolute user paths, private vocabulary, emails,
secret-shaped strings) — this also runs in CI and as an optional
pre-commit hook (`git config core.hooksPath .githooks`).

## Contributing

Found a different failure mode, a cleaner identity-resolution heuristic, or
a case where a fail-open path didn't actually fail open? Issues and PRs are
welcome.

## License

MIT — see `LICENSE`.
