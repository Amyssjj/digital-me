#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Sanitization gate — fail if any package source file contains personal
# identifiers, hardcoded user paths, or organization-specific names.
#
# This script is run by CI on every PR and as a pre-commit hook locally.
# If it fails, the leak must be either:
#   (a) moved to a config-loaded value (see packages/shared/contracts/),
#   (b) replaced with a generic placeholder, or
#   (c) added to ALLOWLIST below with a written justification.
#
# Scans: packages/**, docs/**, scripts/**, *.md, *.json (excluding allowlist)
# Skips: node_modules, dist, build, .git, *.example.*
# ---------------------------------------------------------------------------

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ---------------------------------------------------------------------------
# Forbidden patterns
#
# Each entry is a regex that should NEVER appear in code or docs.
# Add new entries as new leakage vectors are discovered.
# ---------------------------------------------------------------------------

declare -a FORBIDDEN_PATTERNS=(
  # User home / machine paths
  '/Users/[a-zA-Z0-9_-]+'
  '/Volumes/[A-Za-z0-9_-]+_SSD'
  '/Volumes/[A-Za-z0-9_-]+_Workspaces'

  # Known personal organization names (case-insensitive variations)
  '\bMotus\b'
  '\bMotusAI\b'
  '\bMotusCOO\b'
  '\bMotus_SSD\b'
  '\bMotusAI[_ ]Teams\b'
  '\bMotusAI[_ ]Workspaces\b'

  # Known personal user identifiers — DO NOT remove without confirming the
  # identifier is not the current maintainer's. `Jing` is capital-J only:
  # lowercase `jing` appears in legacy schema/identity keys (question_for_jing,
  # jing_modal) that match the owner's existing local DB and are retired with
  # the legacy dashboard reader. NB: the GitHub owner handle (in canonical
  # repo URLs in README/pyproject/RELEASING) is public identity, deliberately
  # NOT forbidden — only private identifiers are.
  '\bjingshi\b'
  '\bamysj1983\b'
  '\bJing\b'

  # Personal project codenames / agent IDs that have appeared in source today.
  # If a different deployment needs these names, override via config.
  '\bPodcastCoach\b'
  '\bReadingMaster\b'
  '\bMarketingWriter\b'
  '\bMarketingVideo\b'

  # Personal command paths that have appeared in code
  '/opt/homebrew/bin/node /Users/'
  '~/Documents/mission-control'

  # ── Secret material — credential leak vectors ──
  # High-signal, prefix-anchored token shapes (low false-positive risk). A real
  # key committed to source must be rotated + moved to env/config, never landed.
  '\bsk-[A-Za-z0-9]{32,}'             # OpenAI classic API key (sk- + long unbroken alnum)
  '\bsk-(ant|proj)-[A-Za-z0-9_-]{20,}' # Anthropic / OpenAI project keys (hyphenated prefixes)
  'ghp_[A-Za-z0-9]{36}'               # GitHub personal access token (classic)
  'gh[ousr]_[A-Za-z0-9]{36}'          # GitHub oauth/user/server/refresh tokens
  'github_pat_[A-Za-z0-9_]{60,}'      # GitHub fine-grained PAT
  'AKIA[0-9A-Z]{16}'                  # AWS access key ID
  'AIza[0-9A-Za-z_-]{35}'             # Google API key
  'xox[baprs]-[0-9A-Za-z-]{10,}'      # Slack tokens
  '-----BEGIN [A-Z ]*PRIVATE KEY-----' # PEM private key blocks
)

# ---------------------------------------------------------------------------
# Allowlist — files that may legitimately reference forbidden patterns
# (e.g. this script itself, which DEFINES the patterns).
# ---------------------------------------------------------------------------

declare -a ALLOWLIST=(
  'scripts/sanitize-check.sh'
  'docs/SANITIZATION.md'
)

# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

# Build the file list. Walk: packages, docs, scripts, top-level *.md/*.json
# Exclude: node_modules, dist, build, .git, *.example.*, *.lock
# Portable to bash 3.2 (macOS default) — no mapfile.
SCANNED_FILE="$(mktemp)"
trap 'rm -f "$SCANNED_FILE"' EXIT

# Search dirs that exist (empty scaffold may not have all of these yet).
# `tests` and `.github` are NOT optional extras: a personal-machine regression
# baseline under tests/ and a workflow default under .github/ both leaked
# precisely because earlier versions of this script skipped those roots.
SEARCH_DIRS=""
for d in packages docs scripts tests .github; do
  [ -d "$d" ] && SEARCH_DIRS="$SEARCH_DIRS $d"
done

if [ -n "$SEARCH_DIRS" ]; then
  # shellcheck disable=SC2086
  find $SEARCH_DIRS -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \
       -o -name '*.cjs' -o -name '*.md' -o -name '*.json' -o -name '*.yaml' \
       -o -name '*.yml' -o -name '*.sh' -o -name '*.py' -o -name '*.toml' \
       -o -name '*.html' -o -name '*.css' -o -name '*.txt' -o -name '*.plist' \) \
    ! -path '*/node_modules/*' \
    ! -path '*/dist/*' \
    ! -path '*/npm-dist/*' \
    ! -path '*/build/*' \
    ! -path '*/coverage/*' \
    ! -name '*.example.*' \
    ! -name '*.lock' \
    2>/dev/null > "$SCANNED_FILE"
fi

# Also include top-level package.json, tsconfig, README, etc.
for f in package.json tsconfig.base.json README.md; do
  [ -f "$f" ] && echo "$f" >> "$SCANNED_FILE"
done

# Filter out allowlist
SCANNED_FILTERED="$(mktemp)"
trap 'rm -f "$SCANNED_FILE" "$SCANNED_FILTERED"' EXIT

while IFS= read -r f; do
  skip=0
  for allowed in "${ALLOWLIST[@]}"; do
    if [ "$f" = "$allowed" ]; then
      skip=1
      break
    fi
  done
  if [ $skip -eq 0 ]; then
    echo "$f" >> "$SCANNED_FILTERED"
  fi
done < "$SCANNED_FILE"

scanned_count=$(wc -l < "$SCANNED_FILTERED" | tr -d ' ')
if [ "$scanned_count" -eq 0 ]; then
  echo "sanitize-check: no files to scan (this is fine for an empty scaffold)."
  exit 0
fi

# ---------------------------------------------------------------------------
# Run regex sweep
# ---------------------------------------------------------------------------

violations=0
for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  matches=$(xargs grep -InE "$pattern" < "$SCANNED_FILTERED" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo ""
    echo "FORBIDDEN PATTERN: $pattern"
    echo "$matches" | sed 's/^/  /'
    violations=$((violations + 1))
  fi
done

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

echo ""
if [ $violations -eq 0 ]; then
  echo "sanitize-check: clean. ($scanned_count files scanned, ${#FORBIDDEN_PATTERNS[@]} patterns checked)"
  exit 0
else
  echo "sanitize-check: FAILED — found $violations forbidden-pattern matches."
  echo ""
  echo "Fix options:"
  echo "  1. Move the value to packages/shared/contracts/ (env-var driven config)."
  echo "  2. Replace with a generic placeholder."
  echo "  3. If the match is a false positive, add the file to ALLOWLIST in this script."
  echo ""
  echo "See docs/SANITIZATION.md for the full policy."
  exit 1
fi
