#!/usr/bin/env bash
# Digital Me: per-session application_rate writer (Claude Code and Codex).
# Runs on Stop. Computes, for this session:
#   hook_injections  — count of UserPromptSubmit-hook deliveries
#   surfaced_unique  — unique wiki paths surfaced via the inject hook
#   acted_unique     — surfaced paths the agent later opened (memory_get /
#                      wiki Read) or named after the [Digital Me] marker
#   application_rate — acted_unique / surfaced_unique
# Appends one JSONL line per session to <runtime home>/hooks/application_rate.log
# (~/.claude/hooks or ~/.codex/hooks) so the daily intake script can
# corroborate live signal without re-parsing.
#
# The two hosts write different transcripts, so the runtime
# (`--runtime claude-code|codex`, see dm_hook_lib.sh) picks the parser:
#   claude-code  Surfaced set = the inject hook's `hook_additional_context`
#                attachments in the session JSONL; hook_injections counts
#                them. Access = `Read` of a wiki/tastes file or
#                `mcp__digital-me-brain__memory_get` tool_use blocks. Needs the
#                transcript.
#   codex        Surfaced set = the inject hook's per-session SEEN_FILE
#                (/tmp/dm_hook_seen_codex_<sid>.txt), NOT the rollout JSONL:
#                Codex's hook `additionalContext` lands ambiguously there,
#                whereas the SEEN_FILE is the exact list the hook surfaced.
#                Access = response_item function_call entries named
#                `memory_get` / `mcp__digital_me_brain__memory_get`. Needs the
#                SEEN_FILE; the transcript is optional.
# Both fold `.last_assistant_message` from stdin (when the host sends it)
# into the [Digital Me] ack scan, and the record carries `runtime`.
#
# Fails open (exit 0, no output) on any error.

set -u
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

DM_HOOK_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)"
# shellcheck source=dm_hook_lib.sh
. "$DM_HOOK_DIR/dm_hook_lib.sh" 2>/dev/null && dm_hook_init "$@" || exit 0

STDIN="$(cat)"
SESSION_ID="$(printf '%s' "$STDIN" | jq -r '.session_id // empty' 2>/dev/null)"
TRANSCRIPT_PATH="$(printf '%s' "$STDIN" | jq -r '.transcript_path // empty' 2>/dev/null)"
LAST_MSG="$(printf '%s' "$STDIN" | jq -r '.last_assistant_message // empty' 2>/dev/null)"
[ -z "$SESSION_ID" ] && exit 0

SEEN_FILE="${DM_SEEN_PREFIX}${SESSION_ID}.txt"
case "$DM_RUNTIME" in
  codex)
    # Nothing surfaced this session → nothing to score. Exit quiet.
    [ ! -f "$SEEN_FILE" ] && exit 0
    ;;
  *)
    [ -z "$TRANSCRIPT_PATH" ] && exit 0
    [ ! -f "$TRANSCRIPT_PATH" ] && exit 0
    ;;
esac

LOG_DIR="$DM_RUNTIME_HOME/hooks"
LOG_FILE="$LOG_DIR/application_rate.log"
mkdir -p "$LOG_DIR"

# The M1 emitter ships next to this hook (both are installed into the same
# hooks dir); pass our own absolute dir explicitly because a `python3 -`
# heredoc has no usable __file__ ('<stdin>' → the user's cwd).
DM_LAST_ASSISTANT="$LAST_MSG" \
python3 - "$SESSION_ID" "$TRANSCRIPT_PATH" "$LOG_FILE" "$DM_HOOK_DIR" "$DM_RUNTIME" "$SEEN_FILE" "$DM_RUNTIME_HOME" <<'PYEOF' 2>/dev/null || exit 0
import json, os, re, sys
from datetime import datetime

(session_id, transcript_path, log_file, hook_dir, runtime, seen_file,
 runtime_home) = sys.argv[1:8]
