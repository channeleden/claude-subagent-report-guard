#!/usr/bin/env node
'use strict';

/**
 * migrate-legacy-log.js — one-shot rotation for a pre-existing, already
 * oversized log file, run manually once when adopting size-capped rotation
 * on a log that predates it (an invocation log that grew unbounded before
 * `lib/log-rotation.js` existed).
 *
 * Usage: node scripts/migrate-legacy-log.js <path>
 *
 * If <path> is over 2 MB (or SUBAGENT_REPORT_GUARD_LOG_MAX_BYTES, if set),
 * it is renamed to <path>.1 (overwriting any existing .1), exactly like the
 * ongoing rotation policy would have done incrementally. Idempotent: running
 * it again on an already-small file is a no-op. Never touches anything
 * other than the exact path given.
 */

const fs = require('fs');
const { rotateIfNeeded, MAX_BYTES } = require('../lib/log-rotation.js');

function main(argv = process.argv) {
  const target = argv[2];
  if (!target) {
    process.stderr.write('usage: migrate-legacy-log.js <path>\n');
    return 1;
  }
  let size;
  try {
    size = fs.statSync(target).size;
  } catch (err) {
    process.stderr.write(`cannot stat ${target}: ${err.message}\n`);
    return 1;
  }
  if (size <= MAX_BYTES) {
    process.stdout.write(`${target} is ${size} bytes, under the ${MAX_BYTES}-byte cap — nothing to do.\n`);
    return 0;
  }
  const rotated = rotateIfNeeded(target, MAX_BYTES);
  if (!rotated) {
    process.stderr.write(`failed to rotate ${target}\n`);
    return 1;
  }
  process.stdout.write(`rotated ${target} (${size} bytes) -> ${target}.1\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
