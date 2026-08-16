#!/usr/bin/env bash
#
# Janitor for the Dependabot PR queue. Driven by
# .github/workflows/dependabot-maintenance.yml — see that file for the rationale.
#
# This script never merges anything. Deciding that a bump is safe to land needs
# Dependabot's update-type metadata (only available on a `pull_request` event)
# and branch protection's merge-time evaluation; neither is available here, so
# the decision is left entirely to dependabot-auto-merge.yml and to GitHub. All
# this does is clear the friction that stops those two from reaching a decision.
#
# Environment:
#   REPO             owner/name (required)
#   GH_TOKEN         token for `gh` (required)
#   DRY_RUN          "true" to report without changing anything (default true)
#   MAX_REBASES      max branches to nudge per run (default 3)
#   STALE_DAYS       close required-check failures older than this (default 30)
#   REQUIRED_CHECKS  JSON array of required status check names (required)
set -euo pipefail

REPO="${REPO:?REPO must be set}"
DRY_RUN="${DRY_RUN:-true}"
MAX_REBASES="${MAX_REBASES:-3}"
STALE_DAYS="${STALE_DAYS:-30}"
REQUIRED_CHECKS="${REQUIRED_CHECKS:?REQUIRED_CHECKS must be a JSON array}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${REPO}/actions/runs/${GITHUB_RUN_ID:-manual}"

