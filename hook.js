#!/usr/bin/env node
'use strict';

/**
 * subagent-report-delivery-gate.js — a `SubagentStop` hook for Claude Code
 * that blocks a background/team-mailbox subagent from ending its turn
 * without having called `SendMessage`.
 *
 * WHY THIS EXISTS
 * ----------------
 * A background teammate dispatched via the Agent tool (a "team-mailbox"
 * participant, addressable with `SendMessage`) does NOT have its plain
 * final assistant text delivered to whoever dispatched it. Only an
 * explicit `SendMessage` tool call delivers content upstream; a separate,
 * content-free `idle_notification` event is all the dispatcher otherwise
 * sees when that agent goes idle. If a teammate finishes its work and ends
 * its turn with plain text only (no `SendMessage`), that text is
 * effectively lost — visible only inside that teammate's own transcript
 * file on disk, never surfaced to the conversation that dispatched it.
 *
 * This hook is a deterministic backstop for that failure mode: it fires on
 * every `SubagentStop` event and, for team-mailbox participants only,
 * blocks the stop (forcing the harness to give the agent another turn)
 * unless a well-formed `SendMessage` call already occurred.
 *
 * THE `transcript_path` CAVEAT (read this before you install)
 * --------------------------------------------------------------
 * The most natural way to write this hook is: read `payload.transcript_path`
 * from the `SubagentStop` event, look for a sibling `<path>.meta.json` file
 * (Claude Code writes one next to each spawned subagent's transcript, with
 * a `taskKind` field that is `"in_process_teammate"` for team-mailbox
 * participants and absent for plain synchronous subagents), and gate on
 * that.
 *
 * In practice, `payload.transcript_path` on a `SubagentStop` firing for a
 * NAMED background teammate (an "agent teams"-style dispatch, carrying a
 * `teamName` field in its own meta.json) has been observed, live, to
 * resolve to the LEAD session's own top-level transcript file
 * (`<project-dir>/<session-id>.jsonl`) — NOT to the teammate's own
 * dedicated transcript. No sibling `.meta.json` exists next to the lead's
 * own transcript file, so a naive direct-sibling lookup always misses:
 * `taskKind` reads as `null` for every single firing, and a hook written
 * the "natural" way above will never actually gate anything, silently.
 *
 * The teammate's REAL transcript + meta.json sidecar live one directory
 * down, at:
 *
 *     <project-dir>/<session-id>/subagents/agent-a<name>-<hash>.jsonl
 *     <project-dir>/<session-id>/subagents/agent-a<name>-<hash>.meta.json
 *
 * (the literal `a` right after `agent-` is part of Claude Code's own
 * naming scheme, not part of the dispatched agent's name).
 *
 * There is no field on the `SubagentStop` payload, confirmed present live,
 * that identifies WHICH teammate under that directory is the one that just
 * stopped (several may be active concurrently). This hook resolves it with
 * a three-step fallback, in order of confidence:
 *
 *   1. Direct sibling of `payload.transcript_path` — exact, not a
 *      heuristic. Kept first so any future harness fix that starts pointing
 *      `transcript_path` correctly upgrades this hook for free, and so a
 *      plain synchronous Task-tool subagent (whose transcript_path DOES
 *      point at its own file, but which never carries `taskKind` at all)
 *      is still correctly exempted from gating.
 *   2. An explicit agent-identity field on the payload itself — checked
 *      defensively under a few plausible key spellings
 *      (`agent_id`/`agentId`/`subagent_id`/`subagentId`), in case a given
 *      Claude Code version does expose one even though none was confirmed
 *      present as of this writing.
 *   3. A recency heuristic: among every `agent-a*.meta.json` under that
 *      session's `subagents/` dir tagged `taskKind: "in_process_teammate"`,
 *      pick the one whose sibling `.jsonl` has the most recent mtime,
 *      bounded to a time window (default 10 minutes, overridable via
 *      `SUBAGENT_REPORT_GATE_RECENCY_WINDOW_MS`) so a stale file from
 *      earlier in a long session is never silently chosen once the real
 *      signal is genuinely absent.
 *
 * KNOWN LIMITATION of step 3: two teammates that both write within the same
 * tight recency window cannot be told apart by mtime alone — in a heavily
 * parallel session this can occasionally misattribute which teammate's
 * transcript history the block/allow decision is based on. The decision
 * always still applies to whichever agent actually fired the `SubagentStop`
 * event; what can be wrong is which transcript this hook read to make that
 * call. This is a bounded, occasional-miss risk, not an unbounded one, and
 * is a large net improvement over a hook that (per the caveat above) never
 * gates anything at all.
 *
 * THE REGENERATION-DRIFT PROBLEM, AND HOW THIS HOOK REDUCES IT
 * ------------------------------------------------------------------
 * A hook's block `reason` can only ask the model to call `SendMessage` — it
 * cannot force a tool call's arguments directly. Composing that call is
 * itself a fresh model generation; simply telling an agent "resend your
 * report" after it already produced a long or structured report (e.g. a
 * Markdown table) can result in a paraphrase, a reformat, or (observed
 * live) a table silently collapsing into a prose list — fluent, plausible,
 * and WRONG relative to the original.
 *
 * This hook reduces that risk structurally rather than relying on
 * instruction alone: it reads the stopping agent's OWN transcript, extracts
 * its actual final assistant text (`lastAssistantText` below), and embeds
 * that text DIRECTLY inside the block `reason` string, verbatim. When the
 * agent's next turn sees the block reason, the exact bytes it needs to
 * reproduce are already sitting in its own context — reproducing them is
 * then a copy, not a reconstruction from memory. The embed is size-bounded
 * (`MAX_EMBEDDED_REPORT_CHARS` below); past that bound, the reason still
 * includes as much as fits plus an explicit instruction to reproduce the
 * COMPLETE original message, not just the shown excerpt.
 *
 * For the highest-stakes case (a report you need with zero regeneration
 * risk, even for the truncated tail past the embed bound), don't rely on
 * the hook's resend at all: read the teammate's own transcript file
 * directly. See the companion script `extract-report.js` in this same kit
 * for a small, deterministic, zero-model-involvement CLI that does exactly
 * that.
 *
 * INSTALLATION
 * ------------
 * See README.md in this same kit for the settings.json snippet.
 *
 * INVARIANTS
 * ----------
 *  - Always exits 0 — communicates via the `decision` field on stdout only,
 *    never via a non-zero process exit code.
 *  - Every failure mode (missing payload, unreadable transcript/meta,
 *    unwritable state file, ambiguous identity resolution) fails OPEN —
 *    this hook must never be the reason a legitimate subagent turn cannot
 *    end.
 *  - Never gates a subagent whose meta.json does not carry
 *    `taskKind: "in_process_teammate"` — a plain synchronous Task-tool
 *    subagent reports back via its own plain-text tool_result and has no
 *    `SendMessage` tool to call; gating it would be a false positive.
 */

