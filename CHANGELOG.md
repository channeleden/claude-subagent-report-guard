# Changelog

## Unreleased

- Report gate invocation log (`<data dir>/logs/report-gate-invocations.log`)
  is now privacy-minimal but far more diagnosable: every line carries
  `hook_event_name`, `session_id`, `agent_id`, `agent_type`, `payload_keys`
  (key names only, never values), and `has_agent_transcript_path`; every
  RESOLVED outcome (`block`/`allow`/`delivered`) also carries
  `resolutionMethod`. The previously single `not-team-mailbox-or-unresolvable`
  outcome now also carries `reason`, distinguishing `no-payload` (stdin
  empty/unparseable) from `not-team-mailbox` (a payload parsed but
  `evaluate()` returned null). `lib/report-gate.js`'s `evaluate()` now
  threads `resolutionMethod` through every one of its return objects
  (decision logic unchanged). Never logs message content or a full
  filesystem path. Existing `outcome` values are unchanged for back-compat.
- Added `test/report-gate-real-shape.test.js` plus sanitized fixtures
  (`test/fixtures/real-shape-2026-09-27/`) reproducing the real live
  meta.json + transcript.jsonl shapes from the 2026-09-27
  `gate-live-test` incident, covering: first-stop block with the verbatim
  embed, one-shot allow on replay, delivered after an appended SendMessage,
  a plain (non-team-mailbox) subagent never gating, resolution via
  `payload-identity-field` when `agent_transcript_path` is absent, and an
  end-to-end child-process run asserting both the stdout decision and the
  new log line's shape.
- README: documented that plugin hooks load only at session START (a
  session already running when this plugin is installed/updated will not
  run the gate — this is the confirmed root cause of the 2026-09-27
  incident above) and that Claude Code's plugin CLI (`claude plugin
  install`/`uninstall`/`marketplace add`) has been observed to silently
  drop `name` keys from hook entries when it re-serializes
  `~/.claude/settings.json` — back up and diff before running it. Also
  documented the invocation log's full field set under a new "Report gate
  — invocation log" section.

## 2.0.2

- Fixed a false-positive orphan surfacing race in `UserPromptSubmit`:
  delivering a background-agent task-notification (or a team-mailbox
  agent/teammate message) to the parent is itself the prompt that fires this
  hook, arriving before the harness appends the delivery entry to the
  transcript — the hook now checks its own raw `prompt` payload text for
  that delivery first (`claimPointersDeliveredByPrompt`) and claims the
  pointer immediately, independent of the transcript scan.
- `UserPromptSubmit` no longer surfaces an undelivered pointer on the very
  next prompt. A same-session top-level pointer now surfaces only once
  undelivered for longer than `SUBAGENT_REPORT_GUARD_PARENT_GONE_GRACE_MS`
  (default 10 min); a nested pointer whose parent agent has already
  finished now waits out a minimum settle time,
  `SUBAGENT_REPORT_GUARD_NESTED_SETTLE_MS` (default 30 s), before
  surfacing. `SessionStart` is unaffected.

## 2.0.1

- Fixed a Linux stdin `EAGAIN` bug that made hooks silently no-op on Linux.
- Added CI coverage on both `ubuntu-latest` and `macos-latest`.
- Added a test-isolation guard so a test run can never fall back to writing
  under the operator's real `HOME`.
- Orphaned-report pointers now use the real `SubagentStop` payload shape
  (`agent_transcript_path` / `agent_id` / `session_id` /
  `last_assistant_message`) instead of a direct-sibling lookup against
  `transcript_path` — previously inert for plain (non-team-mailbox)
  subagents, the exact case this mechanism exists to catch.
- Nested lanes (a subagent spawned by another subagent) are now checked for
  delivery against their PARENT AGENT's own transcript, not the top-level
  session transcript.
- `agent_transcript_path` is now validated for containment under the
  session's own `subagents/` directory, agreement with `payload.agent_id`
  when present, and a safe path segment — a basename-pattern match alone is
  no longer sufficient to accept it.

## 2.0.0

Breaking change from 1.x: the blocking gate now ships as a first-class
plugin hook (`hooks/report-gate.js`) and the standalone `legacy-gate/`
directory has been removed. `hooks/hooks.json` is the only wiring point.
