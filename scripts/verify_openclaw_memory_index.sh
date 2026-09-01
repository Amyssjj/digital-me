#!/usr/bin/env bash
#
# Health gate: catch openclaw memory-index reindex failures and the disk they leak.
#
# THE FAILURE THIS CATCHES
# openclaw's memory engine (`memory-core-host-engine-storage`) builds a full
# reindex into a temporary sibling database named
# `<agent>.sqlite.memory-reindex-<uuid>`. When the live index revision moves
# while that build is running it aborts with:
#
#   [memory] sync failed (search): Memory index changed while full reindex was
#   building (expected revision N, found N+1); retry the full reindex.
#
# and — the actual damage — it does NOT remove the temp database. Each aborted
# attempt strands a copy the size of the agent's whole index. Observed on
# 2026-08-31: four orphans on `coo` (4.8 GiB) plus one on `main` (369 MB) from
# a single afternoon, while `openclaw memory status` still reported
# `Dirty: no` and every search kept working.
#
# That combination is why nothing else notices: the index is healthy, search
# succeeds, the gateway probe passes, and the only symptom is disk quietly
# disappearing plus RSS spikes during each doomed rebuild.
#
# This is an UPSTREAM defect — digital-me cannot fix it (see
# docs/UPSTREAM-ADAPTATION-CONSTRAINT.md: we consume openclaw, we don't change
# it). Per that document's prescribed pattern the downstream job is
# detect-and-degrade-and-notify, which is what this script is.
#
# Exit 0 = clean. Exit 1 = orphaned reindex databases over threshold, or a
# livelock signature in the gateway log.
#
# Read-only: no writes, no network, no LLM. Safe to run at any time.

set -uo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
AGENTS_DIR="$OPENCLAW_HOME/agents"
# One stranded temp DB can be a genuinely in-flight rebuild; two or more is a
# leak. Override for a machine with a different tolerance.
MAX_ORPHANS="${OPENCLAW_MAX_REINDEX_ORPHANS:-1}"

fail=0
note() { printf '  %s\n' "$1"; }

if [[ ! -d "$AGENTS_DIR" ]]; then
  echo "SKIP openclaw-memory-index: no $AGENTS_DIR (openclaw not installed here)"
  exit 0
fi

# ── 1. Orphaned reindex databases ───────────────────────────────────────
# Match openclaw's own naming (src/infra/backup-volatile-filter.ts treats
# these as transient artifacts). Count only the base file, not -wal/-shm.
# Portable collection: macOS ships bash 3.2, which has no `mapfile`.
orphans=()
while IFS= read -r line; do
  [[ -n "$line" ]] && orphans+=("$line")
done < <(
  find "$AGENTS_DIR" -maxdepth 3 -name '*.sqlite.memory-reindex-*' 2>/dev/null \
    | grep -vE -- '-(wal|shm|journal)$' | sort
)

if (( ${#orphans[@]} > MAX_ORPHANS )); then
  total=$(du -ch "${orphans[@]}" 2>/dev/null | tail -1 | awk '{print $1}')
  note "FAIL    ${#orphans[@]} orphaned reindex database(s) (~${total:-?}), threshold ${MAX_ORPHANS}"
  for o in "${orphans[@]}"; do
    agent=$(sed -E 's|.*/agents/([^/]+)/.*|\1|' <<<"$o")
    sz=$(du -h "$o" 2>/dev/null | awk '{print $1}')
    note "          ${agent}: ${sz}  $(basename "$o")"
  done
  note "        Each is a full reindex that aborted without cleaning up."
  note "        Upstream: openclaw memory-core-host-engine-storage."
  note "        Safe to delete when no reindex is running (verify the files are"
  note "        not growing first), but they WILL come back until upstream fixes it."
  fail=1
elif (( ${#orphans[@]} > 0 )); then
  note "warn    ${#orphans[@]} reindex database present (within threshold ${MAX_ORPHANS}; may be in flight)"
else
  note "ok      no orphaned reindex databases"
fi

# ── 2. Livelock signature in the gateway log ────────────────────────────
# Same log-resolution problem as verify_openclaw_hooks.sh: the service's
# StandardOutPath moved to ~/Library/Logs, and openclaw hardcodes
# StandardErrorPath to /dev/null (daemon/launchd-service-files.ts), so the
# error stream is only visible when the operator has redirected it. Pick the
# newest candidate and say which one was read.
resolve_log() {
  local newest="" cand
  for cand in \
    "${OPENCLAW_GATEWAY_LOG:-}" \
    "$HOME/Library/Logs/openclaw/gateway.err.log" \
    "$HOME/Library/Logs/openclaw/gateway.log" \
    "$OPENCLAW_HOME/logs/gateway.log"; do
    [[ -n "$cand" && -f "$cand" ]] || continue
    if [[ -z "$newest" || "$cand" -nt "$newest" ]]; then newest="$cand"; fi
  done
  printf '%s\n' "$newest"
}
LOG="$(resolve_log)"

if [[ -n "$LOG" ]]; then
  note "log     $LOG"
  hits=$(tail -c 4000000 "$LOG" 2>/dev/null \
    | grep -c "Memory index changed while full reindex" || true)
  if (( hits > 0 )); then
    note "FAIL    ${hits} full-reindex abort(s) in the log tail — the rebuild is not converging:"
    tail -c 4000000 "$LOG" 2>/dev/null \
      | grep -o "expected revision [0-9]*, found [0-9]*" | tail -3 \
      | sed 's/^/          /'
    fail=1
  else
    note "ok      no full-reindex aborts in the log tail"
  fi
else
  note "warn    no gateway log found — livelock signal not checked"
fi

if (( fail != 0 )); then
  echo "FAIL openclaw-memory-index: reindex is leaking or not converging."
  exit 1
fi
echo "OK openclaw-memory-index: no reindex leak or livelock detected."
exit 0