const fs = require('fs');
const path = require('path');

const RECENCY_WINDOW_MS =
  Number(process.env.SUBAGENT_REPORT_GATE_RECENCY_WINDOW_MS) || 10 * 60 * 1000;

// Size bound for the verbatim copy embedded directly in the block reason
// (see "THE REGENERATION-DRIFT PROBLEM" above). An unbounded embed could
// balloon a single hook decision by an arbitrary amount of context; 10000
// characters comfortably covers a typical multi-paragraph report with
// structured content (e.g. a sizeable Markdown table) without truncating
// most real-world cases. Overridable via env for tuning; a truncated embed
// still anchors the resend past this threshold (see `buildStage1Reason`).
const MAX_EMBEDDED_REPORT_CHARS =
  Number(process.env.SUBAGENT_REPORT_GATE_MAX_EMBEDDED_REPORT_CHARS) || 10000;

// Matches the live-observed naming convention for a team-mailbox teammate's
// dedicated meta.json sidecar. See the "transcript_path CAVEAT" section
// above. The literal `a` right after `agent-` is part of the harness's own
// naming scheme, not part of the dispatched agent's own name.
const AGENT_META_PATTERN = /^agent-a(.+)-([0-9a-f]+)\.meta\.json$/;

function allow() {
  process.exit(0);
}

