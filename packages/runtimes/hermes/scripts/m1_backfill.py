#!/usr/bin/env python3
"""
m1_backfill — Replay the hermes M1 write-ahead log into the brain.

Reads ``~/.openclaw/data/m1_events_hermes.jsonl`` line by line, posts each
event to the brain's ``m1_event_record`` tool (digital-me brain-host when
``DIGITAL_ME_BRAIN_URL`` + ``DIGITAL_ME_BRAIN_TOKEN`` are set, otherwise
the openclaw gateway), and reports inserted vs. deduped vs. failed counts.
Closes pillar 4 of the universal M1 protocol (WAL → brain → backfill).

Idempotency contract:
  Brain uses ``INSERT OR IGNORE INTO m1_events ... WHERE event_id = ?``
  so re-running this script on a WAL whose lines already landed in brain
  is safe — every event reports ``inserted=false``. The script exits 0
  in that case, and the script's ``--selftest`` mode asserts exactly that.

Usage:
  # one-shot replay of the whole WAL
  python -m m1_backfill

  # replay only lines past offset (e.g. resume from a crashed run)
  python -m m1_backfill --since-line 12345

  # see what would happen without actually posting
  python -m m1_backfill --dry-run

  # self-test (no production state touched)
  python -m m1_backfill --selftest

Exit codes:
  0  success (all lines accepted, or all were duplicates)
  1  argument / config error
  2  network error talking to gateway
  3  at least one event was rejected by brain (logged)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


HOME = Path.home()
DEFAULT_WAL_PATH = HOME / ".openclaw" / "data" / "m1_events_hermes.jsonl"
DEFAULT_GATEWAY_URL = "http://localhost:18789/tools/invoke"


# ─── Endpoint + auth (mirrors the plugin's _resolve_gateway_url / token loader) ──
#
# Precedence, same as transport/brain-mcp-proxy and the claude-code hooks:
#   1. DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN (both required) → brain-host
#   2. OPENCLAW_GATEWAY_URL, or OPENCLAW_GATEWAY_HOST / OPENCLAW_GATEWAY_PORT,
#      with OPENCLAW_GATEWAY_TOKEN
#   3. the openclaw gateway on localhost:18789, token from openclaw config files


def _brain_host_configured() -> bool:
    return bool(os.environ.get("DIGITAL_ME_BRAIN_URL"))


def _resolve_gateway_url() -> str:
    url = os.environ.get("DIGITAL_ME_BRAIN_URL") or os.environ.get("OPENCLAW_GATEWAY_URL")
    if url:
        return url
    host = os.environ.get("OPENCLAW_GATEWAY_HOST")
    port = os.environ.get("OPENCLAW_GATEWAY_PORT")
    if host or port:
        return f"http://{host or 'localhost'}:{port or '18789'}/tools/invoke"
    return DEFAULT_GATEWAY_URL


def _resolve_token() -> Optional[str]:
    """Env-only token for the resolved endpoint. When DIGITAL_ME_BRAIN_URL is
    set only DIGITAL_ME_BRAIN_TOKEN counts — OPENCLAW_GATEWAY_TOKEN and the
    openclaw config files authenticate a different server and are never
    used against brain-host (main() turns the missing token into exit 1)."""
    if _brain_host_configured():
        return os.environ.get("DIGITAL_ME_BRAIN_TOKEN") or None
    return os.environ.get("OPENCLAW_GATEWAY_TOKEN") or None


def load_gateway_token() -> Optional[str]:
    """Read the gateway bearer token from the same candidate paths the
    hermes recall plugin uses, so this script Just Works on the same
    machine where the plugin is configured."""
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


# ─── Brain client ─────────────────────────────────────────────────────────


def invoke_brain(
    gateway_url: str,
    token: str,
    tool: str,
    args: Dict[str, Any],
    timeout: float = 5.0,
) -> Optional[Dict[str, Any]]:
    # openclaw >= 2026.8.1 rejects /tools/invoke on a multi-agent host without
    # an explicit owner. Distinct from args["agent_id"], which is attribution.
    _gw_agent = os.environ.get("OPENCLAW_GATEWAY_AGENT_ID", "main")
    body = json.dumps(
        {"tool": tool, "agentId": _gw_agent, "args": args}
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
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode("utf-8")
        return json.loads(text)


# ─── Backfill core ────────────────────────────────────────────────────────


@dataclass
class BackfillStats:
    total_lines: int = 0
    parsed: int = 0
    parse_errors: int = 0
    sent: int = 0
    inserted: int = 0
    deduped: int = 0
    failed: int = 0
    skipped_before_offset: int = 0
    failures: list = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"lines={self.total_lines} parsed={self.parsed} "
            f"parse_errors={self.parse_errors} sent={self.sent} "
            f"inserted={self.inserted} deduped={self.deduped} "
            f"failed={self.failed} skipped_before_offset={self.skipped_before_offset}"
        )


def _normalize_event_for_record(ev: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a WAL line (canonical event shape, list/dict fields as
    Python objects) into the m1_event_record args shape (list/dict fields
    JSON-encoded strings). The brain's envelope handles both shapes, but
    encoding here matches the live plugin and keeps the wire format
    identical."""
    args: Dict[str, Any] = {
        k: v
        for k, v in ev.items()
        if k not in ("entries", "extra")
    }
    if isinstance(ev.get("entries"), (list, tuple)):
        args["entries"] = json.dumps(ev["entries"])
    elif "entries" in ev:
        args["entries"] = ev["entries"]
    if isinstance(ev.get("extra"), dict):
        args["extra"] = json.dumps(ev["extra"])
    elif "extra" in ev:
        args["extra"] = ev["extra"]
    return args


