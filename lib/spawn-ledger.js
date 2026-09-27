'use strict';

/**
 * spawn-ledger.js — three-valued lead-vs-background spawn discrimination.
 *
 * See `lib/report-gate.js`'s header for how this fits into the report
 * gate's overall design, and `README.md`'s "Report gate — the details"
 * section for the current, accurate list of what the gate includes.
 *
 * WHY THIS EXISTS
 * ----------------
 * `taskKind === 'in_process_teammate'` (checked in `report-gate.js`'s
 * `resolveTeammateContext`) tells us a stopping agent IS a team-mailbox
 * participant, but says nothing about whether THIS PARTICULAR dispatch was
 * background or an explicit, deliberately synchronous one. A synchronous
 * dispatch's plain return value IS delivered to its parent through the
 * ordinary tool_result channel — gating it on `SendMessage` would be a false
 * block. `classifyBackgroundSpawn` answers that narrower question by
 * correlating the stopping agent back to the parent's own `Agent` tool_use
 * call and reading that call's `run_in_background` input.
 *
 * THREE-VALUED, NOT BOOLEAN — the load-bearing design decision here:
 *   - `confirmed`    — the correlating spawn carries an explicit
 *                       `run_in_background: true`.
 *   - `contradicted` — the correlating spawn carries an explicit
 *                       `run_in_background: false` (a deliberately
 *                       synchronous dispatch). This is the ONLY verdict that
 *                       suppresses gating on its own.
 *   - `unknown`      — no parent transcript, no correlating record, or the
 *                       flag is simply ABSENT. Falls back to the `taskKind`
 *                       evidence the caller already established; never
 *                       treated as a reason to allow on its own.
 *
 * That third case is the one a naive boolean read gets wrong: an ABSENT
 * `run_in_background` key is the harness's own DEFAULT dispatch shape, and
 * the documented default is background — so absence must never be read as
 * "not background" (that would silently turn this into an allow-everything
 * no-op for the exact case this module exists to gate). Only an EXPLICIT
 * `false` is treated as a genuine contradiction.
 *
 * `findBackgroundAgentSpawn` locates the parent `Agent` tool_use by the most
 * exact key available, in order: the child sidecar's own `toolUseId` (exact
 * and stable even when a teammate name is reused across dispatches); the
 * native agent id echoed back in the spawn's own tool_result text, then
 * that result's `tool_use_id`; a UNIQUE teammate name for a sidecar
 * predating `toolUseId` — a REPEATED name is ambiguous and deliberately
 * yields no match rather than attaching this stop to the wrong lane.
 */

const { transcriptPathForAgentId, readTranscriptEntries } = require('./subagent-transcript.js');

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function assistantToolUses(entry) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool_use');
}

function toolResultText(block) {
  if (!block || block.type !== 'tool_result') return '';
  const content = Array.isArray(block.content) ? block.content : [block.content];
  return content.map((item) => (item && typeof item.text === 'string' ? item.text : '')).join('\n');
}

// The parent's `Agent` tool_use with this exact id, whatever its
// `run_in_background` value — the caller decides what a non-background
// spawn means (see `classifyBackgroundSpawn`).
function agentSpawnForToolUseId(entries, toolUseId) {
  const id = nonEmptyString(toolUseId);
  if (!id || !Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!entry || entry.type !== 'assistant') continue;
    for (const block of assistantToolUses(entry)) {
      if (block.id === id && block.name === 'Agent') return block;
    }
  }
  return null;
}

// See the file header for the three-step resolution order.
function findBackgroundAgentSpawn(entries, { agentId, toolUseId, name } = {}) {
  const nativeAgentId = nonEmptyString(agentId);
  const id = nonEmptyString(toolUseId);
  const agentName = nonEmptyString(name);
  if ((!nativeAgentId && !id && !agentName) || !Array.isArray(entries)) return null;

  const toolUseMatch = agentSpawnForToolUseId(entries, id);
  if (toolUseMatch) return toolUseMatch;

  if (nativeAgentId) {
    const escaped = nativeAgentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const agentIdPattern = new RegExp(`(?:agent_id|agentId):\\s*${escaped}(?:\\s|$)`);
    for (const entry of entries) {
      if (!entry || entry.type !== 'user') continue;
      const blocks = entry.message && entry.message.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (!agentIdPattern.test(toolResultText(block))) continue;
        const resultMatch = agentSpawnForToolUseId(entries, block.tool_use_id);
        if (resultMatch) return resultMatch;
      }
    }
  }

  if (!agentName || id) return null;
  let uniqueNameMatch = null;
  for (const entry of entries) {
    if (!entry || entry.type !== 'assistant') continue;
    for (const block of assistantToolUses(entry)) {
      if (block.name !== 'Agent' || !block.input || block.input.name !== agentName) continue;
      if (uniqueNameMatch) return null; // ambiguous name — refuse rather than guess
      uniqueNameMatch = block;
    }
  }
  return uniqueNameMatch;
}

// See the file header for the three verdicts. `agentId` is the resolved
// teammate's own identity field (from `resolveTeammateContext`, may be
// null); `subagentsDir` is the directory containing this teammate's own
// transcript, used to derive a parent-at-depth transcript path from
// `meta.parentAgentId` when present.
function classifyBackgroundSpawn(payload, meta, { agentId, subagentsDir } = {}) {
  // Which transcript actually records this agent's spawn depends on its
  // DEPTH: `payload.transcript_path` is the root session transcript, which
  // is the right place to look only for a depth-0 agent. A nested agent was
  // spawned by its immediate parent, so its `Agent` tool_use lives in THAT
  // parent's transcript — searching only the root would silently degrade to
  // `unknown` for every nested agent. The sidecar records `parentAgentId`
  // when this agent was itself spawned by another teammate rather than the
  // lead, so the immediate parent is tried first and the root kept as a
  // fallback.
  const candidates = [];
  const parentAgentId = nonEmptyString(meta && meta.parentAgentId);
  if (parentAgentId && nonEmptyString(subagentsDir)) {
    const p = transcriptPathForAgentId(subagentsDir, parentAgentId);
    if (p) candidates.push(p);
  }
  const rootTranscriptPath = nonEmptyString(payload && payload.transcript_path);
  if (rootTranscriptPath) candidates.push(rootTranscriptPath);
  if (!candidates.length) return { verdict: 'unknown', reason: 'no-parent-transcript-path' };

  let sawReadableParent = false;
  let spawn = null;
  for (const candidate of candidates) {
    const entries = readTranscriptEntries(candidate);
    if (!Array.isArray(entries) || !entries.length) continue;
    sawReadableParent = true;
    spawn = findBackgroundAgentSpawn(entries, {
      agentId,
      toolUseId: meta && meta.toolUseId,
      name: meta && meta.name,
    });
    if (spawn) break;
  }
  if (!sawReadableParent) return { verdict: 'unknown', reason: 'parent-transcript-unreadable' };
  if (!spawn) return { verdict: 'unknown', reason: 'no-correlating-spawn' };

  const flag = spawn.input && spawn.input.run_in_background;
  if (flag === true) return { verdict: 'confirmed', reason: 'background-spawn-correlated' };
  // ABSENT is not a contradiction — see the file header. Only an EXPLICIT
  // `false` genuinely contradicts background-ness.
  if (flag === false) return { verdict: 'contradicted', reason: 'spawn-explicitly-foreground' };
  return { verdict: 'unknown', reason: 'spawn-background-flag-absent' };
}

module.exports = {
  assistantToolUses,
  toolResultText,
  agentSpawnForToolUseId,
  findBackgroundAgentSpawn,
  classifyBackgroundSpawn,
};
