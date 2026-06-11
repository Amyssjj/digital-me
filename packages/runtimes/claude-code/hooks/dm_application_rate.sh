#!/usr/bin/env bash
# Digital Me: per-session application_rate writer.
# Runs on Stop. Reads the session's JSONL, computes:
#   hook_injections  — count of UserPromptSubmit-hook deliveries
#   surfaced_unique  — unique wiki paths surfaced via hook
#   acted_unique     — surfaced paths the agent later opened (memory_get / wiki Read)
#   application_rate — acted_unique / surfaced_unique
# Appends one JSONL line per session to ~/.claude/hooks/application_rate.log
# so the daily intake script can corroborate live signal without re-parsing.
#
# Fails open (exit 0, no output) on any error.

set -u
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

STDIN="$(cat)"
SESSION_ID="$(printf '%s' "$STDIN" | jq -r '.session_id // empty' 2>/dev/null)"
TRANSCRIPT_PATH="$(printf '%s' "$STDIN" | jq -r '.transcript_path // empty' 2>/dev/null)"
[ -z "$SESSION_ID" ] || [ -z "$TRANSCRIPT_PATH" ] && exit 0
[ ! -f "$TRANSCRIPT_PATH" ] && exit 0

LOG_DIR="$HOME/.claude/hooks"
LOG_FILE="$LOG_DIR/application_rate.log"
mkdir -p "$LOG_DIR"

python3 - "$SESSION_ID" "$TRANSCRIPT_PATH" "$LOG_FILE" <<'PYEOF' 2>/dev/null || exit 0
import json, re, sys
from datetime import datetime

session_id, transcript_path, log_file = sys.argv[1], sys.argv[2], sys.argv[3]
HOOK_BLOCK_MARKER = "Digital Me / openclaw-brain memory_search top hits"
HOOK_BULLET_RE = re.compile(r"^-\s+(\S+\.md)\s+\(score=", re.M)

def normalize_path(raw):
    # Per NUX scope-down §A: tastes live alongside wiki under ~/digital-me/.
    # Both trees feed application_rate; prefix the normalized path with
    # 'wiki/' or 'tastes/' so downstream metrics can split by tree.
    if not raw: return None
    if "/wiki/" in raw: return "wiki/" + raw.split("/wiki/", 1)[1]
    if "/tastes/" in raw: return "tastes/" + raw.split("/tastes/", 1)[1]
    return raw

hook_injections = 0
surfaced = {}        # path -> count (insertion order = injection order)
accessed = set()
user_msgs = 0
tool_uses = 0
assistant_text_parts = []   # all assistant text blocks, for [Digital Me] ack scan

try:
    with open(transcript_path, encoding="utf-8") as f:
        for line in f:
            try: ev = json.loads(line)
            except: continue
            t = ev.get("type")
            if t == "attachment":
                att = ev.get("attachment", {})
                if att.get("type") != "hook_additional_context": continue
                contents = att.get("content")
                if isinstance(contents, list):
                    text = "\n".join(c if isinstance(c,str) else c.get("text","") for c in contents)
                else:
                    text = contents if isinstance(contents,str) else ""
                if HOOK_BLOCK_MARKER not in text: continue
                hook_injections += 1
                # cut at action sentinel
                for sent in ("\n[Digital Me]", "\nACTION REQUIRED:", "\nIf relevant, open the full"):
                    idx = text.find(sent)
                    if idx > 0: text = text[:idx]; break
                seen_in_block = set()
                for m in HOOK_BULLET_RE.finditer(text):
                    p = normalize_path(m.group(1))
                    if p and p not in seen_in_block:
                        seen_in_block.add(p)
                        surfaced[p] = surfaced.get(p, 0) + 1
                continue
            if t == "user":
                msg = ev.get("message",{})
                c = msg.get("content")
                if isinstance(c, str) or (isinstance(c, list) and any(isinstance(x,dict) and x.get("type")=="text" for x in c)):
                    user_msgs += 1
            if t == "assistant":
                msg = ev.get("message",{})
                for c in msg.get("content",[]) if isinstance(msg.get("content"),list) else []:
                    if not isinstance(c, dict): continue
                    if c.get("type") == "text":
                        txt = c.get("text")
                        if isinstance(txt, str) and txt:
                            assistant_text_parts.append(txt)
                        continue
                    if c.get("type") != "tool_use": continue
                    tool_uses += 1
                    name = c.get("name","")
                    inp = c.get("input") or {}
                    if name == "Read":
                        fp = str(inp.get("file_path",""))
                        # Tag accessed paths with tree prefix so the dashboard
                        # intake can split application_rate by wiki vs tastes.
                        if "/digital-me/wiki/" in fp:
                            accessed.add("wiki/" + fp.split("/wiki/",1)[1])
                        elif "/digital-me/tastes/" in fp:
                            accessed.add("tastes/" + fp.split("/tastes/",1)[1])
                    elif name == "mcp__openclaw-brain__memory_get":
                        raw = str(inp.get("path",""))
                        if raw.endswith(".md") and not raw.startswith("/") and not raw.startswith("memory/"):
                            # memory_get paths may be 'wiki/<...>' or 'tastes/<...>'
                            # already (the brain returns tree-prefixed paths). If
                            # neither prefix is present, assume wiki for backcompat.
                            if raw.startswith("wiki/") or raw.startswith("tastes/"):
                                accessed.add(raw)
                            else:
                                accessed.add("wiki/" + raw)