def replay_lines(
    lines: Iterable[str],
    *,
    poster,
    since_line: int = 0,
    dry_run: bool = False,
    verbose: bool = False,
) -> BackfillStats:
    """Replay an iterable of WAL lines through `poster(args) -> dict`.

    `poster` is a function `(args: dict) -> brain response dict` so the
    selftest can substitute a fake without hitting the network. Returns
    aggregated stats.
    """
    stats = BackfillStats()
    for idx, raw in enumerate(lines, start=1):
        stats.total_lines += 1
        if idx <= since_line:
            stats.skipped_before_offset += 1
            continue
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except json.JSONDecodeError:
            stats.parse_errors += 1
            continue
        if not isinstance(ev, dict):
            stats.parse_errors += 1
            continue
        stats.parsed += 1

        if dry_run:
            if verbose:
                eid = ev.get("event_id", "<no-id>")
                print(f"  [dry-run] line {idx}: {ev.get('event_type')} {eid[:80]}")
            continue

        args = _normalize_event_for_record(ev)
        try:
            resp = poster(args)
        except Exception as exc:  # noqa: BLE001
            stats.failed += 1
            stats.failures.append({"line": idx, "error": str(exc), "event_id": ev.get("event_id")})
            if verbose:
                print(f"  line {idx}: ERROR {exc}")
            continue

        stats.sent += 1
        # Brain returns {"ok": true, "result": {"content": [{"type": "text", "text": "<json>"}]}}.
        # The JSON inside text has {"ok": true, "eventId": "...", "inserted": <bool>}.
        inserted = _extract_inserted(resp)
        if inserted is True:
            stats.inserted += 1
            if verbose:
                print(f"  line {idx}: inserted event_id={ev.get('event_id', '<no-id>')[:60]}")
        elif inserted is False:
            stats.deduped += 1
            if verbose:
                print(f"  line {idx}: deduped (already in brain) event_id={ev.get('event_id', '<no-id>')[:60]}")
        else:
            # Unparseable response — treat as failure
            stats.failed += 1
            stats.failures.append(
                {"line": idx, "error": "unparseable response", "event_id": ev.get("event_id"), "resp": str(resp)[:200]},
            )
    return stats


def _extract_inserted(resp: Optional[Dict[str, Any]]) -> Optional[bool]:
    """Unwrap brain's MCPToolResult envelope and return the `inserted`
    flag. Returns None when the response is malformed."""
    if not isinstance(resp, dict):
        return None
    # Outer ok flag
    if resp.get("ok") is False:
        return None
    result = resp.get("result")
    if not isinstance(result, dict):
        return None
    content = result.get("content")
    if not isinstance(content, list) or not content:
        return None
    first = content[0]
    if not isinstance(first, dict):
        return None
    text = first.get("text")
    if not isinstance(text, str):
        return None
    try:
        inner = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(inner, dict):
        return None
    return bool(inner.get("inserted")) if "inserted" in inner else None


# ─── Selftest (no production state touched) ───────────────────────────────


