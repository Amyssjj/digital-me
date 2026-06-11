#!/usr/bin/env bash
# Digital Me: remind Claude to call tasks.handoff if the turn did work without handoff.
# Runs on Stop. Fires at most once per session (respects stop_hook_active).

set -u
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

STDIN="$(cat)"

ACTIVE="$(printf '%s' "$STDIN" | jq -r '.stop_hook_active // false' 2>/dev/null)"
[ "$ACTIVE" = "true" ] && exit 0

TRANSCRIPT="$(printf '%s' "$STDIN" | jq -r '.transcript_path // empty' 2>/dev/null)"
[ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ] && exit 0

# Non-trivial work signal: any write-ish tool use in this session.
if ! grep -qE '"(name|tool_name)"[[:space:]]*:[[:space:]]*"(Edit|Write|NotebookEdit|MultiEdit)"' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi

# Open-task signal: only remind if this session was dispatched as a task
# (run_goal) or mid-task (checkpoint). Ad-hoc interactive sessions have no task
# to hand off to, so the reminder would be noise.
if ! grep -q 'mcp__openclaw-brain__tasks' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi
if ! grep -qE '"action"[[:space:]]*:[[:space:]]*"(run_goal|checkpoint)"' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi

# Handoff signal: tasks tool call with handoff action in the args.
if grep -qE '"action"[[:space:]]*:[[:space:]]*"handoff"' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi

jq -cn '{
  decision: "block",
  reason: "Digital Me protocol check: this turn modified files (Edit/Write/NotebookEdit) but no mcp__openclaw-brain__tasks action=handoff was recorded. Before stopping, call tasks with action=handoff and a short summary (what changed, reusable insights, follow-ups). If the work was too trivial to warrant a handoff, say so in one sentence and stop — this reminder will not fire again this session."
}'
