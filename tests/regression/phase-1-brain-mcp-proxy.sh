#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Phase 1 regression test — brain-mcp-proxy
#
# Verifies the extracted brain-mcp-proxy produces identical responses to the
# upstream personal proxy for the same set of queries against the same running
# openclaw gateway.
#
# Requires:
#   - openclaw gateway running locally
#   - $HOME/openclaw/mcp-brain-proxy.mjs (the old proxy) present
#   - $ROOT/packages/transport/brain-mcp-proxy/ built (`pnpm build`)
#   - python3, node available on PATH
#
# Modes (REGRESSION_MODE):
#   capture — capture baseline from old proxy
#   run     — capture if absent, then diff new proxy against baseline
# ---------------------------------------------------------------------------

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASELINES_DIR="${REGRESSION_BASELINES_DIR:-$ROOT/tests/regression/baselines}"
MODE="${REGRESSION_MODE:-run}"

OLD_PROXY="$HOME/openclaw/mcp-brain-proxy.mjs"
NEW_PROXY="$ROOT/packages/transport/brain-mcp-proxy/bin/brain-mcp-proxy.mjs"
BASELINE_FILE="$BASELINES_DIR/phase-1-memory-search.json"

# Gateway reachability check (TCP port only — POST happens via proxy).
if ! nc -z localhost 18789 2>/dev/null; then
  echo "  SKIP: openclaw gateway not reachable at localhost:18789"
  exit 0
fi

if [ ! -f "$OLD_PROXY" ]; then
  echo "  SKIP: old proxy not found at $OLD_PROXY"
  exit 0
fi

if [ "$MODE" = "run" ] && [ ! -f "$NEW_PROXY" ]; then
  echo "  FAIL: new proxy not built (run \`pnpm build\` first)"
  exit 1
fi

mkdir -p "$BASELINES_DIR"

# Python helper: invoke a proxy via stdio, send handshake + 5 queries, read
# responses in a background thread, wait until all 5 are in, then close stdin
# and join.
#
# Why the thread: the proxy exits immediately on stdin EOF, but gateway calls
# are async, so closing stdin before responses are flushed loses them. We
# keep stdin open until we've observed all 5 expected responses.
run_proxy_py() {
  python3 - "$1" <<'PY'
import json
import os
import subprocess
import sys
import threading
import time

proxy_path = sys.argv[1]

QUERIES = [
    "task orchestrator",
    "brain mcp proxy",
    "wiki schema",
    "learning capture",
    "agent identify",
]

env = dict(os.environ)
env["OPENCLAW_AGENT_ID"] = "regression"

proc = subprocess.Popen(
    ["node", proxy_path],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    env=env,
    bufsize=0,
)

requests = []
requests.append({
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "regression", "version": "1"},
    },
})
requests.append({"jsonrpc": "2.0", "method": "notifications/initialized"})
for i, q in enumerate(QUERIES, start=2):
    requests.append({
        "jsonrpc": "2.0", "id": i, "method": "tools/call",
        "params": {
            "name": "memory_search",
            "arguments": {"query": q, "limit": 3, "agent_id": "regression"},
        },
    })

input_bytes = ("\n".join(json.dumps(r) for r in requests) + "\n").encode("utf-8")
proc.stdin.write(input_bytes)
proc.stdin.flush()

# Read stdout in a background thread.
output_lines = []
output_lock = threading.Lock()

def reader():
    for raw in iter(proc.stdout.readline, b""):
        line = raw.decode("utf-8", errors="replace").rstrip()
        if not line:
            continue
        with output_lock:
            output_lines.append(line)

t = threading.Thread(target=reader, daemon=True)
t.start()

# Wait for all 5 query responses (ids 2..6) or 60s timeout.
deadline = time.time() + 60
seen_ids = set()
while time.time() < deadline:
    with output_lock:
        for line in output_lines:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict) and isinstance(obj.get("id"), int) and obj["id"] >= 2:
                seen_ids.add(obj["id"])
    if len(seen_ids) >= len(QUERIES):
        break
    time.sleep(0.2)

# Close stdin, wait for proxy to exit, join reader.
try:
    proc.stdin.close()
except Exception:
    pass
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()
t.join(timeout=2)

# Normalize the collected responses. Strip ephemeral fields (timing,
# timestamps) that vary between runs but don't affect correctness.
def strip_ephemeral(obj):
    """Recursively remove gateway-side timing/runtime fields."""
    if isinstance(obj, dict):
        return {
            k: strip_ephemeral(v)
            for k, v in obj.items()
            if k not in {"searchMs", "debug", "t", "duration_ms"}
        }
    if isinstance(obj, list):
        return [strip_ephemeral(v) for v in obj]
    if isinstance(obj, str):
        # Some content blocks are JSON-encoded strings — re-strip the inner JSON.
        try:
            inner = json.loads(obj)
        except (json.JSONDecodeError, ValueError):
            return obj
        return json.dumps(strip_ephemeral(inner), sort_keys=True)
    return obj

results = []
seen = set()
with output_lock:
    for line in output_lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        rid = obj.get("id")
        if not isinstance(rid, int) or rid < 2:
            continue
        if rid in seen:
            continue
        seen.add(rid)
        result = obj.get("result")
        if not isinstance(result, dict):
            continue
        content = result.get("content")
        if not isinstance(content, list):
            continue
        results.append({
            "id": rid,
            "content": strip_ephemeral(content),
            "isError": bool(result.get("isError", False)),
        })

results.sort(key=lambda x: x["id"])
print(json.dumps(results, indent=2, sort_keys=True))
PY
}

case "$MODE" in
  capture)
    echo "  capturing baseline from old proxy"
    run_proxy_py "$OLD_PROXY" > "$BASELINE_FILE"
    count=$(python3 -c "import json,sys; print(len(json.load(open('$BASELINE_FILE'))))")
    if [ "$count" -eq 0 ]; then
      echo "  FAIL: baseline capture produced 0 responses"
      exit 1
    fi
    echo "  baseline written: $BASELINE_FILE ($count responses)"
    ;;
  run)
    if [ ! -f "$BASELINE_FILE" ]; then
      echo "  capturing baseline (run with REGRESSION_MODE=capture to refresh)"
      run_proxy_py "$OLD_PROXY" > "$BASELINE_FILE"
    fi
    baseline_count=$(python3 -c "import json; print(len(json.load(open('$BASELINE_FILE'))))" 2>/dev/null || echo 0)
    if [ "$baseline_count" -eq 0 ]; then
      echo "  SKIP: could not establish baseline (got 0 responses)"
      exit 0
    fi
    NEW_NORM="$(mktemp)"
    trap 'rm -f "$NEW_NORM"' EXIT
    echo "  running new proxy"
    run_proxy_py "$NEW_PROXY" > "$NEW_NORM"
    new_count=$(python3 -c "import json; print(len(json.load(open('$NEW_NORM'))))")
    if [ "$new_count" -eq 0 ]; then
      echo "  FAIL: new proxy produced 0 responses"
      exit 1
    fi
    if diff -u "$BASELINE_FILE" "$NEW_NORM"; then
      echo "  PASS: $new_count memory_search responses identical between old and new proxy"
      exit 0
    else
      echo "  FAIL: new proxy responses differ from baseline (see diff above)"
      exit 1
    fi
    ;;
  *)
    echo "  unknown REGRESSION_MODE: $MODE"
    exit 2
    ;;
esac