def run_selftest() -> int:
    """Exercise the script's idempotency contract end-to-end using a
    fake poster. Asserts:

      - First replay: every event reports inserted=true
      - Second replay over the same WAL: every event reports inserted=false (deduped)
      - Malformed lines are counted as parse_errors and skipped
      - --since-line N correctly skips the first N lines
    """
    sample_wal = [
        json.dumps({
            "event_id": "S1::0::session_start::aaa",
            "schema_version": 1,
            "runtime": "hermes",
            "agent_id": "hermes",
            "session_id": "S1",
            "turn_id": "0",
            "event_type": "session_start",
            "entries": [],
            "t": 1000,
        }),
        json.dumps({
            "event_id": "S1::1::knowledge_surfaced::bbb",
            "schema_version": 1,
            "runtime": "hermes",
            "agent_id": "hermes",
            "session_id": "S1",
            "turn_id": "1",
            "event_type": "knowledge_surfaced",
            "entries": [{"path": "infra/foo.md"}],
            "t": 2000,
        }),
        "this is not json",  # bad line
        json.dumps({
            "event_id": "S1::1::assistant_ack::ccc",
            "schema_version": 1,
            "runtime": "hermes",
            "agent_id": "hermes",
            "session_id": "S1",
            "turn_id": "1",
            "event_type": "assistant_ack",
            "entries": [{"path": "infra/foo.md"}],
            "ack_signal": "explicit_path",
            "t": 3000,
        }),
    ]

    # Fake brain that simulates INSERT OR IGNORE: tracks event_ids it's
    # already seen and returns inserted=false on retries.
    seen = set()
    def fake_brain(args):
        eid = args.get("event_id")
        first = eid not in seen
        seen.add(eid)
        return {
            "ok": True,
            "result": {
                "content": [
                    {"type": "text", "text": json.dumps({"ok": True, "eventId": eid, "inserted": first})},
                ],
            },
        }

    print("[selftest] First replay (cold brain) — expect 3 inserts, 0 dedups, 1 parse_error")
    s1 = replay_lines(sample_wal, poster=fake_brain)
    print(f"  {s1.summary()}")
    assert s1.inserted == 3, s1
    assert s1.deduped == 0, s1
    assert s1.parse_errors == 1, s1
    assert s1.sent == 3, s1

    print("[selftest] Second replay (warm brain) — expect 0 inserts, 3 dedups")
    s2 = replay_lines(sample_wal, poster=fake_brain)
    print(f"  {s2.summary()}")
    assert s2.inserted == 0, s2
    assert s2.deduped == 3, s2

    print("[selftest] --since-line 2 — should skip the first 2 lines, then parse 1 bad + 1 good")
    seen.clear()
    s3 = replay_lines(sample_wal, poster=fake_brain, since_line=2)
    print(f"  {s3.summary()}")
    # Lines 1,2 skipped. Line 3 is the bad line (parse_error, never sent).
    # Line 4 is a valid event → sent + inserted.
    assert s3.skipped_before_offset == 2, s3
    assert s3.parse_errors == 1, s3
    assert s3.sent == 1, s3
    assert s3.inserted == 1, s3

    print("[selftest] --dry-run — should parse but never call brain")
    calls = []
    def counting_brain(args):
        calls.append(args)
        return fake_brain(args)
    s4 = replay_lines(sample_wal, poster=counting_brain, dry_run=True)
    print(f"  {s4.summary()}")
    assert s4.sent == 0, s4
    assert s4.parsed == 3, s4
    assert s4.parse_errors == 1, s4
    assert len(calls) == 0, calls

    print("[selftest] endpoint precedence — DIGITAL_ME_BRAIN_URL/TOKEN beat OPENCLAW_GATEWAY_*")
    _selftest_endpoint_precedence()

    print("[selftest] PASSED")
    return 0


_ENDPOINT_ENV_KEYS = (
    "DIGITAL_ME_BRAIN_URL",
    "DIGITAL_ME_BRAIN_TOKEN",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_HOST",
    "OPENCLAW_GATEWAY_PORT",
)


