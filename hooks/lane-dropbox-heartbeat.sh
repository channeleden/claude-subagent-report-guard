#!/bin/sh
# lane-dropbox-heartbeat.sh — POSIX sh prefilter for lane-dropbox-heartbeat.js
#
# This prefilter avoids spawning node for the common case where the session
# has no active subagent lanes. It reads the hook payload from stdin, extracts
# transcript_path via sed/grep (no node, no jq), derives the session directory
# using the same logic as the JS hook, and skips node invocation if that
# directory does not exist.
#
# This is deliberately Claude-Code-specific: PostToolUse is a Claude Code hook,
# and the other provider surfaces do not have this failure mode (they do not
# fire on every tool call across all lanes). The optimization targets Claude
# Code's specific baseline cost (~17ms process startup per tool call in a main
# session with no subagents).
#
# CRITICAL INVARIANT (inherited from the JS hook):
#   - Must ALWAYS exit 0, even on error paths
#   - Must NEVER write a {decision: ...} field to stdout
#   - Must fail OPEN — when in doubt, fall through to node, never skip
#
# Rationale: a prefilter that wrongly skips is a silently broken guard. A
# prefilter that sometimes invokes node and sometimes doesn't, but both paths
# eventually exit 0, is correct. The worst failure mode is a false negative
# (skipping when we should have invoked).

# Read the entire payload from stdin into a variable.
# We must read it exactly once and forward it verbatim to node.
payload="$(cat)"

# Extract transcript_path from the JSON payload using sed and grep.
# Pattern: "transcript_path":"<value>" or "transcript_path": "<value>"
# We use sed to find the line, then extract the value between quotes.
transcript_path="$(printf '%s\n' "$payload" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"

# If transcript_path is empty or unparseable, fail open — invoke node anyway.
if [ -z "$transcript_path" ]; then
  printf '%s\n' "$payload" | exec node "$(dirname "$0")/lane-dropbox-heartbeat.js"
  exit 0
fi

# Derive the session directory from transcript_path using the same logic as JS:
#
# 1. If transcript_path ends with .jsonl, remove it (base)
# 2. Find the last occurrence of /subagents/ in the path
# 3. If found, return everything before /subagents/
# 4. If not found, return base
#
# In POSIX sh, we simulate this with string manipulation.

# Step 1: Remove .jsonl suffix if present
base="$transcript_path"
case "$base" in
  *.jsonl)
    base="${base%.jsonl}"
    ;;
esac

# Step 2 & 3: Find /subagents/ marker and extract session dir
# Use parameter expansion to find the last occurrence of /subagents/
# We'll use a case statement to check if /subagents/ exists at all
case "$base" in
  *"/subagents/"*)
    # The marker exists. We need to extract everything before it.
    # In POSIX sh without advanced regex, we can use sed for this.
    #
    # ASSUMPTION this depends on: a FLAT subagents dir — exactly one
    # `/subagents/` segment directly under the session dir, never a
    # subagent spawning its own nested `subagents/` dir. `sed`'s `s///`
    # here removes from the FIRST match of `/subagents/` onward, not the
    # last; that only agrees with `lib/subagent-transcript.js`'s own
    # `subagentSessionDir` (which explicitly uses `lastIndexOf`) because the
    # flat-layout assumption means there is only ever one such segment to
    # find in the first place. If that JS-side layout ever changes to allow
    # nesting, this line must change to match (or this prefilter can
    # silently derive the wrong session dir and skip node when it
    # shouldn't) — the two are NOT independently maintainable.
    session_dir="$(printf '%s\n' "$base" | sed 's|/subagents/.*||')"
    ;;
  *)
    # No /subagents/ marker — session_dir is base itself
    session_dir="$base"
    ;;
esac

# Now check if the subagents directory exists.
# If it doesn't, we have no subagent lanes, so skip node invocation.
subagents_dir="${session_dir}/subagents"

if [ ! -d "$subagents_dir" ]; then
  # No subagents directory → no subagent lanes → skip node, exit 0 immediately.
  exit 0
fi

# The subagents directory exists, so we must invoke node to handle the
# identity resolution and heartbeat writing.
printf '%s\n' "$payload" | exec node "$(dirname "$0")/lane-dropbox-heartbeat.js"
exit 0
