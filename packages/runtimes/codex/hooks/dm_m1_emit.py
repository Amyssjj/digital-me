#!/usr/bin/env python3
"""
dm_m1_emit — Codex-side M1 universal-protocol event emitter.

Called from the Codex `dm_memory_search_inject.sh` (UserPromptSubmit) and
`dm_application_rate.sh` (Stop) hooks to emit canonical M1 events:

  - session_start       once per session_id, on first surfaced injection
  - knowledge_surfaced  every successful recall inject
  - assistant_ack       per surfaced session after Stop, with parsed ack signal
  - session_end         at Stop, with rollup of session totals

This is the Codex sibling of the Claude Code emitter — byte-for-byte the
same protocol shape, but with codex-flavoured defaults (runtime/agent_id/
platform = "codex", WAL = ~/.openclaw/data/m1_events_codex.jsonl). Keeping
a self-contained copy per runtime is deliberate: each runtime's install
path (~/.codex/hooks vs ~/.claude/hooks) must work standalone, and the
brain de-dupes on event_id regardless of which runtime emitted. See wiki:
  infrastructure/m1-universal-event-protocol.md
  infrastructure/keep-m1-tracking-plugins-self-contained-via-module-level-state.md

Pillar 4 of the universal protocol:

  1. Append the canonical event to ~/.openclaw/data/m1_events_codex.jsonl
     (durable — survives brain outages).
  2. Best-effort POST to brain MCP `m1_event_record` (idempotent on event_id).

Brain's INSERT OR IGNORE handles retries — failed POSTs get replayed by the
shared m1_backfill.py script (with --wal pointed at the codex log) when
brain is reachable again.

Self-contained: only stdlib, no extra deps.

Usage:
  dm_m1_emit.py session_start    --session-id S
  dm_m1_emit.py knowledge_surfaced --session-id S --turn-id 1 \
                                    --entries-json '[{"path":"x.md"}]'
  dm_m1_emit.py assistant_ack    --session-id S --turn-id 1 \
                                    --ack-signal explicit_path \
                                    --entries-json '[{"path":"x.md"}]'
  dm_m1_emit.py session_end      --session-id S --extra-json '{"surfaced_unique":5}'
  dm_m1_emit.py --selftest       # offline idempotency test

Exit codes:
  0  WAL append succeeded (brain POST is best-effort, never blocks 0 exit)
  1  Argument error
  2  WAL write failed (rare — disk full / permission)
  3  Brain misconfigured: DIGITAL_ME_BRAIN_URL set (env or the
     digital-me-brain.env sidecar) but no token resolves from
     DIGITAL_ME_BRAIN_TOKEN, DIGITAL_ME_BRAIN_TOKEN_FILE or the default token
     file. The event is kept in the WAL and NO POST is attempted — never a
     silent fallback to the openclaw gateway token.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional


HOME = Path.home()
DEFAULT_WAL = HOME / ".openclaw" / "data" / "m1_events_codex.jsonl"
DEFAULT_GATEWAY = "http://localhost:18789/tools/invoke"

# Brain sidecar: `digital-me install` writes digital-me-brain.env next to the
# hooks because Codex runs them with its own process env, which never has
# DIGITAL_ME_BRAIN_URL. The script's own dir, symlinks NOT resolved (same as
# the bash hooks' `dirname "$0"`). Module-level so --selftest can repoint it.
BRAIN_SIDECAR = Path(os.path.abspath(__file__)).parent / "digital-me-brain.env"
_BRAIN_SIDECAR_KEYS = ("DIGITAL_ME_BRAIN_URL", "DIGITAL_ME_BRAIN_TOKEN_FILE")


class BrainConfigError(RuntimeError):
    """DIGITAL_ME_BRAIN_URL is set but no token resolves (env var, token file
    or default token file)."""


def _read_brain_sidecar(path: Path) -> Dict[str, str]:
    """The sidecar's DIGITAL_ME_BRAIN_URL / DIGITAL_ME_BRAIN_TOKEN_FILE.
    Parsed line by line, never executed: lines without `=` and other keys
    (so `#` comments too) are skipped, one pair of surrounding quotes is
    stripped, the last assignment wins. Missing or unreadable → {}."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return {}
    values: Dict[str, str] = {}
    for raw in text.splitlines():
        key, sep, value = raw.partition("=")
        key = key.strip()
        if not sep or key not in _BRAIN_SIDECAR_KEYS:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def _brain_env(key: str) -> Optional[str]:
    """Effective DIGITAL_ME_BRAIN_URL / DIGITAL_ME_BRAIN_TOKEN_FILE: the
    process env when non-empty, else — only while the env has no
    DIGITAL_ME_BRAIN_URL — the sidecar. Explicit env always wins; the sidecar
    in turn beats every OPENCLAW_GATEWAY_* source, because it records the
    installer's decision that brain-host is the brain."""
    value = os.environ.get(key)
    if value or os.environ.get("DIGITAL_ME_BRAIN_URL"):
        return value or None
    return _read_brain_sidecar(BRAIN_SIDECAR).get(key) or None


