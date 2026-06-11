#!/usr/bin/env bash
# Digital Me: skinny audit log of Claude Code sessions for protocol compliance.
# One JSONL line appended per Stop. Not ingested by the dream cycle.
# Silent side-effect — never blocks, never emits stdout. Fails open.

set -u
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

STDIN="$(cat)"
TRANSCRIPT="$(printf '%s' "$STDIN" | jq -r '.transcript_path // empty' 2>/dev/null)"
SESSION_ID="$(printf '%s' "$STDIN" | jq -r '.session_id // empty' 2>/dev/null)"
CWD="$(printf '%s' "$STDIN" | jq -r '.cwd // empty' 2>/dev/null)"

[ -z "$TRANSCRIPT" ] && exit 0
[ ! -f "$TRANSCRIPT" ] && exit 0
[ -z "$SESSION_ID" ] && exit 0

AUDIT_DIR="$HOME/.claude/audit"
mkdir -p "$AUDIT_DIR" 2>/dev/null || exit 0
OUT="$AUDIT_DIR/dm_sessions.jsonl"

TS="$(date +%Y-%m-%dT%H:%M:%S%z)"

MEMORY_SEARCH=0
grep -q 'mcp__openclaw-brain__memory_search' "$TRANSCRIPT" 2>/dev/null && MEMORY_SEARCH=1

HANDOFF=0
grep -qE '"action"[[:space:]]*:[[:space:]]*"handoff"' "$TRANSCRIPT" 2>/dev/null && HANDOFF=1

TASK_SESSION=0
grep -qE '"action"[[:space:]]*:[[:space:]]*"(run_goal|checkpoint)"' "$TRANSCRIPT" 2>/dev/null && TASK_SESSION=1

jq -cn \
  --arg ts "$TS" \
  --arg sid "$SESSION_ID" \
  --arg cwd "$CWD" \
  --argjson ms "$MEMORY_SEARCH" \
  --argjson ho "$HANDOFF" \
  --argjson tk "$TASK_SESSION" \
  '{ts:$ts, session_id:$sid, cwd:$cwd, memory_search:($ms==1), handoff:($ho==1), task_session:($tk==1)}' \
  >> "$OUT" 2>/dev/null

exit 0
