# WIP: require receiver-side evidence before claiming a pointer

**Status:** design settled, not yet implemented. This branch exists so the work is
visible rather than held back. Nothing here changes behavior yet.

## The defect

`lib/orphan-pointers.js` marks a pointer `claimed` — meaning "the dispatcher got
this, don't surface it" — when any of several delivery signals match. Since 2.0.4
one of those signals is `wasDeliveredPerGateLog`: a recorded
`outcome: "delivered"` in the plugin's **own** invocation log.

That signal is **sender-side**. It proves the subagent called `SendMessage` and the
call succeeded. It cannot see whether the recipient rendered the message.

Those two things come apart, because the teammate inbox is file-backed and the
harness's render/turn-injection step is separate from transport. A message can be
written to `~/.claude/teams/<session>/inboxes/<agent>.json`, drained from the
file, and never appear in the recipient's transcript.

### Observed 2026-09-28

One live session, three teammates, all three `SendMessage` calls returning
`{"success": true}`:

| Agent | Addressed | Envelopes in parent transcript | Pointer |
|---|---|---|---|
| A | `main` | 3 | claimed (correct) |
| B | lead agent by name | **0** | claimed (**wrong**) |
| C | lead agent by name | **0** | claimed (**wrong**) |

Inbox files had drained to `[]`. Agent C sent three escalating versions, each told
it had succeeded, with no way to learn nobody was reading. Because all three
pointers were claimed, the orphan-report path never fired and about 23,000
characters of completed analysis went unread until recovered by hand from the
subagents' own transcripts.

The pre-2.0.4 behavior was the opposite defect — a genuinely delivered report
reported as undelivered. The 2.0.4 fix for that traded a noisy false positive for
a **silent false negative**, which is the worse direction for a safety net.

## The fix

Sender-side evidence may **lower confidence but never satisfy** the claim.

- Receiver-side evidence — a message envelope for that agent in the parent
  transcript — remains sufficient, unchanged.
- `wasDeliveredPerGateLog` alone stops being sufficient. With sender-side
  evidence and no receiver-side envelope, the pointer stays **unclaimed** and
  remains eligible to surface.
- Surfacing such a pointer is therefore possible when the report did in fact
  arrive. That is the pre-2.0.4 false positive, deliberately reaccepted: a
  redundant surfaced report is recoverable, a silently suppressed one is not.
  To keep it quiet, mark that case distinctly (e.g. `deliveryConfidence:
  "sender-only"`) and word the surfaced text as "may already have reached you".

### Constraints

- **Fail open.** Every path stays fail-open; this gate must never be the reason a
  turn cannot end.
- **No new per-event cost.** The check reads evidence already gathered; it adds no
  polling, no retry, no unbounded state.
- **One-shot per pointer.** Surfacing stays idempotent per channel via the
  existing `surfaced` flags.

## Tests to add

1. Gate-log `delivered` present, **no** parent envelope → pointer stays unclaimed
   and is eligible to surface.
2. Gate-log `delivered` present **and** a parent envelope → claimed, not surfaced
   (2.0.4's fix preserved).
3. A sender-only surfaced pointer is marked as such and worded as possibly
   already delivered.
4. Regression: the original 2.0.4 case — a real relay via the
   `type: "attachment"` / `queued_command` shape — still resolves as delivered.

## Separately, not in this branch

**An interrupted agent is not an undelivered report.** A pointer whose final text
is 87 characters of *"Now making the edits…"* is an agent that died mid-task.
Classifying *interrupted* separately from *finished but undelivered* would stop
recovery prompts that hand back narration instead of a report. Tracked, not
started.
