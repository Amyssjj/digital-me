#!/usr/bin/env bash
#
# Invariant: EVERY caller of openclaw's /tools/invoke sends an owning agent.
#
# WHY THIS EXISTS
# openclaw >= 2026.8.1 rejects an invocation on a multi-agent host that carries
# no explicit owner:
#
#   Multiple agents are configured, but session key "main" has no explicit
#   owner. Pass agentId or use an agent-prefixed session key.
#
# One upstream change, but SIX independent call sites in this repo across
# three languages — TypeScript, Python and Bash. Each was found separately, by
# a person noticing a downstream symptom, over about sixteen hours:
#
#   claude-code inject hook   recall silently stopped
#   codex inject hook         same, unnoticed
#   brain MCP proxy           every brain tool failed for every MCP client
#   hermes recall plugin      hermes never injected at all
#   m1_backfill.py            found only by enumerating, not by symptom
#   dream_cycle/brain_client  same — the nightly pipeline
#
# The last two had no reported symptom. They were found by asking "how many
# callers are there?" instead of "what broke?" — which is the whole point of
# this check. A grep finds them once; this makes it an invariant.
#
# The deeper fix is fewer call sites (see PROPOSAL in the repo docs); until
# they are consolidated, this guards the seam.
#
# Exit 0 = every caller conforms. Exit 1 = at least one does not.
# Read-only. Safe to run anywhere, including CI with no gateway present.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
note() { printf '  %s\n' "$1"; }

# Files that POST to the gateway's tool endpoint, excluding tests and builds.
# Read via process substitution, NOT a pipe: the last stage of a pipeline runs
# in a subshell, so an array built there is discarded and this check would
# silently pass with zero callers — the exact failure mode it exists to catch.
# macOS ships bash 3.2, which has no `mapfile`.
CALLERS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && CALLERS+=("$line")
done < <(
  grep -rl "tools/invoke" \
    --include="*.ts" --include="*.py" --include="*.sh" --include="*.mjs" \
    packages/ scripts/ 2>/dev/null \
    | grep -vE "(^|/)(dist|node_modules)/" \
    | grep -vE "\.test\.(ts|py)$|_test\.py$|/test_[^/]*\.py$" \
    | grep -v "verify_gateway_callers.sh" \
    | sort
)

if (( ${#CALLERS[@]} == 0 )); then
  # This repo always has callers. Zero means the search itself broke — which
  # is precisely how this script failed on first run (an array built in a
  # pipeline subshell). A check that cannot find its subject must fail, not
  # report success.
  echo "FAIL gateway-callers: found NO callers — the search is broken, not the repo."
  exit 1
fi

for f in "${CALLERS[@]}"; do
  # A file that only names the URL (a constants module) is not a caller.
  if ! grep -qE '"tool"|tool:|\{tool' "$f" 2>/dev/null; then
    note "skip    $f (references the endpoint but builds no request)"
    continue
  fi
  if grep -q "agentId" "$f" 2>/dev/null; then
    note "ok      $f"
  else
    note "FAIL    $f builds a /tools/invoke request with no agentId"
    fail=1
  fi
done

if (( fail != 0 )); then
  echo ""
  echo "FAIL gateway-callers: a caller omits the owning agent."
  echo "  On a multi-agent host every one of its calls is refused, and callers"
  echo "  that fail open (the inject hooks) will do so SILENTLY."
  echo "  Send agentId, defaulting to \$OPENCLAW_GATEWAY_AGENT_ID or \"main\"."
  exit 1
fi
echo "OK gateway-callers: all ${#CALLERS[@]} caller(s) send an owning agent."
exit 0
