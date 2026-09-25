#!/usr/bin/env bash
# Digital Me: skinny audit log of agent sessions (Claude Code and Codex) for
# protocol compliance. One JSONL line appended per Stop to
# <runtime home>/audit/dm_sessions.jsonl (~/.claude/audit or ~/.codex/audit).
# Not ingested by the dream cycle.
# Silent side-effect — never blocks, never emits stdout. Fails open.
#
# A session with no readable transcript is still recorded (all signals false)
# so the audit counts every Stop the host delivered.

set -u
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

DM_HOOK_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)"
# shellcheck source=dm_hook_lib.sh
. "$DM_HOOK_DIR/dm_hook_lib.sh" 2>/dev/null && dm_hook_init "$@" || exit 0

STDIN="$(cat)"
TRANSCRIPT="$(printf '%s' "$STDIN" | jq -r '.transcript_path // empty' 2>/dev/null)"
SESSION_ID="$(printf '%s' "$STDIN" | jq -r '.session_id // empty' 2>/dev/null)"
CWD="$(printf '%s' "$STDIN" | jq -r '.cwd // empty' 2>/dev/null)"

[ -z "$SESSION_ID" ] && exit 0

AUDIT_DIR="$DM_RUNTIME_HOME/audit"
mkdir -p "$AUDIT_DIR" 2>/dev/null || exit 0
OUT="$AUDIT_DIR/dm_sessions.jsonl"

TS="$(date +%Y-%m-%dT%H:%M:%S%z)"

MEMORY_SEARCH=0
HANDOFF=0
TASK_SESSION=0
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  # Claude Code names the tool mcp__openclaw-brain__memory_search; Codex uses
  # the underscore server name or the bare tool name.
  grep -qE 'mcp__openclaw[-_]brain__memory_search|"(name|tool_name)"[[:space:]]*:[[:space:]]*"memory_search"' "$TRANSCRIPT" 2>/dev/null && MEMORY_SEARCH=1
  # Codex rollouts carry tool arguments as a JSON-encoded string, so the key
  # and value quotes may be backslash-escaped there (\"action\":\"handoff\").
  grep -qE '\\?"action\\?"[[:space:]]*:[[:space:]]*\\?"handoff\\?"' "$TRANSCRIPT" 2>/dev/null && HANDOFF=1
  grep -qE '\\?"action\\?"[[:space:]]*:[[:space:]]*\\?"(run_goal|checkpoint)\\?"' "$TRANSCRIPT" 2>/dev/null && TASK_SESSION=1
fi

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
