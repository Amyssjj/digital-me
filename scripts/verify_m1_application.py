#!/usr/bin/env python3
"""Live M1 application-rate verifier.

Scans the canonical M1 event sources — brain.db `m1_events` and the per-runtime
WALs (`~/.openclaw/data/m1_events_<runtime>.jsonl`) — over a recent window and,
for each runtime (claude-code, openclaw, hermes), reports:

  - surfaced turns          (knowledge_surfaced events)
  - acknowledged turns      (assistant_ack with a COUNTING signal)
  - application rate        (acked / surfaced)

A runtime is HEALTHY when it has surfaced>0 AND acked>0 — i.e. it both injects
knowledge AND records that the assistant applied it (the `[Digital Me]`
marker). A runtime with surfaced>0 but acked==0 is the failure this verifier
guards against (the OpenClaw "0% application rate" regression).

Exit code 0 when every runtime that surfaced anything also acked at least once;
1 otherwise. With --require-all, every known runtime must be healthy.

Usage:
  python3 scripts/verify_m1_application.py [--days N] [--brain-db PATH]
                                           [--home PATH] [--require-all]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

RUNTIMES = ("claude-code", "openclaw", "hermes")

# Signals the M1 scorer counts as "the assistant acknowledged the surfaced
# context" — must match brain-orchestrator handlers/m1.ts ACK_SIGNALS_THAT_COUNT.
COUNTING_ACK_SIGNALS = {"explicit_path", "title_match", "no_applicable"}

WALS = {
    "claude-code": ".openclaw/data/m1_events_claude_code.jsonl",
    "openclaw": ".openclaw/data/m1_events_openclaw.jsonl",
    "hermes": ".openclaw/data/m1_events_hermes.jsonl",
}
DEFAULT_BRAIN_DB = ".openclaw/data/brain.db"


def _accumulate(events, since_ms, surfaced_turns, acked_turns):
    """Fold (runtime, event_type, ack_signal, session_id, turn_id, t) rows
    into per-runtime turn sets keyed by (session_id, turn_id)."""
    for runtime, event_type, ack_signal, session_id, turn_id, t in events:
        if not isinstance(t, (int, float)) or t < since_ms:
            continue
        key = (session_id or "", turn_id or "")
        if event_type == "knowledge_surfaced":
            surfaced_turns[runtime].add(key)
        elif event_type == "assistant_ack" and ack_signal in COUNTING_ACK_SIGNALS:
            acked_turns[runtime].add(key)


def _read_brain(brain_db: Path, since_ms: int):
    if not brain_db.exists():
        return []
    conn = sqlite3.connect(str(brain_db))
    try:
        rows = conn.execute(
            """SELECT runtime, event_type, ack_signal, session_id, turn_id, t
                 FROM m1_events
                WHERE event_type IN ('knowledge_surfaced','assistant_ack')
                  AND t >= ?""",
            (since_ms,),
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    finally:
        conn.close()
    return rows


def _read_wals(home: Path, since_ms: int):
    out = []
    for runtime, rel in WALS.items():
        p = home / rel
        if not p.exists():
            continue
        with p.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                out.append(
                    (
                        e.get("runtime") or runtime,
                        e.get("event_type"),
                        e.get("ack_signal"),
                        e.get("session_id"),
                        e.get("turn_id"),
                        e.get("t"),
                    )
                )
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--home", type=Path, default=Path.home())
    ap.add_argument("--brain-db", type=Path, default=None)
    ap.add_argument(
        "--require-all",
        action="store_true",
        help="Fail unless EVERY known runtime is healthy (surfaced>0 and acked>0).",
    )
    args = ap.parse_args(argv)

    home = args.home
    brain_db = args.brain_db or (home / DEFAULT_BRAIN_DB)
    since_ms = int(
        (datetime.now(timezone.utc) - timedelta(days=args.days)).timestamp() * 1000
    )

    surfaced_turns = defaultdict(set)
    acked_turns = defaultdict(set)
    _accumulate(_read_brain(brain_db, since_ms), since_ms, surfaced_turns, acked_turns)
    _accumulate(_read_wals(home, since_ms), since_ms, surfaced_turns, acked_turns)

    print(f"M1 application-rate verification — last {args.days}d "
          f"(brain.db ∪ WALs)\n")
    print(f"{'runtime':<14}{'surfaced':>10}{'acked':>8}{'rate':>9}   status")
    print("-" * 56)

    unhealthy = []
    runtimes = sorted(set(RUNTIMES) | set(surfaced_turns) | set(acked_turns))
    for rt in runtimes:
        s = len(surfaced_turns.get(rt, set()))
        a = len(acked_turns.get(rt, set()))
        rate = (a / s) if s else None
        rate_str = f"{rate*100:5.1f}%" if rate is not None else "   n/a"
        if s > 0 and a == 0:
            status = "FAIL (surfaces but never acks)"
            unhealthy.append(rt)
        elif s == 0:
            status = "idle (nothing surfaced)"
            if args.require_all and rt in RUNTIMES:
                unhealthy.append(rt)
        else:
            status = "ok"
        print(f"{rt:<14}{s:>10}{a:>8}{rate_str:>9}   {status}")

    print()
    if unhealthy:
        print(f"UNHEALTHY: {', '.join(unhealthy)}")
        return 1
    print("All runtimes that surfaced knowledge also recorded application. ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
