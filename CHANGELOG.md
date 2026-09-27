# Changelog

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