def _default_brain_token_file() -> Path:
    """`<DIGITAL_ME_WIKI_ROOT or ~/digital-me>/.data/brain-host.token` — the
    mode-600 file `digital-me install --runtime brain-host` writes. Mirrors
    brain-mcp-proxy/config.ts `defaultBrainTokenFile`."""
    wiki_root = os.environ.get("DIGITAL_ME_WIKI_ROOT") or str(HOME / "digital-me")
    return Path(wiki_root) / ".data" / "brain-host.token"


def _brain_token_file() -> Path:
    """DIGITAL_ME_BRAIN_TOKEN_FILE (env, else the sidecar) when non-empty,
    else the default file."""
    return Path(_brain_env("DIGITAL_ME_BRAIN_TOKEN_FILE") or _default_brain_token_file())


def _read_brain_token_file(path: Path) -> Optional[str]:
    """Trimmed file contents; None when missing, unreadable or blank."""
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def _resolve_gateway_url() -> str:
    """Brain endpoint precedence (mirrors brain-mcp-proxy/config.ts and the
    inject hook): DIGITAL_ME_BRAIN_URL (digital-me brain-host; env, else the
    sidecar) > OPENCLAW_GATEWAY_URL > OPENCLAW_GATEWAY_HOST/PORT > the default
    gateway."""
    brain_url = _brain_env("DIGITAL_ME_BRAIN_URL")
    if brain_url:
        return brain_url
    gateway_url = os.environ.get("OPENCLAW_GATEWAY_URL")
    if gateway_url:
        return gateway_url
    host = os.environ.get("OPENCLAW_GATEWAY_HOST")
    port = os.environ.get("OPENCLAW_GATEWAY_PORT")
    if host or port:
        return f"http://{host or 'localhost'}:{port or '18789'}/tools/invoke"
    return DEFAULT_GATEWAY


DEFAULT_RUNTIME = "codex"
DEFAULT_AGENT_ID = "codex"
DEFAULT_PLATFORM = "codex"

# Once-only-per-session session_start guard. Our process is a one-shot CLI —
# so the guard is a flag file scoped to /tmp. Codex session ids are UUIDs,
# distinct from Claude Code's, so the shared prefix never collides.
SESSION_START_FLAG_DIR = Path("/tmp")
SESSION_START_FLAG_PREFIX = "dm_m1_started_codex_"

V1_EVENT_TYPES = {
    "session_start",
    "knowledge_surfaced",
    "assistant_ack",
    "session_snapshot",
    "session_end",
}


# ─── Auth (mirrors dm_memory_search_inject.sh) ────────────────────────────