except Exception:
    sys.exit(0)

surfaced_set = set(surfaced.keys())
acted = surfaced_set & accessed
ignored = surfaced_set - accessed

now = datetime.now().astimezone()
record = {
    "ts": now.isoformat(),
    "session_id": session_id,
    "session_date": now.date().isoformat(),
    "user_msgs": user_msgs,
    "tool_uses": tool_uses,
    "hook_injections": hook_injections,
    "surfaced_unique": len(surfaced_set),
    "acted_unique": len(acted),
    "application_rate": (len(acted) / len(surfaced_set)) if surfaced_set else None,
    "acted_paths": sorted(acted),
    "ignored_paths": sorted(ignored),
    "source": "live",
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(record) + "\n")

# ─── M1 universal-protocol emit (2026-05-27) ─────────────────────────────
# Two events per session at Stop time:
#   1. assistant_ack    one per surfaced turn — parser-derived ack signal
#   2. session_end      one summary
# Lookup paths surfaced per-turn via the SEEN_FILE the inject hook writes
# (one path per line, in injection order). Each block of paths between
# inject-points is one "turn" — parse the assistant messages that fell
# between the inject and the next user message for ack signals.
#
# Best-effort: any failure here is swallowed (record + aggregate log
# above are the authoritative legacy outputs). See wiki:
# infrastructure/m1-universal-event-protocol.md
try:
    import os as _os, subprocess as _sp
    _emit = _os.path.join(_os.path.dirname(__file__) or ".", "dm_m1_emit.py")
    # The shell hook installs both scripts in the same dir; resolve via /tmp
    # subprocess-style by finding the emitter relative to this stop-hook script.
    # Fallback to ~/.claude/hooks/dm_m1_emit.py
    if not _os.path.isfile(_emit):
        _emit = _os.path.expanduser("~/.claude/hooks/dm_m1_emit.py")

    if _os.path.isfile(_emit):
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

        # session_end summary — single event with rollup counts in `extra`
        # and the surfaced universe in `entries`.
        _emit_event(
            event_type="session_end",
            turn_id=str(hook_injections),
            entries=[{"path": p} for p in sorted(surfaced_set)],
            extra={
                "reason": "stop_hook",
                "hook_injections": hook_injections,
                "surfaced_unique": len(surfaced_set),
                "acted_unique": len(acted),
                "user_msgs": user_msgs,
                "tool_uses": tool_uses,
            },
        )

        # assistant_ack — the canonical M1 ack for the stop. Mirrors the
        # openclaw `parseDigitalMeAck` + hermes `_parse_ack` semantics so the
        # signal is computed identically across runtimes. Two acted sources
        # both count as application: the agent OPENING a surfaced file
        # (access, via Read/memory_get) and NAMING it after the
        # `[Digital Me]` application-start marker in its reply (text).
        if surfaced_set:
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
                # top-1 (first-injected) surfaced entry, so the marker still
                # registers application start without inflating the acted set.
                if _has_prefix and not _combined:
                    _combined = {next(iter(surfaced))}
                if _combined:
                    ack_signal, ack_paths = "explicit_path", sorted(_combined)
                else:
                    ack_signal, ack_paths = "no_acknowledgement", []
            _emit_event(
                event_type="assistant_ack",
                turn_id=str(hook_injections),
                entries=[{"path": p} for p in ack_paths],
                ack_signal=ack_signal,
                extra={
                    "surfaced_count": len(surfaced_set),
                    "ack_method": "stop_hook_transcript_scan+digital_me_prefix",
                },
            )
except Exception:
    pass  # best-effort — record + aggregate log already written
PYEOF

exit 0
