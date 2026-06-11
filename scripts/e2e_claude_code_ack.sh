#!/usr/bin/env bash
# E2E test for the Claude Code M1 ack path: feeds a synthetic transcript
# (knowledge_surfaced via hook attachment + an assistant reply carrying the
# [Digital Me] marker) through dm_application_rate.sh and asserts the
# emitted assistant_ack signal. HOME is redirected to a tempdir so the M1 WAL
# never touches the live ~/.openclaw/data files.
#
# Usage: bash scripts/e2e_claude_code_ack.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS="$REPO_ROOT/packages/runtimes/claude-code/hooks"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/.claude/hooks"
cp "$HOOKS/dm_m1_emit.py" "$TMP/.claude/hooks/dm_m1_emit.py"
TRANSCRIPT="$TMP/transcript.jsonl"

mk_transcript() {
  python3 - "$TRANSCRIPT" "$1" <<'PY'
import json, sys
p, reply = sys.argv[1], sys.argv[2]
inject = ("Digital Me / openclaw-brain memory_search top hits for this prompt:\n"
          "- infrastructure/m1-universal-event-protocol.md (score=80/100)\n"
          "- youtube/thumbnail-rules.md (score=55/100)\n\n[Digital Me] protocol ...")
rows = [
    {"type": "attachment", "attachment": {"type": "hook_additional_context", "content": inject}},
    {"type": "user", "message": {"content": "how does m1 work?"}},
    {"type": "assistant", "message": {"content": [{"type": "text", "text": reply}]}},
]
open(p, "w").write("\n".join(json.dumps(r) for r in rows) + "\n")
PY
}

run() {
  echo "{\"session_id\":\"$1\",\"transcript_path\":\"$TRANSCRIPT\"}" \
    | HOME="$TMP" OPENCLAW_GATEWAY_URL="http://127.0.0.1:1" \
      bash "$HOOKS/dm_application_rate.sh"
}

mk_transcript "[Digital Me] applying m1-universal-event-protocol — here's how."; run "e2e-A"
mk_transcript "[Digital Me] no applicable wiki entries. Proceeding.";          run "e2e-B"
mk_transcript "Sure, here's a plain answer with no protocol prefix.";            run "e2e-C"

python3 - "$TMP/.openclaw/data/m1_events_claude_code.jsonl" <<'PY'
import json, sys
want = {"e2e-A": "explicit_path", "e2e-B": "no_applicable", "e2e-C": "no_acknowledgement"}
got = {}
for line in open(sys.argv[1]):
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("event_type") == "assistant_ack":
        got[e["session_id"]] = e.get("ack_signal")
fail = 0
for sid, exp in want.items():
    actual = got.get(sid)
    ok = actual == exp
    fail += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'} {sid}: ack_signal={actual} (expected {exp})")
print(f"\n{len(want) - fail}/{len(want)} passed")
raise SystemExit(1 if fail else 0)
PY
