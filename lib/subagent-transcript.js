'use strict';

/**
 * subagent-transcript.js — stateless, offset-resumable core for reading a
 * Claude Code background/team-mailbox teammate's own transcript files.
 *
 * Part of the lane drop-box + report-gate mechanisms in this repo (see
 * ../README.md).
 *
 * DUAL-USE INTENT (read before changing the shape of anything here)
 * -------------------------------------------------------------------
 * This module is deliberately factored out as a plain, stateless library
 * (no module-level mutable state, no side effects beyond reading files it's
 * given a path to) so it can serve multiple independent consumers:
 *
 *   1. `lib/report-gate.js` (the `SubagentStop` delivery-gate) — resolves
 *      which real per-agent transcript a stop event corresponds to, and
 *      extracts that agent's final text to embed verbatim in a block reason.
 *   2. `hooks/lane-dropbox-checkpoint.js` / `hooks/lane-dropbox-heartbeat.js`
 *      — the same identity resolution, for a non-blocking durable record
 *      instead of a block decision.
 *   3. Any future polling consumer of a live transcript: a dispatched
 *      teammate's transcript file on disk always exists and is always
 *      current — this module's `readTranscriptFromOffset` is written
 *      specifically so a polling consumer can resume reading a
 *      still-growing transcript from exactly where it left off (a byte
 *      offset) rather than re-parsing the whole file on every poll. Nothing
 *      in this module assumes a one-shot "read once and exit" caller —
 *      every function is safe to call repeatedly against a file that is
 *      still being appended to by a live agent.
 *
 * `subagentSessionDir` / `listTeammateMetaCandidates` exist to work around a
 * live-observed `transcript_path` identity mismatch (see `lib/report-gate.js`
 * for the full caveat) — that is a hook-payload concern, not a
 * transcript-reading concern, so it stays out of this module; this module
 * only knows how to find and read transcript files once a session directory
 * is already known.
 */

const fs = require('fs');
const path = require('path');

// Matches Claude Code's live-verified naming convention for a team-mailbox
// teammate's own transcript file. Two live shapes exist, both captured by
// this single pattern as one whole id (group 1, always `a`-prefixed): a
// named lane is `agent-a<name>-<hash>.jsonl`; an unnamed lane is
// `agent-a<hash>.jsonl` with no separator. The leading `a` is NOT a
// harness-only decoration to be stripped before use — it is part of the
// harness's own agent id, and a SubagentStop hook payload's `agent_id`
// carries that id verbatim, `a` included. Any candidate this module hands
// back for identity matching (`agentId` below) must therefore preserve the
// id whole, letter for letter, or an exact-match lookup against
// `payload.agent_id` can never fire. The human-facing name still excludes
// the `a` — see `agentName` — but that is a display convenience derived
// from the id, not the id itself.
const AGENT_TRANSCRIPT_PATTERN = /^agent-(a.+)\.jsonl$/;
const AGENT_META_PATTERN = /^agent-(a.+)\.meta\.json$/;

// Splits the portion of an agent id AFTER the leading `a` into a
// human-facing `agentName` + `hash`, for the named-lane shape
// `<name>-<hash>` where `hash` is a trailing run of lowercase hex. Greedy
// backtracking on `(.+)-` means the match always lands on the RIGHTMOST
// hyphen whose suffix is valid hex, so a name that itself contains a
// hex-looking segment still splits at the true trailing hash rather than
// the first hex-looking run. An unnamed lane's body is pure hex with no
// hyphen at all, so it never matches this pattern — both fields come back
// null, which is correct: there is no name to report.
const AGENT_ID_BODY_PATTERN = /^(.+)-([0-9a-f]+)$/;

