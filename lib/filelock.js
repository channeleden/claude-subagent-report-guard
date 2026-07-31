'use strict';

/**
 * filelock v2 — shared advisory file lock for serializing read-modify-write
 * access to a shared file across concurrent processes (used here to
 * serialize each lane's own dropbox sidecar writes; see lane-dropbox.js).
 *
 * Part of the lane drop-box mechanism in this repo (see ../README.md).
 *
 * WHY v1 existed: an earlier version spin-retried and stale-stole by mtime,
 * which had two structural holes: (a) contenders judged staleness with
 * their OWN local threshold, so a legitimately long hold could be stolen by
 * a contender judging on a much shorter window; (b) mtime says nothing
 * about whether the holder is still alive.
 *
 * v2 INVARIANTS (the contract; mechanisms below just implement them):
 *   1. Lock file content is JSON: { pid, nonce, acquiredAt, staleMs }. A
 *      contender judges staleness from the HOLDER's declared staleMs (+grace),
 *      never a local default.
 *   2. NEVER steal while the holder pid is alive (process.kill(pid, 0);
 *      EPERM counts as alive). A live process's lock is untouchable regardless
 *      of age. Documented accepted residual: PID reuse — a recycled pid can
 *      make a dead holder look alive (wedges until that process exits; the
 *      declared-staleMs gate still bounds the common case) or, inversely,
 *      cannot make a live holder look dead (kill(pid,0) on a live pid is
 *      always alive), so the DANGEROUS direction is impossible.
 *   3. Steals are serialized on a `.steal` mutex whose own staleness is ALSO
 *      pid-verified (never blind-unlinked). After wx-acquiring the main lock
 *      post-steal, the stealer re-reads the .steal token and verifies it is
 *      still its own before returning success; a mismatch releases everything
 *      and retries from scratch.
 *   4. Release verifies the on-disk token immediately before unlink and never
 *      unlinks on a mismatch.
 *
 * Synchronous on purpose — callers of this module include hooks that must
 * run synchronously, so the sleep uses Atomics.wait (blocks the thread
 * without busy-spin).
 *
 * ── Concurrency model & ACCEPTED RESIDUALS (declared, not fixed) ───────────
 * 1. v1→v2 transition: a still-LIVE legacy-format (non-JSON) lock can be
 *    mtime-stolen during a deploy window — legacy content carries no pid to
 *    liveness-verify. Transitional only: once every writer is on v2, legacy
 *    content can only be a pre-upgrade leftover.
 * 2. PID-liveness is HOST-LOCAL (process.kill(pid, 0)) — these locks are valid
 *    for a single machine only, NOT shared/network filesystems.
 * 3. PID reuse: a recycled pid can make a dead holder look alive, delaying a
 *    steal until that unrelated process exits. It can never make a live holder
 *    look dead, so the dangerous direction is impossible.
 * 4. Sub-millisecond TOCTOU between a final re-verification and the write it
 *    guards is accepted: this is an ADVISORY-lock system among cooperating
 *    writers, not a mandatory-locking database.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STALE_MS = 30_000; // declared by the ACQUIRER into its own lock file
const DEFAULT_RETRIES = 5;       // up to 5 retries...
const DEFAULT_WAIT_MS = 150;     // ...×150ms = ~750ms max wait before giving up
const STALE_GRACE_MS = 5_000;    // grace on top of the holder's declared staleMs
// Clamp: the maximum staleMs a contender will HONOR from a holder's declaration —
// an absurd declaration (or corrupted field) can delay steals, never wedge
// contenders past this bound.
const MAX_HONORED_STALE_MS = 30 * 60_000;
// Clamp: an acquiredAt further in the future than this is not clock skew — the
// token is MALFORMED and staleness falls to the file's real mtime.
const CLOCK_SKEW_ALLOWANCE_MS = 5 * 60_000;

// Ownership map: lockPath → the exact serialized token we wrote at acquire time.
// Process-local by design — ownership is per-writer.
const HELD = new Map();

// Module-level singleton — we never Atomics.notify index 0, so every wait just
// times out after `ms`; reusing one buffer avoids a per-call allocation.
const SLEEP_IA = (() => {
  try { return new Int32Array(new SharedArrayBuffer(4)); } catch { return null; }
})();

/** Block the current thread for `ms` without busy-spinning. */
function sleepSync(ms) {
  if (SLEEP_IA) { Atomics.wait(SLEEP_IA, 0, 0, ms); return; }
  const end = Date.now() + ms; // fallback if SharedArrayBuffer unavailable
  while (Date.now() < end) { /* busy-wait */ }
}