function readPayload() {
  try {
    const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readTranscriptEntries(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return entries;
}

function metaPathFor(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null;
  return `${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`;
}

function statePathFor(transcriptPath) {
  return `${transcriptPath}.report-gate-state.json`;
}

// Derives the session directory (the one that directly contains a
// `subagents/` child) from whatever transcript_path the payload handed us —
// works whether that path is the lead's own top-level transcript (the
// commonly observed live case) or already points inside `subagents/`
// itself.
function subagentSessionDir(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const base = transcriptPath.endsWith('.jsonl')
    ? transcriptPath.slice(0, -'.jsonl'.length)
    : transcriptPath;
  const marker = `${path.sep}subagents${path.sep}`;
  const idx = base.lastIndexOf(marker);
  return idx === -1 ? base : base.slice(0, idx);
}

function listTeammateMetaCandidates(subagentsDir) {
  let names;
  try {
    names = fs.readdirSync(subagentsDir);
  } catch {
    return [];
  }
  const candidates = [];
  for (const name of names) {
    const m = AGENT_META_PATTERN.exec(name);
    if (!m) continue;
    const metaPath = path.join(subagentsDir, name);
    const meta = readJsonSafe(metaPath);
    if (!meta || meta.taskKind !== 'in_process_teammate') continue;
    const transcriptPath = `${metaPath.slice(0, -'.meta.json'.length)}.jsonl`;
    candidates.push({ agentId: `${m[1]}-${m[2]}`, metaPath, transcriptPath, meta });
  }
  return candidates;
}

// Resolves the REAL per-teammate {transcriptPath, metaPath, meta} for a
// SubagentStop firing. Returns null when no team-mailbox participant can be
// identified with reasonable confidence — callers must treat null exactly
// like "not a team-mailbox participant" (allow, never block). See the file
// header's "transcript_path CAVEAT" for the three-step resolution order.
function resolveTeammateContext(payload, { now = Date.now() } = {}) {
  const rawTranscriptPath = payload && payload.transcript_path;
  if (typeof rawTranscriptPath !== 'string' || !rawTranscriptPath) return null;

  // Step 1 — direct sibling. Exact, not a heuristic, so tried first.
  const directMetaPath = metaPathFor(rawTranscriptPath);
  const directMeta = directMetaPath && readJsonSafe(directMetaPath);
  if (directMeta && directMeta.taskKind === 'in_process_teammate') {
    return {
      transcriptPath: rawTranscriptPath,
      metaPath: directMetaPath,
      meta: directMeta,
      resolutionMethod: 'direct-sibling',
    };
  }

  const sessionDir = subagentSessionDir(rawTranscriptPath);
  if (!sessionDir) return null;
  const candidates = listTeammateMetaCandidates(path.join(sessionDir, 'subagents'));
  if (!candidates.length) return null;

  // Step 2 — explicit agent-identity field on the payload, if present.
  const identityFieldCandidates = [
    payload.agent_id,
    payload.agentId,
    payload.subagent_id,
    payload.subagentId,
  ].filter((v) => typeof v === 'string' && v);
  for (const id of identityFieldCandidates) {
    const hit = candidates.find((c) => c.agentId === id);
    if (hit) return { ...hit, resolutionMethod: 'payload-identity-field' };
  }

  // Step 3 — recency heuristic, bounded to RECENCY_WINDOW_MS.
  let best = null;
  for (const c of candidates) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(c.transcriptPath).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs > RECENCY_WINDOW_MS) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { ...c, mtimeMs };
  }
  if (best) return { ...best, resolutionMethod: 'recency-heuristic' };

  return null;
}

function isSendMessageToolUse(block) {
  return !!block && block.type === 'tool_use' && block.name === 'SendMessage';
}

function assistantToolUses(entry) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool_use');
}

// The final assistant turn's text content, verbatim. Scans from the tail of
// `entries` for the LAST assistant entry that carries at least one
// `type: 'text'` content block and returns those blocks' text joined
// exactly as authored. An assistant entry whose only content is `tool_use`
// (it ended mid tool-call) is skipped — the walk continues backward to the
// nearest real text block. Returns null when no assistant text block exists
// anywhere in `entries`.
function lastAssistantText(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e || e.type !== 'assistant') continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    const textBlocks = content.filter(
      (b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length,
    );
    if (textBlocks.length) return textBlocks.map((b) => b.text).join('\n\n');
  }
  return null;
}

// Requires a non-empty `to` plus a non-empty `message` or `summary` in the
// call's own input — deliberately does NOT trust a SendMessage tool_result's
// success status as proof of a well-formed delivery. `SendMessage` has been
// observed live to still return `{"success": true}` even when called with
// extra/stray fields instead of the real `to`/`message` — a strict schema
// would reject that, but a lenient one can silently accept it. Checking the
// call's own input, not its result, catches that case too.
function hasWellFormedSendMessage(block) {
  if (!isSendMessageToolUse(block)) return false;
  const input = block.input || {};
  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
  return nonEmpty(input.to) && (nonEmpty(input.message) || nonEmpty(input.summary));
}

// A `type: 'user'` transcript entry is not always an inbound message — every
// tool call's result is ALSO recorded as a `type: 'user'` entry
// (`content: [{ type: 'tool_result', ... }]`). A SendMessage call is
// immediately followed by its own tool_result, also `type: 'user'` — if a
// turn boundary is computed naively as "the last `type: 'user'` entry", it
// can land on THAT tool_result, strictly after the SendMessage call it was
// meant to detect, making a correctly-sent final report invisible. This
// helper skips tool_result-only `user` entries so the boundary never lands
// there.
function isToolResultOnlyEntry(entry) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((b) => b && b.type === 'tool_result');
}

function lastUserBoundary(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i] && entries[i].type === 'user' && !isToolResultOnlyEntry(entries[i])) return i;
  }
  return -1;
}