def _load_gateway_token() -> Optional[str]:
    """Bearer token with the same precedence as _resolve_gateway_url().

    When DIGITAL_ME_BRAIN_URL is set the token is DIGITAL_ME_BRAIN_TOKEN
    when non-empty, else the trimmed contents of DIGITAL_ME_BRAIN_TOKEN_FILE,
    else of the default token file (an empty or unreadable file is "no
    token"). A URL with no resolvable token is a configuration error and
    raises BrainConfigError — main() still appends the event to the WAL (for
    backfill), skips the POST, reports on stderr and exits 3. Never a silent
    fallback to an openclaw gateway token that brain-host would reject
    anyway. The URL may come from the sidecar (see _brain_env)."""
    if _brain_env("DIGITAL_ME_BRAIN_URL"):
        brain_token = os.environ.get("DIGITAL_ME_BRAIN_TOKEN")
        if brain_token:
            return brain_token
        token_file = _brain_token_file()
        file_token = _read_brain_token_file(token_file)
        if file_token:
            return file_token
        source = "" if os.environ.get("DIGITAL_ME_BRAIN_URL") else f" (from {BRAIN_SIDECAR})"
        raise BrainConfigError(
            f"DIGITAL_ME_BRAIN_URL{source} is set but no token was found — set DIGITAL_ME_BRAIN_TOKEN, "
            f"or point DIGITAL_ME_BRAIN_TOKEN_FILE at a readable token file (looked in {token_file}), "
            "or unset the URL to fall back to the openclaw gateway"
        )
    env_token = os.environ.get("OPENCLAW_GATEWAY_TOKEN")
    if env_token:
        return env_token
    for candidate in (
        os.environ.get("DIGITAL_ME_OPENCLAW_CONFIG"),
        str(HOME / ".openclaw" / "config.json"),
        str(HOME / ".openclaw" / "openclaw.json"),
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


# ─── Event ID + WAL ───────────────────────────────────────────────────────


def derive_event_id(
    session_id: str,
    turn_id: str,
    event_type: str,
    entries: List[Dict[str, Any]],
    ack_signal: Optional[str],
) -> str:
    """Stable id matching the brain handler's `deriveEventId`. Same input
    shape → same id → brain INSERT OR IGNORE catches retries."""
    entries_key = json.dumps(
        [[e.get("path", ""), e.get("score")] for e in entries],
        separators=(",", ":"),
    )
    h = hashlib.sha1((entries_key + "|" + (ack_signal or "")).encode("utf-8"))
    return f"{session_id}::{turn_id or '_'}::{event_type}::{h.hexdigest()[:12]}"


def wal_append(payload: Dict[str, Any], wal_path: Path) -> bool:
    try:
        wal_path.parent.mkdir(parents=True, exist_ok=True)
        with wal_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, separators=(",", ":")) + "\n")
        return True
    except OSError:
        return False


# ─── Brain MCP POST (best-effort) ─────────────────────────────────────────