# The inject hook's header. The server was renamed openclaw-brain →
# digital-me-brain; transcripts from before the rename carry the old header
# (and tool names), and they still count.
HOOK_BLOCK_MARKERS = ("Digital Me / digital-me-brain memory_search top hits",
                      "Digital Me / openclaw-brain memory_search top hits")
HOOK_BULLET_RE = re.compile(r"^-\s+(\S+\.md)\s+\(score=", re.M)
MEMGET_NAMES = {"memory_get",
                "mcp__digital-me-brain__memory_get", "mcp__digital_me_brain__memory_get",
                "mcp__openclaw-brain__memory_get", "mcp__openclaw_brain__memory_get"}

def normalize_path(raw):
    # Per NUX scope-down §A: tastes live alongside wiki under ~/digital-me/.
    # Both trees feed application_rate; surfaced (memory_search .path) and
    # accessed (memory_get .path / Read file_path) forms reduce to a
    # 'wiki/<rel>' or 'tastes/<rel>' key so they intersect and downstream
    # metrics can split by tree.
    if not raw:
        return None
    if "/wiki/" in raw:
        return "wiki/" + raw.split("/wiki/", 1)[1]
    if "/tastes/" in raw:
        return "tastes/" + raw.split("/tastes/", 1)[1]
    return raw

def memget_path(raw):
    # memory_get paths may be tree-prefixed already ('wiki/<...>' or
    # 'tastes/<...>'), absolute, or a bare wiki-relative '<dir>/<entry>.md'
    # (assume wiki for backcompat). memory/ paths are not wiki entries.
    raw = str(raw or "")
    if not raw.endswith(".md") or raw.startswith("memory/"):
        return None
    p = normalize_path(raw)
    if p is None or p.startswith("/"):
        return None
    if p.startswith("wiki/") or p.startswith("tastes/"):
        return p
    return "wiki/" + p

hook_injections = 0
surfaced = {}        # normalized path -> count (insertion order = injection order)
accessed = set()
user_msgs = 0
tool_uses = 0
assistant_text_parts = []   # all assistant text blocks, for [Digital Me] ack scan

def read_transcript_lines():
    if not transcript_path or not os.path.isfile(transcript_path):
        return []
    with open(transcript_path, encoding="utf-8") as f:
        return f.readlines()

def parse_claude_code(lines):
    """Claude Code session JSONL: the inject hook's context arrives as a
    `hook_additional_context` attachment; tools are `tool_use` blocks."""
    global hook_injections, user_msgs, tool_uses
    for line in lines:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t = ev.get("type")
        if t == "attachment":
            att = ev.get("attachment", {})
            if att.get("type") != "hook_additional_context":
                continue
            contents = att.get("content")
            if isinstance(contents, list):
                text = "\n".join(c if isinstance(c, str) else c.get("text", "") for c in contents)
            else:
                text = contents if isinstance(contents, str) else ""
            if not any(m in text for m in HOOK_BLOCK_MARKERS):
                continue
            hook_injections += 1
            # cut at action sentinel
            for sent in ("\n[Digital Me]", "\nACTION REQUIRED:", "\nIf relevant, open the full"):
                idx = text.find(sent)
                if idx > 0:
                    text = text[:idx]
                    break
            seen_in_block = set()
            for m in HOOK_BULLET_RE.finditer(text):
                p = normalize_path(m.group(1))
                if p and p not in seen_in_block:
                    seen_in_block.add(p)
                    surfaced[p] = surfaced.get(p, 0) + 1
            continue
        if t == "user":
            msg = ev.get("message", {})
            c = msg.get("content")
            if isinstance(c, str) or (isinstance(c, list) and any(isinstance(x, dict) and x.get("type") == "text" for x in c)):
                user_msgs += 1
        if t == "assistant":
            msg = ev.get("message", {})
            for c in msg.get("content", []) if isinstance(msg.get("content"), list) else []:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "text":
                    txt = c.get("text")
                    if isinstance(txt, str) and txt:
                        assistant_text_parts.append(txt)
                    continue
                if c.get("type") != "tool_use":
                    continue
                tool_uses += 1
                name = c.get("name", "")
                inp = c.get("input") or {}
                if name == "Read":
                    fp = str(inp.get("file_path", ""))
                    # Tag accessed paths with tree prefix so the dashboard
                    # intake can split application_rate by wiki vs tastes.
                    if "/digital-me/wiki/" in fp or "/digital-me/tastes/" in fp:
                        accessed.add(normalize_path(fp))
                elif name in MEMGET_NAMES:
                    p = memget_path(inp.get("path", ""))
                    if p:
                        accessed.add(p)

