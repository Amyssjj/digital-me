"""
digital-me-recall-hermes — Hermes plugin parity with Claude Code's
dm_memory_search_inject + dm_application_rate hooks and OpenClaw's
digital-me-recall plugin.

Hooks registered:
  pre_llm_call    → inject `<recalled-knowledge>` block into the turn
                    (M1 hygiene: score gate + per-session dedup + top-1
                    full body inline + [Digital Me] attribution + directive).
  pre_tool_call   → per-tool route reminders (matches frontmatter
                    `route: tool=X, params.Y contains "Z"` entries).
  post_tool_call  → track memory_get / Read / file-read tool calls so
                    on_session_end can compute application_rate.
  on_session_end  → append one JSONL record to the application_rate log
                    capturing surfaced/acted paths for this session.

Design notes:
  - MCP calls to openclaw-brain go via direct HTTP to the gateway
    (mirrors dm_memory_search_inject.sh). No PluginLlm needed.
  - All I/O is best-effort; any exception is swallowed inside the hook
    so a flaky gateway can never break the agent's turn.
  - Per-session state lives in module-level dicts keyed by session_id.
  - Auth token is read once at module load from the same canonical
    locations the CC hook uses.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# ── Tunables (kept in sync with CC hook + OpenClaw plugin) ────────────────

MIN_SCORE = 0.4              # drop memory_search hits below this score
TOP1_BODY_CHARS = 2000       # cap on inlined top-1 entry full body
SEARCH_LIMIT = 6             # request more than needed so hygiene leaves usable hits
SURFACED_PER_TURN_CAP = 3    # max hits surfaced per turn after filtering
QUERY_PREVIEW_CHARS = 400    # truncate user_message for the search query
HOOK_RECALL_MARKER = "<recalled-knowledge>"

# ── Auth + paths ──────────────────────────────────────────────────────────

HOME = Path.home()
WIKI_ROOT = Path(os.environ.get("DIGITAL_ME_WIKI_ROOT") or HOME / "digital-me") / "wiki"
APP_RATE_LOG = HOME / ".openclaw" / "data" / "application_rate_hermes.log"
GATEWAY_URL = "http://localhost:18789/tools/invoke"

# ── Self-contained M1 writer tunables (2026-05-26) ─────────────────────────
#
# Hermes runs as a long-lived Discord bot — `on_session_end` doesn't fire
# reliably for daemon-style runtimes (see wiki entry
# m1-application-rate-openclaw-hermes-hook-lifecycle). Without an
# internal periodic-flush trigger, the application_rate log stays empty
# even when pre_llm_call + post_tool_call fire correctly per turn.
#
# The flush thread iterates every PERIODIC_FLUSH_SEC and writes a
# cumulative snapshot for any session with new activity since its last
# flush. Stale sessions (no activity > STALE_SESSION_SEC) get finalized
# and dropped. The dashboard intake unions paths across all records per
# (date, tree, domain|agent), so re-emitting the same paths in
# successive snapshots is harmless.

def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        return default


PERIODIC_FLUSH_SEC = _env_int("DIGITAL_ME_HERMES_FLUSH_SEC", 5 * 60)
STALE_SESSION_SEC = _env_int("DIGITAL_ME_HERMES_STALE_SEC", 24 * 60 * 60)


def _load_gateway_token() -> Optional[str]:
    """Read auth token from the same paths the Claude Code hook uses."""
    for candidate in (
        os.environ.get("DIGITAL_ME_OPENCLAW_CONFIG"),
        str(HOME / ".openclaw" / "config.json"),
        str(HOME / ".clawdbot" / "openclaw.json"),
    ):
        if not candidate:
            continue
        try:
            with open(candidate, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            token = (cfg.get("gateway") or {}).get("auth", {}).get("token")
            if token:
                return token
        except (OSError, json.JSONDecodeError):
            continue
    return None


_GATEWAY_TOKEN: Optional[str] = None


def _get_token() -> Optional[str]:
    global _GATEWAY_TOKEN
    if _GATEWAY_TOKEN is None:
        _GATEWAY_TOKEN = _load_gateway_token()
    return _GATEWAY_TOKEN


# ── Per-session state ─────────────────────────────────────────────────────
#
# Module-level keyed by session_id. The Hermes plugin runtime loads the
# module once per process; sessions share a single process, so per-session
# dicts give us isolation.

_SESSION_SURFACED: Dict[str, Set[str]] = {}     # session_id → wiki paths surfaced this session
_SESSION_ACCESSED: Dict[str, Set[str]] = {}     # session_id → wiki paths the agent opened
_SESSION_HOOK_INJECTIONS: Dict[str, int] = {}   # session_id → count of non-empty injections
_SESSION_STARTED_AT: Dict[str, str] = {}        # session_id → ISO timestamp of first hook
_SESSION_REV: Dict[str, int] = {}               # session_id → monotonic revision (bumped on activity)
_SESSION_LAST_FLUSHED_REV: Dict[str, int] = {}  # session_id → rev at last successful flush
_SESSION_LAST_ACTIVE: Dict[str, float] = {}     # session_id → monotonic time of last activity

# ── M1 universal protocol state (2026-05-27) ─────────────────────────────
#
# Per-session per-turn snapshot of the entries surfaced into the LLM's
# context. The post_llm_call hook reads this to identify which entries
# the LLM acknowledged in its response. See wiki:
# infrastructure/m1-universal-event-protocol.md
_SESSION_TURN: Dict[str, int] = {}                              # session_id → monotonic turn counter
_SESSION_LAST_SURFACED: Dict[str, List[Dict[str, Any]]] = {}    # session_id → list of {path, title, score}
_SESSION_M1_STARTED: Set[str] = set()                           # session_ids that have emitted session_start
_SESSION_PLATFORM: Dict[str, str] = {}                          # session_id → "discord" | "cli" | ...
_SESSION_SNAPSHOT_REV: Dict[str, int] = {}                      # rev at last session_snapshot emit

# Coordinates the periodic flush thread, the per-hook bumps, and the
# atexit handler. Held only for the brief duration of state mutations
# and the snapshot iteration in flush_all_sessions.
_STATE_LOCK = threading.RLock()


def _session_started(session_id: str) -> None:
    if session_id not in _SESSION_STARTED_AT:
        _SESSION_STARTED_AT[session_id] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    _SESSION_SURFACED.setdefault(session_id, set())
    _SESSION_ACCESSED.setdefault(session_id, set())
    _SESSION_HOOK_INJECTIONS.setdefault(session_id, 0)
    _SESSION_REV.setdefault(session_id, 0)
    _SESSION_LAST_FLUSHED_REV.setdefault(session_id, 0)
    _SESSION_LAST_ACTIVE.setdefault(session_id, time.monotonic())
    _SESSION_TURN.setdefault(session_id, 0)
    _SESSION_LAST_SURFACED.setdefault(session_id, [])


def _session_cleanup(session_id: str) -> None:
    _SESSION_SURFACED.pop(session_id, None)
    _SESSION_ACCESSED.pop(session_id, None)
    _SESSION_HOOK_INJECTIONS.pop(session_id, None)
    _SESSION_STARTED_AT.pop(session_id, None)
    _SESSION_REV.pop(session_id, None)
    _SESSION_LAST_FLUSHED_REV.pop(session_id, None)
    _SESSION_LAST_ACTIVE.pop(session_id, None)
    _SESSION_TURN.pop(session_id, None)
    _SESSION_LAST_SURFACED.pop(session_id, None)
    _SESSION_M1_STARTED.discard(session_id)
    _SESSION_PLATFORM.pop(session_id, None)
    _SESSION_SNAPSHOT_REV.pop(session_id, None)


def _bump_activity(session_id: str) -> None:
    _SESSION_REV[session_id] = _SESSION_REV.get(session_id, 0) + 1
    _SESSION_LAST_ACTIVE[session_id] = time.monotonic()


# ── Gateway invocation ────────────────────────────────────────────────────


def _invoke_gateway(tool: str, args: Dict[str, Any], timeout: float = 4.0) -> Optional[Dict[str, Any]]:
    """Call an openclaw-brain MCP tool via the gateway. None on any failure."""
    token = _get_token()
    if not token:
        return None
    req_body = json.dumps({"tool": tool, "args": args}).encode("utf-8")
    req = urllib.request.Request(
        GATEWAY_URL,
        data=req_body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except (urllib.error.URLError, json.JSONDecodeError, OSError, TimeoutError):
        return None


# ── Path normalization (mirrors CC hook + OpenClaw plugin) ────────────────


def _normalize_hit_path(raw: str) -> Optional[str]:
    """Reduce the brain's path encoding to a wiki-relative form."""
    if not raw:
        return None
    if "/wiki/" in raw:
        return raw.split("/wiki/", 1)[1]
    if raw.startswith("memory/"):
        # Per-agent memory paths — keep as-is so dedup against tool calls works
        return raw
    if raw.startswith("/"):
        return None
    return raw


