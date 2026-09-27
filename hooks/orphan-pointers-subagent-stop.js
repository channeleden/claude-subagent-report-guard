#!/usr/bin/env node
'use strict';

/**
 * hooks/orphan-pointers-subagent-stop.js — `SubagentStop` hook, the
 * orphaned-report pointer mechanism's write side. Records a small pointer
 * for EVERY finished subagent (team-mailbox or plain), never the report
 * body itself. See `lib/orphan-pointers.js` for the full mechanism and why
 * this never interferes with normal delivery.
 *
 * REAL PAYLOAD SHAPE (verified live, Claude Code 2.1.283) — read before
 * touching identity resolution again:
 *   `transcript_path` is ALWAYS the top-level SESSION transcript
 *   (`<proj>/<session>.jsonl`), NEVER the stopping agent's own file — for a
 *   plain (non-team-mailbox) subagent just as much as for a team-mailbox
 *   one. A direct-sibling `.meta.json` lookup against `transcript_path`
 *   therefore never finds anything for a plain subagent: no meta.json ever
 *   sits next to the SESSION transcript. This was this hook's original
 *   bug — it silently wrote zero pointers for every plain background
 *   subagent, the exact case this whole mechanism exists to catch.
 *
 *   The stopping agent's REAL transcript is instead named directly by
 *   `agent_transcript_path` (`<proj>/<session>/subagents/agent-<agent_id>.jsonl`)
 *   when the harness supplies it, or derivable from `agent_id` joined with
 *   the session's `subagents/` dir otherwise. `session_id` is the top-level
 *   session id and is used as-is — never re-derived from a transcript path
 *   when the payload already states it. `last_assistant_message` (≤200
 *   chars, matches the pointer's own summary cap) is used directly for the
 *   pointer's summary when present, so this hook needs no transcript read
 *   at all in the common case; a transcript read is only a fallback for an
 *   older/leaner payload shape that omits it.
 *
 * Must never block a plain subagent, and must fail open on any error.
 */

