#!/usr/bin/env bash
# Digital Me: remind the agent to call tasks.handoff if the turn did work
# without a handoff. Runs on Stop (Claude Code and Codex). Fires at most once
# per session (respects stop_hook_active).
#
# Tool names the transcript scan accepts, per host:
#   - file mutations: Claude Code's Edit/Write/NotebookEdit/MultiEdit, Codex's
#     `apply_patch` (custom_tool_call).
#   - the brain tasks tool: `mcp__digital-me-brain__tasks` (Claude Code),
#     `mcp__digital_me_brain__tasks` or bare `tasks` (Codex); the legacy
#     `openclaw-brain` spellings still count.
# Runtime (`--runtime claude-code|codex`, see dm_hook_lib.sh) only changes the
# wording of the reminder so it names the tools that runtime actually has.

set -u
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

DM_HOOK_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)"
# shellcheck source=dm_hook_lib.sh
. "$DM_HOOK_DIR/dm_hook_lib.sh" 2>/dev/null && dm_hook_init "$@" || exit 0

STDIN="$(cat)"

ACTIVE="$(printf '%s' "$STDIN" | jq -r '.stop_hook_active // false' 2>/dev/null)"
[ "$ACTIVE" = "true" ] && exit 0

TRANSCRIPT="$(printf '%s' "$STDIN" | jq -r '.transcript_path // empty' 2>/dev/null)"
[ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ] && exit 0

# Non-trivial work signal: any file-mutating tool use in this session.
if ! grep -qE '"(name|tool_name)"[[:space:]]*:[[:space:]]*"(apply_patch|Edit|Write|NotebookEdit|MultiEdit)"' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi

# Open-task signal: only remind if this session was dispatched as a task
# (run_goal) or mid-task (checkpoint). Ad-hoc interactive sessions have no task
# to hand off to, so the reminder would be noise.
if ! grep -qE 'mcp__(digital[-_]me|openclaw)[-_]brain__tasks|"(name|tool_name)"[[:space:]]*:[[:space:]]*"tasks"' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi
# Codex rollouts carry tool arguments as a JSON-encoded string, so the key
# and value quotes may be backslash-escaped there (\"action\":\"checkpoint\").
if ! grep -qE '\\?"action\\?"[[:space:]]*:[[:space:]]*\\?"(run_goal|checkpoint)\\?"' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi

# Handoff signal: tasks tool call with handoff action in the args.
if grep -qE '\\?"action\\?"[[:space:]]*:[[:space:]]*\\?"handoff\\?"' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi

case "$DM_RUNTIME" in
  codex)
    WORK_TOOLS="apply_patch"
    TASKS_TOOL="digital-me-brain tasks"
    ;;
  *)
    WORK_TOOLS="Edit/Write/NotebookEdit"
    TASKS_TOOL="mcp__digital-me-brain__tasks"
    ;;
esac

jq -cn --arg work "$WORK_TOOLS" --arg tasks "$TASKS_TOOL" '{
  decision: "block",
  reason: ("Digital Me protocol check: this turn modified files (" + $work + ") but no " + $tasks + " action=handoff was recorded. Before stopping, call tasks with action=handoff and a short summary (what changed, reusable insights, follow-ups). If the work was too trivial to warrant a handoff, say so in one sentence and stop — this reminder will not fire again this session.")
}'