def _read_wiki_body(rel_path: str, max_chars: int = TOP1_BODY_CHARS) -> Optional[str]:
    """Read the body of a wiki entry, strip frontmatter, truncate."""
    if not rel_path or rel_path.startswith("memory/"):
        return None
    abs_path = WIKI_ROOT / rel_path
    if not abs_path.is_file():
        return None
    try:
        text = abs_path.read_text(encoding="utf-8")
    except OSError:
        return None
    parts = re.split(r"^---$", text, maxsplit=2, flags=re.M)
    body = (parts[2] if len(parts) >= 3 else text).strip()
    if not body:
        return None
    return body[:max_chars] + "…" if len(body) > max_chars else body


# ── M1 universal protocol emitter (2026-05-27) ────────────────────────────
#
# Best-effort emission to brain.m1_event_record. Failures are swallowed —
# the local JSONL writer (kept as the WAL) is the durable layer; brain is
# best-effort. See wiki: infrastructure/m1-universal-event-protocol.md
#
# Stable event_ids are computed client-side from
# (session_id, turn_id, event_type, entries-hash) so retries are
# idempotent on the brain side via INSERT OR IGNORE.

import hashlib

M1_RUNTIME_NAME = "hermes"
# Universal agent_id for ALL hermes M1 events regardless of surface
# (discord, cli, cron, etc). The protocol schema already carries
# `runtime: "hermes"`, and per-surface drilldown is captured in
# `extra.platform` — folding surface into agent_id would double-encode
# the dimension and inflate rollup row counts. Matches claude-code's
# convention (one agent_id per runtime).
M1_AGENT_ID = "hermes"
# Local WAL for raw canonical events. Append-only, one event per line.
# Source of truth for backfill when brain ingest is unreachable. See wiki:
# infrastructure/m1-universal-event-protocol.md, pillar 4 ("Durable
# transport / buffering").
M1_EVENTS_WAL = HOME / ".openclaw" / "data" / "m1_events_hermes.jsonl"


