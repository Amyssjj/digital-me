#!/usr/bin/env bash
#
# Upstream openclaw watch — for a host deliberately soaking a release before
# committing to it.
#
# Reports three things and nothing else:
#   1. Installed version vs the npm dist-tags (is a newer stable out?)
#   2. Whether a newer stable touches the subsystems that broke us
#   3. The state of the upstream issues we are blocked on / tracking
#
# Read-only: no installs, no config writes, no gateway restarts. It tells you
# when to look; it never acts. That distinction matters — an auto-updater is
# exactly what you do NOT want on a host you are soaking.
#
# Usage:  bash scripts/watch_openclaw_upstream.sh
# Exit:   0 always (this is a report, not a gate) unless --strict is passed,
#         which exits 1 when a newer stable exists.

set -uo pipefail
STRICT=0
[[ "${1:-}" == "--strict" ]] && STRICT=1

say() { printf '%s\n' "$1"; }
hr() { printf '%s\n' "────────────────────────────────────────────────────────"; }

# ── 1. versions ─────────────────────────────────────────────────────────
INSTALLED="$(openclaw --version 2>/dev/null | awk '{print $2}')"
TAGS_JSON="$(npm view openclaw dist-tags --json 2>/dev/null)"
LATEST="$(printf '%s' "$TAGS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("latest",""))' 2>/dev/null)"
EXTENDED="$(printf '%s' "$TAGS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("extended-stable",""))' 2>/dev/null)"

hr; say "openclaw upstream watch — $(date '+%Y-%m-%d %H:%M')"; hr
say "  installed        : ${INSTALLED:-unknown}"
say "  latest (npm)     : ${LATEST:-unknown}"
say "  extended-stable  : ${EXTENDED:-unknown}"

NEWER=0
if [[ -n "$INSTALLED" && -n "$LATEST" && "$INSTALLED" != "$LATEST" ]]; then
  NEWER=1
  say ""
  say "  ► NEWER STABLE AVAILABLE: $INSTALLED → $LATEST"
fi

# ── 2. does the new release touch what broke us? ────────────────────────
# Only meaningful with a local checkout holding both tags.
REPO="${OPENCLAW_REPO:-$HOME/openclaw}"
if (( NEWER )) && [[ -d "$REPO/.git" ]]; then
  git -C "$REPO" fetch origin --tags --quiet 2>/dev/null || true
  if git -C "$REPO" rev-parse "v$LATEST" >/dev/null 2>&1; then
    say ""
    say "  memory-core changes in v$INSTALLED..v$LATEST:"
    git -C "$REPO" log --oneline "v$INSTALLED..v$LATEST" -- extensions/memory-core/ 2>/dev/null \
      | head -15 | sed 's/^/      /'
    say ""
    say "  plugin-loader / hook changes:"
    git -C "$REPO" log --oneline "v$INSTALLED..v$LATEST" -- src/plugins/ 2>/dev/null \
      | head -10 | sed 's/^/      /'
  fi
fi

# ── 3. tracked upstream issues ──────────────────────────────────────────
# Everything digital-me is currently working around. When one of these closes
# WITH a fix in a shipped stable, the corresponding local workaround may be
# retired — check before assuming.
ISSUES=(
  "128140:memory_search tool always times out (15s) — coo is over the line"
  "121043:zero-hit query rebuilds the whole index — drove the reindex storms"
  "134337:dirty maintenance repeatedly full-reindexes under concurrent writes"
  "134332:maintenance reindex fails after a concurrent incremental write"
  "132708:embeddings need configurable throttle + honor Retry-After + batch"
  "135086:observability gaps — conflated status=unavailable"
  "134830:aborted reindex strands its temp DB (ours; closed NOT_PLANNED)"
)
if command -v gh >/dev/null 2>&1; then
  say ""; hr; say "  tracked upstream issues"; hr
  for entry in "${ISSUES[@]}"; do
    n="${entry%%:*}"; desc="${entry#*:}"
    state="$(gh issue view "$n" --repo openclaw/openclaw --json state,stateReason \
      --jq '.state + (if .stateReason then " ("+.stateReason+")" else "" end)' 2>/dev/null)"
    printf '  #%-7s %-22s %s\n' "$n" "${state:-unknown}" "$desc"
  done
else
  say ""; say "  (gh not on PATH — skipping upstream issue status)"
fi

say ""
if (( NEWER )); then
  say "  Next step is a JUDGEMENT call, not an upgrade: read the changes above,"
  say "  check whether any tracked issue closed, then decide. The upgrade path is"
  say "  documented in wiki: infrastructure/openclaw-2026-8-1-cutover-blockers."
else
  say "  No newer stable. Nothing to do."
fi
hr

(( STRICT && NEWER )) && exit 1
exit 0
