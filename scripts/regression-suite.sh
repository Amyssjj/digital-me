#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Regression suite — run before each phase switchover.
#
# The success criterion for the digital-me-os migration is that every
# owner-facing behavior runs through this repo identically to the prior
# personal setup. This harness encodes that test as code so we cannot
# accidentally regress.
#
# Phase-specific test files live in `tests/regression/phase-<N>-*.sh`
# and are picked up automatically. Each test:
#   - captures a baseline (old setup) on first run, stored in
#     tests/regression/baselines/
#   - runs the equivalent action on the new setup and diffs vs baseline
#   - exits non-zero if behavior differs
#
# Usage:
#   bash scripts/regression-suite.sh             # run all phases' tests
#   bash scripts/regression-suite.sh phase-1     # run one phase's tests
#   bash scripts/regression-suite.sh --capture   # capture baselines (one-shot)
# ---------------------------------------------------------------------------

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TESTS_DIR="tests/regression"
BASELINES_DIR="$TESTS_DIR/baselines"

mkdir -p "$BASELINES_DIR"

MODE="run"
PHASE_FILTER=""

for arg in "$@"; do
  case "$arg" in
    --capture) MODE="capture" ;;
    phase-*)   PHASE_FILTER="$arg" ;;
    -h|--help)
      sed -n '2,/^# ---/p' "$0"
      exit 0
      ;;
    *) echo "regression-suite: unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Locate test scripts
# ---------------------------------------------------------------------------

if [ ! -d "$TESTS_DIR" ]; then
  echo "regression-suite: tests/regression/ not yet populated. Skipping."
  echo "(Each phase will add tests/regression/phase-<N>-*.sh as it lands.)"
  exit 0
fi

TEST_LIST="$(mktemp)"
trap 'rm -f "$TEST_LIST"' EXIT
find "$TESTS_DIR" -maxdepth 1 -name 'phase-*.sh' -type f 2>/dev/null | sort > "$TEST_LIST"

if [ -n "$PHASE_FILTER" ]; then
  FILTERED="$(mktemp)"
  trap 'rm -f "$TEST_LIST" "$FILTERED"' EXIT
  while IFS= read -r f; do
    case "$(basename "$f")" in
      "$PHASE_FILTER"*.sh) echo "$f" >> "$FILTERED" ;;
    esac
  done < "$TEST_LIST"
  mv "$FILTERED" "$TEST_LIST"
fi

test_count=$(wc -l < "$TEST_LIST" | tr -d ' ')
if [ "$test_count" -eq 0 ]; then
  echo "regression-suite: no test files match filter '$PHASE_FILTER'."
  exit 0
fi

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

export REGRESSION_MODE="$MODE"
export REGRESSION_BASELINES_DIR="$BASELINES_DIR"

failures=0
while IFS= read -r f; do
  echo ""
  echo "▶ $(basename "$f")"
  if bash "$f"; then
    echo "  (test exited 0)"
  else
    echo "  (test exited non-zero)"
    failures=$((failures + 1))
  fi
done < "$TEST_LIST"

echo ""
if [ $failures -eq 0 ]; then
  echo "regression-suite: all $test_count test files passed."
  exit 0
else
  echo "regression-suite: $failures of $test_count test files failed."
  exit 1
fi