def parse_codex(lines):
    """Codex rollout JSONL: tool calls are response_item function_call /
    custom_tool_call entries (arguments is a JSON string); assistant text is
    response_item message output_text blocks."""
    global user_msgs, tool_uses
    for line in lines:
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
            if p.get("name", "") in MEMGET_NAMES:
                raw_args = p.get("arguments") or p.get("input") or "{}"
                try:
                    a = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                except Exception:
                    a = {}
                if isinstance(a, dict):
                    mp = memget_path(a.get("path", ""))
                    if mp:
                        accessed.add(mp)
            continue
        if t == "response_item" and pt == "message" and p.get("role") == "assistant":
            for c in p.get("content", []) if isinstance(p.get("content"), list) else []:
                if isinstance(c, dict) and c.get("type") in ("output_text", "text"):
                    txt = c.get("text")
                    if isinstance(txt, str) and txt:
                        assistant_text_parts.append(txt)

if runtime == "codex":
    # Surfaced universe: the inject hook's per-session SEEN_FILE.
    try:
        with open(seen_file, encoding="utf-8") as f:
            for line in f:
                sp = normalize_path(line.strip())
                if sp and sp not in surfaced:
                    surfaced[sp] = 1
    except OSError:
        sys.exit(0)
    hook_injections = len(surfaced)
    try:
        parse_codex(read_transcript_lines())
    except Exception:
        pass  # the SEEN_FILE alone still scores the session
else:
    try:
        parse_claude_code(read_transcript_lines())
    except Exception:
        sys.exit(0)

# `last_assistant_message` (from stdin, when the host sends it) is the most
# reliable [Digital Me] carrier — the final answer — so always fold it in.
last_msg = os.environ.get("DM_LAST_ASSISTANT", "")
if last_msg:
    assistant_text_parts.append(last_msg)

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
    "runtime": runtime,
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(record) + "\n")

# ─── M1 universal-protocol emit ───────────────────────────────────────────
# Two events per session at Stop time:
#   1. session_end      one summary
#   2. assistant_ack    parser-derived ack signal (only when something was
#                       surfaced)
#
# Best-effort: any failure here is swallowed (record + aggregate log
# above are the authoritative legacy outputs). See wiki:
# infrastructure/m1-universal-event-protocol.md
try:
    import subprocess as _sp
    # The emitter is installed alongside this hook: resolve it from the hook
    # dir the shell wrapper passed, never from __file__ (this is a stdin
    # heredoc) or the cwd. Fallback to <runtime home>/hooks/dm_m1_emit.py.
    _emit = os.path.join(hook_dir or ".", "dm_m1_emit.py")
    if not os.path.isfile(_emit):
        _emit = os.path.join(runtime_home, "hooks", "dm_m1_emit.py")

    if os.path.isfile(_emit):
        def _emit_event(event_type, turn_id, entries, ack_signal=None, extra=None):
            cmd = [
                "python3", _emit, event_type,
                "--runtime", runtime,
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
                    "ack_method": (
                        "stop_hook_last_message+transcript_scan+digital_me_prefix"
                        if runtime == "codex"
                        else "stop_hook_transcript_scan+digital_me_prefix"
                    ),
                },
            )
except Exception:
    pass  # best-effort — record + aggregate log already written
PYEOF

exit 0
