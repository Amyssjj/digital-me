#!/usr/bin/env bash
# Digital Me (Codex): per-session application_rate writer.
# Runs on Codex Stop. Computes, for this session:
#   surfaced_unique  — unique wiki paths surfaced via the inject hook
#   acted_unique     — surfaced paths the agent later opened (memory_get) or
#                      named after the [Digital Me] marker in its reply
#   application_rate — acted_unique / surfaced_unique
# Appends one JSONL line per session to ~/.codex/hooks/application_rate.log
# so the daily intake script can corroborate live signal without re-parsing.
#
# Codex differences from the Claude Code port:
#   - Surfaced set comes from the inject hook's per-session SEEN_FILE
#     (/tmp/dm_hook_seen_codex_<sid>.txt), NOT from re-parsing the transcript:
#     Codex's hook `additionalContext` lands ambiguously in the rollout JSONL,
#     whereas the SEEN_FILE is the exact list the inject hook surfaced.
#   - Access scan reads Codex `response_item`/`function_call` entries named
#     `memory_get` or `mcp__openclaw_brain__memory_get` (with arguments.path).
#   - The ack/[Digital Me] scan uses `.last_assistant_message` (delivered on
#     stdin by Codex) plus assistant `output_text` blocks from the transcript.
#
# Fails open (exit 0, no output) on any error.

set -u
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

STDIN="$(cat)"
SESSION_ID="$(printf '%s' "$STDIN" | jq -r '.session_id // empty' 2>/dev/null)"
TRANSCRIPT_PATH="$(printf '%s' "$STDIN" | jq -r '.transcript_path // empty' 2>/dev/null)"
LAST_MSG="$(printf '%s' "$STDIN" | jq -r '.last_assistant_message // empty' 2>/dev/null)"
[ -z "$SESSION_ID" ] && exit 0

SEEN_FILE="/tmp/dm_hook_seen_codex_${SESSION_ID}.txt"
# Nothing surfaced this session → nothing to score. Exit quiet.
[ ! -f "$SEEN_FILE" ] && exit 0

LOG_DIR="$HOME/.codex/hooks"
LOG_FILE="$LOG_DIR/application_rate.log"
mkdir -p "$LOG_DIR"

EMIT_DIR="$(dirname "$0")"

DM_LAST_ASSISTANT="$LAST_MSG" \
python3 - "$SESSION_ID" "$TRANSCRIPT_PATH" "$LOG_FILE" "$SEEN_FILE" "$EMIT_DIR" <<'PYEOF' 2>/dev/null || exit 0
import json, os, re, sys
from datetime import datetime

session_id, transcript_path, log_file, seen_file, emit_dir = (
    sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
)

def normalize_path(raw):
    # Both surfaced (memory_search .path) and accessed (memory_get .path)
    # forms reduce to a 'wiki/<rel>' or 'tastes/<rel>' key so they intersect.
    if not raw:
        return None
    if "/wiki/" in raw:
        return "wiki/" + raw.split("/wiki/", 1)[1]
    if "/tastes/" in raw:
        return "tastes/" + raw.split("/tastes/", 1)[1]
    if raw.startswith("wiki/") or raw.startswith("tastes/"):
        return raw
    return raw

# ─── Surfaced universe: the inject hook's per-session SEEN_FILE ────────────
surfaced = {}  # normalized path -> insertion order
try:
    with open(seen_file, encoding="utf-8") as f:
        for line in f:
            p = normalize_path(line.strip())
            if p and p not in surfaced:
                surfaced[p] = len(surfaced)
except OSError:
    sys.exit(0)

surfaced_set = set(surfaced.keys())
if not surfaced_set:
    sys.exit(0)

# ─── Access + counts: parse the Codex rollout JSONL ───────────────────────
# Codex MCP tool calls appear as response_item/function_call. The brain's
# memory_get tool may be named bare (`memory_get`, with a sibling
# `namespace` field) or fully-qualified (`mcp__openclaw_brain__memory_get`).
MEMGET_NAMES = {"memory_get", "mcp__openclaw_brain__memory_get",
                "mcp__openclaw-brain__memory_get"}
accessed = set()
user_msgs = 0
tool_uses = 0
assistant_text_parts = []

if transcript_path and os.path.isfile(transcript_path):
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                t = ev.get("type")
                p = ev.get("payload") if isinstance(ev.get("payload"), dict) else {}
                pt = p.get("type")
                if t == "event_msg" and pt == "user_message":
                    user_msgs += 1
                    continue
                if t == "response_item" and pt in ("function_call", "custom_tool_call"):
                    tool_uses += 1
                    name = p.get("name", "")
                    if name in MEMGET_NAMES:
                        raw_args = p.get("arguments") or p.get("input") or "{}"
                        try:
                            a = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                        except Exception:
                            a = {}
                        if isinstance(a, dict):
                            np = normalize_path(str(a.get("path", "")))
                            if np:
                                accessed.add(np)
                    continue
                if t == "response_item" and pt == "message" and p.get("role") == "assistant":
                    for c in p.get("content", []) if isinstance(p.get("content"), list) else []:
                        if isinstance(c, dict) and c.get("type") in ("output_text", "text"):
                            txt = c.get("text")
                            if isinstance(txt, str) and txt:
                                assistant_text_parts.append(txt)
    except Exception:
        pass

