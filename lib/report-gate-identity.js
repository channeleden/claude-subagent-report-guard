'use strict';

/**
 * report-gate-identity.js — teammate identity resolution for a hook firing.
 *
 * This module covers only the identity-resolution logic that
 * `hooks/lane-dropbox-checkpoint.js` and `hooks/lane-dropbox-heartbeat.js`
 * need. A related but separate blocking `SubagentStop` gate, with its own
 * additional logic, lives in `legacy-gate/` — see its README for the
 * relationship between the two.
 *
 * `resolveTeammateContext(payload, { now })` resolves the REAL per-teammate
 * `{ transcriptPath, metaPath, meta, resolutionMethod }` for a hook firing
 * (`SubagentStop` or `PostToolUse`). Returns `null` when no team-mailbox
 * participant can be identified with reasonable confidence — callers MUST
 * treat `null` as "not a team-mailbox event" (allow / no-op, never block or
 * guess).
 *
 * Why this needs to exist at all: naively reading `payload.transcript_path`
 * and checking a sibling `.meta.json` file has been observed, live, to
 * silently resolve to the LEAD session's own top-level transcript for a
 * named background teammate, not the teammate's dedicated file — that
 * shape defeats the "obvious" direct-sibling lookup on its own. This
 * function tries three strategies in order, each strictly more permissive
 * (and less certain) than the last:
 *
 *   1. Direct sibling meta.json lookup — exact, tried first. If the direct
 *      sibling is readable and definitively is NOT a team-mailbox
 *      participant, that is treated as definitive negative evidence about
 *      THIS caller (never falls through to step 3's heuristic).
 *   2. An explicit agent-identity field on the payload itself
 *      (`agent_id` / `agentId` / `subagent_id` / `subagentId`), matched
 *      against every team-mailbox candidate under the session's
 *      `subagents/` directory.
 *   3. A bounded recency heuristic — the most recently touched
 *      team-mailbox candidate within `RECENCY_WINDOW_MS` (default 10
 *      minutes, overridable via `SUBAGENT_REPORT_GATE_RECENCY_WINDOW_MS`).
 *      Only reached when step 1 found no evidence at all about the caller
 *      (no sibling meta.json — the "transcript_path points at the lead's
 *      own file" case this whole function exists for).
 *
 * `resolutionMethod` on the returned object is one of `'direct-sibling'`,
 * `'payload-identity-field'`, or `'recency-heuristic'` — callers that treat
 * these three with different trust levels (e.g. `lane-dropbox-heartbeat.js`
 * re-verifies a `'recency-heuristic'` result against a much tighter bound
 * before trusting it for a high-frequency `PostToolUse` firing) rely on this
 * field being present and accurate.
 */

const fs = require('fs');
const path = require('path');

const {
  metaPathFor,
  subagentSessionDir,
  listTeammateMetaCandidates,
} = require('./subagent-transcript.js');

// Overridable for tests; widening/narrowing this outside a test harness has
// no legitimate real-world use.
const RECENCY_WINDOW_MS = Number(process.env.SUBAGENT_REPORT_GATE_RECENCY_WINDOW_MS) || 10 * 60 * 1000;

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function resolveTeammateContext(payload, { now = Date.now() } = {}) {
  const rawTranscriptPath = payload && payload.transcript_path;
  if (typeof rawTranscriptPath !== 'string' || !rawTranscriptPath) return null;

  // Step 1 — direct sibling (exact, not a heuristic, so always tried first).
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
  // sessionDir is only null when rawTranscriptPath itself is unusable for
  // derivation — nothing further to try either way.
  const candidates = sessionDir ? listTeammateMetaCandidates(path.join(sessionDir, 'subagents')) : [];

  // Step 2 — explicit agent-identity field on the payload, if present. This
  // MUST run before the directMeta-non-team short-circuit below: unconditionally
  // returning null the moment a direct sibling meta.json is read and
  // definitively isn't team-mailbox would also suppress this strictly-safer
  // explicit-identity match for ANY readable non-team sibling, including one
  // that happens to sit next to a different caller's own transcript.
  // Checking identity first means a payload that DOES carry a valid
  // agent_id/agentId can still resolve correctly even when directMeta is a
  // definitive non-match.
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

  // A sibling meta.json that was found AND successfully read, but does not
  // claim team-mailbox membership, is DEFINITIVE negative evidence about
  // THIS specific calling agent — e.g. a plain synchronous subagent whose
  // transcript_path correctly points at its own file. Reached here (after
  // step 2 above already had its chance to match an explicit identity
  // field), this must return null rather than fall through to step 3's
  // session-wide recency heuristic below: that heuristic exists only for
  // the case where we have NO direct evidence about the caller at all
  // (directMeta === null). Falling through to the blind recency heuristic
  // here would reintroduce cross-resolution exposure — an unrelated,
  // fresher team-mailbox candidate elsewhere in the same session getting
  // cross-resolved onto this non-team-mailbox caller.
  if (directMeta) return null;

  if (!candidates.length) return null;

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

module.exports = { resolveTeammateContext, RECENCY_WINDOW_MS };
