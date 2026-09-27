'use strict';

/**
 * read-stdin.js — the one portable way every hook in this repo drains its
 * stdin payload synchronously.
 *
 * WHY THIS EXISTS (read before "simplifying" back to a single readFileSync
 * call): every hook here used to open `/dev/stdin` (or fd 0) once and call
 * `fs.readFileSync(...)` on it directly. That is reliable on macOS, but on
 * Linux the same call can throw `EAGAIN` ("resource temporarily
 * unavailable") when stdin is a PIPE rather than a regular file or TTY —
 * which is exactly what a hook always sees, whether that pipe comes from
 * Claude Code's own hook invocation or, in this repo's own tests, from
 * `execFileSync(..., { input })`/a shell `printf ... | node ...` pipeline.
 * A pipe's read end can be non-blocking on Linux even for a synchronous
 * `fs.readSync`, so a read attempted before the writer's bytes have arrived
 * can legitimately return "not ready yet" instead of blocking until they
 * do — libuv's pipe handling differs enough between the two platforms that
 * this is a real, not theoretical, difference, not a one-off flake.
 * Every hook's own `readPayload()` wraps its stdin read in a `catch {
 * return null }` (correct fail-open behavior for a genuinely unreadable or
 * malformed payload) — but that same catch silently swallowed a transient
 * EAGAIN too, which reads identically to "no payload" and made the hook
 * exit as a silent no-op instead of doing its actual job. This was
 * invisible on macOS (where the read never threw in the first place) and
 * turned into a consistent Linux-CI-only failure across every
 * hook-subprocess integration test in this repo — pure-library tests, which
 * never spawn a subprocess or touch stdin, were unaffected either way.
 *
 * `readStdinSync()` reads from fd 0 in a loop, retrying ONLY on `EAGAIN`
 * (any other error, or a genuine 0-byte EOF read, stops the loop) until the
 * full payload is drained. The retry budget is bounded — `MAX_ATTEMPTS`
 * iterations, each separated by a short `Atomics.wait`-based sleep once a
 * handful of immediate retries haven't succeeded — so a caller whose stdin
 * is simply never going to produce data (e.g. a genuinely closed fd) cannot
 * spin forever; it degrades to returning whatever was collected so far
 * (typically nothing), matching every hook's own existing fail-open
 * contract. Never throws.
 */

const fs = require('fs');

// A handful of immediate retries covers the common case (the writer's bytes
// land within microseconds); after that, a short bounded sleep between
// attempts avoids pegging a core while still resolving well within a single
// hook's time budget. Total worst case: ~200 * 2ms = 400ms, then give up —
// generous for real stdin delivery, still bounded (no runaway loop).
const IMMEDIATE_RETRIES = 50;
const MAX_ATTEMPTS = 250;
const RETRY_SLEEP_MS = 2;

const SLEEP_IA = (() => {
  try { return new Int32Array(new SharedArrayBuffer(4)); } catch { return null; }
})();

function sleepSync(ms) {
  if (SLEEP_IA) { Atomics.wait(SLEEP_IA, 0, 0, ms); return; }
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait fallback only if SharedArrayBuffer is unavailable */ }
}

/**
 * Synchronously reads all of stdin (fd 0) and returns it as a UTF-8 string.
 * Returns '' on any unrecoverable read error, on a closed/empty stdin, or
 * once the bounded retry budget is exhausted — never throws.
 */
function readStdinSync() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let fd;
  try {
    fd = fs.openSync('/dev/stdin', 'r');
  } catch {
    fd = 0; // fall back to the fd Node already has open for us
  }

  let attempt = 0;
  for (;;) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if (err && err.code === 'EAGAIN' && attempt < MAX_ATTEMPTS) {
        attempt += 1;
        if (attempt > IMMEDIATE_RETRIES) sleepSync(RETRY_SLEEP_MS);
        continue; // not ready yet on this platform — retry within budget
      }
      break; // any other error, or budget exhausted — stop, return what we have
    }
    if (!bytesRead) break; // 0 bytes read = EOF
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    attempt = 0; // reset the EAGAIN budget once real progress is made
  }

  try { if (fd !== 0) fs.closeSync(fd); } catch { /* best-effort */ }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { readStdinSync };
