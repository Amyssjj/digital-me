#!/usr/bin/env bash
#
# Watchdog for the `overrides:` floors in pnpm-workspace.yaml. Driven by
# .github/workflows/dependabot-maintenance.yml.
#
# An override is the only tool that fixes a vulnerable *transitive* dependency
# whose parent has not shipped a fix yet — and it is the one dependency edit no
# automation maintains. Dependabot opens pull requests against manifests, never
# against a pnpm override block, so once a floor is written it is frozen until a
# human moves it. When the next advisory for the same package lands
# (brace-expansion alone went 5.0.7 -> 5.0.8 -> 5.0.9 inside a month) the alert
# opens and then simply stays open, because nothing in the pipeline is capable
# of acting on it.
#
# That is how a repo accumulates permanently-open "high" alerts and stops
# reading them. This script finds exactly those alerts — open, against a package
# an override already pins — and says which floor to move where.
#
# It never edits the override block itself: choosing a floor can drag a tree
# across a major to fix a hole that major never had (see the body-parser@1 note
# in pnpm-workspace.yaml), and that call needs a human.
#
# Environment:
#   REPO       owner/name (required)
#   GH_TOKEN   token for `gh`, needs vulnerability-alerts: read (required)
#   DRY_RUN    "true" to report without filing an issue (default true)
#   WORKSPACE  path to the workspace file (default pnpm-workspace.yaml)
set -euo pipefail

REPO="${REPO:?REPO must be set}"
DRY_RUN="${DRY_RUN:-true}"
WORKSPACE="${WORKSPACE:-pnpm-workspace.yaml}"
ISSUE_TITLE="Dependency override floors need a manual bump"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${REPO}/actions/runs/${GITHUB_RUN_ID:-manual}"

summary() { printf '%s\n' "$*" >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"; }
changing() { [ "$DRY_RUN" != "true" ]; }

# --- Read the current floors -------------------------------------------------
# The override block is the last top-level key in the workspace file. Entries are
# `  <package>[@<major>]: <range>`; comments and blank lines are skipped.
#
# Emitted as a plain `package<TAB>major<TAB>floor` table rather than an
# associative array: bash 3.2 ships on macOS and has no `declare -A`, and these
# scripts are meant to stay runnable there for testing.
floors=$(awk '
  /^overrides:[[:space:]]*$/ { inblock = 1; next }
  inblock && /^[^[:space:]]/ { inblock = 0 }
  inblock && /^[[:space:]]+[^#[:space:]]/ {
    line = $0
    sub(/^[[:space:]]+/, "", line)
    idx = index(line, ":")
    if (idx == 0) next
    key = substr(line, 1, idx - 1)
    val = substr(line, idx + 1)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
    gsub(/^["'\'']|["'\'']$/, "", val)
    sub(/^[^0-9]+/, "", val)          # drop the range operator: ^, ~, >=
    at = index(key, "@")
    # A bare `pkg` key applies to every major line, recorded as major "*".
    if (at > 1) print substr(key, 1, at - 1) "\t" substr(key, at + 1) "\t" val
    else        print key "\t*\t" val
  }
' "$WORKSPACE")

if [ -z "$floors" ]; then
  echo "No overrides declared in ${WORKSPACE}; nothing to watch."
  summary ""
  summary "### Override floors"
  summary "_no overrides declared_"
  exit 0
fi

echo "Declared override floors:"
printf '%s\n' "$floors" | sed 's/^/  /'

# True when $1 is a lower version than $2.
below() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ] && [ "$1" != "$2" ]; }

lookup() { # package major -> floor, or empty
  printf '%s\n' "$floors" | awk -F'\t' -v p="$1" -v m="$2" '$1 == p && $2 == m { print $3; exit }'
}
pinned() { # package -> non-empty when any key pins it
  printf '%s\n' "$floors" | awk -F'\t' -v p="$1" '$1 == p { print "yes"; exit }'
}

# --- Cross-reference against open alerts -------------------------------------
alerts=$(gh api "repos/${REPO}/dependabot/alerts" --paginate \
  -q '.[] | select(.state=="open")
      | [.number,
         .security_advisory.severity,
         .dependency.package.name,
         (.security_vulnerability.first_patched_version.identifier // "")]
      | @tsv')

findings=""
while IFS=$'\t' read -r number severity pkg patched; do
  [ -n "${pkg:-}" ] || continue
  # No published fix yet means no floor can be written — not this script's call.
  [ -n "${patched:-}" ] || continue
  [ -n "$(pinned "$pkg")" ] || continue

  major="${patched%%.*}"
  current=$(lookup "$pkg" "$major")
  key="${pkg}@${major}"
  if [ -z "$current" ]; then
    current=$(lookup "$pkg" "*")
    key="$pkg"
  fi

  if [ -z "$current" ]; then
    # Overridden, but on a different major line than this alert. Left to a
    # human: adding a key for a new major can pull the tree backwards.
    findings+="- \`${pkg}\` is pinned, but no key covers the **${major}.x** line — alert #${number} (${severity}) wants \`^${patched}\`"$'\n'
  elif below "$current" "$patched"; then
    findings+="- \`${key}: ^${current}\` → **\`^${patched}\`** — alert #${number} (${severity})"$'\n'
  fi
  # Floor already at or above the advisory: the alert is mid-rescan, not rot.
done <<<"$alerts"

summary ""
summary "### Override floors"
if [ -z "$findings" ]; then
  echo "All override floors are at or above every open advisory."
  summary "_all floors current_"
  exit 0
fi

echo "Override floors behind an open advisory:"
printf '%s' "$findings"
summary "Behind an open advisory — **no bot will fix these**, they need a manual edit:"
summary ""
summary "$findings"

body="These \`overrides:\` floors in \`${WORKSPACE}\` sit below an open Dependabot alert.

Dependabot cannot fix them: it opens pull requests against manifests, never
against a pnpm override block. Until someone edits the floor by hand, these
alerts stay open indefinitely.

${findings}
Bump the floor, run \`pnpm install\` to regenerate the lockfile, and confirm the
alert closes. Check that each bump does not drag the tree across a major to fix
a hole that major never had — see the \`body-parser@1\` note in \`${WORKSPACE}\`.

— [dependabot-maintenance](${RUN_URL})"

if ! changing; then
  echo "DRY RUN — would file or update: ${ISSUE_TITLE}"
  summary ""
  summary "_Dry run — no issue filed._"
  exit 0
fi

existing=$(gh issue list --repo "$REPO" --state open --search "${ISSUE_TITLE} in:title" \
  --json number --jq '.[0].number // ""')
if [ -n "$existing" ]; then
  gh issue comment "$existing" --repo "$REPO" --body "$body"
  echo "Updated issue #${existing}"
else
  gh issue create --repo "$REPO" --title "$ISSUE_TITLE" --body "$body"
fi
