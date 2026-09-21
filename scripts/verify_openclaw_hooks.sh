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
# The config signal needs a JSON5 parser (openclaw.json may carry comments,
# trailing commas, unquoted keys). Parser availability is a property of the
# HOST, not of the grant: when neither node+json5 nor python3+pyjson5 can be
# resolved the config signal is SKIPPED with a warn and the gate leans on the
# runtime signal, which is what actually proves the hooks registered. It never
# fails a config it could not read — that false-red (json5 lives un-hoisted in
# pnpm's store, so a bare `require('json5')` from an arbitrary cwd failed on a
# config that DID carry the grant, 2026-09-20) is exactly what this rule fixes.
#
# Exit 0 = no hooks blocked. Exit 1 = at least one signal fired.
# Read-only: no writes, no network, no LLM.

set -uo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
CONFIG="${DIGITAL_ME_OPENCLAW_CONFIG:-$OPENCLAW_HOME/openclaw.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Where the json5 package is looked up (the repo checkout this script ships
# in, by default). Override when the gate runs from an installed copy.
REPO_ROOT="${DIGITAL_ME_REPO_ROOT:-$SCRIPT_DIR/..}"

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
config_unverified=0
runtime_checked=0
note() { printf '  %s\n' "$1"; }

# Verdict for one plugin's grant, printed on stdout:
#   yes | no          a parser read the file; the grant is / is not there
#   unparsed <why>    a parser exists but the file did not parse
#   noparser          neither node+json5 nor python3+pyjson5 is resolvable
# Only `no` is a config FAIL.
config_grant() {
  local cfg="$1" id="$2" verdict=""
  if command -v node >/dev/null 2>&1; then
    verdict=$(node - "$cfg" "$id" "$REPO_ROOT" 2>/dev/null <<'JS'
const fs = require('fs');
const path = require('path');
const [cfgPath, id, repoRoot] = process.argv.slice(2);

// json5 is a dependency of packages/cli, which pnpm keeps un-hoisted under
// node_modules/.pnpm — so resolve it the way that package would, then fall
// back to scanning the store, then to whatever the cwd can see.
function loadJson5() {
  const roots = [repoRoot, path.join(repoRoot, 'packages', 'cli'), process.cwd()];
  for (const r of roots) {
    try { return require(require.resolve('json5', { paths: [r] })); } catch {}
  }
  for (const r of roots) {
    const store = path.join(r, 'node_modules', '.pnpm');
    let names = [];
    try { names = fs.readdirSync(store); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith('json5@')) continue;
      try { return require(path.join(store, n, 'node_modules', 'json5')); } catch {}
    }
  }
  return null;
}

const JSON5 = loadJson5();
if (!JSON5) { console.log('noparser'); process.exit(0); }
let cfg;
try {
  cfg = JSON5.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (e) {
  console.log('unparsed ' + String(e && e.message ? e.message : e).split('\n')[0]);
  process.exit(0);
}
const entries = (cfg && cfg.plugins && cfg.plugins.entries) || {};
const entry = entries[id] || {};
console.log((entry.hooks || {}).allowConversationAccess === true ? 'yes' : 'no');
JS
) || verdict=""
  fi

  if [[ -z "$verdict" || "$verdict" == "noparser" ]] && command -v python3 >/dev/null 2>&1; then
    verdict=$(python3 - "$cfg" "$id" 2>/dev/null <<'PY'
import sys
try:
    import pyjson5
except ImportError:
    print("noparser")
    raise SystemExit(0)
try:
    with open(sys.argv[1]) as fh:
        cfg = pyjson5.load(fh)
except Exception as e:  # any parse failure is "unparsed", never a FAIL
    why = str(e).splitlines()[0] if str(e) else "parse error"
    print("unparsed " + why)
    raise SystemExit(0)
entry = (((cfg or {}).get("plugins") or {}).get("entries") or {}).get(sys.argv[2]) or {}
print("yes" if (entry.get("hooks") or {}).get("allowConversationAccess") is True else "no")
PY
) || verdict=""
  fi
  printf '%s\n' "${verdict:-noparser}"
}

# ── 1. Config: is the grant present? ────────────────────────────────────
if [[ ! -f "$CONFIG" ]]; then
  echo "SKIP openclaw-hooks: no config at $CONFIG (openclaw not installed here)"
  exit 0
fi

for id in "${PLUGINS[@]}"; do
  verdict="$(config_grant "$CONFIG" "$id")"
  case "$verdict" in
    yes) note "ok      $id: allowConversationAccess=true" ;;
    no)
      note "FAIL    $id: plugins.entries.$id.hooks.allowConversationAccess is not true"
      note "        openclaw will silently drop its before_prompt_build / agent_end hooks."
      fail=1
      ;;
    unparsed*)
      note "warn    $id: could not parse $CONFIG (${verdict#unparsed }) — config signal skipped, relying on the runtime signal"
      config_unverified=1
      ;;
    *)
      note "warn    $id: no JSON5 parser resolvable (node+json5 under $REPO_ROOT, or python3+pyjson5) — config signal skipped, relying on the runtime signal"
      note "        restore it with: pnpm install (repo root) or pip install pyjson5"
      config_unverified=1
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
      runtime_checked=1
    elif grep -q "conversation_hooks=granted" <<<"$last_reg"; then
      note "ok      recall self-check reported conversation_hooks=granted"
      runtime_checked=1
    fi
  fi

  # Host-side hook-block diagnostic. Scope to the last boot (everything after the
  # last registration line) so an old `agent_end` gate warn doesn't false-red the
  # update sweep after the grant is written.
  if [[ -n "$last_reg" ]]; then
    # Extract everything AFTER the LAST registration line (not the first).
    # awk: print=1 once we see the last occurrence of the registration marker.
    last_boot_txt=$(awk -v marker="digital-me-recall: registered hooks" '
      {line[NR]=$0}
      $0 ~ marker {last_match=NR}
      END {
        if (last_match) {
          for (i=last_match; i<=NR; i++) print line[i]
        }
      }
    ' <<<"$tail_txt")
  else
    # No registration found — check the whole tail (first boot or pre-recall install)
    last_boot_txt="$tail_txt"
  fi
  if [[ -n "$last_boot_txt" ]] && grep -q "blocked because non-bundled plugins must set" <<<"$last_boot_txt"; then
    note "FAIL    gateway log carries a host hook-block diagnostic in the last boot:"
    grep -o "typed hook \"[a-z_]*\" blocked because non-bundled[^\"]*" <<<"$last_boot_txt" \
      | tail -3 | sed 's/^/          /'
    fail=1
    runtime_checked=1
  fi
else
  note "warn    no gateway log at $GATEWAY_LOG — runtime signal not checked"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "FAIL openclaw-hooks: at least one conversation hook is (or will be) dropped."
  exit 1
fi
if [[ "$config_unverified" -ne 0 && "$runtime_checked" -eq 0 ]]; then
  # Neither signal could be read. Not a FAIL (nothing says a hook is dropped)
  # but say so loudly: a blind gate must never look like a green one.
  note "warn    UNVERIFIED: neither the config grant nor the recall self-check could be read on this host"
  echo "OK openclaw-hooks: no dropped conversation hooks detected (UNVERIFIED — see warns above)."
  exit 0
fi
echo "OK openclaw-hooks: no dropped conversation hooks detected."
exit 0
