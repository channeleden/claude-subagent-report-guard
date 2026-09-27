# Changelog

## 2.0.5

- Fixed the "unread-message drop": a lead can `SendMessage` a teammate
  while that teammate is on its final turn. `SendMessage` reports success
  ("queued for next tool round"), but if the teammate ends its turn with no
  further tool round, the message is never drained — the teammate's idle
  notification says "nothing further", and the follow-up was silently
  lost, even though it durably sits, unread, in the teammate's own team
  inbox file on disk. The `SubagentStop` gate now also checks that inbox
  (`<teams root>/<teamName>/inboxes/<name>.json` — Claude Code's own real,
  live layout, read-only, resolved via the new `lib/inbox-gate.js` +
  `teamsRootDir()` in `lib/paths.js`) and blocks once per distinct unread
  set (`lib/report-gate.js`'s `computeUnreadInboxOutcome`), forcing the
  extra turn that drains it. Bounded exactly like the existing
  missing-report block: a hash of the sorted unread `msg_id`s is claimed
  through the same atomic per-agent marker mechanism, so the same set never
  re-blocks and a genuinely new message blocks once more. Composes with the
  missing-report block into a single `gateResult` (both reasons present)
  when both apply in the same stop, with each side's one-shot bookkeeping
  staying independent.
- When the one-shot unread-inbox block has already fired and a teammate
  stops anyway with messages still unread, a notice is now recorded for the
  LEAD and surfaced once on its next prompt (reusing
  `lib/orphan-pointers.js`'s existing atomic surfaced-once marker
  mechanism, via `hooks/orphan-pointers-user-prompt-submit.js`) — e.g.
  "teammate `<name>` stopped with 1 unread message(s) from `team-lead`:
  `<summary>` — re-send or follow up".
- Verified read-only against a live inbox file
  (`~/.claude/teams/<session>/inboxes/<name>.json`): the harness's `read`
  field never transitions to `true` in real data (dozens of inbox files
  spanning months, every message still `"read": false`) — this is itself
  the root-cause evidence for the fix above, and the reason the gate is
  keyed on a hash of the unread `msg_id` set rather than on `read`
  transitioning. `isReadTrue()` in `lib/inbox-gate.js` also defensively
  accepts the strings `"true"`/`"True"` (and therefore treats
  `"false"`/`"False"` as unread too), though the real data never emits
  anything but a JSON boolean.
- Investigated whether a PLAIN (unnamed) subagent has an equivalent
  observable inbox to gate on: it does not. A plain Task-tool subagent has
  no `taskKind: "in_process_teammate"` sidecar, no `name`/`teamName` fields
  to resolve a team inbox path from, and no `SendMessage`-based mailbox at
  all — its result is returned as a synchronous `tool_result` or a
  background task-notification, not queued mail. Out of scope for this
  fix; documented in the README.
- New env var `SUBAGENT_REPORT_GUARD_TEAMS_ROOT` (default `~/.claude/teams`)
  and matching `{ "teamsRoot": "..." }` config.json key, mirroring the
  existing `dropboxRoot` override shape.

## 2.0.4

- Fixed a false "undelivered" report on a team-mailbox teammate whose
  report WAS delivered via `SendMessage`. Delivery is now also confirmed
  from the report-gate's OWN invocation log: a recorded
  `outcome: "delivered"` for that exact agent id (`wasDeliveredPerGateLog`
  in `lib/orphan-pointers.js`). That evidence is independent of the
  transcript-timestamp guard, which rejected the real relay because the
  pointer's `finishedAt` had been moved later by the misattribution fixed
  below. A regression test now locks in that the existing transcript
  matcher also handles the real `type: "attachment"` /
  `attachment.type === "queued_command"` relay shape.
- Fixed a real misattribution: a plain, non-team-mailbox agent's
  `SubagentStop` — whose own `agent_id` matched no team-mailbox candidate —
  could fall through `resolveTeammateContext`'s (`lib/report-gate.js`)
  session-wide recency heuristic and resolve to an unrelated NAMED
  teammate's transcript, purely because that teammate was the freshest (or
  only) team-mailbox candidate at that instant. The resulting pointer was
  then written under the teammate's own storage key but stamped with the
  SECOND agent's `finishedAt` and final-message excerpt — a correct,
  already-delivered pointer corrupted into a false "undelivered" report
  with a completely wrong excerpt. `resolveTeammateContext` now returns
  null outright whenever the payload names an explicit agent-identity field
  that matches no team-mailbox candidate, rather than falling through to
  the heuristic. `hooks/orphan-pointers-subagent-stop.js` also gained an
  independent, defense-in-depth guard: it now fails closed (writes no
  pointer at all) whenever a resolved transcript's own filename-derived
  agent id disagrees with the payload's asserted `agent_id`. A read-side
  backstop (`pointerIdentityConsistent`, used by both the `UserPromptSubmit`
  and `SessionStart` surfacing hooks) also now refuses to ever surface a
  pointer already on disk whose storage key disagrees with its own
  `transcriptPath`'s filename-encoded agent id — covering any pointer
  written before this fix shipped.
- Added regression coverage for both fixes using anonymized real-shape
  fixtures (`test/orphan-pointers.test.js`, `test/report-gate.test.js`):
  the `queued_command` attachment relay shape, the gate-log delivered-state
  check (including negative cases for a different outcome/agent/session),
  an unmatched-`agent_id` case that must never fall through to the recency
  heuristic, a second unrelated agent's `SubagentStop` that must never
  overwrite or misattribute a different agent's existing pointer, and an
  already-corrupted pointer that must never be surfaced by either hook.

## 2.0.3

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
