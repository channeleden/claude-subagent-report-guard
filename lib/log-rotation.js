'use strict';

/**
 * log-rotation.js — cheap size-capped rotation for this plugin's append-only
 * logs (the gate invocation log, and any other JSONL this plugin appends to
 * forever). Without this, a long-lived install accumulates an unbounded
 * file — this plugin's migration script (`scripts/migrate-legacy-log.js`)
 * exists to rotate an oversized pre-existing log once, by hand, on
 * adoption.
 *
 * Policy: before every append, stat the target file. If it is already over
 * `MAX_BYTES` (~2 MB), rename it to `<path>.1` — overwriting any existing
 * `.1`, so at most one prior generation is ever kept — then append fresh.
 * The stat is one syscall; there is no line counting, no timed rotation, no
 * external process.
 */

const fs = require('fs');

const MAX_BYTES = Number(process.env.SUBAGENT_REPORT_GUARD_LOG_MAX_BYTES) || 2 * 1024 * 1024;

function rotateIfNeeded(filePath, maxBytes = MAX_BYTES) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return false; // file does not exist yet — nothing to rotate
  }
  if (size <= maxBytes) return false;
  try {
    fs.renameSync(filePath, `${filePath}.1`);
    return true;
  } catch {
    return false; // best-effort; a failed rotation must never block the append
  }
}

// Appends `line` (a single line of text; a trailing "\n" is added if
// missing) to `filePath`, rotating first when the file is already over the
// size cap. Creates the parent directory lazily. Never throws — a logging
// failure must never be the reason a hook fails.
function appendRotating(filePath, line, { maxBytes = MAX_BYTES } = {}) {
  try {
    fs.mkdirSync(require('path').dirname(filePath), { recursive: true });
    rotateIfNeeded(filePath, maxBytes);
    const text = line.endsWith('\n') ? line : `${line}\n`;
    fs.appendFileSync(filePath, text, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { rotateIfNeeded, appendRotating, MAX_BYTES };