def post_to_brain(
    event: Dict[str, Any],
    gateway_url: str,
    token: Optional[str],
    timeout: float = 2.0,
) -> bool:
    """Best-effort POST to brain's `m1_event_record` MCP tool. Returns
    True if the call completed (regardless of inserted vs deduped),
    False on any error. Caller doesn't need to act on the return — the
    WAL is the source of truth and m1_backfill.py replays on demand."""
    if not token:
        return False
    args: Dict[str, Any] = {k: v for k, v in event.items() if k not in ("entries", "extra")}
    if isinstance(event.get("entries"), (list, tuple)):
        args["entries"] = json.dumps(event["entries"])
    if isinstance(event.get("extra"), dict):
        args["extra"] = json.dumps(event["extra"])
    # openclaw >= 2026.8.1 requires an explicit owner on a multi-agent host;
    # without agentId the gateway returns invalid_request and the event only
    # ever reaches the WAL (replayable via m1_backfill.py, but brain.db
    # silently stops receiving live events). Canonical name is
    # OPENCLAW_GATEWAY_AGENT_ID; DIGITAL_ME_OPENCLAW_AGENT_ID is aliased.
    agent_id = os.environ.get(
        "OPENCLAW_GATEWAY_AGENT_ID",
        os.environ.get("DIGITAL_ME_OPENCLAW_AGENT_ID", "main"),
    )
    body = json.dumps(
        {"tool": "m1_event_record", "agentId": agent_id, "args": args}
    ).encode("utf-8")
    req = urllib.request.Request(
        gateway_url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
        return True
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


# ─── once-only session_start guard ────────────────────────────────────────


def session_already_started(session_id: str) -> bool:
    if not session_id:
        return False
    flag = SESSION_START_FLAG_DIR / f"{SESSION_START_FLAG_PREFIX}{session_id}"
    return flag.exists()


def mark_session_started(session_id: str) -> None:
    if not session_id:
        return
    flag = SESSION_START_FLAG_DIR / f"{SESSION_START_FLAG_PREFIX}{session_id}"
    try:
        flag.touch()
    except OSError:
        pass


# ─── Build event ──────────────────────────────────────────────────────────


def build_event(
    *,
    event_type: str,
    session_id: str,
    turn_id: str = "0",
    agent_id: str = DEFAULT_AGENT_ID,
    runtime: str = DEFAULT_RUNTIME,
    platform: str = DEFAULT_PLATFORM,
    entries: Optional[List[Dict[str, Any]]] = None,
    ack_signal: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    entries = entries or []
    payload: Dict[str, Any] = {
        "event_id": derive_event_id(session_id, turn_id, event_type, entries, ack_signal),
        "schema_version": 1,
        "metric": "m1_application_rate",
        "runtime": runtime,
        "agent_id": agent_id,
        "session_id": session_id,
        "turn_id": turn_id,
        "event_type": event_type,
        "entries": entries,
        "t": int(time.time() * 1000),
    }
    if ack_signal:
        payload["ack_signal"] = ack_signal
    merged_extra: Dict[str, Any] = {}
    if platform:
        merged_extra["platform"] = platform
    if extra:
        merged_extra.update(extra)
    if merged_extra:
        payload["extra"] = merged_extra
    return payload


def emit(
    event: Dict[str, Any],
    *,
    wal_path: Path,
    gateway_url: str,
    token: Optional[str],
) -> Dict[str, bool]:
    """Two-step durability: WAL append first, then best-effort brain
    POST. Returns {"wal": bool, "brain": bool} for callers that want to
    know what happened (smoke tests, debug logging)."""
    wrote_wal = wal_append(event, wal_path)
    posted = False
    if wrote_wal:
        posted = post_to_brain(event, gateway_url, token)
    return {"wal": wrote_wal, "brain": posted}


# ─── Selftest ─────────────────────────────────────────────────────────────


def run_selftest() -> int:
    import tempfile

    print("[selftest] derive_event_id stability")
    a = derive_event_id("S1", "1", "knowledge_surfaced", [{"path": "x.md"}], None)
    b = derive_event_id("S1", "1", "knowledge_surfaced", [{"path": "x.md"}], None)
    assert a == b, (a, b)
    print(f"  ✓ same inputs → same id ({a})")

    diff = derive_event_id("S1", "1", "knowledge_surfaced", [{"path": "y.md"}], None)
    assert diff != a
    print("  ✓ different entries → different id")

    print("[selftest] build_event shape (codex defaults)")
    ev = build_event(
        event_type="knowledge_surfaced",
        session_id="S1",
        turn_id="1",
        entries=[{"path": "x.md", "title": "X"}],
    )
    assert ev["schema_version"] == 1
    assert ev["runtime"] == "codex"
    assert ev["agent_id"] == "codex"
    assert ev["entries"][0]["path"] == "x.md"
    assert ev["extra"]["platform"] == "codex"
    print("  ✓ canonical schema fields present, runtime=codex")

    print("[selftest] WAL append")
    with tempfile.TemporaryDirectory() as td:
        wal = Path(td) / "wal.jsonl"
        ok = wal_append(ev, wal)
        assert ok
        lines = wal.read_text().strip().splitlines()
        assert len(lines) == 1
        parsed = json.loads(lines[0])
        assert parsed["event_id"] == ev["event_id"]
        print(f"  ✓ wrote 1 line to {wal}")

        wal_append(ev, wal)
        assert len(wal.read_text().strip().splitlines()) == 2
        print("  ✓ WAL is append-only (brain INSERT OR IGNORE handles dedup)")

    print("[selftest] once-only session_start guard")
    import secrets
    sid = "sess-" + secrets.token_hex(4)
    assert not session_already_started(sid)
    mark_session_started(sid)
    assert session_already_started(sid)
    (SESSION_START_FLAG_DIR / f"{SESSION_START_FLAG_PREFIX}{sid}").unlink(missing_ok=True)
    print("  ✓ flag file lifecycle")

    print("[selftest] brain endpoint + token precedence")
    _selftest_token_precedence()

    print("[selftest] brain sidecar (digital-me-brain.env)")
    _selftest_brain_sidecar()

    print("[selftest] PASSED")
    return 0


_PRECEDENCE_ENV_KEYS = (
    "DIGITAL_ME_BRAIN_URL",
    "DIGITAL_ME_BRAIN_TOKEN",
    "DIGITAL_ME_BRAIN_TOKEN_FILE",
    "DIGITAL_ME_WIKI_ROOT",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_HOST",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_TOKEN",
    "DIGITAL_ME_OPENCLAW_CONFIG",
)


def _selftest_token_precedence() -> None:
    """Offline: DIGITAL_ME_BRAIN_* wins over an exported gateway token, the
    token may come from DIGITAL_ME_BRAIN_TOKEN_FILE or the default token
    file, a brain URL with no resolvable token is a hard error (never a
    fallback), and the gateway env / config-file chain still works when no
    brain URL is set."""
    import tempfile

    global BRAIN_SIDECAR
    saved = {k: os.environ.get(k) for k in _PRECEDENCE_ENV_KEYS}
    saved_sidecar = BRAIN_SIDECAR
    try:
        for k in _PRECEDENCE_ENV_KEYS:
            os.environ.pop(k, None)
        with tempfile.TemporaryDirectory() as td:
            # Isolate the config-file chain from the machine: an explicit
            # DIGITAL_ME_OPENCLAW_CONFIG is consulted first, and the default
            # brain token file lives under a scratch wiki root (the real
            # ~/digital-me/.data/brain-host.token may exist on this host), and
            # an installed copy of this script sits next to a live sidecar.
            BRAIN_SIDECAR = Path(td) / "digital-me-brain.env"
            cfg_path = Path(td) / "openclaw.json"
            cfg_path.write_text(json.dumps({"gateway": {"auth": {"token": "file-token"}}}), encoding="utf-8")
            os.environ["DIGITAL_ME_OPENCLAW_CONFIG"] = str(cfg_path)
            os.environ["DIGITAL_ME_WIKI_ROOT"] = td
            assert _load_gateway_token() == "file-token"
            assert _resolve_gateway_url() == DEFAULT_GATEWAY
            print("  ✓ no env → openclaw config file token + default gateway url")

            os.environ["OPENCLAW_GATEWAY_TOKEN"] = "gateway-token"
            os.environ["OPENCLAW_GATEWAY_HOST"] = "10.0.0.5"
            os.environ["OPENCLAW_GATEWAY_PORT"] = "1234"
            assert _load_gateway_token() == "gateway-token"
            assert _resolve_gateway_url() == "http://10.0.0.5:1234/tools/invoke"
            os.environ["OPENCLAW_GATEWAY_URL"] = "http://gw.local/tools/invoke"
            assert _resolve_gateway_url() == "http://gw.local/tools/invoke"
            print("  ✓ OPENCLAW_GATEWAY_TOKEN + HOST/PORT (or URL) beat the config file")

            os.environ["DIGITAL_ME_BRAIN_URL"] = "http://127.0.0.1:18791/tools/invoke"
            os.environ["DIGITAL_ME_BRAIN_TOKEN"] = "brain-token"
            assert _load_gateway_token() == "brain-token", "brain token must beat OPENCLAW_GATEWAY_TOKEN"
            assert _resolve_gateway_url() == "http://127.0.0.1:18791/tools/invoke"
            print("  ✓ DIGITAL_ME_BRAIN_TOKEN beats an exported OPENCLAW_GATEWAY_TOKEN")

            del os.environ["DIGITAL_ME_BRAIN_TOKEN"]
            try:
                _load_gateway_token()
            except BrainConfigError as exc:
                assert "DIGITAL_ME_BRAIN_TOKEN_FILE" in str(exc) and "DIGITAL_ME_BRAIN_TOKEN," in str(exc), exc
            else:
                raise AssertionError("DIGITAL_ME_BRAIN_URL without any token must not fall back")
            print("  ✓ brain URL without token is a hard error naming both token vars, never a gateway fallback")

            default_file = Path(td) / ".data" / "brain-host.token"
            default_file.parent.mkdir(parents=True)
            default_file.write_text("  default-file-token\n", encoding="utf-8")
            assert _brain_token_file() == default_file
            assert _load_gateway_token() == "default-file-token", "default token file must be read and trimmed"
            print("  ✓ token read from the default <wiki-root>/.data/brain-host.token")

            explicit_file = Path(td) / "elsewhere.token"
            explicit_file.write_text("explicit-file-token\n", encoding="utf-8")
            os.environ["DIGITAL_ME_BRAIN_TOKEN_FILE"] = str(explicit_file)
            assert _load_gateway_token() == "explicit-file-token", "DIGITAL_ME_BRAIN_TOKEN_FILE must beat the default file"
            print("  ✓ DIGITAL_ME_BRAIN_TOKEN_FILE beats the default file")

            os.environ["DIGITAL_ME_BRAIN_TOKEN"] = "env-token"
            assert _load_gateway_token() == "env-token", "DIGITAL_ME_BRAIN_TOKEN must beat every file"
            del os.environ["DIGITAL_ME_BRAIN_TOKEN"]
            print("  ✓ DIGITAL_ME_BRAIN_TOKEN beats the token file")

            explicit_file.write_text("   \n", encoding="utf-8")
            try:
                _load_gateway_token()
            except BrainConfigError as exc:
                assert str(explicit_file) in str(exc), exc
            else:
                raise AssertionError("a blank token file must count as no token")
            os.environ["DIGITAL_ME_BRAIN_TOKEN_FILE"] = str(Path(td) / "missing.token")
            try:
                _load_gateway_token()
            except BrainConfigError:
                pass
            else:
                raise AssertionError("a missing token file must count as no token")
            print("  ✓ blank or missing token file is a hard error, never a gateway fallback")
    finally:
        BRAIN_SIDECAR = saved_sidecar
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _selftest_brain_sidecar() -> None:
    """Offline: with no DIGITAL_ME_BRAIN_URL in the env the sidecar supplies
    the URL + token-file path and beats the gateway env and openclaw.json
    (even under a wrong DIGITAL_ME_WIKI_ROOT); an exported
    DIGITAL_ME_BRAIN_URL hides the whole sidecar; a missing or garbage
    sidecar changes nothing."""
    import tempfile

    global BRAIN_SIDECAR
    saved = {k: os.environ.get(k) for k in _PRECEDENCE_ENV_KEYS}
    saved_sidecar = BRAIN_SIDECAR
    try:
        for k in _PRECEDENCE_ENV_KEYS:
            os.environ.pop(k, None)
        with tempfile.TemporaryDirectory() as td:
            scratch = Path(td)
            BRAIN_SIDECAR = scratch / "digital-me-brain.env"
            cfg_path = scratch / "openclaw.json"
            cfg_path.write_text(json.dumps({"gateway": {"auth": {"token": "file-token"}}}), encoding="utf-8")
            os.environ["DIGITAL_ME_OPENCLAW_CONFIG"] = str(cfg_path)
            # A wrong wiki root (the wiki dir itself): its default token file is absent.
            os.environ["DIGITAL_ME_WIKI_ROOT"] = str(scratch / "wiki")
            os.environ["OPENCLAW_GATEWAY_URL"] = "http://gw.local/tools/invoke"
            os.environ["OPENCLAW_GATEWAY_TOKEN"] = "gateway-token"
            assert _resolve_gateway_url() == "http://gw.local/tools/invoke"
            assert _load_gateway_token() == "gateway-token"
            BRAIN_SIDECAR.write_bytes(b"\xff\xfe not utf-8\nno pair here\n")
            assert _resolve_gateway_url() == "http://gw.local/tools/invoke"
            assert _load_gateway_token() == "gateway-token"
            print("  ✓ missing or garbage sidecar → the gateway chain is untouched")

            token_file = scratch / "brain-host.token"
            token_file.write_text("sidecar-token\n", encoding="utf-8")
            BRAIN_SIDECAR.write_text(
                "# comment line\r\n\nOTHER_KEY=ignored\n"
                'DIGITAL_ME_BRAIN_URL = "http://127.0.0.1:18791/tools/invoke"\r\n'
                f"DIGITAL_ME_BRAIN_TOKEN_FILE='{token_file}'\n",
                encoding="utf-8",
            )
            assert _resolve_gateway_url() == "http://127.0.0.1:18791/tools/invoke"
            assert _load_gateway_token() == "sidecar-token"
            print("  ✓ sidecar URL + token file beat OPENCLAW_GATEWAY_* and openclaw.json")

            os.environ["DIGITAL_ME_BRAIN_URL"] = "http://env.local/tools/invoke"
            assert _resolve_gateway_url() == "http://env.local/tools/invoke"
            try:
                _load_gateway_token()
            except BrainConfigError:
                pass
            else:
                raise AssertionError("an exported DIGITAL_ME_BRAIN_URL must not borrow the sidecar's token file")
            print("  ✓ an exported DIGITAL_ME_BRAIN_URL hides the sidecar (URL and token file)")

            del os.environ["DIGITAL_ME_BRAIN_URL"]
            token_file.unlink()
            try:
                _load_gateway_token()
            except BrainConfigError as exc:
                assert str(BRAIN_SIDECAR) in str(exc), exc
            else:
                raise AssertionError("a sidecar URL without a readable token file must not fall back")
            print("  ✓ sidecar URL without a readable token file is a hard error naming the sidecar")
    finally:
        BRAIN_SIDECAR = saved_sidecar
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ─── CLI ──────────────────────────────────────────────────────────────────


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dm_m1_emit",
        description="Emit one Codex-side M1 universal-protocol event.",
    )
    parser.add_argument(
        "event_type", nargs="?",
        choices=sorted(V1_EVENT_TYPES) + ["__selftest__"],
        help="One of the v1 event types",
    )
    parser.add_argument("--session-id", default="", help="Session identifier")
    parser.add_argument("--turn-id", default="0", help="Monotonic turn id")
    parser.add_argument("--agent-id", default=DEFAULT_AGENT_ID)
    parser.add_argument("--runtime", default=DEFAULT_RUNTIME)
    parser.add_argument("--platform", default=DEFAULT_PLATFORM)
    parser.add_argument("--entries-json", default="[]",
                        help='JSON-array of {"path": "...", "title": "...", "score": <n>}')
    parser.add_argument("--ack-signal", default=None,
                        choices=[None, "explicit_path", "title_match", "no_applicable", "no_acknowledgement"])
    parser.add_argument("--extra-json", default="{}", help="JSON object of extra fields")
    parser.add_argument("--wal", type=Path, default=DEFAULT_WAL)
    parser.add_argument("--gateway", default=_resolve_gateway_url(),
                        help="Brain /tools/invoke URL (default: DIGITAL_ME_BRAIN_URL, else the "
                             "digital-me-brain.env next to this script > OPENCLAW_GATEWAY_URL > "
                             "OPENCLAW_GATEWAY_HOST/PORT > openclaw gateway)")
    parser.add_argument("--token", default=None,
                        help="Bearer token override (default: DIGITAL_ME_BRAIN_TOKEN, else the "
                             "DIGITAL_ME_BRAIN_TOKEN_FILE / default token file when a brain URL "
                             "resolves; else OPENCLAW_GATEWAY_TOKEN, else openclaw.json)")
    parser.add_argument(
        "--skip-if-already-started", action="store_true",
        help="For session_start: exit 0 without emitting if the once-only flag already exists",
    )
    parser.add_argument("--selftest", action="store_true",
                        help="Offline idempotency selftest (no network, no production state)")
    parser.add_argument("--quiet", action="store_true", help="No stdout chatter")
    args = parser.parse_args(argv)

    if args.selftest:
        return run_selftest()
    if not args.event_type or args.event_type == "__selftest__":
        parser.print_help()
        return 1
    if not args.session_id:
        print("--session-id required", file=sys.stderr)
        return 1

    # Once-only session_start guard
    if args.event_type == "session_start" and args.skip_if_already_started:
        if session_already_started(args.session_id):
            if not args.quiet:
                print(f"[m1] session_start already emitted for {args.session_id[:12]}…, skipping")
            return 0
        mark_session_started(args.session_id)

    try:
        entries = json.loads(args.entries_json)
        if not isinstance(entries, list):
            raise ValueError("entries-json must be a JSON array")
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"--entries-json invalid: {exc}", file=sys.stderr)
        return 1

    try:
        extra = json.loads(args.extra_json) if args.extra_json else {}
        if not isinstance(extra, dict):
            raise ValueError("extra-json must be a JSON object")
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"--extra-json invalid: {exc}", file=sys.stderr)
        return 1

    event = build_event(
        event_type=args.event_type,
        session_id=args.session_id,
        turn_id=args.turn_id,
        agent_id=args.agent_id,
        runtime=args.runtime,
        platform=args.platform,
        entries=entries,
        ack_signal=args.ack_signal,
        extra=extra or None,
    )

    token: Optional[str] = args.token
    config_error: Optional[str] = None
    if not token:
        try:
            token = _load_gateway_token()
        except BrainConfigError as exc:
            # Durability first: the event still lands in the WAL so
            # m1_backfill.py can replay it once the config is fixed. With no
            # token, emit() skips the POST — never a fallback to openclaw.
            config_error = str(exc)
    result = emit(event, wal_path=args.wal, gateway_url=args.gateway, token=token)

    if not result["wal"]:
        if not args.quiet:
            print(f"[m1] WAL append FAILED for {args.event_type}", file=sys.stderr)
        return 2
    if config_error is not None:
        # Always on stderr, even with --quiet: this is a misconfiguration the
        # operator must see, not chatter.
        print(f"[m1] {config_error}; {args.event_type} kept in WAL only", file=sys.stderr)
        return 3
    if not args.quiet:
        brain_status = "ok" if result["brain"] else "deferred (will retry via backfill)"
        print(f"[m1] {args.event_type} event_id={event['event_id'][:60]} wal=ok brain={brain_status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
