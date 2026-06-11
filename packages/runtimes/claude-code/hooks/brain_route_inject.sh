#!/bin/bash
# brain_route_inject.sh — PreToolUse hook for Claude Code
# Reads tool-call JSON on stdin, emits hookSpecificOutput JSON on stdout
# if a brain-MCP protocol rule matches the tool/input combination.
#
# Fail-safe: any error path exits 0 with no inject. Never blocks the tool call.
# Logs every decision (fire and skip) to ~/.claude/logs/brain_route_inject.jsonl
# for offline analysis.

set -uo pipefail

INPUT="$(cat)" || exit 0

LOG="$HOME/.claude/logs/brain_route_inject.jsonl"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

WIKI="${DIGITAL_ME_WIKI_ROOT:-$HOME/digital-me}/wiki"
SNIPPET=""
RULE=""

TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
INPUT_JSON="$(printf '%s' "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null)"
[ -z "$INPUT_JSON" ] && INPUT_JSON="{}"

extract_rule() {
  if [ -f "$1" ]; then
    awk '/^## Rule/,/^## How/' "$1" 2>/dev/null | sed '$d'
  fi
}

case "$TOOL" in
  mcp__openclaw-brain__tasks)
    ACTION="$(printf '%s' "$INPUT_JSON" | jq -r '.action // empty' 2>/dev/null)"
    HAS_OBJ="$(printf '%s' "$INPUT_JSON" | jq '(.tasks|type=="array") or (.variables|type=="object")' 2>/dev/null || echo false)"
    FORMAT="$(printf '%s' "$INPUT_JSON" | jq -r '.format // empty' 2>/dev/null)"

    if [ "$HAS_OBJ" = "true" ]; then
      RULE="stringify-tasks"
      SNIPPET="$(extract_rule "$WIKI/tools/stringify-tasks-tool-parameters.md")"
    elif [[ "$ACTION" =~ ^(board|status|schedule_list|workflow_list)$ ]] && [ "$FORMAT" != "json" ]; then
      RULE="tasks-json-format"
      SNIPPET="$(extract_rule "$WIKI/agents/brain-tasks-json-output-mode.md")"
    fi
    ;;
  Bash)
    CMD="$(printf '%s' "$INPUT_JSON" | jq -r '.command // empty' 2>/dev/null)"
    if [[ "$CMD" =~ sqlite3 ]] \
       && [[ "$CMD" =~ (task-orchestrator\.db|system_monitor\.db|\.openclaw/.*\.db) ]] \
       && [[ "$CMD" =~ (INSERT|UPDATE|DELETE|REPLACE[[:space:]]+INTO) ]]; then
      RULE="brain-write-via-tasks"
      SNIPPET="$(extract_rule "$WIKI/tools/use-brain-tasks-for-orchestrator-writes.md")"
    fi
    ;;
esac

# Always log (numerator data for compliance metrics)
INJECTED="no"
[ -n "$SNIPPET" ] && INJECTED="yes"
{
  jq -nc \
    --arg t "$(date -u +%FT%TZ)" \
    --arg tool "$TOOL" \
    --arg rule "$RULE" \
    --arg injected "$INJECTED" \
    '{t:$t, tool:$tool, rule:$rule, injected:$injected}' \
    >> "$LOG" 2>/dev/null
} || true

if [ -n "$SNIPPET" ]; then
  jq -nc --arg s "From digital-me wiki — protocol rule: $RULE

$SNIPPET" '{hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$s}}' 2>/dev/null || exit 0
fi

exit 0
