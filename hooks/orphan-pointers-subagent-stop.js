#!/usr/bin/env node
'use strict';

/**
 * hooks/orphan-pointers-subagent-stop.js — `SubagentStop` hook, the
 * orphaned-report pointer mechanism's write side. Records a small pointer
 * for EVERY finished subagent (team-mailbox or plain), never the report
 * body itself. See `lib/orphan-pointers.js` for the full mechanism and why
 * this never interferes with normal delivery.
 *
 * Must never block a plain subagent, and must fail open on any error.
 */

const fs = require('fs');
const path = require('path');
const {
  AGENT_TRANSCRIPT_PATTERN,
  metaPathFor,
  subagentSessionDir,
  lastAssistantText,
  readTranscriptEntries,
} = require('../lib/subagent-transcript.js');
const { resolveTeammateContext } = require('../lib/report-gate.js');
const { writePointer } = require('../lib/orphan-pointers.js');
const { isSafePathSegment } = require('../lib/path-safety.js');
const { readStdinSync } = require('../lib/read-stdin.js');

// See lib/read-stdin.js for why this is not a direct fs.readFileSync call —
// a naive single-shot stdin read is reliable on macOS but can throw EAGAIN
// on Linux, which this catch would otherwise silently mistake for "no
// payload" (a real Linux-CI-only failure mode, not theoretical).
function readPayload() {
  try {
    const raw = readStdinSync().trim();
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

// Resolves {transcriptPath, meta} for ANY finished subagent, team-mailbox or
// plain — broader than report-gate.js's resolveTeammateContext (which only
// resolves team-mailbox participants). Returns null when nothing usable can
// be derived at all (never guesses).
function resolveAnyAgentContext(payload) {
  const teammate = resolveTeammateContext(payload);
  if (teammate) return teammate;

  const rawTranscriptPath = payload && payload.transcript_path;
  if (typeof rawTranscriptPath !== 'string' || !rawTranscriptPath) return null;
  const metaPath = metaPathFor(rawTranscriptPath);
  const meta = metaPath && readJsonSafe(metaPath);
  if (!meta) return null; // no sibling meta at all — can't attribute this to a specific agent
  return { transcriptPath: rawTranscriptPath, metaPath, meta, resolutionMethod: 'plain-direct-sibling' };
}

// The harness's own agent id (leading `a`, "agent-" prefix stripped — e.g.
// `a3a2ad2af148bcfcb`), derived from the transcript filename. This is the
// EXACT string a background dispatch's `<task-id>` tag carries verbatim
// (verified against real transcripts — see lib/orphan-pointers.js's file
// header), so it must be preserved whole for `wasDelivered`'s task-id match
// to ever fire. Falls back to the bare filename (still a valid, unique-
// enough pointer storage key) for any transcript path that does not match
// the documented naming convention — never expected in practice, but this
// must never be the reason a pointer fails to write at all.
function harnessAgentId(transcriptPath) {
  const base = path.basename(transcriptPath);
  const m = AGENT_TRANSCRIPT_PATTERN.exec(base);
  if (m) return m[1];
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

function main() {
  try {
    const payload = readPayload();
    if (!payload) return process.exit(0);

    const resolved = resolveAnyAgentContext(payload);
    if (!resolved) return process.exit(0);

    const { transcriptPath, meta } = resolved;
    const sessionId = path.basename(subagentSessionDir(transcriptPath) || '');
    const agentId = harnessAgentId(transcriptPath);
    // Same safe-path-segment rule the lane drop-box uses — both ids are
    // derived from `transcript_path`, which is hook-payload-supplied and
    // therefore not to be trusted blindly for path interpolation. `writePointer`
    // itself validates too (defense in depth), but failing open here skips
    // even the transcript read that would otherwise follow. Never throws;
    // an unsafe id is a no-op, not an error.
    if (!isSafePathSegment(sessionId) || !isSafePathSegment(agentId)) return process.exit(0);

    const entries = readTranscriptEntries(transcriptPath);
    const summary = lastAssistantText(entries) || '';

    writePointer({
      sessionId,
      agentId,
      transcriptPath,
      agentName: (meta && meta.name) || null,
      toolUseId: (meta && meta.toolUseId) || null,
      parentSessionId: sessionId,
      finishedAt: new Date().toISOString(),
      summary,
    });
  } catch {
    /* fail open, unconditionally */
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { main, resolveAnyAgentContext, harnessAgentId };