function decomposeAgentIdBody(body) {
  const m = AGENT_ID_BODY_PATTERN.exec(body);
  if (!m) return { agentName: null, hash: null };
  return { agentName: m[1], hash: m[2] };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function metaPathFor(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null;
  return `${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`;
}

// Pure path derivation for the exact-match resolution path: given a full
// harness agent id (leading `a` included, as carried verbatim by the
// SubagentStop payload's `agent_id`), returns the deterministic transcript
// path `<subagentsDir>/agent-<agentId>.jsonl` a caller can go read directly
// once it already knows the id — no directory listing, no filesystem
// access here at all. Returns null for anything that isn't a plausible id
// (missing, empty, or not `a`-prefixed) rather than building a path that
// could never correspond to a real file.
function transcriptPathForAgentId(subagentsDir, agentId) {
  if (typeof subagentsDir !== 'string' || !subagentsDir) return null;
  if (typeof agentId !== 'string' || agentId.length < 2 || agentId[0] !== 'a') return null;
  // A separator in the id would let `path.join` normalize its way OUT of
  // subagentsDir (`a../../..` escapes upward); a real harness id never
  // contains a separator, so rejecting one costs nothing and keeps this
  // helper's output provably inside the directory it was handed.
  if (agentId.includes('/') || agentId.includes('\\') || agentId.includes('\0')) return null;
  return path.join(subagentsDir, `agent-${agentId}.jsonl`);
}

// Derives the session directory (the one that directly contains a
// `subagents/` child) from a transcript path — works whether that path is a
// lead session's own top-level transcript, or already points inside
// `subagents/` itself.
function subagentSessionDir(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const base = transcriptPath.endsWith('.jsonl')
    ? transcriptPath.slice(0, -'.jsonl'.length)
    : transcriptPath;
  const marker = `${path.sep}subagents${path.sep}`;
  const idx = base.lastIndexOf(marker);
  return idx === -1 ? base : base.slice(0, idx);
}

// Every team-mailbox candidate under a session's `subagents/` dir, parsed
// and paired with its derived transcript path. Never throws; an unreadable
// dir or malformed meta file just yields fewer (or zero) candidates.
function listTeammateMetaCandidates(subagentsDir) {
  let names;
  try {
    names = fs.readdirSync(subagentsDir);
  } catch {
    return [];
  }
  const candidates = [];
  for (const name of names) {
    if (!AGENT_META_PATTERN.test(name)) continue;
    const metaPath = path.join(subagentsDir, name);
    const meta = readJsonSafe(metaPath);
    if (!meta || meta.taskKind !== 'in_process_teammate') continue;
    // Sliced from the filename itself (not reassembled from regex capture
    // groups) so the full harness agent id — leading `a` included — is
    // preserved whole for exact matching against `payload.agent_id`.
    const agentId = name.slice('agent-'.length, -'.meta.json'.length);
    const { agentName, hash } = decomposeAgentIdBody(agentId.slice(1));
    const transcriptPath = `${metaPath.slice(0, -'.meta.json'.length)}.jsonl`;
    candidates.push({ agentId, agentName, hash, metaPath, transcriptPath, meta });
  }
  return candidates;
}

// Every `.jsonl` transcript under a session's `subagents/` dir, regardless
// of taskKind (a plain synchronous Task-tool subagent's transcript is
// listed too — callers that only want team-mailbox participants should use
// `listTeammateMetaCandidates` instead). Includes each file's mtime, since
// "most recently active" is this module's standard disambiguator when a
// caller has no more specific identity signal.
function listAgentTranscripts(subagentsDir) {
  let names;
  try {
    names = fs.readdirSync(subagentsDir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!AGENT_TRANSCRIPT_PATTERN.test(name)) continue;
    const fullPath = path.join(subagentsDir, name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }
    const agentId = name.slice('agent-'.length, -'.jsonl'.length);
    const { agentName, hash } = decomposeAgentIdBody(agentId.slice(1));
    found.push({ file: name, path: fullPath, agentId, agentName, hash, mtimeMs });
  }
  return found;
}

// The newest matching transcript by mtime, optionally filtered to one agent
// by name. "Newest" is the intended disambiguator when several teammates
// are in flight under the same session and no more specific identity signal
// is available.
function findNewestTranscript(sessionDir, agentName) {
  const subagentsDir = path.join(sessionDir, 'subagents');
  let candidates = listAgentTranscripts(subagentsDir);
  if (isNonEmptyString(agentName)) {
    candidates = candidates.filter((c) => c.agentName === agentName);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0];
}

// Reads a transcript starting at `byteOffset`, returning only fully-written
// JSONL lines plus the byte offset to resume from on the next call.
//
// Why this exists (offset-resumability, not just "read the whole file"): a
// team-mailbox teammate's transcript is actively appended to while its
// session is live. A one-shot "read the whole file every time" caller is
// fine for a single extraction, but a POLLING consumer needs to resume from
// exactly where it left off without re-parsing everything on every poll.
// Two correctness properties this function guarantees:
//
//   1. A partial trailing line (the file is mid-write on its last line) is
//      NEVER parsed or counted as consumed — `nextOffset` only advances past
//      the last COMPLETE line (terminated by `\n`), so a caller that polls
//      again after that partial line finishes will see it whole, exactly
//      once, on a later call.
//   2. If `byteOffset` is past the current file size (the file was
//      truncated or rotated since the caller's last read — not expected for
//      an append-only transcript, but cheap to guard), this resets to 0
//      rather than throwing or returning nothing forever.
//
// Returns `{ entries, nextOffset, eof }` — `eof` is true when there was no
// complete trailing line left unconsumed at the moment of this read (the
// caller has "caught up" as of this call; more may still arrive later).
function readTranscriptFromOffset(transcriptPath, byteOffset = 0) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return { entries: [], nextOffset: byteOffset, eof: true };
  }
  let offset = Number.isInteger(byteOffset) && byteOffset >= 0 ? byteOffset : 0;
  if (offset > stat.size) offset = 0; // file rotated/truncated since last read

  const length = stat.size - offset;
  if (length <= 0) return { entries: [], nextOffset: offset, eof: true };

  let raw;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch {
    return { entries: [], nextOffset: offset, eof: true };
  }

  const lastNewline = raw.lastIndexOf('\n');
  const completeChunk = lastNewline === -1 ? '' : raw.slice(0, lastNewline + 1);
  const consumedBytes = Buffer.byteLength(completeChunk, 'utf8');

  const entries = [];
  for (const line of completeChunk.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }

  return { entries, nextOffset: offset + consumedBytes, eof: consumedBytes === length };
}

