'use strict';

/**
 * pending-followup.js — stale-report detection: a teammate follow-up
 * delivered AFTER the agent's latest well-formed SendMessage makes that
 * report stale.
 *
 * A shared, provider-neutral pre-final-inbox evaluator. State-free by design —
 * re-derived from the transcript on every call, so no one-shot marker can
 * accidentally waive a later crossed message the way a cached verdict could.
 * Its proof scope is deliberately limited to transcript entries the harness
 * has already delivered; it never claims a provider's own opaque queue is
 * empty.
 *
 * PEER-ACK-LOOP SAFETY (why this cannot itself cause an unbounded loop)
 * -----------------------------------------------------------------------
 * Two teammates exchanging pure acknowledgments ("confirmed, holding" /
 * "acked") would otherwise re-trigger EACH OTHER's gate on every ack: each
 * delivered ack is itself a new inbound `<teammate-message>`, and a
 * content-blind "any newer inbound message means the report is stale" rule
 * can never distinguish a genuine unaddressed follow-up from a peer's pure
 * no-reply-needed acknowledgment — so it never terminates on its own. This
 * is closed by requiring the SENDER to opt a message out EXPLICITLY ("this
 * needs no reply"), never by the recipient guessing from content alone (a
 * "no question mark" heuristic can misfire on an implicit ask, e.g. "let me
 * know if X"). Two forms are recognized, both anchored to content the
 * sender actually controls:
 *   1. An attribute on the delivered envelope's own opening tag, mirroring
 *      the `teammate_id="..."` attribute this envelope already carries:
 *      `<teammate-message ... terminal="true">`.
 *   2. A literal in-body marker token in the sender's own message text,
 *      `[[terminal]]` (case-insensitive) — the form guaranteed to survive
 *      regardless of what a given harness build does with extra tool-call
 *      fields, since the enclosed text is the one thing this envelope
 *      indisputably passes through verbatim.
 * This recognition is consulted ONLY for classifying INBOUND messages
 * (never for the agent's own outbound report) — a subagent decorating its
 * own SendMessage with a `terminal`-shaped field has zero effect on whether
 * that call counts as a real, delivered report.
 *
 * LOOP-SAFETY ARGUMENT (stated explicitly, because a loop-risk mistake here
 * would be expensive): `evaluatePendingFollowup` is a pure, side-effect-free
 * read of the transcript — it never sends a message, retries, or re-enters
 * itself. Its caller (the SubagentStop hook, via `lib/report-gate.js`) can
 * only BLOCK a turn, which hands control back to the model; how many times a
 * genuinely stuck agent can be blocked at all is bounded by a SEPARATE,
 * one-shot marker (`reportBlockedOnce` in `report-gate.js`), not by this
 * function. Adding the terminal-marker exemption can only ever make this
 * function return `pending-followup` LESS often than the naive content-blind
 * version (a strict narrowing of when it blocks), never more — so it cannot
 * introduce a new blocking path, only close one that could not terminate.
 */

const TEAMMATE_MESSAGE_PATTERN = /<teammate-message(?:\s|>)/;
const TERMINAL_ENVELOPE_ATTRIBUTE_PATTERN = /<teammate-message\b[^>]*\bterminal\s*=\s*"true"[^>]*>/i;
const TERMINAL_BODY_MARKER_PATTERN = /\[\[terminal\]\]/i;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function contentBlocks(entry) {
  const content = entry && entry.message && entry.message.content;
  return Array.isArray(content) ? content : [];
}

// Deliberately duplicated (not shared via require) from
// `report-gate.js`'s own `hasWellFormedSendMessage` — see that module's
// header for why it trusts only the call's own `input`, never a
// tool_result's success status. Kept dependency-free here so this module
// stays testable in isolation, matching `subagent-transcript.js`'s own
// stated preference for that shape.
function hasWellFormedSendMessage(block) {
  if (!block || block.type !== 'tool_use' || block.name !== 'SendMessage') return false;
  const input = block.input || {};
  return isNonEmptyString(input.to) && (isNonEmptyString(input.message) || isNonEmptyString(input.summary));
}

function entryHasWellFormedSendMessage(entry) {
  return Boolean(entry && entry.type === 'assistant' && contentBlocks(entry).some(hasWellFormedSendMessage));
}

function userText(entry) {
  if (!entry || entry.type !== 'user' || !entry.message) return '';
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function isInboundTeammateMessage(entry) {
  return TEAMMATE_MESSAGE_PATTERN.test(userText(entry));
}

// True only for an inbound teammate message the SENDER explicitly marked as
// needing no reply — see the file header's two recognized forms. Callers
// must already know `entry` is an inbound teammate message; this answers
// "is this specific message exempt", not "is this an inbound message".
function isTerminalTeammateMessage(entry) {
  const text = userText(entry);
  if (!TEAMMATE_MESSAGE_PATTERN.test(text)) return false;
  return TERMINAL_ENVELOPE_ATTRIBUTE_PATTERN.test(text) || TERMINAL_BODY_MARKER_PATTERN.test(text);
}

// Evaluates a teammate transcript for whether its latest report is stale
// relative to what has actually been delivered inbound. `status` is one of:
//   - `'unobserved'`         — no inbound teammate message seen at all.
//   - `'awaiting-initial-report'` — an inbound message exists but no report
//     has been sent since ever (not itself a "stale report" case — the
//     caller's own Stage-1 boundary/SendMessage check covers this).
//   - `'pending-followup'`   — an ACTIONABLE (non-terminal-marked) inbound
//     message landed after the latest report — the report is stale.
//   - `'clear'`              — the latest report is at or after every
//     actionable inbound message.
function evaluatePendingFollowup(entries) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const inboundIndexes = [];
  const actionableInboundIndexes = []; // inbound minus sender-marked-terminal
  const reportIndexes = [];
  safeEntries.forEach((entry, index) => {
    if (isInboundTeammateMessage(entry)) {
      inboundIndexes.push(index);
      if (!isTerminalTeammateMessage(entry)) actionableInboundIndexes.push(index);
    }
    if (entryHasWellFormedSendMessage(entry)) reportIndexes.push(index);
  });

  const latestInboundIndex = inboundIndexes.length ? inboundIndexes[inboundIndexes.length - 1] : null;
  // The ack-loop-resolving comparison uses the latest ACTIONABLE (non-
  // terminal) inbound message, not simply the latest inbound message — a
  // trailing terminal ack after a real, still-unaddressed follow-up must NOT
  // mask that follow-up. This is "is there any unaddressed message after the
  // latest report at all", not "was the very last message terminal".
  const latestActionableInboundIndex = actionableInboundIndexes.length
    ? actionableInboundIndexes[actionableInboundIndexes.length - 1]
    : null;
  const latestReportIndex = reportIndexes.length ? reportIndexes[reportIndexes.length - 1] : null;

  let status = 'unobserved';
  if (latestInboundIndex !== null && latestReportIndex === null) status = 'awaiting-initial-report';
  else if (latestActionableInboundIndex !== null && latestReportIndex < latestActionableInboundIndex) status = 'pending-followup';
  else if (latestReportIndex !== null) status = 'clear';

  return {
    status,
    clear: status === 'clear',
    inboundCount: inboundIndexes.length,
    terminalInboundCount: inboundIndexes.length - actionableInboundIndexes.length,
    reportCount: reportIndexes.length,
    latestInboundIndex,
    latestActionableInboundIndex,
    latestReportIndex,
  };
}

module.exports = {
  isInboundTeammateMessage,
  isTerminalTeammateMessage,
  entryHasWellFormedSendMessage,
  evaluatePendingFollowup,
};
