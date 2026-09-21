#!/usr/bin/env bash
# Digital Me: inject openclaw-brain memory_search hits into user prompts.
# Runs on UserPromptSubmit. Fails open (empty output, exit 0) on any error.
#
# 2026-05-22 changes (M1 calibration):
#   - SCORE_GATE: drop hits below MIN_SCORE (was: unconditional top-3).
#   - PER_SESSION_DEDUP: skip paths already injected in this session.
#   - TOP1_FULL_BODY: inline the highest-scoring hit's full body (cap 2000 ch)
#     so the agent doesn't need a follow-up memory_get for the most relevant
#     entry. Remaining hits stay snippet-only.
#   - ACTION_FRAMING: replace "If relevant, open the full entry..." with a
#     force-name-relevance closing so the agent has to acknowledge or refuse.

set -u
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

STDIN="$(cat)"
PROMPT="$(printf '%s' "$STDIN" | jq -r '.prompt // empty' 2>/dev/null)"
[ -z "$PROMPT" ] && exit 0

# Session id for per-session dedup. Claude Code passes `session_id` on stdin.
SESSION_ID="$(printf '%s' "$STDIN" | jq -r '.session_id // empty' 2>/dev/null)"

# Skip for trivial prompts / slash-only messages
PLEN=${#PROMPT}
[ "$PLEN" -lt 12 ] && exit 0
case "$PROMPT" in /*) exit 0 ;; esac

# Brain endpoint precedence (mirrors brain-mcp-proxy/config.ts, dm_m1_emit.py
# and the Codex inject hook):
#   1. DIGITAL_ME_BRAIN_URL — the digital-me brain-host. Its bearer token is
#      DIGITAL_ME_BRAIN_TOKEN when non-empty, else the trimmed contents of
#      DIGITAL_ME_BRAIN_TOKEN_FILE, else of the default token file
#      <DIGITAL_ME_WIKI_ROOT or ~/digital-me>/.data/brain-host.token (the
#      mode-600 file `digital-me install --runtime brain-host` writes). An
#      empty or unreadable file is "no token". A URL with no resolvable token
#      is a configuration error, so the hook reports it on stderr and exits
#      (fail-open, no request) rather than silently falling back to the
#      openclaw gateway.
#   2. OPENCLAW_GATEWAY_HOST / OPENCLAW_GATEWAY_PORT / OPENCLAW_GATEWAY_TOKEN.
#   3. The openclaw config file (gateway.auth.token) on the default port.
#
# The score gate is backend-aware. The gateway's hybrid `score` is 0-1 (top
# hits ~0.5) and MIN_SCORE=40 was calibrated against it. brain-host fuses
# ranks with RRF, so its `score` peaks at ~0.043 (2.6/61) and a 0-100 gate on
# it drops every hit; its `vectorScore` (cosine) is the comparable signal —
# measured 2026-09-20 on the live index: relevant hits 0.71-0.77, off-topic
# probe 0.50-0.53 — so brain-host gates on vectorScore >= 60.
# DIGITAL_ME_HOOK_MIN_SCORE overrides either default (0-100 scale).
if [ -n "${DIGITAL_ME_BRAIN_URL:-}" ]; then
  BRAIN_URL="$DIGITAL_ME_BRAIN_URL"
  TOKEN="${DIGITAL_ME_BRAIN_TOKEN:-}"
  TOKEN_FILE="${DIGITAL_ME_BRAIN_TOKEN_FILE:-${DIGITAL_ME_WIKI_ROOT:-$HOME/digital-me}/.data/brain-host.token}"
  if [ -z "$TOKEN" ]; then
    # Env token wins; otherwise the token file. "$( )" drops trailing
    # newlines, the two expansions trim any remaining whitespace (bash 3.2
    # safe, no subprocess). A missing, unreadable or blank file leaves TOKEN
    # empty, which is the hard error below — never a gateway fallback.
    TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"
    TOKEN="${TOKEN#"${TOKEN%%[![:space:]]*}"}"
    TOKEN="${TOKEN%"${TOKEN##*[![:space:]]}"}"
  fi
  if [ -z "$TOKEN" ]; then
    echo "dm_memory_search_inject: DIGITAL_ME_BRAIN_URL is set but no token was found — set DIGITAL_ME_BRAIN_TOKEN, or point DIGITAL_ME_BRAIN_TOKEN_FILE at a readable token file (looked in $TOKEN_FILE), or unset the URL to fall back to the openclaw gateway" >&2
    exit 0
  fi
  SCORE_FIELD="vectorScore"
  MIN_SCORE="${DIGITAL_ME_HOOK_MIN_SCORE:-60}"
else
  BRAIN_URL="http://${OPENCLAW_GATEWAY_HOST:-localhost}:${OPENCLAW_GATEWAY_PORT:-18789}/tools/invoke"
  TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
  if [ -z "$TOKEN" ]; then
    OPENCLAW_CONFIG="${DIGITAL_ME_OPENCLAW_CONFIG:-$HOME/.openclaw/config.json}"
    [ ! -f "$OPENCLAW_CONFIG" ] && OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
    [ ! -f "$OPENCLAW_CONFIG" ] && OPENCLAW_CONFIG="$HOME/.clawdbot/openclaw.json"
    TOKEN="$(jq -r '.gateway.auth.token // empty' "$OPENCLAW_CONFIG" 2>/dev/null)"
  fi
  SCORE_FIELD="score"
  MIN_SCORE="${DIGITAL_ME_HOOK_MIN_SCORE:-40}"
fi
[ -z "$TOKEN" ] && exit 0

# Tunables
TOP1_BODY_CHARS=2000        # cap on inlined top-1 entry body
FRESH_DAYS_THRESHOLD=7
WIKI_ROOT_LOCAL="${DIGITAL_ME_WIKI_ROOT:-$HOME/digital-me}/wiki"
NOW_EPOCH=$(date +%s)

# Per-session dedup cache. Holds wiki paths already surfaced in this session
# so we never inject the same entry twice — forces the hook to escalate to
# fresh hits if the topic stays the same.
SEEN_FILE=""
if [ -n "$SESSION_ID" ]; then
  SEEN_FILE="/tmp/dm_hook_seen_${SESSION_ID}.txt"
  : > /dev/null  # noop; create lazily when we write
fi

# Trim prompt for the query (brain does semantic search; long verbatim prompts add noise)
QUERY="$(printf '%s' "$PROMPT" | head -c 400)"

# Request a few more than we need (limit 6) so the score-gate + dedup still
# leaves us with usable hits. Then we trim back to ≤ 3 surfaced hits.
# openclaw >= 2026.8.1 REJECTS /tools/invoke on a multi-agent host unless the
# caller names an owner: "Multiple agents are configured, but session key
# \"main\" has no explicit owner. Pass agentId or use an agent-prefixed session
# key." Without it every injection fails and the hook exits 0 silently, so
# recall just stops with no error anywhere. Override per machine if the
# default agent is not "main". Canonical name is OPENCLAW_GATEWAY_AGENT_ID;
# DIGITAL_ME_OPENCLAW_AGENT_ID is aliased for backward compat.
AGENT_ID="${OPENCLAW_GATEWAY_AGENT_ID:-${DIGITAL_ME_OPENCLAW_AGENT_ID:-main}}"
REQ="$(jq -cn --arg q "$QUERY" --arg a "$AGENT_ID" '{tool:"memory_search", agentId:$a, args:{query:$q, limit:6, corpus:"all"}}' 2>/dev/null)"
[ -z "$REQ" ] && exit 0

HOOK_TIMEOUT="${DIGITAL_ME_HOOK_TIMEOUT_SECS:-12}"
RESP="$(curl -sS -m "$HOOK_TIMEOUT" -X POST "$BRAIN_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$REQ" 2>/dev/null)"
[ -z "$RESP" ] && exit 0

# Filter: score >= MIN_SCORE, not in session-dedup cache. Output ≤ 3 hits.
RESULTS_RAW="$(printf '%s' "$RESP" | jq -r '.result.content[0].text' 2>/dev/null)"
[ -z "$RESULTS_RAW" ] && exit 0

# Build a newline-separated list of already-seen paths for jq filtering.
SEEN_PATHS=""
if [ -n "$SEEN_FILE" ] && [ -f "$SEEN_FILE" ]; then
  SEEN_PATHS="$(cat "$SEEN_FILE")"
fi

# Filter and shape via jq. score_int = floor(<SCORE_FIELD>*100) — `score` for
# the gateway, `vectorScore` for brain-host (see the gate note above); falls
# back to `score` when the backend omits the field. dedup against SEEN_PATHS.
# Note: RESULTS_RAW is already-parsed-text-of-JSON; jq parses it directly on stdin,
# so we DON'T call fromjson (which would only apply to a string-typed input).
HITS_JSON="$(printf '%s' "$RESULTS_RAW" | jq -c --arg seen "$SEEN_PATHS" --arg field "$SCORE_FIELD" --argjson min_score "$MIN_SCORE" '
  .results // []
  | map(. + {score_int: (((.[$field] // .score // 0) * 100) | floor)})
  | map(select(.score_int >= $min_score))
  | (($seen | split("\n") | map(select(length > 0))) as $seenset
     | map(select(.path as $p | $seenset | index($p) | not)))
  | .[0:3]
' 2>/dev/null)"

# If filtering left us empty, exit silently — we already showed the user the
# relevant entries earlier this session.
if [ -z "$HITS_JSON" ] || [ "$HITS_JSON" = "[]" ] || [ "$HITS_JSON" = "null" ]; then
  exit 0
fi

# Helper: read the body of a wiki entry (skip frontmatter), truncated.
inline_body() {
  local rel="$1" max_chars="$2"
  local abs="$WIKI_ROOT_LOCAL/$rel"
  [ ! -f "$abs" ] && return
  awk -v max="$max_chars" '
    BEGIN { fm=0; body=""; }
    /^---/ { fm++; next }
    fm >= 2 { body = body $0 "\n"; if (length(body) >= max) { exit } }
    END { print substr(body, 1, max) }
  ' "$abs"
}

# Build the hit blocks. The first surviving hit gets inlined-body treatment;
# the rest stay as snippet+metadata.
HITS="$(printf '%s' "$HITS_JSON" | jq -c '.[]' | awk 'BEGIN{i=0} {print i "\t" $0; i++}' | while IFS=$'\t' read -r idx hit; do
  path="$(printf '%s' "$hit" | jq -r '.path // ""')"
  [ -z "$path" ] && continue
  score=$(printf '%s' "$hit" | jq -r '.score_int // 0')
  snippet=$(printf '%s' "$hit" | jq -r '(.snippet // "") | gsub("\n"; " ") | .[0:240]')

  rel="${path##*/wiki/}"
  age_tag=""
  if [ "$rel" != "$path" ]; then
    abs="$WIKI_ROOT_LOCAL/$rel"
    if [ -f "$abs" ]; then
      # GNU stat first: on coreutils "stat -f %m" succeeds with filesystem info,
      # so a BSD-first fallback never fires and the arithmetic below dies. BSD
      # stat rejects -c, so this order works on both. Keep numeric results only.
      # NOTE: no case/esac here - bash 3.2 mis-parses its ")" inside "$( )".
      mtime=$(stat -c %Y "$abs" 2>/dev/null || stat -f %m "$abs" 2>/dev/null)
      [[ "$mtime" =~ ^[0-9]+$ ]] || mtime=""
      if [ -n "$mtime" ]; then
        age_days=$(( (NOW_EPOCH - mtime) / 86400 ))
        if [ "$age_days" -gt "$FRESH_DAYS_THRESHOLD" ]; then
          age_tag=", age=${age_days}d ⚠ verify before asserting"
        else
          age_tag=", age=${age_days}d"
        fi
      fi
    fi
  fi

  printf '%s\n' "- ${path} (score=${score}/100${age_tag})"

  if [ "$idx" = "0" ] && [ "$rel" != "$path" ]; then
    # Top hit: inline full body
    body="$(inline_body "$rel" "$TOP1_BODY_CHARS")"
    if [ -n "$body" ]; then
      printf '  FULL BODY (top hit, truncated to %s chars):\n' "$TOP1_BODY_CHARS"
      printf '%s\n' "$body" | sed 's/^/    /'
    else
      printf '  %s\n' "$snippet"
    fi
  else
    printf '  %s\n' "$snippet"
  fi