def _selftest_endpoint_precedence() -> None:
    """Assert the resolver precedence with a scratch environment, restoring
    the caller's env afterwards. Exercises the argparse defaults through
    a real parse so the CLI surface is what's under test, not a helper."""
    saved = {k: os.environ.get(k) for k in _ENDPOINT_ENV_KEYS}

    def _set(**env: Optional[str]) -> None:
        for k in _ENDPOINT_ENV_KEYS:
            os.environ.pop(k, None)
        for k, v in env.items():
            if v is not None:
                os.environ[k] = v

    def _parsed_defaults() -> argparse.Namespace:
        # The real CLI parser, built after the env is set, so the defaults
        # under test are exactly what `python -m m1_backfill` would use.
        return _build_parser().parse_args([])

    try:
        # Both families set: brain-host wins, gateway values ignored.
        _set(
            DIGITAL_ME_BRAIN_URL="http://brain.test:18791/tools/invoke",
            DIGITAL_ME_BRAIN_TOKEN="brain-tok",
            OPENCLAW_GATEWAY_URL="http://gw.test:18789/tools/invoke",
            OPENCLAW_GATEWAY_TOKEN="gw-tok",
        )
        ns = _parsed_defaults()
        assert ns.gateway == "http://brain.test:18791/tools/invoke", ns
        assert ns.token == "brain-tok", ns

        # brain URL without brain token: the gateway token must NOT leak in.
        _set(
            DIGITAL_ME_BRAIN_URL="http://brain.test:18791/tools/invoke",
            OPENCLAW_GATEWAY_TOKEN="gw-tok",
        )
        ns = _parsed_defaults()
        assert ns.gateway == "http://brain.test:18791/tools/invoke", ns
        assert ns.token is None, ns

        # Gateway family only.
        _set(OPENCLAW_GATEWAY_URL="http://gw.test:18789/tools/invoke", OPENCLAW_GATEWAY_TOKEN="gw-tok")
        ns = _parsed_defaults()
        assert ns.gateway == "http://gw.test:18789/tools/invoke", ns
        assert ns.token == "gw-tok", ns

        # HOST/PORT composition.
        _set(OPENCLAW_GATEWAY_HOST="10.0.0.9", OPENCLAW_GATEWAY_PORT="28789")
        assert _resolve_gateway_url() == "http://10.0.0.9:28789/tools/invoke"
        _set(OPENCLAW_GATEWAY_PORT="28789")
        assert _resolve_gateway_url() == "http://localhost:28789/tools/invoke"

        # Nothing set: default gateway, no env token.
        _set()
        ns = _parsed_defaults()
        assert ns.gateway == DEFAULT_GATEWAY_URL, ns
        assert ns.token is None, ns
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ─── CLI ──────────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    """The CLI surface. Factored out of main() so the selftest can assert
    the env-derived defaults through a real parse."""
    parser = argparse.ArgumentParser(
        prog="m1_backfill",
        description="Replay the hermes M1 WAL into the brain. Idempotent.",
    )
    parser.add_argument(
        "--wal", type=Path, default=DEFAULT_WAL_PATH,
        help=f"WAL path (default: {DEFAULT_WAL_PATH})",
    )
    parser.add_argument(
        "--gateway", default=_resolve_gateway_url(),
        help=(
            "Brain endpoint URL (default: DIGITAL_ME_BRAIN_URL, then "
            f"OPENCLAW_GATEWAY_URL / HOST+PORT, then {DEFAULT_GATEWAY_URL})"
        ),
    )
    parser.add_argument(
        "--token", default=_resolve_token(),
        help=(
            "Override the auth token (default: DIGITAL_ME_BRAIN_TOKEN when "
            "DIGITAL_ME_BRAIN_URL is set, else OPENCLAW_GATEWAY_TOKEN, else openclaw config)"
        ),
    )
    parser.add_argument(
        "--since-line", type=int, default=0, metavar="N",
        help="Skip the first N lines of the WAL (resume after a crashed run)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Parse but don't POST")
    parser.add_argument("-v", "--verbose", action="store_true", help="Per-line progress")
    parser.add_argument("--selftest", action="store_true", help="Run the built-in idempotency selftest (no live brain)")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.selftest:
        return run_selftest()

    if not args.wal.exists():
        print(f"WAL not found: {args.wal}", file=sys.stderr)
        return 1

    # brain-host mode never falls back to the openclaw config files: their
    # token belongs to the gateway, and posting it to brain-host is a 401
    # dressed up as "backfill ran". A URL without a token is a hard error.
    token = args.token or (None if _brain_host_configured() else load_gateway_token())
    if not token and not args.dry_run:
        if _brain_host_configured():
            print(
                "DIGITAL_ME_BRAIN_URL is set but DIGITAL_ME_BRAIN_TOKEN is not "
                "(set both to use brain-host, pass --token, or unset the URL to "
                "fall back to the openclaw gateway)",
                file=sys.stderr,
            )
        else:
            print(
                "No brain token (set DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN "
                "for brain-host, OPENCLAW_GATEWAY_TOKEN for the gateway, or fix openclaw config)",
                file=sys.stderr,
            )
        return 1

    def poster(args_dict: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        return invoke_brain(args.gateway, token or "", "m1_event_record", args_dict)

    started = time.time()
    print(f"[m1_backfill] WAL: {args.wal}")
    print(f"[m1_backfill] Gateway: {args.gateway}")
    if args.since_line:
        print(f"[m1_backfill] Resuming from line {args.since_line}")
    if args.dry_run:
        print("[m1_backfill] DRY RUN — not sending to brain")

    with args.wal.open("r", encoding="utf-8") as f:
        stats = replay_lines(
            f,
            poster=poster,
            since_line=args.since_line,
            dry_run=args.dry_run,
            verbose=args.verbose,
        )

    elapsed = time.time() - started
    print(f"[m1_backfill] Done in {elapsed:.2f}s: {stats.summary()}")
    if stats.failures:
        print("[m1_backfill] First 5 failures:", file=sys.stderr)
        for f in stats.failures[:5]:
            print(f"  line {f['line']}: {f['error']}", file=sys.stderr)

    if stats.failed > 0:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
