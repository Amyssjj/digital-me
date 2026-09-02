#!/usr/bin/env bash
#
# Post-update gate: assert the openclaw gateway did NOT drop any of
# digital-me-recall's typed hooks.
#
# THE FAILURE THIS CATCHES
# openclaw refuses a "conversation" typed hook from a NON-BUNDLED plugin
# unless the operator has set
# `plugins.entries.<id>.hooks.allowConversationAccess: true`. The refusal is a
# warn diagnostic plus an early `return` inside the host's hook registrar
# (plugins/registry-registrars-tools-hooks.ts) — the plugin still loads, still
# registers its tools, still reports `Status: loaded`, and the gateway
# connectivity probe still passes. Only the hooks are gone.
#
# openclaw 2026.8.1 added `before_prompt_build` to that gated set
# (plugins/hook-types.ts CONVERSATION_HOOK_NAMES), which is the entire wiki
# recall-injection path; `agent_end` (the M1 application-ack) has been gated
# for longer. Every digital-me plugin is non-bundled (`Origin: global`).
#
# NOTHING ELSE IN THE UPDATE GATE SEES THIS. The updater's overlay smoke is
# `node --check` (syntax only — it cannot load the bundle because `openclaw/*`
# is externalized), the gateway probe passes, and the digest pipeline is
# unaffected. Hence this check.
#
# Two independent signals, either of which fails the gate:
#   1. CONFIG   — the grant is missing for a plugin that registers such hooks.
#   2. RUNTIME  — the gateway log carries a host block diagnostic, or the
#                 plugin's own boot self-check reported conversation_hooks=BLOCKED.
#
# Exit 0 = no hooks blocked. Exit 1 = at least one signal fired.
# Read-only: no writes, no network, no LLM.

set -uo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
CONFIG="${DIGITAL_ME_OPENCLAW_CONFIG:-$OPENCLAW_HOME/openclaw.json}"

# Resolve the log the RUNNING gateway writes to — not the first path that
# happens to exist. `$OPENCLAW_HOME/logs/gateway.log` is a real file on this
# machine but has been frozen since the service moved its StandardOutPath to
# ~/Library/Logs; reading it would make this gate silently blind, which is the
# exact failure class the gate exists to catch. Pick the NEWEST candidate.
resolve_gateway_log() {
  if [[ -n "${OPENCLAW_GATEWAY_LOG:-}" ]]; then
    printf '%s\n' "$OPENCLAW_GATEWAY_LOG"
    return
  fi
  # The debug file log (/tmp/openclaw/openclaw-<date>.log, what `openclaw logs`
  # tails) carries every plugin/hook diagnostic the stdout log carries and more;
  # it is a candidate so a host whose stdout log is frozen is still observable.
  local newest="" cand
  for cand in \
    "$(ls -t /tmp/openclaw/openclaw-*.log 2>/dev/null | head -1)" \
    "$HOME/Library/Logs/openclaw/gateway.log" \
    "$OPENCLAW_HOME/logs/gateway.log" \
    "${XDG_STATE_HOME:-$HOME/.local/state}/openclaw/gateway.log"; do
    [[ -n "$cand" && -f "$cand" ]] || continue
    if [[ -z "$newest" || "$cand" -nt "$newest" ]]; then newest="$cand"; fi
  done
  printf '%s\n' "$newest"
}
GATEWAY_LOG="$(resolve_gateway_log)"
# Plugins that actually register conversation hooks. digital-me-brain
# registers tools only, so it needs no grant (least privilege).
PLUGINS=("digital-me-recall")

fail=0
note() { printf '  %s\n' "$1"; }

# ── 1. Config: is the grant present? ────────────────────────────────────
if [[ ! -f "$CONFIG" ]]; then
  echo "SKIP openclaw-hooks: no config at $CONFIG (openclaw not installed here)"
  exit 0
fi

for id in "${PLUGINS[@]}"; do
  granted=$(python3 - "$CONFIG" "$id" <<'PY'
import sys
# openclaw parses its config as JSON5 (comments, trailing commas, unquoted keys).
# Use pyjson5 if available; fall back to a lenient JSON parser that strips
# comments/trailing-commas manually (the same dialect the installer uses).
try:
    import pyjson5
    cfg = pyjson5.load(open(sys.argv[1]))
except ImportError:
    import json, re
    raw = open(sys.argv[1]).read()
    # Strip // and /* */ comments (minimal; sufficient for openclaw.json)
    raw = re.sub(r'//.*?$', '', raw, flags=re.MULTILINE)
    raw = re.sub(r'/\*.*?\*/', '', raw, flags=re.DOTALL)
    # Strip trailing commas before } or ]
    raw = re.sub(r',(\s*[}\]])', r'\1', raw)
    cfg = json.loads(raw)
except Exception as e:
    print(f"FAIL: config parse error: {e}", file=sys.stderr)
    raise SystemExit(1)

entry = (cfg.get("plugins") or {}).get("entries", {}).get(sys.argv[2]) or {}
granted = (entry.get("hooks") or {}).get("allowConversationAccess") is True
print("yes" if granted else "no")
PY
)
  case "$granted" in
    yes) note "ok      $id: allowConversationAccess=true" ;;
    *)
      note "FAIL    $id: plugins.entries.$id.hooks.allowConversationAccess is not true"
      note "        openclaw will silently drop its before_prompt_build / agent_end hooks."
      fail=1
      ;;
  esac
done

# ── 2. Runtime: did the host or the plugin report a block? ──────────────
# Only the tail matters — earlier boots may predate the fix.
if [[ -n "$GATEWAY_LOG" && -f "$GATEWAY_LOG" ]]; then
  note "log     $GATEWAY_LOG"
  tail_txt=$(tail -c 2000000 "$GATEWAY_LOG" 2>/dev/null)

  # The plugin's own boot self-check (see templates/recall/index.mjs). Use the
  # LAST registration line only: an older blocked boot must not fail a fixed one.
  last_reg=$(grep "digital-me-recall: registered hooks" <<<"$tail_txt" | tail -1)
  if [[ -n "$last_reg" ]]; then
    if grep -q "conversation_hooks=BLOCKED" <<<"$last_reg"; then
      note "FAIL    recall self-check reported conversation_hooks=BLOCKED at boot"
      fail=1
    elif grep -q "conversation_hooks=granted" <<<"$last_reg"; then
      note "ok      recall self-check reported conversation_hooks=granted"
    fi
  fi

  # Host-side hook-block diagnostic. Scope to the last boot (everything after the
  # last registration line) so an old `agent_end` gate warn doesn't false-red the
  # update sweep after the grant is written.
  if [[ -n "$last_reg" ]]; then
    # Extract everything from the last registration onward
    last_boot_txt=$(grep -A 99999 "digital-me-recall: registered hooks" <<<"$tail_txt" | tail -n +1)
  else
    # No registration found — check the whole tail (first boot or pre-recall install)
    last_boot_txt="$tail_txt"
  fi
  if grep -q "blocked because non-bundled plugins must set" <<<"$last_boot_txt"; then
    note "FAIL    gateway log carries a host hook-block diagnostic in the last boot:"
    grep -o "typed hook \"[a-z_]*\" blocked because non-bundled[^\"]*" <<<"$last_boot_txt" \
      | tail -3 | sed 's/^/          /'
    fail=1
  fi
else
  note "warn    no gateway log at $GATEWAY_LOG — runtime signal not checked"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "FAIL openclaw-hooks: at least one conversation hook is (or will be) dropped."
  exit 1
fi
echo "OK openclaw-hooks: no dropped conversation hooks detected."
exit 0