function makeToken(staleMs) {
  return JSON.stringify({
    pid: process.pid,
    nonce: crypto.randomBytes(6).toString('hex'),
    acquiredAt: Date.now(),
    staleMs,
  });
}

// ATOMIC lock publish. Never wx-create-then-write (a contender could
// observe the file between creation and the token write — the empty-file window
// that got misread as a legacy lock and mtime-stolen). Instead: write the fully-
// formed token to a private temp file, then hard-link it into place —
// link(2) is atomic publish-WITH-content (EEXIST = we lost the race). A lock
// file, once visible, always has complete content.
// Returns 'ok' | 'exists' | 'error'.
function publishToken(targetPath, token) {
  const tmp = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.pub-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  try {
    fs.writeFileSync(tmp, token);
    fs.linkSync(tmp, targetPath); // atomic — exactly one publisher wins
    return 'ok';
  } catch (e) {
    return e.code === 'EEXIST' ? 'exists' : 'error';
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
  }
}

function readTokenInfo(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Liveness probe. EPERM = the pid exists but is another user's — alive.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

// Is the file at `p` a STALE lock per invariants 1+2? Legacy/corrupt content
// (no parseable pid) cannot be liveness-verified — fall back to an mtime age
// check against the DEFAULT threshold so a corrupt lock can't wedge forever.
// `nowMs` is injectable for tests (defaults to the real clock).
//
// Staleness clamps:
//   • the honored declared staleMs is capped at MAX_HONORED_STALE_MS so an
//     absurd declaration can't wedge contenders forever;
//   • an acquiredAt beyond now + CLOCK_SKEW_ALLOWANCE_MS is not clock
//     skew — the token is MALFORMED, and staleness falls to the file's REAL
//     mtime (same rule as legacy/corrupt tokens). The earlier stateless
//     min(acquiredAt, now) clamp restarted the age window on EVERY retry, so a
//     dead far-future lock stayed age-0 forever. INVARIANT 2 still holds even
//     for a malformed token: if its pid parses and is alive, never steal.
function tokenIsStale(p, nowMs = Date.now()) {
  const info = readTokenInfo(p);
  if (info && Number.isInteger(info.pid)) {
    if (pidAlive(info.pid)) return false; // INVARIANT 2: live holder untouchable
    const acquiredAt = Number(info.acquiredAt) || 0;
    if (acquiredAt <= nowMs + CLOCK_SKEW_ALLOWANCE_MS) {
      const declaredRaw = Number(info.staleMs) > 0 ? Number(info.staleMs) : DEFAULT_STALE_MS;
      const declared = Math.min(declaredRaw, MAX_HONORED_STALE_MS);
      return (nowMs - acquiredAt) > declared + STALE_GRACE_MS; // INVARIANT 1 (capped)
    }
    // Far-future acquiredAt (dead pid) — malformed: fall through to mtime rule.
  }
  // Legacy/corrupt/malformed token — judge by the file's real mtime.
  try { return (nowMs - fs.statSync(p).mtimeMs) > DEFAULT_STALE_MS + STALE_GRACE_MS; }
  catch { return false; } // vanished — not stale, just gone
}

// One steal attempt for a lock already judged stale (INVARIANT 3). Returns true
// with the main lock held (token = myToken) or false (caller retries/backs off).
// Both the .steal mutex and the re-created main lock are published via
// the atomic link() path — a visible file always has complete content, so the
// empty-file→legacy-misread→mtime-steal interleaving is impossible for v2 locks.
function tryStealStale(lockPath, myToken) {
  const stealPath = `${lockPath}.steal`;
  // Acquire the .steal mutex. If it exists, its own staleness is PID-VERIFIED —
  // never a blind unlink: read its token; only a dead (or legacy-stale) stealer
  // may be cleared.
  let published = publishToken(stealPath, myToken);
  if (published === 'exists') {
    if (!tokenIsStale(stealPath)) return false; // live (or fresh) stealer — back off
    try { fs.unlinkSync(stealPath); } catch { /* raced — retry next loop */ }
    published = publishToken(stealPath, myToken);
  }
  if (published !== 'ok') return false;
  try {
    // Re-verify the MAIN lock under the steal mutex — it may have been stolen
    // and replaced by a live lock while we were acquiring `.steal`.
    if (!tokenIsStale(lockPath)) return false;
    try { fs.unlinkSync(lockPath); } catch { /* already gone — fine */ }
    // Contend for the freed path like any acquirer (atomic publish).
    if (publishToken(lockPath, myToken) !== 'ok') return false; // a normal acquirer beat us — fine
    // INVARIANT 3 post-check: our .steal token must still be ours. A mismatch
    // means our mutex was (wrongly or via pid-reuse) cleared and another steal
    // may be interleaved — release everything and retry from scratch.
    let cur = '';
    try { cur = fs.readFileSync(stealPath, 'utf8'); } catch { cur = ''; }
    if (cur !== myToken) {
      try {
        const main = fs.readFileSync(lockPath, 'utf8');
        if (main === myToken) fs.unlinkSync(lockPath);
      } catch { /* best-effort rollback */ }
      return false;
    }
    return true;
  } finally {
    // Remove OUR .steal only (token-verified — never a peer's).
    try {
      if (fs.readFileSync(stealPath, 'utf8') === myToken) fs.unlinkSync(stealPath);
    } catch { /* already gone */ }
  }
}

/**
 * Acquire an O_EXCL lockfile, spin-retrying on contention.
 * opts.staleMs is DECLARED into the lock file — it is this holder's own
 * staleness contract that every contender honors (INVARIANT 1). A long-running
 * holder (e.g. compile --write) passes a large staleMs and is safe from
 * short-threshold stealers for that whole window.
 * @returns {boolean} true if the lock is held by us, false if it could not be
 *   acquired within the retry budget (caller decides whether to skip).
 */
function acquireLock(lockPath, opts = {}) {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  for (let attempt = 0; ; attempt++) {
    const token = makeToken(staleMs);
    // Atomic publish — a visible lock file ALWAYS has complete content
    // (no wx-create-then-write window a peer could misread as empty/legacy).
    const published = publishToken(lockPath, token);
    if (published === 'ok') {
      HELD.set(lockPath, token);
      return true;
    }
    if (published === 'error') return false; // unexpected error — don't loop
    try {
      if (tokenIsStale(lockPath) && tryStealStale(lockPath, token)) {
        HELD.set(lockPath, token);
        return true;
      }
    } catch { /* raced — normal retry below */ }
    if (attempt >= retries) return false; // budget exhausted
    sleepSync(waitMs); // SPIN-RETRY (never silent drop)
  }
}

/**
 * Release a lock. INVARIANT 4: verifies the on-disk token matches the one we
 * wrote at acquire time IMMEDIATELY before the unlink, and never unlinks on a
 * mismatch — a writer whose stale lock was stolen sees the thief's token and
 * leaves it alone. A path with no recorded ownership in THIS process falls back
 * to a best-effort unlink (legacy callers / out-of-band acquisition).
 * Best-effort; never throws.
 */
function releaseLock(lockPath) {
  const token = HELD.get(lockPath);
  try {
    if (token === undefined) { fs.unlinkSync(lockPath); return; }
    let cur = '';
    try { cur = fs.readFileSync(lockPath, 'utf8'); }
    catch { HELD.delete(lockPath); return; } // already gone
    if (cur === token) fs.unlinkSync(lockPath); // verified ours — safe to remove
    // else: stolen by a live writer — leave it strictly alone.
    HELD.delete(lockPath);
  } catch { /* already gone / race — best-effort */ }
}

/**
 * Run `fn` while holding `lockPath`. Releases in finally (even on throw).
 * @returns {{locked: boolean, value?: *}} locked=false if the lock could not be
 *   acquired within the retry budget (fn is NOT run).
 */
function withLock(lockPath, fn, opts = {}) {
  if (!acquireLock(lockPath, opts)) return { locked: false };
  try { return { locked: true, value: fn() }; }
  finally { releaseLock(lockPath); }
}

module.exports = { acquireLock, releaseLock, withLock, sleepSync, tokenIsStale,
  DEFAULT_STALE_MS, DEFAULT_RETRIES, DEFAULT_WAIT_MS, STALE_GRACE_MS, MAX_HONORED_STALE_MS,
  CLOCK_SKEW_ALLOWANCE_MS };