done)"

[ -z "$HITS" ] && exit 0

# Crosslink expansion: pull `related:` titles from each surfaced entry's
# frontmatter (one-hop graph view).
PATHS="$(printf '%s' "$HITS_JSON" | jq -r 'map(.path // empty) | .[]' 2>/dev/null)"

RELATED=""
WIKI_ROOT="${DIGITAL_ME_WIKI_ROOT:-$HOME/digital-me}/wiki"
SEEN_REL=""
if [ -d "$WIKI_ROOT" ]; then
  while IFS= read -r hit_path; do
    [ -z "$hit_path" ] && continue
    rel="${hit_path##*/wiki/}"
    [ "$rel" = "$hit_path" ] && rel="$hit_path"
    abs="$WIKI_ROOT/$rel"
    [ ! -f "$abs" ] && continue

    rel_paths="$(awk '
      /^---/ { fm++; next }
      fm == 1 && /^related:/ {
        if (match($0, /\[.*\]/)) {
          s = substr($0, RSTART+1, RLENGTH-2)
          gsub(/[ ",'\''"]/, "", s)
          n = split(s, arr, ",")
          for (i = 1; i <= n; i++) if (length(arr[i])) print arr[i]
          next
        }
        in_list = 1; next
      }
      fm == 1 && in_list && /^- / { p = $0; sub(/^- */, "", p); gsub(/["\047]/, "", p); print p; next }
      fm == 1 && in_list && /^[a-zA-Z]/ { in_list = 0 }
      fm == 2 { exit }
    ' "$abs")"

    while IFS= read -r r; do
      [ -z "$r" ] && continue
      case "$SEEN_REL" in
        *"|$r|"*) continue ;;
      esac
      SEEN_REL="$SEEN_REL|$r|"
      r_abs="$WIKI_ROOT/$r"
      [ ! -f "$r_abs" ] && continue
      title="$(awk '/^---/{fm++; next} fm==1 && /^title:/{sub(/^title: */, ""); gsub(/["\047]/, ""); print; exit}' "$r_abs")"
      [ -z "$title" ] && title="$r"
      RELATED="$RELATED- $r — $title"$'\n'
    done <<< "$rel_paths"
  done <<< "$PATHS"
