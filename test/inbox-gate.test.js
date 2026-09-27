'use strict';

// Unit coverage for lib/inbox-gate.js — the read-only helper that finds
// unread messages in Claude Code's own real team-mailbox inbox files
// (`<teams root>/<teamName>/inboxes/<name>.json`).
//
// Fixtures under test/fixtures/real-shape-2026-09-27/team-inbox-*.json
// mirror the REAL shape of a live inbox file (verified read-only against
// ~/.claude/teams/<session>/inboxes/<name>.json on 2026-09-27 — see
// lib/inbox-gate.js's own header), with every name/id/path replaced by an
// obvious placeholder before being committed to this public repo.
//
// Every test here points `SUBAGENT_REPORT_GUARD_TEAMS_ROOT` at a scratch
// tmpdir — never the real HOME — so `teamsRootDir()`'s own
// `NODE_TEST_CONTEXT` guard (lib/paths.js) is never even reached.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  isReadTrue,
  readUnreadInboxMessages,
  unreadSetKey,
  buildUnreadInboxReason,
} = require('../lib/inbox-gate.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'real-shape-2026-09-27');

let counter = 0;
function withTeamsRoot(fn) {
  counter += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `inbox-gate-teams-${counter}-`));
  const prev = process.env.SUBAGENT_REPORT_GUARD_TEAMS_ROOT;
  process.env.SUBAGENT_REPORT_GUARD_TEAMS_ROOT = root;
  try {
    return fn(root);
  } finally {
    if (prev === undefined) delete process.env.SUBAGENT_REPORT_GUARD_TEAMS_ROOT;
    else process.env.SUBAGENT_REPORT_GUARD_TEAMS_ROOT = prev;
  }
}

function writeInbox(root, teamName, name, fixtureName) {
  const dir = path.join(root, teamName, 'inboxes');
  fs.mkdirSync(dir, { recursive: true });
  const content = fs.readFileSync(path.join(FIXTURE_DIR, fixtureName), 'utf8');
  fs.writeFileSync(path.join(dir, `${name}.json`), content, 'utf8');
}

test('isReadTrue: JSON boolean true and the defensive string forms are true; everything else is false', () => {
  assert.equal(isReadTrue(true), true);
  assert.equal(isReadTrue('true'), true);
  assert.equal(isReadTrue('True'), true);
  assert.equal(isReadTrue(false), false);
  assert.equal(isReadTrue('false'), false);
  assert.equal(isReadTrue('False'), false);
  assert.equal(isReadTrue(undefined), false);
  assert.equal(isReadTrue(null), false);
  assert.equal(isReadTrue('TRUE'), false); // exact-case only, no surprises
});

test('readUnreadInboxMessages: the real unread shape (JSON boolean false) is returned', () => {
  withTeamsRoot((root) => {
    writeInbox(root, 'session-00000000', 'gate-live-test', 'team-inbox-unread.json');
    const unread = readUnreadInboxMessages({ teamName: 'session-00000000', name: 'gate-live-test' });
    assert.equal(unread.length, 1);
    assert.equal(unread[0].from, 'team-lead');
    assert.equal(unread[0].read, false);
  });
});

test('readUnreadInboxMessages: all messages read (JSON boolean true) -> no-op, empty array', () => {
  withTeamsRoot((root) => {
    writeInbox(root, 'session-00000000', 'gate-live-test', 'team-inbox-read.json');
    const unread = readUnreadInboxMessages({ teamName: 'session-00000000', name: 'gate-live-test' });
    assert.deepEqual(unread, []);
  });
});

test('readUnreadInboxMessages: the string "False" is treated as unread (defensive acceptance)', () => {
  withTeamsRoot((root) => {
    const dir = path.join(root, 'session-00000000', 'inboxes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'gate-live-test.json'),
      JSON.stringify([{ from: 'team-lead', summary: 'x', msg_id: 'm1', read: 'False' }]),
      'utf8',
    );
    const unread = readUnreadInboxMessages({ teamName: 'session-00000000', name: 'gate-live-test' });
    assert.equal(unread.length, 1);
  });
});

test('readUnreadInboxMessages: missing inbox file -> no-op, never throws', () => {
  withTeamsRoot(() => {
    assert.doesNotThrow(() => {
      const unread = readUnreadInboxMessages({ teamName: 'session-00000000', name: 'no-such-teammate' });
      assert.deepEqual(unread, []);
    });
  });
});

test('readUnreadInboxMessages: malformed JSON -> no-op, never throws', () => {
  withTeamsRoot((root) => {
    const dir = path.join(root, 'session-00000000', 'inboxes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gate-live-test.json'), '{ not valid json', 'utf8');
    const unread = readUnreadInboxMessages({ teamName: 'session-00000000', name: 'gate-live-test' });
    assert.deepEqual(unread, []);
  });
});

test('readUnreadInboxMessages: non-list top level (an object, not an array) -> no-op', () => {
  withTeamsRoot((root) => {
    const dir = path.join(root, 'session-00000000', 'inboxes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gate-live-test.json'), JSON.stringify({ oops: true }), 'utf8');
    const unread = readUnreadInboxMessages({ teamName: 'session-00000000', name: 'gate-live-test' });
    assert.deepEqual(unread, []);
  });
});

test('readUnreadInboxMessages: oversized inbox file -> skipped outright, never parsed', () => {
  withTeamsRoot((root) => {
    const dir = path.join(root, 'session-00000000', 'inboxes');
    fs.mkdirSync(dir, { recursive: true });
    const prevMax = process.env.SUBAGENT_REPORT_GUARD_INBOX_MAX_BYTES;
    process.env.SUBAGENT_REPORT_GUARD_INBOX_MAX_BYTES = '10'; // absurdly small cap for this test
    try {
      fs.writeFileSync(
        path.join(dir, 'gate-live-test.json'),
        JSON.stringify([{ from: 'team-lead', summary: 'x', msg_id: 'm1', read: false }]),
        'utf8',
      );
      // Re-require to pick up the new MAX_INBOX_BYTES module-level constant.
      delete require.cache[require.resolve('../lib/inbox-gate.js')];
      const fresh = require('../lib/inbox-gate.js');
      const unread = fresh.readUnreadInboxMessages({ teamName: 'session-00000000', name: 'gate-live-test' });
      assert.deepEqual(unread, []);
    } finally {
      if (prevMax === undefined) delete process.env.SUBAGENT_REPORT_GUARD_INBOX_MAX_BYTES;
      else process.env.SUBAGENT_REPORT_GUARD_INBOX_MAX_BYTES = prevMax;
      delete require.cache[require.resolve('../lib/inbox-gate.js')];
    }
  });
});

test('unreadSetKey: stable across reorderings, changes when the set changes', () => {
  const a = [{ msg_id: 'a' }, { msg_id: 'b' }];
  const aReordered = [{ msg_id: 'b' }, { msg_id: 'a' }];
  const b = [{ msg_id: 'a' }, { msg_id: 'c' }];
  assert.equal(unreadSetKey(a), unreadSetKey(aReordered));
  assert.notEqual(unreadSetKey(a), unreadSetKey(b));
});

test('buildUnreadInboxReason: lists count, sender(s), and summaries, and instructs reading the inbox before stopping', () => {
  const unread = [{ from: 'team-lead', summary: 'Correct my brief', msg_id: 'm1', read: false }];
  const reason = buildUnreadInboxReason(unread);
  assert.match(reason, /1 unread message/);
  assert.match(reason, /team-lead/);
  assert.match(reason, /Correct my brief/);
  assert.match(reason, /Read your inbox/);
  assert.match(reason, /Do not stop yet/);
});
