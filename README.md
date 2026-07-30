# Background-teammate report delivery: mitigation kit

Two compounding defects in Claude Code's background/team-mailbox teammate flow, and a
self-serve mitigation for both:

1. **Undelivered final text.** A background teammate's plain final assistant text is never
   delivered to whoever dispatched it — only an explicit `SendMessage` call delivers content
   upstream. If a teammate finishes and ends its turn without calling `SendMessage`, the
   dispatcher receives only a content-free `idle_notification`; the actual report exists solely
   in that teammate's own transcript file on disk.
2. **Lossy "recovery."** The standard workaround — ping the idle teammate and ask it to send its
   report — is not a resend. There is no verbatim-replay primitive on this tool surface:
   `SendMessage`'s `message` field is authored fresh by the model on every call. Recovering an
   abandoned report this way has been observed to range from a trivial trim, to a full
   sentence-level rewrite (facts preserved), to a full structural collapse — an 11-row Markdown
   table silently became a prose numbered list, with no error or warning. A fluent paraphrase
   passes review where an obviously-missing report would not. `hook.js` in this kit reduces (but
   does not structurally eliminate) this risk by extracting the agent's own abandoned text and
   embedding it directly in the block reason — see "What's in this kit" below.
3. **A hook payload caveat that defeats the "obvious" fix.** The natural deterministic
   mitigation is a `SubagentStop` hook that blocks turn-end without a `SendMessage`. Writing
   that hook the "obvious" way — reading `payload.transcript_path` and checking a sibling
   `.meta.json` file — silently never fires for named background teammates: on this dispatch
   shape, `transcript_path` has been observed, live, to resolve to the LEAD session's own
   top-level transcript, not the teammate's dedicated file. See the comment block at the top of
   `hook.js` for the full explanation and the three-step resolution this kit uses instead.

## What's in this kit

- **`hook.js`** — a `SubagentStop` hook that blocks a team-mailbox teammate from ending its turn
  without a well-formed `SendMessage` call, correctly resolving the real per-teammate transcript
  despite the `transcript_path` caveat above. When it blocks, it extracts the agent's own
  abandoned final text from its transcript and embeds that text VERBATIM directly inside the
  block reason — so reproducing it on the agent's next turn is a copy of bytes already in its own
  context, not a fresh reconstruction from memory. The embed is size-bounded
  (`MAX_EMBEDDED_REPORT_CHARS`, default 10000 characters, overridable via
  `SUBAGENT_REPORT_GATE_MAX_EMBEDDED_REPORT_CHARS`); past that bound the reason still includes as
  much as fits plus an explicit instruction to reproduce the complete original message, not just
  the shown excerpt. Self-contained (Node built-ins only, no external dependencies).
- **`extract-report.js`** — a small deterministic CLI that reads a teammate's own transcript file
  directly off disk and prints its final assistant text verbatim, with zero model involvement.
  This is the zero-regeneration-risk path — use it when you need the report exactly as written,
  including any tail past the hook's embed truncation threshold. Also self-contained.

## Installing the hook

Add to your Claude Code `settings.json` (merge into any existing `hooks` object rather than
replacing it):

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/hook.js"
          }
        ]
      }
    ]
  }
}
```

No further configuration is required. The hook fails open on every error path (missing payload,
unreadable transcript, unwritable state file, ambiguous identity resolution) — it is designed to
never be the reason a legitimate subagent turn cannot end. It also never gates a plain
synchronous Task-tool subagent (only team-mailbox participants, identified by
`taskKind: "in_process_teammate"` in their meta.json, are ever blocked).

**Tunables:**
- `SUBAGENT_REPORT_GATE_RECENCY_WINDOW_MS` (default `600000`, i.e. 10 minutes) bounds how old a
  candidate teammate transcript can be before the hook's recency-based identity resolution (step
  3 in `hook.js`'s header comment) will still consider it a match.
- `SUBAGENT_REPORT_GATE_MAX_EMBEDDED_REPORT_CHARS` (default `10000`) bounds how much of the
  agent's abandoned text gets embedded verbatim in the block reason (see "What's in this kit"
  above).

## Using the extraction script

If a background teammate went idle without a `SendMessage` (whether or not you have the hook
above installed), recover its abandoned report losslessly instead of pinging it:

```sh
node extract-report.js --session-dir ~/.claude/projects/<your-project-dir>/<session-id> [--agent <teammate-name>]
```

`<session-id>` is the directory that directly contains a `subagents/` child. Omit `--agent` to
get the most recently active teammate under that session; pass it to target a specific one when
several were dispatched. The script prints that teammate's final assistant text block(s) exactly
as written, with no model call and no regeneration risk.

## If you still need to ping

`hook.js` automates the embedded-verbatim-text approach below when it's installed. If you don't
have it installed, or you're recovering a report from a machine other than the one that ran the
session (so reading the transcript directly isn't practical), use anti-regeneration wording
rather than a generic "please send your report" when pinging the idle teammate yourself:

> Resend your original report VERBATIM from your own prior turn — do not summarize, re-render,
> or re-compose it. Copy it exactly.

This measurably reduces (though does not structurally eliminate) drift versus a generic
follow-up prompt, and for any structured deliverable (tables, counts, classifications) you
should still spot-diff the recovered text against the transcript before acting on it — fluency
is not fidelity.

## Known limitations

- The hook's recency-based identity resolution (used when no direct-sibling match and no
  explicit identity field is available) cannot distinguish two teammates that both write to
  their own transcript within the same tight time window. In a heavily parallel session this can
  occasionally cause the hook's block/allow decision to be based on the wrong teammate's
  transcript history. The decision always still applies to whichever agent actually triggered
  the `SubagentStop` event — what can be wrong, in this narrow case, is which transcript was read
  to make that call. This is a bounded, occasional-miss risk, not an unbounded one, and is a
  large net improvement over a hook that (per the caveat above) never gates anything at all on
  this dispatch shape.
- Neither script here fixes the underlying platform behavior (undelivered final text, no
  verbatim-resend primitive, and the `transcript_path` payload mismatch for named background
  teammates) — they are user-side mitigations, not upstream fixes.

## Contributing

Found a different failure mode, a cleaner identity-resolution heuristic, or a case where this
gate's fail-open behavior didn't fail open? Issues and PRs are welcome — this is a small,
self-contained kit and workarounds from other setups are genuinely useful.

## License

MIT — see [LICENSE](LICENSE).