function wellFormedSendMessageInRange(entries, fromIdx) {
  for (let i = Math.max(fromIdx, 0); i < entries.length; i += 1) {
    const e = entries[i];
    if (!e || e.type !== 'assistant') continue;
    if (assistantToolUses(e).some(hasWellFormedSendMessage)) return true;
  }
  return false;
}

// Write-temp-then-rename so a concurrent reader never sees a partial write.
// Returns whether the marker was actually persisted — callers MUST treat a
// false return as "the one-shot guard did not persist" and fail open
// (never block without a durable marker), otherwise an unwritable path
// (e.g. permissions, or the path colliding with a directory) can leave a
// stage blocking on every subsequent stop attempt forever.
function writeStateSafe(p, obj) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup only; never throw from a hook */
    }
    return false;
  }
}

// Builds the stage-1 block reason. When the stopping agent's own final
// assistant text is available (the common case), it is embedded VERBATIM
// in the reason itself — see "THE REGENERATION-DRIFT PROBLEM" in the file
// header. Falls back to a generic instruction only when there is no
// assistant text at all to anchor to.
function buildStage1Reason(finalText) {
  const genericTail =
    'Use exactly these three fields on the call — "to" (main, or your dispatcher if different), ' +
    '"message", and "summary" (a short preview) — no other fields. Plain final text is not ' +
    'visible to whoever dispatched you — only SendMessage delivers it, and a malformed call can ' +
    'silently return success without actually landing. If you are genuinely blocked, send that ' +
    'via SendMessage too instead of going idle silently.';

  if (typeof finalText !== 'string' || !finalText.length) {
    return (
      'You are ending your turn without having sent a well-formed report via SendMessage (no call ' +
      'with both a non-empty "to" and a non-empty "message" or "summary" found this turn). Call ' +
      `SendMessage now with your report. ${genericTail}`
    );
  }

  const truncated = finalText.length > MAX_EMBEDDED_REPORT_CHARS;
  const snippet = truncated ? finalText.slice(0, MAX_EMBEDDED_REPORT_CHARS) : finalText;
  const truncationNote = truncated
    ? `\n\n[...embedded copy truncated at ${MAX_EMBEDDED_REPORT_CHARS} of ${finalText.length} characters. ` +
      'Your full final message was longer than this excerpt — reproduce your COMPLETE final ' +
      'message from your own last turn, not just the text shown above.]'
    : '';
  const messageFieldNote = truncated
    ? 'The "message" field should be your complete final message (the excerpt above plus ' +
      'everything after it), reproduced verbatim — do not summarize or re-render any of it.'
    : 'The "message" field should be exactly the text above, reproduced verbatim — do not ' +
      'summarize or re-render it.';

  return (
    'Your final text was not delivered. Call SendMessage now with EXACTLY this content, ' +
    `verbatim:\n\n${snippet}${truncationNote}\n\n${messageFieldNote} ${genericTail}`
  );
}

function main() {
  const payload = readPayload();
  if (!payload) return allow();

  const rawTranscriptPath = payload.transcript_path;
  if (!rawTranscriptPath) return allow();

  const resolved = resolveTeammateContext(payload);
  if (!resolved) return allow(); // not a team-mailbox participant, or unresolvable — never gate

  const { transcriptPath } = resolved;
  const entries = readTranscriptEntries(transcriptPath);
  if (!entries || !entries.length) return allow();

  const statePath = statePathFor(transcriptPath);
  const state = readJsonSafe(statePath) || {};

  const boundary = lastUserBoundary(entries);
  const sentThisTurn = wellFormedSendMessageInRange(entries, boundary);
  if (sentThisTurn) return allow();

  // One-shot: block at most once per teammate transcript, so a genuinely
  // stuck agent is never trapped in an infinite block loop.
  if (state.reportBlockedOnce) return allow();
  const persisted = writeStateSafe(statePath, { ...state, reportBlockedOnce: true });
  if (!persisted) return allow(); // no durable marker -> fail open, never block

  const finalText = lastAssistantText(entries);
  const reason = buildStage1Reason(finalText);
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  return allow();
}

if (require.main === module) main();

module.exports = {
  metaPathFor,
  statePathFor,
  subagentSessionDir,
  listTeammateMetaCandidates,
  resolveTeammateContext,
  hasWellFormedSendMessage,
  wellFormedSendMessageInRange,
  lastUserBoundary,
  isToolResultOnlyEntry,
  lastAssistantText,
  buildStage1Reason,
  writeStateSafe,
  RECENCY_WINDOW_MS,
  MAX_EMBEDDED_REPORT_CHARS,
  AGENT_META_PATTERN,
};