fi

if [ -n "$RELATED" ]; then
  RELATED="$(printf '%s' "$RELATED" | head -12)"
  RELATED_BLOCK="

Related (cross-linked from those hits — fetch via memory_get if useful):
$RELATED"
else
  RELATED_BLOCK=""
fi

# Record what we surfaced so the next turn dedups against it.
if [ -n "$SEEN_FILE" ]; then
  printf '%s' "$PATHS" >> "$SEEN_FILE"
  printf '\n' >> "$SEEN_FILE"
fi

# ─── M1 universal-protocol emit (2026-05-27) ──────────────────────────────
# Emit canonical events to brain via dm_m1_emit.py:
#   1. session_start (once-only per session_id, gated by /tmp flag file)
#   2. knowledge_surfaced (every successful injection)
# Both append to ~/.openclaw/data/m1_events_claude_code.jsonl as the
# durable WAL; brain POSTs are best-effort (m1_backfill.py replays on
# next reachable window). See wiki: infrastructure/m1-universal-event-protocol.md
M1_EMIT="$(dirname "$0")/dm_m1_emit.py"
if [ -n "$SESSION_ID" ] && [ -x "$M1_EMIT" ] && [ -n "$PATHS" ]; then
  # Build a turn id from the seen-file line count (monotonic per session)
  if [ -n "$SEEN_FILE" ] && [ -f "$SEEN_FILE" ]; then
    M1_TURN_ID="$(wc -l < "$SEEN_FILE" 2>/dev/null | tr -d ' ')"
  else
    M1_TURN_ID="0"
  fi
  [ -z "$M1_TURN_ID" ] && M1_TURN_ID="0"

  # Build the entries JSON array from HITS_JSON (already has path + score)
  ENTRIES_JSON="$(printf '%s' "$HITS_JSON" | jq -c 'map({path: (.path // ""), title: (.title // ""), score: (.score // null), source: "memory_search"}) | map(select(.path != ""))' 2>/dev/null)"
  [ -z "$ENTRIES_JSON" ] && ENTRIES_JSON='[]'

  # 1. session_start — once-only-per-session (--skip-if-already-started)
  "$M1_EMIT" session_start \
    --session-id "$SESSION_ID" \
    --turn-id "0" \
    --skip-if-already-started \
    --quiet \
    >/dev/null 2>&1 || true

  # 2. knowledge_surfaced
  "$M1_EMIT" knowledge_surfaced \
    --session-id "$SESSION_ID" \
    --turn-id "$M1_TURN_ID" \
    --entries-json "$ENTRIES_JSON" \
    --quiet \
    >/dev/null 2>&1 || true
fi

CTX="Digital Me / openclaw-brain memory_search top hits for this prompt (auto-injected; may be stale — verify against current state before acting):

$HITS
$RELATED_BLOCK

[Digital Me] protocol — BEGIN your reply with a line that starts \`[Digital Me]\`.
If one or more entries above apply, write \`[Digital Me] applying <entry slug or title>\`
and use their content. If none apply, write \`[Digital Me] no applicable wiki entries\`
and proceed. This prefix marks knowledge-application start and is tracked as M1
(application_rate); skipping it is a protocol violation.
Entries already shown earlier in this session are filtered out — anything
here is new context worth one explicit acknowledgment."

jq -cn --arg ctx "$CTX" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext:$ctx}}'