summary() { printf '%s\n' "$*" >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"; }
changing() { [ "$DRY_RUN" != "true" ]; }

# Skip ledger. Every PR this run declines to act on gets a line here with the
# reason. Without it a run that silently skipped everything is indistinguishable
# from a run that had nothing to do — which is exactly how the auto-merge
# workflow this replaces managed to fail on every PR for months unnoticed.
ledger=""
note() { ledger+="- ${1}"$'\n'; }

if ! changing; then
  echo "DRY RUN — no pull request will be commented on or closed."
fi

prs=$(gh pr list --repo "$REPO" --state open --author "app/dependabot" --limit 100 \
  --json number,title,createdAt,headRefOid,mergeStateStatus,autoMergeRequest,statusCheckRollup)

total=$(jq 'length' <<<"$prs")
echo "Open Dependabot PRs: $total"
summary "## Dependabot maintenance"
summary ""
summary "Open Dependabot PRs: **$total**"
if ! changing; then
  summary ""
  summary "_Dry run — nothing was changed._"
fi

if [ "$total" -eq 0 ]; then
  exit 0
fi

# GNU date on the runner; the BSD form keeps this runnable on macOS for testing.
cutoff=$(date -u -d "${STALE_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
  date -u -v-"${STALE_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)

# --- 1. Close PRs that are permanently red on a required check ---------------
# A dependency major that breaks the build never goes green on its own, and each
# one left open eats into `open-pull-requests-limit` — which starves genuine
# security updates from being opened at all.
stale_red=$(jq -c --argjson req "$REQUIRED_CHECKS" --arg cutoff "$cutoff" '
  [ .[]
    | select(.createdAt < $cutoff)
    | { number, title,
        failing: [ .statusCheckRollup[]?
                   | select(.conclusion == "FAILURE")
                   | select(.name as $n | $req | index($n))
                   | .name ] }
    | select(.failing | length > 0) ]' <<<"$prs")

summary ""
summary "### Closed — red on a required check for >${STALE_DAYS}d"
if [ "$(jq 'length' <<<"$stale_red")" -eq 0 ]; then
  summary "_none_"
fi

while read -r pr; do
  number=$(jq -r '.number' <<<"$pr")
  title=$(jq -r '.title' <<<"$pr")
  failing=$(jq -r '.failing | join("`, `")' <<<"$pr")
  echo "Closing #${number} (${title}) — failing: ${failing}"
  summary "- #${number} — failing \`${failing}\`"
  changing || continue
  gh pr close "$number" --repo "$REPO" --delete-branch --comment "$(
    cat <<EOF
Closing automatically: this has been red on the required check \`${failing}\` for
more than ${STALE_DAYS} days, and a version bump alone will not turn it green —
it needs migration work.

Reopen it once that work is planned, or ignore this major in
\`.github/dependabot.yml\` if the upgrade is off the table. Closing rather than
leaving it open keeps the ecosystem under its \`open-pull-requests-limit\`, so
security updates can still be opened.

— [dependabot-maintenance](${RUN_URL})
EOF
  )"
done < <(jq -c '.[]' <<<"$stale_red")

# --- 2. Nudge out-of-date branches -------------------------------------------
# `@dependabot rebase` rather than `gh pr update-branch`: pushing our own merge
# commit onto a Dependabot branch makes Dependabot treat the PR as
# human-modified and stop managing it. A rebase keeps it in charge, and keeps
# the resulting history linear.
#
# Only PRs with auto-merge already armed are nudged. A rebase is only worth a
# CI cycle if something is waiting to consume the result; rebasing a PR that
# needs human review (every major) just burns minutes and goes stale again
# before anyone looks. Those are reported in section 3 instead.
#
# BEHIND is an out-of-date branch; DIRTY is a conflict, which in a pnpm monorepo
# is the common one — every landed bump rewrites the same lockfile and conflicts
# whatever is queued behind it. `@dependabot rebase` regenerates the branch and
# resolves both.
behind=$(jq -c --argjson skip "$(jq '[.[].number]' <<<"$stale_red")" '
  [ .[]
    | select(.mergeStateStatus == "BEHIND" or .mergeStateStatus == "DIRTY")
    | select(.autoMergeRequest != null)
    | select(.number as $n | $skip | index($n) | not)
    | { number, sha: .headRefOid, state: .mergeStateStatus } ]' <<<"$prs")

summary ""
summary "### Rebase nudges"
nudged=0
while read -r pr; do
  number=$(jq -r '.number' <<<"$pr")
  sha=$(jq -r '.sha' <<<"$pr")
  state=$(jq -r '.state' <<<"$pr")
  marker="<!-- maintenance-sweep: ${sha} -->"

  if [ "$nudged" -ge "$MAX_REBASES" ]; then
    echo "#${number}: rebase cap reached; deferring."
    note "#${number} — not nudged: hit \`MAX_REBASES=${MAX_REBASES}\` this run, deferred to the next"
    continue
  fi

  # Skip if this exact head has already been nudged. When Dependabot acts the
  # head SHA changes and the PR becomes eligible again, so this dedupes without
  # storing any state — and without nagging the same PR every morning.
  if gh pr view "$number" --repo "$REPO" --json comments \
    --jq '[.comments[].body] | join("\n")' | grep -qF "$marker"; then
    echo "#${number} already nudged at ${sha}; skipping."
    note "#${number} — not nudged: already asked at head \`${sha:0:8}\`, waiting on Dependabot to act"
    continue
  fi

  echo "Nudging #${number} (${state}, head ${sha})"
  summary "- #${number} — \`${state}\`"
  nudged=$((nudged + 1))
  changing || continue
  gh pr comment "$number" --repo "$REPO" --body "$(
    cat <<EOF
@dependabot rebase

${marker}
EOF
  )"
done < <(jq -c '.[]' <<<"$behind")

if [ "$nudged" -eq 0 ]; then
  summary "_none_"
fi

# --- 3. Report, don't act ----------------------------------------------------
# A green Dependabot PR with no auto-merge armed means the arming workflow
# either did not run or deliberately declined (a major, which is meant to get a
# human's attention). Either way this script must not guess: arming it here
# would bypass the update-type metadata that makes that call safe.
unarmed=$(jq -r '
  [ .[]
    | select(.autoMergeRequest == null)
    | select(any(.statusCheckRollup[]?; .conclusion == "FAILURE") | not)
    | "- #\(.number) — \(.title)" ] | join("\n")' <<<"$prs")

summary ""
summary "### Green, no auto-merge armed — needs a human decision"
if [ -z "$unarmed" ]; then
  summary "_none_"
else
  summary "$unarmed"
fi

# --- 4. The skip ledger ------------------------------------------------------
# Reads from a process substitution, never a pipe: a pipe would run the loop in
# a subshell and silently discard everything appended to $ledger.
collect() {
  while read -r line; do
    if [ -n "$line" ]; then note "$line"; fi
  done
}

# Out of date, but nothing is waiting to consume a rebase.
collect < <(jq -r '
  .[]
  | select(.mergeStateStatus == "BEHIND" or .mergeStateStatus == "DIRTY")
  | select(.autoMergeRequest == null)
  | "#\(.number) — not nudged: `\(.mergeStateStatus)` but no auto-merge armed, so a rebase would buy nothing"
  ' <<<"$prs")

# Red on a required check, but not yet old enough to close.
collect < <(jq -r --argjson req "$REQUIRED_CHECKS" --arg cutoff "$cutoff" '
  .[]
  | select(.createdAt >= $cutoff)
  | . as $pr
  | [ .statusCheckRollup[]?
      | select(.conclusion == "FAILURE")
      | select(.name as $n | $req | index($n))
      | .name ] as $failing
  | select($failing | length > 0)
  | "#\($pr.number) — not closed: red on `\($failing | join("`, `"))`, but opened \($pr.createdAt[0:10]) and the close threshold is \($cutoff[0:10])"
  ' <<<"$prs")

# Drift signal. A failing check absent from REQUIRED_CHECKS can never count
# toward a close, which is the fail-safe direction — but if branch protection
# gained a check and this list did not, that silence is the bug. Say so.
collect < <(jq -r --argjson req "$REQUIRED_CHECKS" '
  .[]
  | . as $pr
  | [ .statusCheckRollup[]?
      | select(.conclusion == "FAILURE")
      | select(.name as $n | $req | index($n) | not)
      | .name ] as $other
  | select($other | length > 0)
  | "#\($pr.number) — failing `\($other | join("`, `"))`, ignored: not in `REQUIRED_CHECKS`. If branch protection now requires it, update the list"
  ' <<<"$prs")

summary ""
summary "### Skipped — and why"
if [ -z "$ledger" ]; then
  summary "_nothing was skipped_"
else
  summary "$ledger"
fi