# `last_assistant_message` (from stdin) is the most reliable [Digital Me]
# carrier — the final answer — so always fold it in.
last_msg = os.environ.get("DM_LAST_ASSISTANT", "")
if last_msg:
    assistant_text_parts.append(last_msg)

acted = surfaced_set & accessed
ignored = surfaced_set - accessed

now = datetime.now().astimezone()
record = {
    "ts": now.isoformat(),
    "session_id": session_id,
    "session_date": now.date().isoformat(),
    "user_msgs": user_msgs,
    "tool_uses": tool_uses,
    "hook_injections": len(surfaced_set),
    "surfaced_unique": len(surfaced_set),
    "acted_unique": len(acted),
    "application_rate": (len(acted) / len(surfaced_set)) if surfaced_set else None,
    "acted_paths": sorted(acted),
    "ignored_paths": sorted(ignored),
    "source": "live",
    "runtime": "codex",
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(record) + "\n")

# ─── M1 universal-protocol emit ───────────────────────────────────────────
# Two events at Stop time:
#   1. assistant_ack    parser-derived ack signal (mirrors openclaw
#                       parseDigitalMeAck + hermes _parse_ack semantics)
#   2. session_end      one summary
# Best-effort: any failure here is swallowed (record above is authoritative).
try:
    import subprocess as _sp
    _emit = os.path.join(emit_dir or ".", "dm_m1_emit.py")
    if not os.path.isfile(_emit):
        _emit = os.path.expanduser("~/.codex/hooks/dm_m1_emit.py")

    if os.path.isfile(_emit):
        def _emit_event(event_type, turn_id, entries, ack_signal=None, extra=None):
            cmd = [
                "python3", _emit, event_type,
                "--session-id", session_id,
                "--turn-id", str(turn_id),
                "--entries-json", json.dumps(entries),
                "--quiet",
            ]
            if ack_signal:
                cmd += ["--ack-signal", ack_signal]
            if extra:
                cmd += ["--extra-json", json.dumps(extra)]
            try:
                _sp.run(cmd, timeout=3, check=False, capture_output=True)
            except Exception:
                pass

        _emit_event(
            event_type="session_end",
            turn_id=str(len(surfaced_set)),
            entries=[{"path": p} for p in sorted(surfaced_set)],
            extra={
                "reason": "stop_hook",
                "hook_injections": len(surfaced_set),
                "surfaced_unique": len(surfaced_set),
                "acted_unique": len(acted),
                "user_msgs": user_msgs,
                "tool_uses": tool_uses,
            },
        )

        # assistant_ack — two acted sources both count as application: the
        # agent OPENING a surfaced file (memory_get access) and NAMING it
        # after the [Digital Me] application-start marker in its reply.
        _norm = re.sub(r"\s+", " ", "\n".join(assistant_text_parts).strip().lower())
        _NO_APPLICABLE = (
            "no applicable wiki entries", "no applicable entries",
            "no applicable wiki entry", "none of the entries above",
            "none apply", "no relevant wiki", "no relevant entries",
        )
        _has_prefix = "[digital me]" in _norm
        _declined = any(pat in _norm for pat in _NO_APPLICABLE)
        if _declined:
            ack_signal, ack_paths = "no_applicable", []
        else:
            _name_acted = set()
            for p in surfaced_set:
                pl = p.lower()
                slug = pl.rsplit("/", 1)[-1] if "/" in pl else pl
                slug_noext = slug[:-3] if slug.endswith(".md") else slug
                if (len(pl) > 10 and pl in _norm) or (len(slug_noext) > 6 and slug_noext in _norm):
                    _name_acted.add(p)
            _combined = (surfaced_set & accessed) | _name_acted
            # Bare prefix present but nothing matchable → attribute the
            # first-injected surfaced entry, so the marker still registers
            # application start without inflating the acted set.
            if _has_prefix and not _combined:
                _combined = {min(surfaced, key=surfaced.get)}
            if _combined:
                ack_signal, ack_paths = "explicit_path", sorted(_combined)
            else:
                ack_signal, ack_paths = "no_acknowledgement", []
        _emit_event(
            event_type="assistant_ack",
            turn_id=str(len(surfaced_set)),
            entries=[{"path": p} for p in ack_paths],
            ack_signal=ack_signal,
            extra={
                "surfaced_count": len(surfaced_set),
                "ack_method": "stop_hook_last_message+transcript_scan+digital_me_prefix",
            },
        )
except Exception:
    pass  # best-effort — record above already written
PYEOF

exit 0
