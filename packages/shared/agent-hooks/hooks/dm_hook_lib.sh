# shellcheck shell=bash
# Digital Me: shared runtime resolution for the agent hooks.
#
# Sourced (never executed) by every hook in this directory. The same scripts
# are installed for Claude Code (~/.claude/hooks) and Codex (~/.codex/hooks);
# only a few things genuinely differ between the two hosts, and they are all
# derived here from ONE runtime id:
#
#   DM_RUNTIME          claude-code | codex — exported so dm_m1_emit.py (a
#                       child process) labels its events and picks its WAL
#                       and once-only flag with the same id.
#   DM_RUNTIME_HOME     ~/.claude | ~/.codex — where logs/audit/app-rate go.
#   DM_SEEN_PREFIX      per-session dedup cache written by the inject hook
#                       and read by the Stop hook. The codex tag keeps the two
#                       runtimes from cross-deduping each other.
#   DM_M1_FLAG_PREFIX   once-only session_start flag (same names
#                       dm_m1_emit.py uses: SESSION_START_FLAG_PREFIX).
#
# Resolution order (first hit wins):
#   1. `--runtime <id>` / `--runtime=<id>` in the hook's argv — what
#      `digital-me install` bakes into the registered hook command line.
#   2. DM_RUNTIME in the environment.
#   3. The install location: a hook that lives under a `.codex/` directory is
#      the Codex copy, anything else is Claude Code (keeps a hook command
#      registered by an older installer, with no argv, working).
#
# dm_hook_init returns non-zero on an unknown runtime id; callers fail open.

dm_hook_init() {
  local rt=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --runtime=*) rt="${1#--runtime=}" ;;
      --runtime) shift; rt="${1:-}" ;;
    esac
    [ "$#" -gt 0 ] && shift
  done
  [ -z "$rt" ] && rt="${DM_RUNTIME:-}"
  if [ -z "$rt" ]; then
    case "${DM_HOOK_DIR:-}/" in
      */.codex/*) rt="codex" ;;
      *) rt="claude-code" ;;
    esac
  fi
  case "$rt" in
    claude-code)
      DM_RUNTIME_HOME="$HOME/.claude"
      DM_STATE_TAG=""
      ;;
    codex)
      DM_RUNTIME_HOME="$HOME/.codex"
      DM_STATE_TAG="codex_"
      ;;
    *)
      return 1
      ;;
  esac
  DM_RUNTIME="$rt"
  export DM_RUNTIME
  DM_SEEN_PREFIX="/tmp/dm_hook_seen_${DM_STATE_TAG}"
  DM_M1_FLAG_PREFIX="/tmp/dm_m1_started_${DM_STATE_TAG}"
  return 0
}
