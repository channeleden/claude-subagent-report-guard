# Legacy gate: the original blocking mitigation

This directory holds this repo's original mitigation for the same
underlying problem the lane drop-box (see the top-level `README.md`)
now addresses: a **blocking `SubagentStop` hook** (`hook.js`) plus a
standalone recovery CLI (`extract-report.js`).

## How it's different from the lane drop-box

|                       | `legacy-gate/hook.js`                                   | Lane drop-box (`hooks/`, `lib/`)                            |
|-----------------------|-----------------------------------------------------------|----------------------------------------------------------------|
| Mechanism             | **Blocking** — refuses to let a turn end without a well-formed `SendMessage` | **Non-blocking** — writes a durable record, never blocks a turn |
| When it acts          | Only at the very end of a turn (`SubagentStop`)          | At every stop (`SubagentStop`) and continuously (`PostToolUse` heartbeat) |
| What a dispatcher gets | An in-context, verbatim-embedded nudge for the agent to resend | An append-only, out-of-band JSONL record it can read anytime |
| Failure mode          | Fails open (never wedges a turn), but a report can still be lost if the agent goes idle some other way | Fails open at every step; a skipped record is the worst case, never a wrong one |

They are complementary, not competing. The blocking gate tries to fix the
report *at the source* — the agent is still in the room and can be nudged to
call `SendMessage` correctly. The drop-box is a safety net *underneath* it —
even if the agent never calls `SendMessage` at all, its progress and last
known text are still durably recorded somewhere the dispatcher can read.
The lane drop-box is the recommended default: install both if you want the
active nudge and the passive safety net together, or the drop-box alone if
you want a purely non-blocking mitigation.

## What's in this directory

- **`hook.js`** — a `SubagentStop` hook that blocks a team-mailbox teammate
  from ending its turn without a well-formed `SendMessage` call. When it
  blocks, it extracts the agent's own abandoned final text from its
  transcript and embeds that text verbatim directly inside the block reason
  — so reproducing it on the agent's next turn is a copy of bytes already in
  its own context, not a fresh reconstruction from memory. Self-contained
  (Node built-ins only, no external dependencies).
- **`extract-report.js`** — a small deterministic CLI that reads a
  teammate's own transcript file directly off disk and prints its final
  assistant text verbatim, with zero model involvement. Useful with or
  without the hook installed — it's the zero-regeneration-risk way to
  recover a report that's still sitting in a transcript file.

## Installing the legacy gate

Add to your Claude Code `settings.json` (merge into any existing `hooks`
object rather than replacing it):

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/legacy-gate/hook.js"
          }
        ]
      }
    ]
  }
}
```

The hook fails open on every error path (missing payload, unreadable
transcript, unwritable state file, ambiguous identity resolution) — it is
designed to never be the reason a legitimate subagent turn cannot end. It
also never gates a plain synchronous Task-tool subagent (only team-mailbox
participants are ever blocked).

**Tunables:**
- `SUBAGENT_REPORT_GATE_RECENCY_WINDOW_MS` (default `600000`, 10 minutes)
  bounds how old a candidate teammate transcript can be before the hook's
  recency-based identity resolution will still consider it a match.
- `SUBAGENT_REPORT_GATE_MAX_EMBEDDED_REPORT_CHARS` (default `10000`) bounds
  how much of the agent's abandoned text gets embedded verbatim in the
  block reason.

## Using the extraction script

```sh
node extract-report.js --session-dir ~/.claude/projects/<your-project-dir>/<session-id> [--agent <teammate-name>]
```

`<session-id>` is the directory that directly contains a `subagents/` child.
Omit `--agent` to get the most recently active teammate under that session;
pass it to target a specific one when several were dispatched. The script
prints that teammate's final assistant text block(s) exactly as written,
with no model call and no regeneration risk.

## If you still need to ping

`hook.js` automates the embedded-verbatim-text approach above when it's
installed. If you don't have it installed, or you're recovering a report
from a machine other than the one that ran the session (so reading the
transcript directly isn't practical), use anti-regeneration wording rather
than a generic "please send your report" when pinging the idle teammate
yourself:

> Resend your original report VERBATIM from your own prior turn — do not
> summarize, re-render, or re-compose it. Copy it exactly.

This measurably reduces (though does not structurally eliminate) drift
versus a generic follow-up prompt, and for any structured deliverable
(tables, counts, classifications) you should still spot-diff the recovered
text against the transcript before acting on it — fluency is not fidelity.

## Known limitations

- The hook's recency-based identity resolution (used when no direct-sibling
  match and no explicit identity field is available) cannot distinguish two
  teammates that both write to their own transcript within the same tight
  time window. In a heavily parallel session this can occasionally cause
  the hook's block/allow decision to be based on the wrong teammate's
  transcript history. The decision always still applies to whichever agent
  actually triggered the `SubagentStop` event — what can be wrong, in this
  narrow case, is which transcript was read to make that call. This is a
  bounded, occasional-miss risk, not an unbounded one.
- Neither script here fixes the underlying platform behavior (undelivered
  final text, no verbatim-resend primitive, and the `transcript_path`
  payload mismatch for named background teammates) — they are user-side
  mitigations, not upstream fixes. The lane drop-box (see the top-level
  README) takes a different approach to the same underlying gap: instead of
  trying to get the report delivered at the source, it keeps an independent,
  durable record regardless of whether delivery ever succeeds.
