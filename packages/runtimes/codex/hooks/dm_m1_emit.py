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
    body = json.dumps({"tool": "m1_event_record", "args": args}).encode("utf-8")
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

    print("[selftest] PASSED")
    return 0


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
    parser.add_argument("--gateway", default=os.environ.get("OPENCLAW_GATEWAY_URL") or DEFAULT_GATEWAY)
    parser.add_argument("--token", default=os.environ.get("OPENCLAW_GATEWAY_TOKEN"))
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

    token = args.token or _load_gateway_token()
    result = emit(event, wal_path=args.wal, gateway_url=args.gateway, token=token)

    if not result["wal"]:
        if not args.quiet:
            print(f"[m1] WAL append FAILED for {args.event_type}", file=sys.stderr)
        return 2
    if not args.quiet:
        brain_status = "ok" if result["brain"] else "deferred (will retry via backfill)"
        print(f"[m1] {args.event_type} event_id={event['event_id'][:60]} wal=ok brain={brain_status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
