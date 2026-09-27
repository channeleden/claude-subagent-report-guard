'use strict';

/**
 * inbox-gate.js — read-only helper for the "unread-message drop" gate.
 *
 * WHY THIS EXISTS
 * ----------------
 * A lead can `SendMessage` a teammate while that teammate is on its final
 * turn. `SendMessage` returns success ("queued for next tool round"), but
 * if the teammate ends its turn with no further tool round, the message is
 * never drained — the teammate's idle notification says "nothing further",
 * and the follow-up is silently lost from the teammate's own point of view
 * (it never sees it at all this session, though the message itself is
 * still sitting, unread, in its inbox file on disk).
 *
 * This module reads that inbox file — Claude Code's own real, live
 * per-session team-mailbox layout, `<teams root>/<teamName>/inboxes/
 * <name>.json` (see `teamsRootDir()` in `./paths.js`) — and reports which
 * messages in it are still unread. `lib/report-gate.js` uses this to block
 * a teammate's `SubagentStop` once per distinct unread set, forcing the
 * extra turn that drains the inbox.
 *
 * THIS MODULE NEVER WRITES to that directory — it is Claude Code's own,
 * not this plugin's. Every function here is read-only.
 *
 * REAL SHAPE (verified 2026-09-27 against a live, in-use inbox file,
 * read-only; reduced to an anonymized fixture under
 * `test/fixtures/real-shape-2026-09-27/` before being committed to this
 * public repo): a JSON array of
 *   { from, msgV, msg_id, read, summary, text, timestamp, type }
 * `read` is a JSON boolean in the real file — every message observed live
 * across dozens of inbox files (some months old) carried `"read": false`;
 * no `true` value was ever observed, which is itself the root-cause
 * evidence for this whole mechanism: nothing in the real system ever flips
 * this flag, so a gate that waited for `read` to become `true` would never
 * fire, and a consumer that trusted it would never see a message it had
 * actually drained. `isReadTrue()` below also defensively accepts the
 * strings `"true"`/`"True"` (and therefore `"false"`/`"False"`) in case a
 * different writer of this same file shape ever emits a string instead of
 * a boolean — never required by the real data, just cheap to accept.
 *
 * FAIL-OPEN, ALWAYS
 * ------------------
 * Every function here returns a safe default (empty array) on ANY error —
 * a missing inbox file (the common case: most teammates have none), an
 * unreadable one, malformed JSON, a non-array top level, or a file larger
 * than `MAX_INBOX_BYTES` (skipped outright, never partially parsed). This
 * is a directory this plugin does not own; a read failure here must never
 * be the reason a legitimate subagent turn cannot end.
 *
 * BOUNDED COST
 * ------------
 * The common case — no unread messages, often no inbox file at all — costs
 * at most one `fs.statSync` plus one `fs.readFileSync`, never more.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { teamsRootDir } = require('./paths.js');
const { isSafePathSegment, isPathContainedIn } = require('./path-safety.js');

const MAX_INBOX_BYTES = Number(process.env.SUBAGENT_REPORT_GUARD_INBOX_MAX_BYTES) || 2 * 1024 * 1024;
// Cap on how many unread messages are ever embedded verbatim (summary only,
// never full `text`) into a block reason or a lead-facing notice — mirrors
// `lib/orphan-pointers.js`'s own `MAX_ITEMS_PER_INJECTION` convention.
const UNREAD_INBOX_ITEM_CAP = 5;

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// True iff `v` is an explicit "this message has been read" marker — a JSON
// boolean `true`, or (defensively; never required by real data — see the
// file header) the strings `"true"`/`"True"`. Anything else — JSON
// `false`, the strings `"false"`/`"False"`, any other value, or the field
// being absent entirely — means unread. Treating "absent" as unread is the
// safe direction: a message with no `read` field at all is not evidence
// that it was ever seen.
function isReadTrue(v) {
  return v === true || v === 'true' || v === 'True';
}

// `<teamsRoot>/<teamName>/inboxes/<name>.json`, validated as safe path
// segments and checked to actually land under `teamsRoot` — defense in
// depth against a malformed/hostile `teamName`/`name` (both are harness
// `.meta.json` sidecar fields, not raw external input, but validated with
// the exact same rule every other hook-payload-derived path component in
// this repo uses). Returns null on any invalid input or on
// `teamsRootDir()` itself throwing (the `NODE_TEST_CONTEXT` guard — see
// `lib/paths.js`) — every caller here treats null as "no inbox to read",
// never a thrown exception.
function resolveInboxPath({ teamName, name }) {
  if (!isSafePathSegment(teamName) || !isSafePathSegment(name)) return null;
  let root;
  try {
    root = teamsRootDir();
  } catch {
    return null;
  }
  const p = path.join(root, teamName, 'inboxes', `${name}.json`);
  return isPathContainedIn(p, root) ? p : null;
}

// Reads `<teamsRoot>/<teamName>/inboxes/<name>.json` and returns every
// message in it that is not marked read (see `isReadTrue`). Fails open —
// returns `[]` — on a missing file, an unreadable one, malformed JSON, a
// non-array top level, or a file bigger than `MAX_INBOX_BYTES` (checked via
// `fs.statSync` BEFORE any read, so an oversized file is never partially
// read or parsed). Never throws.
function readUnreadInboxMessages({ teamName, name }) {
  const p = resolveInboxPath({ teamName, name });
  if (!p) return [];
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INBOX_BYTES) return [];
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((m) => m && typeof m === 'object' && !isReadTrue(m.read));
}

// A stable identity for one message: its own `msg_id` when present (the
// real shape always carries one — a uuid), else a deterministic fallback
// derived from its other fields, so a message lacking `msg_id` still keys
// consistently across repeated reads of an unchanged inbox.
function messageKey(m) {
  const id = nonEmptyString(m && m.msg_id);
  if (id) return `id:${id}`;
  const from = (m && typeof m.from === 'string') ? m.from : '';
  const ts = (m && typeof m.timestamp === 'string') ? m.timestamp : '';
  const text = (m && typeof m.text === 'string')
    ? m.text
    : ((m && typeof m.summary === 'string') ? m.summary : '');
  return `fallback:${from}|${ts}|${text.slice(0, 80)}`;
}

// A stable hash of the sorted set of unread message keys. The SAME unread
// set (identical msg_ids, any order) always hashes to the SAME key; adding
// even one genuinely new unread message changes it. Feeds
// `lib/report-gate.js`'s own claim-marker mechanism, which is what actually
// bounds the block to at most once per distinct set.
function unreadSetKey(unread) {
  const keys = unread.map(messageKey).sort();
  return crypto.createHash('sha256').update(keys.join(',')).digest('hex');
}

// A short, bounded (<=200 char, per message) projection of one unread
// message — `from` + a summary (the message's own `summary` field, or a
// truncated `text` fallback) + `msg_id`. Never the full `text` body. Used
// both for the block reason embedded in the teammate's next turn and for
// the lead-facing notice (see `lib/orphan-pointers.js`'s
// `writeUnreadInboxNotice`) — neither should ever carry more than this.
function projectMessage(m) {
  return {
    from: nonEmptyString(m.from) || 'unknown',
    summary: nonEmptyString(m.summary) || (nonEmptyString(m.text) ? m.text.trim().slice(0, 200) : null) || '(no summary)',
    msg_id: nonEmptyString(m.msg_id),
  };
}

function buildUnreadInboxReason(unread) {
  const projected = unread.map(projectMessage);
  const senders = [...new Set(projected.map((m) => m.from))];
  const shown = projected.slice(0, UNREAD_INBOX_ITEM_CAP);
  const lines = shown.map((m) => `- from ${m.from}: ${m.summary}`);
  const more = projected.length > shown.length ? `\n- +${projected.length - shown.length} more` : '';
  return (
    `You have ${unread.length} unread message${unread.length === 1 ? '' : 's'} in your team inbox, from ` +
    `${senders.join(', ')}:\n${lines.join('\n')}${more}\n\n` +
    'Read your inbox and act on the pending message(s) — or at least acknowledge them via SendMessage ' +
    '— before going idle. Do not stop yet.'
  );
}

module.exports = {
  MAX_INBOX_BYTES,
  UNREAD_INBOX_ITEM_CAP,
  isReadTrue,
  resolveInboxPath,
  readUnreadInboxMessages,
  messageKey,
  unreadSetKey,
  projectMessage,
  buildUnreadInboxReason,
};