const fs = require('fs');
const path = require('path');
const {
  AGENT_TRANSCRIPT_PATTERN,
  metaPathFor,
  transcriptPathForAgentId,
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

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

// Resolves {transcriptPath, meta, resolutionMethod} for ANY finished
// subagent, team-mailbox or plain — broader than report-gate.js's
// resolveTeammateContext (which only resolves team-mailbox participants).
// Returns null when nothing usable can be derived at all (never guesses).
//
// Order (see the file header for why `payload.transcript_path` is never
// trusted as a direct-sibling lookup target on its own for a plain agent):
//   1. Team-mailbox resolution (unchanged — already correctly checks
//      `agent_transcript_path` first, internally, via lib/report-gate.js).
//   2. `payload.agent_transcript_path`, validated against the documented
//      `agent-<id>.jsonl` naming pattern before use.
//   3. `payload.agent_id` joined with `<session dir>/subagents/`, where the
//      session dir is derived from `payload.transcript_path` (safe for
//      THIS derivation even though it points at the session file, not the
//      agent's own — that is exactly what `subagentSessionDir` is for).
//   4. Legacy fallback: a direct sibling of `payload.transcript_path`, kept
//      for back-compat with any older/nonstandard payload shape that DOES
//      point `transcript_path` straight at the agent's own file.
function resolveAnyAgentContext(payload) {
  const teammate = resolveTeammateContext(payload);
  if (teammate) return teammate;

  // Step 2 — the harness naming the stopping agent's own transcript
  // outright.
  const ownTranscriptPath = nonEmptyString(payload && payload.agent_transcript_path);
  if (ownTranscriptPath && AGENT_TRANSCRIPT_PATTERN.test(path.basename(ownTranscriptPath))) {
    const ownMetaPath = metaPathFor(ownTranscriptPath);
    const ownMeta = ownMetaPath && readJsonSafe(ownMetaPath);
    if (ownMeta) {
      return {
        transcriptPath: ownTranscriptPath,
        metaPath: ownMetaPath,
        meta: ownMeta,
        resolutionMethod: 'agent-transcript-path',
      };
    }
  }

  // Step 3 — payload.agent_id + the session's subagents/ dir, derived from
  // payload.transcript_path (always the session transcript on a real
  // payload, per the file header).
  const agentId = nonEmptyString(payload && payload.agent_id);
  const rawTranscriptPath = payload && payload.transcript_path;
  if (agentId && typeof rawTranscriptPath === 'string' && rawTranscriptPath) {
    const sessionDir = subagentSessionDir(rawTranscriptPath);
    const derivedPath = sessionDir && transcriptPathForAgentId(path.join(sessionDir, 'subagents'), agentId);
    const derivedMetaPath = derivedPath && metaPathFor(derivedPath);
    const derivedMeta = derivedMetaPath && readJsonSafe(derivedMetaPath);
    if (derivedMeta) {
      return {
        transcriptPath: derivedPath,
        metaPath: derivedMetaPath,
        meta: derivedMeta,
        resolutionMethod: 'agent-id-derived-path',
      };
    }
  }

  // Step 4 — legacy fallback: a direct sibling of transcript_path itself.
  // Never expected against a real payload (see file header), kept only for
  // back-compat with any nonstandard/older shape that points transcript_path
  // straight at the agent's own file.
  if (typeof rawTranscriptPath === 'string' && rawTranscriptPath) {
    const metaPath = metaPathFor(rawTranscriptPath);
    const meta = metaPath && readJsonSafe(metaPath);
    if (meta) return { transcriptPath: rawTranscriptPath, metaPath, meta, resolutionMethod: 'plain-direct-sibling' };
  }

  return null; // no sibling meta at all — can't attribute this to a specific agent
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

    // Prefer the harness-supplied top-level session id outright — no need
    // to re-derive it from a transcript path when the payload already
    // states it. Falls back to the old derivation (from the RESOLVED
    // agent transcript's own session dir) for any payload shape that omits
    // `session_id`.
    const payloadSessionId = nonEmptyString(payload.session_id);
    const sessionId = payloadSessionId || path.basename(subagentSessionDir(transcriptPath) || '');
    const agentId = harnessAgentId(transcriptPath);
    // Same safe-path-segment rule the lane drop-box uses — both ids are
    // derived from hook-payload-supplied fields and therefore not to be
    // trusted blindly for path interpolation. `writePointer` itself
    // validates too (defense in depth), but failing open here skips even
    // the transcript read that would otherwise follow. Never throws; an
    // unsafe id is a no-op, not an error.
    if (!isSafePathSegment(sessionId) || !isSafePathSegment(agentId)) return process.exit(0);

    // `last_assistant_message` is supplied directly on the real payload —
    // when present, this hook needs no transcript read at all. Falls back
    // to reading the agent's own transcript only when the payload omits it
    // (an older/leaner harness build).
    const payloadSummary = nonEmptyString(payload.last_assistant_message);
    const summary = payloadSummary || (() => {
      const entries = readTranscriptEntries(transcriptPath);
      return lastAssistantText(entries) || '';
    })();

    // A NESTED agent's meta sidecar (spawnDepth 2+) carries `parentAgentId`
    // — the agent that dispatched it, itself a subagent rather than the
    // top-level session. Stored on the pointer so delivery / parent-gone
    // checks can target the parent AGENT's own transcript instead of the
    // top-level session transcript (see lib/orphan-pointers.js).
    const parentAgentId = nonEmptyString(meta && meta.parentAgentId);

    writePointer({
      sessionId,
      agentId,
      transcriptPath,
      agentName: (meta && meta.name) || null,
      toolUseId: (meta && meta.toolUseId) || null,
      parentSessionId: sessionId,
      parentAgentId,
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
