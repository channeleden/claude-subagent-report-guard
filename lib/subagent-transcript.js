'use strict';

/**
 * subagent-transcript.js — stateless, offset-resumable core for reading a
 * Claude Code background/team-mailbox teammate's own transcript files.
 *
 * Part of the lane drop-box mechanism in this repo (see ../README.md).
 *
 * DUAL-USE INTENT (read before changing the shape of anything here)
 * -------------------------------------------------------------------
 * This module is deliberately factored out as a plain, stateless library
 * (no module-level mutable state, no side effects beyond reading files it's
 * given a path to) so it can serve multiple independent consumers:
 *
 *   1. `report-gate-identity.js` (this repo's identity-resolution helper) —
 *      resolves which real per-agent transcript a hook firing corresponds
 *      to, and extracts that agent's final text.
 *   2. A CLI/orchestrator wrapper — for humans/orchestrators recovering an
 *      abandoned report from disk (see `legacy-gate/extract-report.js` for
 *      one such wrapper).
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
 * See `report-gate-identity.js`'s own header for the `transcript_path`
 * identity-mismatch caveat this module's `subagentSessionDir` /
 * `listTeammateMetaCandidates` exist to work around — that caveat is a
 * hook-payload concern, not a transcript-reading concern, so it stays out
 * of this module; this module only knows how to find and read transcript
 * files once a session directory is already known.
 */

const fs = require('fs');
const path = require('path');

// Matches Claude Code's live-verified naming convention for a team-mailbox
// teammate's own transcript file: `agent-a<name>-<hash>.jsonl`. The literal
// `a` right after `agent-` is part of the harness's own naming scheme, not
// part of the dispatched agent's own name — captured separately so it's
// never mistaken for the first character of the name.
const AGENT_TRANSCRIPT_PATTERN = /^agent-a(.+)-([0-9a-f]+)\.jsonl$/;
const AGENT_META_PATTERN = /^agent-a(.+)-([0-9a-f]+)\.meta\.json$/;

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
    const m = AGENT_META_PATTERN.exec(name);
    if (!m) continue;
    const metaPath = path.join(subagentsDir, name);
    const meta = readJsonSafe(metaPath);
    if (!meta || meta.taskKind !== 'in_process_teammate') continue;
    const transcriptPath = `${metaPath.slice(0, -'.meta.json'.length)}.jsonl`;
    candidates.push({ agentId: `${m[1]}-${m[2]}`, agentName: m[1], hash: m[2], metaPath, transcriptPath, meta });
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
    const m = AGENT_TRANSCRIPT_PATTERN.exec(name);
    if (!m) continue;
    const fullPath = path.join(subagentsDir, name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }
    found.push({ file: name, path: fullPath, agentName: m[1], hash: m[2], mtimeMs });
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
// fine for a single extraction, but a POLLING consumer (see the file
// header's "DUAL-USE INTENT" note) needs to resume from exactly where it
// left off without re-parsing everything on every poll. Two correctness
// properties this function guarantees:
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

module.exports = {
  AGENT_TRANSCRIPT_PATTERN,
  AGENT_META_PATTERN,
  metaPathFor,
  subagentSessionDir,
  listTeammateMetaCandidates,
  listAgentTranscripts,
  findNewestTranscript,
  readTranscriptFromOffset,
  readTranscriptEntries,
  assistantTextBlocks,
  lastAssistantText,
};