// Convenience wrapper for the common one-shot "read the whole file" case
// (used by both the hook and the CLI, neither of which needs incremental
// resumption). Equivalent to `readTranscriptFromOffset(path, 0).entries`.
function readTranscriptEntries(transcriptPath) {
  return readTranscriptFromOffset(transcriptPath, 0).entries;
}

function assistantTextBlocks(entry) {
  if (!entry || entry.type !== 'assistant') return [];
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length)
    .map((b) => b.text);
}

// The final assistant turn's text content, verbatim. Scans from the tail of
// `entries` for the LAST assistant entry that carries at least one
// `type: 'text'` content block and returns those blocks' text joined
// exactly as authored (a blank-line separator between multiple blocks in
// one entry, no other reformatting). An assistant entry whose only content
// is `tool_use` (it ended mid tool-call) is skipped — the walk continues
// backward to the nearest real text block. Returns null when no assistant
// text block exists anywhere in `entries`.
function lastAssistantText(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const blocks = assistantTextBlocks(entries[i]);
    if (blocks.length) return blocks.join('\n\n');
  }
  return null;
}

// A `type: 'user'` transcript entry is not always an inbound message —
// every tool call's result is ALSO recorded as a `type: 'user'` entry
// (`content: [{ type: 'tool_result', ... }]`), and the harness also injects
// synthetic `type: 'user'` entries marked `isMeta: true` (a Skill-tool load,
// a system reminder, or — for a hook that embeds its own block reason back
// into the transcript — that very reason text on the agent's next turn).
// Neither is a genuine new inbound turn boundary; treating either as one
// lets a hook's own prior feedback (or a tool echo) become a self-amplifying
// "new" boundary. Shared by any caller that needs to find the last REAL
// inbound boundary in a transcript.
function isNonActionableUserEntry(entry) {
  if (!entry) return false;
  if (entry.isMeta === true) return true;
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((b) => b && b.type === 'tool_result');
}

module.exports = {
  AGENT_TRANSCRIPT_PATTERN,
  AGENT_META_PATTERN,
  metaPathFor,
  transcriptPathForAgentId,
  subagentSessionDir,
  listTeammateMetaCandidates,
  listAgentTranscripts,
  findNewestTranscript,
  readTranscriptFromOffset,
  readTranscriptEntries,
  assistantTextBlocks,
  lastAssistantText,
  isNonActionableUserEntry,
};