def _platform_for_extra(platform: Optional[str], session_id: str = "") -> Optional[str]:
    """Normalised platform string used in `extra.platform` so per-surface
    drilldown is possible without baking it into agent_id."""
    p = (platform or _SESSION_PLATFORM.get(session_id, "") or "").strip().lower()
    return p or None


def _m1_event_id(
    session_id: str, turn_id: str, event_type: str, entries: List[Dict[str, Any]],
    ack_signal: Optional[str] = None,
) -> str:
    entries_key = json.dumps(
        [[e.get("path", ""), e.get("score")] for e in entries],
        sort_keys=True,
    )
    h = hashlib.sha1(
        (entries_key + "|" + (ack_signal or "")).encode("utf-8"),
    ).hexdigest()[:12]
    return f"{session_id}::{turn_id}::{event_type}::{h}"


def _m1_wal_append(payload: Dict[str, Any]) -> None:
    """Append one canonical event to the local raw-event WAL. The full
    payload — not the brain MCP wire shape — so a backfill loop can
    reconstruct emitter intent verbatim. Best-effort; swallows IOErrors."""
    try:
        M1_EVENTS_WAL.parent.mkdir(parents=True, exist_ok=True)
        with M1_EVENTS_WAL.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, separators=(",", ":")) + "\n")
    except OSError as exc:
        logger.debug("digital-me-recall-hermes m1 wal append failed: %s", exc)


