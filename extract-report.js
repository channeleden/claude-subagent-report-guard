#!/usr/bin/env node
'use strict';

/**
 * extract-report.js — deterministic, zero-model-involvement extraction of a
 * background teammate's abandoned final report text.
 *
 * WHY THIS EXISTS
 * ----------------
 * When a Claude Code background/team-mailbox teammate finishes its work but
 * ends its turn with plain text instead of calling `SendMessage`, that text
 * is not delivered to whoever dispatched it — only a content-free
 * `idle_notification` arrives. The standard recovery is to ping the idle
 * agent and ask it to send its report. That recovery is a fresh model
 * generation, not a resend: it can range from a trivial trim to a full
 * structural collapse (e.g. a Markdown table silently becoming a prose
 * numbered list), because there is no verbatim-replay primitive — the
 * agent has to compose a new `SendMessage` call from its own context, which
 * is subject to normal paraphrasing/reformatting tendencies.
 *
 * This script sidesteps that entirely: the "lost" report already exists,
 * verbatim, in the teammate's own transcript file on disk. This CLI reads
 * that file directly and prints the final assistant text block(s) exactly
 * as written — no model call, no regeneration, no drift risk.
 *
 * USAGE
 * -----
 *   node extract-report.js --session-dir <dir> [--agent <name>]
 *
 * `<dir>` is the session directory that directly contains a `subagents/`
 * child — i.e. `~/.claude/projects/<project>/<session-id>/`. If you only
 * have the top-level `<session-id>.jsonl` transcript path, strip its
 * `.jsonl` suffix to get this directory.
 *
 * Without `--agent`, the newest (by file mtime) matching teammate transcript
 * under `<dir>/subagents/` is used — the intended disambiguator when
 * several teammates were dispatched in the same session, since the one that
 * most recently finished writing is very likely the one you're trying to
 * recover. With `--agent <name>`, only that teammate's transcript is
 * considered.
 *
 * Exit codes: 0 = printed a report; 1 = bad usage; 2 = no matching
 * transcript found; 3 = a matching transcript exists but has no assistant
 * text block to extract.
 */

const fs = require('fs');
const path = require('path');

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function readTranscriptEntries(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
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

// Matches Claude Code's naming convention for a team-mailbox teammate's own
// transcript file: `agent-a<name>-<hash>.jsonl`. The literal `a` right
// after `agent-` is part of the harness's own naming scheme, not part of
// the dispatched agent's own name.
const AGENT_TRANSCRIPT_PATTERN = /^agent-a(.+)-([0-9a-f]+)\.jsonl$/;

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

// The final assistant turn's text content, verbatim. Scans from the tail of
// the transcript for the LAST assistant entry that carries at least one
// `type: 'text'` content block and returns those blocks' `.text` values
// joined exactly as authored. An assistant entry whose only content is
// `tool_use` (it ended mid tool-call) is skipped — the walk continues
// backward to the nearest real text block.
function lastAssistantText(entries) {
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

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--session-dir') out.sessionDir = argv[++i];
    else if (a === '--agent') out.agent = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function run(argv = process.argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
  if (!isNonEmptyString(args.sessionDir)) {
    stderr.write('usage: extract-report.js --session-dir <dir> [--agent <name>]\n');
    return 1;
  }

  const match = findNewestTranscript(args.sessionDir, args.agent);
  if (!match) {
    stderr.write(
      isNonEmptyString(args.agent)
        ? `no subagent transcript found for agent "${args.agent}" under ${args.sessionDir}/subagents\n`
        : `no subagent transcripts found under ${args.sessionDir}/subagents\n`,
    );
    return 2;
  }

  let entries;
  try {
    entries = readTranscriptEntries(match.path);
  } catch (err) {
    stderr.write(`cannot read transcript ${match.path}: ${err.message}\n`);
    return 2;
  }

  const text = lastAssistantText(entries);
  if (text === null) {
    stderr.write(`no assistant text block found in ${match.path}\n`);
    return 3;
  }

  stdout.write(`${text}\n`);
  return 0;
}

if (require.main === module) process.exitCode = run();

module.exports = {
  readTranscriptEntries,
  listAgentTranscripts,
  findNewestTranscript,
  lastAssistantText,
  parseArgs,
  run,
  AGENT_TRANSCRIPT_PATTERN,
};
