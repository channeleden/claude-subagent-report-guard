#!/usr/bin/env node
'use strict';

/**
 * hygiene-check.js — deterministic, zero-dependency scan for anything that
 * should never ship in this PUBLIC repo: absolute user paths, private
 * vocabulary, internal task ids, emails, secret-shaped strings, OS junk
 * files.
 *
 * Modes:
 *   node scripts/hygiene-check.js            — scans tracked working-tree
 *                                               files (git ls-files)
 *   node scripts/hygiene-check.js --history   — scans every blob in every
 *                                               revision (git rev-list --all
 *                                               + git log -p / git grep);
 *                                               reports findings with
 *                                               commit SHA + path, never
 *                                               modifies history
 *
 * Exit code 1 with one finding per line (`file:line: rule: snippet`) if
 * anything is found in default mode; 0 otherwise. `--history` always exits
 * 0 (it's a report, not a gate — rewriting public git history is out of
 * scope for this script) but still prints every finding.
 *
 * PRIVATE VOCABULARY, HASHED. The private-vocabulary rule never embeds the
 * actual private terms in this file's source (or in any tracked file) —
 * doing that would just move the leak from "shipped in the tree" to
 * "shipped in the denylist that scans the tree". Instead:
 *   1. Scanned text is lowercased and tokenized into words matching
 *      `[a-z0-9]+(?:[-_][a-z0-9]+)*`.
 *   2. 2-word and 3-word phrases are formed from consecutive words, joined
 *      by a single space.
 *   3. Every token and phrase is SHA-256 hashed and checked against
 *      `scripts/hygiene-denylist.sha256` (one lowercase hex hash per line,
 *      `#` comments allowed) — override the path with `--denylist=<path>`
 *      or `SUBAGENT_REPORT_GUARD_HYGIENE_DENYLIST` (tests use this to point
 *      at a scratch file of neutral fake terms).
 * A match is reported as `private-vocabulary (hashed)` with the file/line
 * and that rule name — never the matched term or its snippet, since that
 * would defeat the entire point of hashing the list.
 *
 * A per-line escape `hygiene-allow: <rule>` (anywhere in the line, as a
 * comment or otherwise) skips every rule for that one line — used only
 * when a false positive is truly unavoidable; `main()` reports every use
 * so it stays visible rather than silently accumulating.
 *
 * NO WHOLE-FILE EXEMPTION, ANYWHERE, EVER — including for this file and its
 * own test file. A blanket "this file is exempt" allowlist is exactly the
 * kind of gap a real leak could hide behind (a leak landing in either file
 * would simply go unscanned), and it does not even hold historically: this
 * file's OWN prior revisions genuinely embedded the private vocabulary
 * literally before being hashed into a denylist (see git history) — an
 * exemption keyed on file path, not content, would have hidden that
 * forever in `--history` mode. This file's doc comments describe rule
 * names (e.g. "private-vocabulary (hashed)") without containing any
 * denylisted term or other trigger shape, so it needs no escape at all; its
 * test file's necessarily-literal trigger EXAMPLES are instead either (a)
 * assembled from fragments at runtime, so no complete trigger string lives
 * in the source, or (b) marked with a per-line `hygiene-allow: <rule>` when
 * a fragment split would be more confusing than helpful.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The repo to scan is always the current working directory — this makes
// the script trivially testable against a scratch fixture repo (see
// test/hygiene-check.test.js) as well as usable from any real checkout.
const REPO_ROOT = process.cwd();

const WORD_PATTERN = /[a-z0-9]+(?:[-_][a-z0-9]+)*/g;
const HASH_LINE_PATTERN = /^[0-9a-f]{64}$/;
const HYGIENE_ALLOW_PATTERN = /hygiene-allow:\s*([a-z0-9-]+(?:\s*\(hashed\))?)/i;

function defaultDenylistPath() {
  return path.join(__dirname, 'hygiene-denylist.sha256');
}

function resolveDenylistPath(argv) {
  const flag = argv.find((a) => a.startsWith('--denylist='));
  if (flag) return path.resolve(REPO_ROOT, flag.slice('--denylist='.length));
  if (process.env.SUBAGENT_REPORT_GUARD_HYGIENE_DENYLIST) {
    return path.resolve(REPO_ROOT, process.env.SUBAGENT_REPORT_GUARD_HYGIENE_DENYLIST);
  }
  return defaultDenylistPath();
}

function loadDenylistHashes(denylistPath) {
  let raw;
  try {
    raw = fs.readFileSync(denylistPath, 'utf8');
  } catch {
    return new Set(); // missing denylist is a config problem, not a reason to crash the scan
  }
  const hashes = new Set();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (HASH_LINE_PATTERN.test(trimmed)) hashes.add(trimmed);
  }
  return hashes;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Returns the set of denylisted hashes this line matches, or an empty set.