def _emit_m1_event(
    *,
    event_type: str,
    session_id: str,
    agent_id: str,
    turn_id: str,
    entries: Optional[List[Dict[str, Any]]] = None,
    ack_signal: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Emit one M1 event. Two-step durability per protocol pillar 4:

        1. Append the canonical event to the local WAL (durable).
        2. Best-effort send to brain via MCP (idempotent on event_id).

    Brain-side failures are swallowed; the WAL line is enough for a
    future backfill loop to replay safely (INSERT OR IGNORE on the brain
    side dedupes retries)."""
    try:
        entries = entries or []
        event_id = _m1_event_id(session_id, turn_id, event_type, entries, ack_signal)
        ts_ms = int(time.time() * 1000)
        canonical: Dict[str, Any] = {
            "event_id": event_id,
            "schema_version": 1,
            "metric": "m1_application_rate",
            "runtime": M1_RUNTIME_NAME,
            "agent_id": agent_id or M1_RUNTIME_NAME,
            "session_id": session_id,
            "turn_id": turn_id,
            "event_type": event_type,
            "entries": entries,
            "t": ts_ms,
        }
        if ack_signal:
            canonical["ack_signal"] = ack_signal
        if extra:
            canonical["extra"] = extra

        # Step 1 — local WAL first. Brain reachability is best-effort.
        _m1_wal_append(canonical)

        # Step 2 — brain MCP. JSON-encode list/dict fields per tool schema.
        args: Dict[str, Any] = {
            "event_id": canonical["event_id"],
            "schema_version": canonical["schema_version"],
            "runtime": canonical["runtime"],
            "agent_id": canonical["agent_id"],
            "session_id": canonical["session_id"],
            "turn_id": canonical["turn_id"],
            "event_type": canonical["event_type"],
            "entries": json.dumps(canonical["entries"]),
            "t": canonical["t"],
        }
        if ack_signal:
            args["ack_signal"] = ack_signal
        if extra:
            args["extra"] = json.dumps(extra)
        _invoke_gateway("m1_event_record", args, timeout=2.0)
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.debug("digital-me-recall-hermes m1 emit failed: %s", exc)


# ── M1 ack-signal parser ───────────────────────────────────────────────────
#
# Detects three signals on the LLM's response text:
#   1. "no applicable wiki entries" disclaimer  →  no_applicable
#   2. literal path mention (case-insensitive substring) →  explicit_path
#   3. title (frontmatter `title:` value) substring     →  title_match
# else                                                  →  no_acknowledgement
#
# Path/title matches build the `acted_paths` subset of the prior turn's
# surfaced entries.

_NO_APPLICABLE_PATTERNS: Tuple[str, ...] = (
    "no applicable wiki entries",
    "no applicable entries",
    "no applicable wiki entry",
    "none of the entries above",
    "none apply",
    "no relevant wiki",
    "no relevant entries",
)


def _normalise_for_match(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def _title_stem(title: str) -> str:
    """Strip trailing decorations from a wiki entry's title so that
    LLM responses don't need to quote them verbatim. Examples:
      "Brain API Contract (v1 → v2)"  →  "brain api contract"
      "Hermes — Lifecycle"            →  "hermes"
      "Foo: Bar"                      →  "foo"

    Conservative — only splits on a small set of decoration markers.
    Returns the lowercase stem, or "" if the stem is too short to be a
    confident match (<5 chars).
    """
    norm = _normalise_for_match(title)
    for sep in (" (", " — ", " - ", ": ", " | "):
        i = norm.find(sep)
        if i > 0:
            norm = norm[:i].strip()
            break
    return norm if len(norm) >= 5 else ""


def _parse_ack(
    response_text: str,
    surfaced_entries: List[Dict[str, Any]],
) -> Tuple[str, List[Dict[str, Any]]]:
    """Return (ack_signal, acted_entries_subset).

    Conservative — only counts matches it's confident about. False
    negatives (paraphrased citations missed) prefer over false positives.
    """
    if not surfaced_entries:
        return "no_acknowledgement", []

    norm = _normalise_for_match(response_text)
    if not norm:
        return "no_acknowledgement", []

    # The canonical application-start marker. Its bare presence (when not an
    # explicit decline) counts as an acknowledgment — see the fallback below.
    has_prefix = "[digital me]" in norm

    # Signal 1: explicit "no applicable" disclaimer.
    for pat in _NO_APPLICABLE_PATTERNS:
        if pat in norm:
            return "no_applicable", []

    # Signal 2 + 3: collect entries that have either a path-substring match
    # or a title-substring match.
    acted: List[Dict[str, Any]] = []
    saw_path_match = False
    for e in surfaced_entries:
        raw_path = e.get("path") or ""
        # The slug fragment after the last "/" is the most stable substring
        # the LLM would mention (e.g. "m1-application-rate-..."). The full
        # path with extension is also a strong signal.
        path_lower = raw_path.lower()
        slug = path_lower.rsplit("/", 1)[-1] if "/" in path_lower else path_lower
        # Strip the .md so "m1-application-rate-..." matches even when the
        # LLM doesn't include the extension.
        slug_noext = slug[:-3] if slug.endswith(".md") else slug
        path_match = (
            len(path_lower) > 10 and path_lower in norm
        ) or (
            len(slug_noext) > 6 and slug_noext in norm
        )

        title = (e.get("title") or "").strip()
        title_stem = _title_stem(title) if title else ""
        title_match = bool(title_stem) and title_stem in norm

        if path_match or title_match:
            acted.append(e)
            if path_match:
                saw_path_match = True

    if acted:
        return ("explicit_path" if saw_path_match else "title_match"), acted

    # Prefix present but named nothing matchable and didn't decline → still an
    # acknowledgment; attribute the top-1 (inlined) surfaced entry so the
    # marker registers application start without inflating the acted set.
    if has_prefix:
        return "title_match", [surfaced_entries[0]]

    return "no_acknowledgement", []


# ── Hook B — pre_llm_call: per-turn recall injection ──────────────────────


def _format_injection(hits: List[Dict[str, Any]]) -> str:
    """Render filtered hits into the <recalled-knowledge> block (mirrors
    Claude Code hook output)."""
    if not hits:
        return ""
    lines = [
        "Digital Me / openclaw-brain memory_search top hits for this prompt "
        "(auto-injected; may be stale — verify against current state before acting):",
        "",
    ]
    for i, hit in enumerate(hits):
        path = hit.get("path", "")
        score_int = int((hit.get("score") or 0) * 100)
        snippet = (hit.get("snippet") or "").replace("\n", " ")[:240]
        lines.append(f"- {path} (score={score_int}/100)")
        if i == 0:
            rel = _normalize_hit_path(path) or ""
            body = _read_wiki_body(rel) if rel else None
            if body:
                lines.append(f"  FULL BODY (top hit, truncated to {TOP1_BODY_CHARS} chars):")
                for ln in body.splitlines():
                    lines.append(f"    {ln}")
                continue
        lines.append(f"  {snippet}")
    lines.append("")
    lines.append(
        "[Digital Me] protocol — BEGIN your reply with a line that starts "
        "`[Digital Me]`. If one or more entries above apply, write "
        "`[Digital Me] applying <entry slug or title>` and use their content. "
        "If none apply, write `[Digital Me] no applicable wiki entries` and proceed. "
        "This prefix marks knowledge-application start and is tracked as M1 "
        "(application_rate); skipping it is a protocol violation. "
        "Entries already shown earlier in this session are filtered out — anything "
        "here is new context worth one explicit acknowledgment."
    )
    return "\n".join(lines)


def _extract_user_query(user_message: Any) -> str:
    """Pull plain text out of whatever shape Hermes passes."""
    if isinstance(user_message, str):
        return user_message.strip()
    if isinstance(user_message, dict):
        content = user_message.get("content") or user_message.get("text") or ""
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            return " ".join(
                str(c.get("text", ""))
                for c in content
                if isinstance(c, dict)
            ).strip()
    return ""


def _seed_session_m1_started_from_wal(max_lines: int = 5000) -> int:
    """Re-populate `_SESSION_M1_STARTED` from the WAL on plugin register.

    Without this, a module reload (~4×/day under daily gateway bounce)
    drops the in-memory guard set, and the next `pre_llm_call` for a
    still-active session re-fires `session_start` → duplicate line in
    WAL (brain dedupes by event_id so the DB stays clean, but local WAL
    hygiene suffers).

    Reads the tail of the WAL and adds every session_id that has a
    `session_start` event to the guard set. Bounded to `max_lines` so
    plugin register stays fast even after months of accumulated history.
    Returns the count of sessions seeded for the register-log line.
    """
    if not M1_EVENTS_WAL.exists():
        return 0
    seeded = 0
    try:
        with M1_EVENTS_WAL.open("rb") as f:
            # Read from the end so we don't load the whole file. ~200B
            # per line, max_lines * 256 is a safe upper bound.
            try:
                f.seek(0, 2)  # end
                file_size = f.tell()
                read_size = min(file_size, max_lines * 256)
                f.seek(file_size - read_size, 0)
                tail = f.read().decode("utf-8", errors="ignore")
            except OSError:
                tail = ""
        for line in tail.splitlines()[-max_lines:]:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("event_type") != "session_start":
                continue
            sid = ev.get("session_id")
            if isinstance(sid, str) and sid and sid not in _SESSION_M1_STARTED:
                _SESSION_M1_STARTED.add(sid)
                seeded += 1
    except OSError as exc:
        logger.debug("digital-me-recall-hermes WAL seed read failed: %s", exc)
    return seeded


def _maybe_emit_session_start(session_id: str, platform: Optional[str] = None) -> None:
    """Emit session_start exactly once per session. Guarded by an in-memory
    set seeded from the WAL on plugin register, so module reloads
    (~4×/day under daily gateway bounce) don't re-emit session_start for
    sessions that already had one before the reload."""
    if session_id in _SESSION_M1_STARTED:
        return
    _SESSION_M1_STARTED.add(session_id)
    extra: Dict[str, Any] = {}
    p = _platform_for_extra(platform, session_id)
    if p:
        extra["platform"] = p
    _emit_m1_event(
        event_type="session_start",
        session_id=session_id,
        agent_id=M1_AGENT_ID,
        turn_id="0",
        entries=[],
        extra=extra or None,
    )


def _on_pre_llm_call(
    *,
    session_id: str = "",
    user_message: Any = None,
    is_first_turn: bool = False,
    platform: str = "",
    **_: Any,
) -> Optional[Dict[str, str]]:
    """
    Inject <recalled-knowledge> into the turn. Returns
    {"context": "<text>"} which Hermes appends to the user message
    context for this turn. None / no return → no injection.
    """
    try:
        if not session_id:
            return None
        _session_started(session_id)

        # Track platform for `extra.platform` attribution. Hermes passes
        # platform in the hook kwargs (run_agent.py: pre_llm_call invoke
        # site). agent_id stays "hermes" universal — see M1_AGENT_ID.
        with _STATE_LOCK:
            if platform:
                _SESSION_PLATFORM[session_id] = platform

        # Emit session_start on the first pre_llm_call we see for this
        # session. Best-effort; failure swallowed.
        _maybe_emit_session_start(session_id, platform)

        query = _extract_user_query(user_message)
        if len(query) < 12:
            return None
        query_trimmed = query[:QUERY_PREVIEW_CHARS]

        resp = _invoke_gateway(
            "memory_search",
            {"query": query_trimmed, "limit": SEARCH_LIMIT, "corpus": "all"},
        )
        if not resp or not resp.get("ok"):
            return None
        result = resp.get("result") or {}
        content = result.get("content") or []
        if not content:
            return None
        try:
            parsed = json.loads(content[0].get("text", "{}"))
        except json.JSONDecodeError:
            return None

        raw_hits = parsed.get("results") or []
        if not raw_hits:
            return None

        # M1 hygiene
        seen_this_session = _SESSION_SURFACED[session_id]
        filtered: List[Dict[str, Any]] = []
        for h in raw_hits:
            score = h.get("score") or 0
            path = h.get("path")
            if not path or score < MIN_SCORE:
                continue
            if path in seen_this_session:
                continue
            filtered.append(h)
            if len(filtered) >= SURFACED_PER_TURN_CAP:
                break
        if not filtered:
            return None

        injection_text = _format_injection(filtered)
        if not injection_text:
            return None

        # Update session state
        with _STATE_LOCK:
            for h in filtered:
                seen_this_session.add(h["path"])
                norm = _normalize_hit_path(h["path"])
                if norm:
                    seen_this_session.add(norm)
            _SESSION_HOOK_INJECTIONS[session_id] += 1
            _bump_activity(session_id)
            # Bump turn counter + snapshot surfaced entries for the
            # post_llm_call ack parser. Dedup entries by normalized path
            # within this single event — same path showing up twice in
            # one knowledge_surfaced is noise, not signal.
            _SESSION_TURN[session_id] = _SESSION_TURN.get(session_id, 0) + 1
            turn_id = str(_SESSION_TURN[session_id])
            seen_norm: Set[str] = set()
            surfaced_for_event: List[Dict[str, Any]] = []
            for h in filtered:
                norm = _normalize_hit_path(h["path"]) or h["path"]
                if norm in seen_norm:
                    continue
                seen_norm.add(norm)
                surfaced_for_event.append({
                    "path": norm,
                    "title": h.get("title") or "",
                    "score": h.get("score"),
                    "source": "memory_search",
                })
            _SESSION_LAST_SURFACED[session_id] = surfaced_for_event

        # Best-effort M1 emit (universal protocol). Failure swallowed.
        surface_extra: Dict[str, Any] = {}
        p = _platform_for_extra(platform, session_id)
        if p:
            surface_extra["platform"] = p
        _emit_m1_event(
            event_type="knowledge_surfaced",
            session_id=session_id,
            agent_id=M1_AGENT_ID,
            turn_id=turn_id,
            entries=surfaced_for_event,
            extra=surface_extra or None,
        )

        return {"context": injection_text}
    except Exception as exc:
        logger.debug("digital-me-recall-hermes pre_llm_call failed: %s", exc)
        return None


# ── Hook B-post — post_llm_call: emit M1 assistant_ack event ──────────────


def _extract_response_text(assistant_response: Any) -> str:
    """Pull plain text out of whatever shape Hermes passes."""
    if isinstance(assistant_response, str):
        return assistant_response
    if isinstance(assistant_response, dict):
        content = assistant_response.get("content") or assistant_response.get("text") or ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, dict):
                    t = c.get("text")
                    if isinstance(t, str):
                        parts.append(t)
                elif isinstance(c, str):
                    parts.append(c)
            return " ".join(parts)
    return ""


def _on_post_llm_call(
    *,
    session_id: str = "",
    assistant_response: Any = None,
    platform: str = "",
    **_: Any,
) -> None:
    """Inspect the LLM's response for acknowledgment of the entries
    surfaced this turn, emit one `assistant_ack` event to brain.
    Pure observation; no return value used by hermes."""
    try:
        if not session_id:
            return
        with _STATE_LOCK:
            turn = _SESSION_TURN.get(session_id, 0)
            surfaced = list(_SESSION_LAST_SURFACED.get(session_id, []))
            if platform:
                _SESSION_PLATFORM[session_id] = platform
        if turn <= 0:
            # No surfaced turn to ack — pre_llm_call never injected.
            return
        if not surfaced:
            # Injection happened but no entries snapshot recorded (shouldn't
            # happen, but defensive).
            return
        response_text = _extract_response_text(assistant_response)
        ack_signal, acted = _parse_ack(response_text, surfaced)

        # Update local M1 access set so the JSONL writer (WAL) also
        # reflects the ack outcome. This keeps the local file useful for
        # backfill if brain is unreachable.
        with _STATE_LOCK:
            for e in acted:
                p = e.get("path")
                if isinstance(p, str) and p:
                    _SESSION_ACCESSED[session_id].add(p)
            if acted:
                _bump_activity(session_id)

        ack_extra: Dict[str, Any] = {
            "response_chars": len(response_text),
            "surfaced_count": len(surfaced),
        }
        p = _platform_for_extra(platform, session_id)
        if p:
            ack_extra["platform"] = p
        _emit_m1_event(
            event_type="assistant_ack",
            session_id=session_id,
            agent_id=M1_AGENT_ID,
            turn_id=str(turn),
            entries=acted,
            ack_signal=ack_signal,
            extra=ack_extra,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("digital-me-recall-hermes post_llm_call failed: %s", exc)


# ── Hook D — post_tool_call: track wiki access for application_rate ────────


_WIKI_ACCESS_TOOLS = {
    "memory_get",
    "read_file",
    "read",
    "Read",
}


def _on_post_tool_call(
    *,
    tool_name: str = "",
    args: Any = None,
    session_id: str = "",
    **_: Any,
) -> None:
    """Track wiki-entry opens. Pure observation, no return."""
    try:
        if not session_id:
            return
        if tool_name not in _WIKI_ACCESS_TOOLS:
            return
        if not isinstance(args, dict):
            return

        path_arg = args.get("path") or args.get("file_path") or ""
        if not isinstance(path_arg, str) or not path_arg:
            return

        norm = _normalize_hit_path(path_arg)
        if not norm:
            return

        with _STATE_LOCK:
            _session_started(session_id)
            before = len(_SESSION_ACCESSED[session_id])
            _SESSION_ACCESSED[session_id].add(norm)
            # Also add the raw form in case dedup against surfaced uses the raw key
            _SESSION_ACCESSED[session_id].add(path_arg)
            if len(_SESSION_ACCESSED[session_id]) != before:
                _bump_activity(session_id)
    except Exception as exc:
        logger.debug("digital-me-recall-hermes post_tool_call failed: %s", exc)


# ── Hook E — on_session_end: M1 live writer ───────────────────────────────


def _norm_set(s: Set[str]) -> Set[str]:
    """Normalise a set of raw paths for set-intersection arithmetic."""
    out: Set[str] = set()
    for p in s:
        n = _normalize_hit_path(p)
        if n:
            out.add(n)
        else:
            out.add(p)
    return out


def _write_app_rate_record(
    session_id: str,
    reason: str,
    *,
    drop_after: bool,
) -> bool:
    """Append one JSONL record for ``session_id``. Returns True if a record
    was written, False if skipped because nothing happened. Best-effort:
    swallows any error.

    Caller must hold ``_STATE_LOCK``.
    """
    surfaced = _SESSION_SURFACED.get(session_id, set())
    accessed = _SESSION_ACCESSED.get(session_id, set())
    hook_injections = _SESSION_HOOK_INJECTIONS.get(session_id, 0)

    if not surfaced and not accessed and hook_injections == 0:
        if drop_after:
            _session_cleanup(session_id)
        return False

    surfaced_norm = _norm_set(surfaced)
    accessed_norm = _norm_set(accessed)
    acted = sorted(surfaced_norm & accessed_norm)
    ignored = sorted(surfaced_norm - accessed_norm)
    surfaced_count = len(surfaced_norm)
    acted_count = len(set(acted))
    rate = (acted_count / surfaced_count) if surfaced_count else None

    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "session_id": session_id,
        "session_date": time.strftime("%Y-%m-%d"),
        "agent_id": "hermes",
        "source": "live",
        "surface": "hermes",
        "started_at": _SESSION_STARTED_AT.get(session_id),
        "hook_injections": hook_injections,
        "surfaced_unique": surfaced_count,
        "acted_unique": acted_count,
        "application_rate": rate,
        "acted_paths": acted,
        "ignored_paths": ignored,
        "flush_reason": reason,
    }
    try:
        APP_RATE_LOG.parent.mkdir(parents=True, exist_ok=True)
        with APP_RATE_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
        _SESSION_LAST_FLUSHED_REV[session_id] = _SESSION_REV.get(session_id, 0)
    except OSError as exc:
        logger.debug("digital-me-recall-hermes log write failed: %s", exc)
        return False
    if drop_after:
        _session_cleanup(session_id)
    return True


def _emit_session_lifecycle_m1(
    session_id: str,
    event_type: str,
    reason: str,
) -> None:
    """Emit a session_snapshot or session_end M1 event.

    Carries an aggregated summary of the session's surfaced ∩ acted
    state in `extra`, plus the union of distinct surfaced paths as the
    `entries` array. Lets the brain's scorer eventually compute
    session-grain rollups without needing the full per-turn trail.

    Caller must hold `_STATE_LOCK`.
    """
    if event_type not in ("session_snapshot", "session_end"):
        return
    surfaced = _norm_set(_SESSION_SURFACED.get(session_id, set()))
    accessed = _norm_set(_SESSION_ACCESSED.get(session_id, set()))
    acted = sorted(surfaced & accessed)
    if not surfaced and not accessed and _SESSION_HOOK_INJECTIONS.get(session_id, 0) == 0:
        # No M1 activity this session — skip snapshot/end emission.
        return

    # Entries carry the full distinct-path surfaced set so the brain has
    # the per-session universe in one record.
    entries: List[Dict[str, Any]] = [{"path": p} for p in sorted(surfaced)]
    turn = _SESSION_TURN.get(session_id, 0)

    extra: Dict[str, Any] = {
        "reason": reason,
        "hook_injections": _SESSION_HOOK_INJECTIONS.get(session_id, 0),
        "surfaced_unique": len(surfaced),
        "acted_unique": len(acted),
        "acted_paths": acted,
    }
    p = _platform_for_extra(None, session_id)
    if p:
        extra["platform"] = p
    _emit_m1_event(
        event_type=event_type,
        session_id=session_id,
        agent_id=M1_AGENT_ID,
        turn_id=str(turn),
        entries=entries,
        extra=extra,
    )
    _SESSION_SNAPSHOT_REV[session_id] = _SESSION_REV.get(session_id, 0)


def _flush_all_sessions(reason: str) -> None:
    """Snapshot every active session that has new activity since its last
    flush. Stale sessions (no activity beyond STALE_SESSION_SEC) get
    finalised and dropped. Safe to call from any thread.
    """
    now = time.monotonic()
    with _STATE_LOCK:
        for sid in list(_SESSION_REV.keys()):
            try:
                last_active = _SESSION_LAST_ACTIVE.get(sid, now)
                if STALE_SESSION_SEC > 0 and now - last_active > STALE_SESSION_SEC:
                    # Finalise as session_end before drop. Also write the
                    # legacy aggregate record.
                    _emit_session_lifecycle_m1(sid, "session_end", "stale")
                    _write_app_rate_record(sid, "stale", drop_after=True)
                    continue
                if _SESSION_REV.get(sid, 0) == _SESSION_LAST_FLUSHED_REV.get(sid, 0):
                    continue
                # Periodic snapshot — both the new canonical M1 event and
                # the legacy aggregate record.
                if _SESSION_REV.get(sid, 0) != _SESSION_SNAPSHOT_REV.get(sid, 0):
                    _emit_session_lifecycle_m1(sid, "session_snapshot", reason)
                _write_app_rate_record(sid, reason, drop_after=False)
            except Exception as exc:  # noqa: BLE001 — flush must never crash
                logger.debug(
                    "digital-me-recall-hermes flush(%s) failed for %s: %s",
                    reason,
                    sid,
                    exc,
                )


# ── Periodic flush thread ─────────────────────────────────────────────────
#
# Hermes' `on_session_end` doesn't fire reliably for Discord-bot-driven
# long-running run_conversation loops. The flush thread independently
# emits cumulative snapshots every PERIODIC_FLUSH_SEC, so the M1 log
# fills regardless of whether session_end ever arrives.

_FLUSH_THREAD_STARTED = False
_FLUSH_THREAD_STOP = threading.Event()


def _flush_loop() -> None:
    while not _FLUSH_THREAD_STOP.is_set():
        if _FLUSH_THREAD_STOP.wait(PERIODIC_FLUSH_SEC):
            return
        try:
            _flush_all_sessions("periodic")
        except Exception as exc:  # noqa: BLE001
            logger.debug("digital-me-recall-hermes periodic flush crashed: %s", exc)


def _ensure_flush_thread() -> None:
    """Start the daemon flush thread once per process. Called from
    register(); idempotent under multi-load."""
    global _FLUSH_THREAD_STARTED
    if _FLUSH_THREAD_STARTED or PERIODIC_FLUSH_SEC <= 0:
        return
    _FLUSH_THREAD_STARTED = True
    t = threading.Thread(
        target=_flush_loop,
        name="digital-me-recall-hermes.flush",
        daemon=True,
    )
    t.start()


def _atexit_flush() -> None:
    """Snapshot any remaining state on process shutdown so daemon-style
    runtimes (Discord bot, etc.) still emit final records."""
    try:
        _FLUSH_THREAD_STOP.set()
        _flush_all_sessions("exit")
    except Exception:  # noqa: BLE001
        pass


def _on_session_end(
    *,
    session_id: str = "",
    **_: Any,
) -> None:
    """Append one JSONL aggregate record + one canonical M1 session_end
    event summarising this session's metrics, then drop in-memory state."""
    try:
        if not session_id:
            return
        with _STATE_LOCK:
            # Canonical M1 event first (uses session state before cleanup)
            _emit_session_lifecycle_m1(session_id, "session_end", "session_end")
            # Legacy aggregate record + drop session state
            _write_app_rate_record(session_id, "session_end", drop_after=True)
    except Exception as exc:  # noqa: BLE001
        logger.debug("digital-me-recall-hermes on_session_end failed: %s", exc)


# ── Hook C — pre_tool_call: route reminders (stub for parity) ─────────────
#
# The route system in OpenClaw's digital-me-recall plugin reads
# frontmatter `route: tool=X, params.Y contains "Z"` from wiki entries
# and injects reminders before matching tool calls. For Hermes we ship
# a stub that's a no-op today; the route-index build is shared with
# OpenClaw and can be hooked here as a future enhancement.


def _on_pre_tool_call(**_: Any) -> None:
    return None


# ── Plugin entry ──────────────────────────────────────────────────────────


_ATEXIT_REGISTERED = False


def register(ctx) -> None:
    """Hermes plugin entry. Registers five hooks (recall, ack-emit,
    route-stub, tool tracking, session-end writer) plus the self-contained
    periodic-flush + atexit safety net for the M1 application_rate
    writer."""
    global _ATEXIT_REGISTERED
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("on_session_end", _on_session_end)

    _ensure_flush_thread()
    if not _ATEXIT_REGISTERED:
        try:
            atexit.register(_atexit_flush)
            _ATEXIT_REGISTERED = True
        except Exception:  # noqa: BLE001 — atexit is best-effort
            pass

    # Seed the in-memory once-only session_start guard from the WAL so a
    # module reload (which resets the set) doesn't re-emit session_start
    # for sessions that already had one. Event_id is stable, so brain
    # already dedupes — this fix keeps the local WAL clean too.
    seeded = _seed_session_m1_started_from_wal()

    logger.info(
        "digital-me-recall-hermes registered hooks "
        "(pre_llm_call=recall+m1_surface, post_llm_call=m1_ack, "
        "pre_tool_call=route-stub, post_tool_call=track, "
        "on_session_end=app_rate_writer, "
        "periodic_flush_sec=%d, stale_session_sec=%d, "
        "wal_seeded_sessions=%d)",
        PERIODIC_FLUSH_SEC,
        STALE_SESSION_SEC,
        seeded,
    )
