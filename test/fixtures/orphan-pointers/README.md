# Orphan-pointer delivery-evidence fixtures

Sanitized, minimal shapes modeling the real Claude Code transcript entries
`lib/orphan-pointers.js`'s `wasDelivered()` looks for. No real session
content or user paths — every example below uses placeholder names/ids.
`test/orphan-pointers.test.js` constructs these shapes inline rather than
loading files from this directory (they are a handful of lines each); this
file documents the real-world basis for them, verified against sanitized
excerpts of real local transcripts before being reduced to these minimal
forms.

## Foreground / synchronous subagent (Task-tool `Agent` call)

The subagent's own `.meta.json` sidecar carries the exact tool-use id the
parent's `Agent` call used to spawn it:

```json
{ "agentType": "general-purpose", "description": "...", "toolUseId": "toolu_01ABC...", "spawnDepth": 1 }
```

The parent's own transcript records that spawn's result as an ordinary
`tool_result`, keyed by that same id — DIRECTLY OBSERVED:

```json
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01ABC...","type":"tool_result","content":[{"type":"text","text":"..."}]}]}}
```

A matching `tool_use_id` between the sidecar and a `tool_result` in the
parent transcript is exact, deterministic evidence of delivery — UNLESS the
result's text starts with `"Async agent launched successfully."` (see the
next section): that specific text is the background-launch acknowledgment,
which shares the spawn call's own `tool_use_id`, not the eventual real
result's.

## Background `Agent` dispatch (asynchronous, non-team-mailbox)

DIRECTLY OBSERVED, real transcript shapes (agent ids/paths sanitized
below):

1. The IMMEDIATE launch ack — a `tool_result` with the SAME `tool_use_id`
   as the spawning `Agent` call, whose text starts with `"Async agent
   launched successfully."` and contains `agentId: <id>`. This is NOT
   delivery — it fires the instant the spawn call returns, long before the
   dispatched agent has done any work:

   ```json
   {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_SPAWN1","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully.\nagentId: aFAKE0000000000 (internal ID - do not mention to user...)"}]}]}}
   ```

2. Completion first appears queued, then delivered, as three consecutive
   entries: an `enqueue`, a dequeue (`dequeue` or `remove` — both forms have
   been observed across harness versions), then the real delivery. The
   delivery entry itself has been observed in TWO real shapes:

   - a `type: "attachment"` entry:

     ```json
     {"type":"attachment","attachment":{"type":"queued_command","prompt":"<task-notification>\n<task-id>aFAKE0000000000</task-id>\n<tool-use-id>toolu_SPAWN1</tool-use-id>\n<output-file>...</output-file>\n<status>completed</status>\n<summary>...</summary>\n</attachment>","commandMode":"task-notification"}}
     ```

   - a plain `type: "user"` entry whose message content is the
     task-notification text itself (no `attachment` wrapper):

     ```json
     {"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>aFAKE0000000000</task-id>\n<tool-use-id>toolu_SPAWN1</tool-use-id>\n<output-file>...</output-file>\n<status>completed</status>\n<summary>...</summary>\n<result>...</result>\n</task-notification>"}}
     ```

   The preceding `enqueue` entry's own `content` field also contains the
   same `<task-id>...</task-id>` substring (the queued payload) — that
   entry MUST NOT count as delivery on its own: if the parent session died
   between the enqueue and the dequeue, the notification never reaches the
   conversation, and this is exactly the orphan case this module exists to
   catch. `wasDelivered()` closes this by being entry-aware: it parses each
   tail line as JSON and skips every `type: "queue-operation"` entry before
   running any marker check, for every evidence type, not only this one.

   The harness agent id in `<task-id>` is the SAME string reported by the
   launch ack's `agentId: <id>` line, and is also exactly the transcript
   filename's own id component (`agent-<id>.jsonl`) — the leading `a` is
   part of the id, not a harness-added decoration.

## Team-mailbox teammate (background dispatch, `SendMessage`)

The sidecar instead carries a `name` and `taskKind: "in_process_teammate"`,
no `toolUseId`. DIRECTLY OBSERVED delivery shape — a plain `type: "user"`
entry whose message content is a string containing the marker unescaped:

```json
{"type":"user","message":{"role":"user","content":"Another Claude session sent a message:\n<agent-message from=\"teammate-name\">\n...body...\n</agent-message>"}}
```

or the `<teammate-message teammate_id="...">` variant (also directly
observed, e.g. inside an `idle_notification` payload). Like the
task-notification case above, the SAME marker text has also been observed
inside a preceding `queue-operation` entry's own queued `content` field
before the real delivery entry lands — also excluded from counting as
delivery by the same queue-operation skip.

`wasDelivered()` matches these against `JSON.stringify()` of one
already-parsed transcript entry, which always re-serializes an embedded
quote as exactly one level of `\"` — so, unlike a raw-text scan, one
escaped form per marker is enough; an unescaped form is kept purely as a
defensive fallback.