function privateVocabularyHashesInLine(line, denylistHashes) {
  if (!denylistHashes.size) return [];
  const lower = line.toLowerCase();
  const words = lower.match(WORD_PATTERN) || [];
  const candidates = new Set(words);
  for (let i = 0; i < words.length - 1; i += 1) {
    candidates.add(`${words[i]} ${words[i + 1]}`);
    if (i < words.length - 2) candidates.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  const hits = [];
  for (const candidate of candidates) {
    if (denylistHashes.has(sha256(candidate))) hits.push(candidate);
  }
  return hits;
}

const RULES = [
  {
    name: 'absolute-user-path',
    pattern: /\/Users\/[^/'"`<> \n]+|\/home\/[^/'"`<> \n]+|C:\\\\Users\\\\[^\\'"`<> \n]+/,
    describe: 'absolute user home path',
  },
  {
    name: 'internal-task-id',
    pattern: /\b(?:as|ev|strat)-\d+\b/,
    describe: 'internal task id',
  },
  {
    name: 'email-address',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    describe: 'email address',
    allow: (snippet) => /noreply@anthropic\.com/.test(snippet),
  },
  {
    name: 'secret-pattern',
    pattern: /sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]+|BEGIN [A-Z ]*PRIVATE KEY/,
    describe: 'secret-shaped string',
  },
];

const JUNK_FILE_PATTERN = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$/;

function gitLsFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function readFileLines(relPath) {
  const abs = path.join(REPO_ROOT, relPath);
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    return raw.split('\n');
  } catch {
    return null; // binary or unreadable — skip content rules, junk-file rule still applies
  }
}

function snippetOf(line, match) {
  const idx = line.indexOf(match);
  const start = Math.max(0, idx - 20);
  return line.slice(start, idx + match.length + 20).trim();
}

function allowedRuleForLine(line) {
  const m = HYGIENE_ALLOW_PATTERN.exec(line);
  return m ? m[1].toLowerCase() : null;
}

function scanLine({ file, sha, lineNumber, line, denylistHashes, findings, allowUses }) {
  const allowedRule = allowedRuleForLine(line);
  if (allowedRule) {
    allowUses.push({ file, sha, line: lineNumber, rule: allowedRule });
  }

  if (!(allowedRule && allowedRule.replace(/\s*\(hashed\)/, '') === 'private-vocabulary')) {
    const hits = privateVocabularyHashesInLine(line, denylistHashes);
    if (hits.length) {
      findings.push({
        sha,
        file,
        line: lineNumber,
        rule: 'private-vocabulary (hashed)',
        snippet: '<redacted>',
      });
    }
  }

  for (const rule of RULES) {
    if (allowedRule === rule.name) continue;
    const m = rule.pattern.exec(line);
    if (!m) continue;
    const snippet = snippetOf(line, m[0]);
    if (rule.allow && rule.allow(snippet)) continue;
    findings.push({ sha, file, line: lineNumber, rule: rule.name, snippet });
  }
}

function scanWorkingTree(denylistHashes) {
  const findings = [];
  const allowUses = [];
  const files = gitLsFiles();
  for (const file of files) {
    if (JUNK_FILE_PATTERN.test(file)) {
      findings.push({ file, line: 0, rule: 'os-junk-file', snippet: file });
      continue;
    }
    const lines = readFileLines(file);
    if (!lines) continue;
    for (let i = 0; i < lines.length; i += 1) {
      scanLine({
        file, sha: null, lineNumber: i + 1, line: lines[i], denylistHashes, findings, allowUses,
      });
    }
  }
  return { findings, allowUses };
}

function scanHistory(denylistHashes) {
  const findings = [];
  const allowUses = [];
  let revs;
  try {
    revs = execFileSync('git', ['rev-list', '--all'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return { findings, allowUses };
  }
  for (const sha of revs) {
    let files;
    try {
      files = execFileSync('git', ['ls-tree', '-r', '--name-only', sha], { cwd: REPO_ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      continue;
    }
    for (const file of files) {
      if (JUNK_FILE_PATTERN.test(file)) {
        findings.push({ sha, file, line: 0, rule: 'os-junk-file', snippet: file });
        continue;
      }
      let content;
      try {
        content = execFileSync('git', ['show', `${sha}:${file}`], { cwd: REPO_ROOT, encoding: 'utf8' });
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        scanLine({
          file, sha, lineNumber: i + 1, line: lines[i], denylistHashes, findings, allowUses,
        });
      }
    }
  }
  return { findings, allowUses };
}

function main(argv = process.argv.slice(2)) {
  const historyMode = argv.includes('--history');
  const denylistHashes = loadDenylistHashes(resolveDenylistPath(argv));
  const { findings, allowUses } = historyMode ? scanHistory(denylistHashes) : scanWorkingTree(denylistHashes);

  for (const use of allowUses) {
    const prefix = use.sha ? `${use.sha.slice(0, 12)} ` : '';
    process.stdout.write(`hygiene-allow used: ${prefix}${use.file}:${use.line}: ${use.rule}\n`);
  }

  if (!findings.length) {
    process.stdout.write(historyMode ? 'hygiene-check --history: no findings.\n' : 'hygiene-check: clean.\n');
    return 0;
  }

  for (const f of findings) {
    const prefix = f.sha ? `${f.sha.slice(0, 12)} ` : '';
    process.stdout.write(`${prefix}${f.file}:${f.line}: ${f.rule}: ${f.snippet}\n`);
  }
  if (historyMode) {
    process.stdout.write(`\n${findings.length} finding(s) in history — report only, history not modified.\n`);
    return 0;
  }
  process.stdout.write(`\n${findings.length} finding(s) in working tree.\n`);
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  main,
  scanWorkingTree,
  scanHistory,
  RULES,
  JUNK_FILE_PATTERN,
  loadDenylistHashes,
  resolveDenylistPath,
  privateVocabularyHashesInLine,
  sha256,
};
