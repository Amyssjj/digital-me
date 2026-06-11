#!/usr/bin/env python3
"""
m1_cutover_verify — parallel-aggregate from brain.db.m1_events AND
from the legacy JSONL files, then report whether the two sources agree.

Purpose: validate the dashboard intake cutover from the JSONL-union
source to the brain-side m1_score / m1_events source. Both sources
should produce the same (date, tree, agent_id, surfaced_unique,
acted_unique) tuples for the period where both have data.

Discrepancies are expected during the cutover window:
  - brain has events only since the M1 universal protocol shipped
    (~2026-05-27); JSONL has older history
  - JSONL is per-session aggregated; brain is per-turn
  - claude-code legacy intake parses transcript-level acted vs
    brain-side claude-code uses the Stop-hook's ack-signal heuristic
  - hermes legacy JSONL aggregate uses memory_get tool calls; brain
    uses LLM-output ack parsing (these CAN differ in either direction)

Usage:
  python -m m1_cutover_verify              # last 7 days from both sources
  python -m m1_cutover_verify --days 30
  python -m m1_cutover_verify --since 2026-05-27 --until 2026-05-28
  python -m m1_cutover_verify --json       # machine-readable diff
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple


HOME = Path.home()
BRAIN_DB = HOME / ".openclaw" / "data" / "brain.db"

HOOK_LOGS = {
    "claude-code": HOME / ".claude" / "hooks" / "application_rate.log",
    "openclaw":    HOME / ".openclaw" / "data" / "application_rate_openclaw.log",
    "hermes":      HOME / ".openclaw" / "data" / "application_rate_hermes.log",
}


# ─── Path classifier (matches dashboard_intake/derive_application_rate.py) ─


def _classify_path(raw: str) -> Optional[Tuple[str, str]]:
    if not raw:
        return None
    if raw.startswith("memory/"):
        return None
    if raw.startswith("wiki/"):
        rest = raw[len("wiki/"):]
        parts = rest.split("/", 1)
        if parts[0]:
            return ("wiki", parts[0])
    elif raw.startswith("tastes/"):
        rest = raw[len("tastes/"):]
        parts = rest.split("/", 1)
        if parts[0]:
            return ("tastes", parts[0])
    else:
        parts = raw.split("/", 1)
        if parts[0] and parts[0] != ".":
            return ("wiki", parts[0])
    return None


# ─── Legacy JSONL aggregator (port of derive_application_rate.aggregate) ─


def aggregate_from_jsonl(start: date, end: date) -> Dict[str, Any]:
    surfaced_paths: dict = defaultdict(set)
    acted_paths: dict = defaultdict(set)
    surfaced_by_agent: dict = defaultdict(set)
    acted_by_agent: dict = defaultdict(set)

    for agent_id, log in HOOK_LOGS.items():
        if not log.exists():
            continue
        with log.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                d_str = rec.get("session_date")
                if not d_str:
                    continue
                try:
                    d = datetime.strptime(d_str, "%Y-%m-%d").date()
                except ValueError:
                    continue
                if d < start or d > end:
                    continue
                iso = d.isoformat()
                for path in (rec.get("acted_paths") or []):
                    cls = _classify_path(path)
                    if cls is None:
                        continue
                    tree, _ = cls
                    acted_paths[(iso, tree)].add(path)
                    acted_by_agent[(iso, tree, agent_id)].add(path)
                    surfaced_paths[(iso, tree)].add(path)
                    surfaced_by_agent[(iso, tree, agent_id)].add(path)
                for path in (rec.get("ignored_paths") or []):
                    cls = _classify_path(path)
                    if cls is None:
                        continue
                    tree, _ = cls
                    surfaced_paths[(iso, tree)].add(path)
                    surfaced_by_agent[(iso, tree, agent_id)].add(path)

    return {
        "by_day": {k: (len(surfaced_paths[k]), len(acted_paths.get(k, set()))) for k in surfaced_paths},
        "by_agent": {k: (len(surfaced_by_agent[k]), len(acted_by_agent.get(k, set()))) for k in surfaced_by_agent},
        "raw_surfaced": surfaced_paths,
        "raw_acted": acted_paths,
        "raw_by_agent_surfaced": surfaced_by_agent,
        "raw_by_agent_acted": acted_by_agent,
    }


# ─── New brain.db aggregator ──────────────────────────────────────────────


def aggregate_from_brain(start: date, end: date) -> Dict[str, Any]:
    if not BRAIN_DB.exists():
        return {
            "by_day": {},
            "by_agent": {},
            "raw_surfaced": {},
            "raw_acted": {},
            "raw_by_agent_surfaced": {},
            "raw_by_agent_acted": {},
        }
    start_ms = int(
        datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).timestamp() * 1000
    )
    end_ms = int(
        datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc).timestamp() * 1000
    )
    conn = sqlite3.connect(BRAIN_DB)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT t, runtime, agent_id, event_type, entries_json
              FROM m1_events
             WHERE event_type IN ('knowledge_surfaced', 'assistant_ack')
               AND t >= ? AND t < ?
            """,
            (start_ms, end_ms),
        ).fetchall()
    finally:
        conn.close()

    surfaced_paths: dict = defaultdict(set)
    acted_paths: dict = defaultdict(set)
    surfaced_by_agent: dict = defaultdict(set)
    acted_by_agent: dict = defaultdict(set)

    # Map brain runtime → legacy intake agent_id key. The legacy intake's
    # HOOK_LOGS keys are "claude-code" / "openclaw" / "hermes" — the brain
    # `runtime` column matches exactly, so use it directly.

    for row in rows:
        t_ms = row["t"]
        runtime = row["runtime"]
        event_type = row["event_type"]
        try:
            entries = json.loads(row["entries_json"] or "[]")
        except json.JSONDecodeError:
            entries = []
        d_iso = datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).date().isoformat()
        for e in entries:
            if not isinstance(e, dict):
                continue
            path = e.get("path") or ""
            if not isinstance(path, str) or not path:
                continue
            cls = _classify_path(path)
            if cls is None:
                continue
            tree, _ = cls
            if event_type == "knowledge_surfaced":
                surfaced_paths[(d_iso, tree)].add(path)
                surfaced_by_agent[(d_iso, tree, runtime)].add(path)
            elif event_type == "assistant_ack":
                # acted paths are a subset of the immediately-preceding
                # surfaced — record on both sides (matches legacy intake).
                acted_paths[(d_iso, tree)].add(path)
                acted_by_agent[(d_iso, tree, runtime)].add(path)
                surfaced_paths[(d_iso, tree)].add(path)
                surfaced_by_agent[(d_iso, tree, runtime)].add(path)

    return {
        "by_day": {k: (len(surfaced_paths[k]), len(acted_paths.get(k, set()))) for k in surfaced_paths},
        "by_agent": {k: (len(surfaced_by_agent[k]), len(acted_by_agent.get(k, set()))) for k in surfaced_by_agent},
        "raw_surfaced": surfaced_paths,
        "raw_acted": acted_paths,
        "raw_by_agent_surfaced": surfaced_by_agent,
        "raw_by_agent_acted": acted_by_agent,
    }


# ─── Diff + report ────────────────────────────────────────────────────────


def _diff_counts(legacy: Dict[Any, Tuple[int, int]], brain: Dict[Any, Tuple[int, int]]) -> Dict[str, Any]:
    keys = set(legacy.keys()) | set(brain.keys())
    diff_rows = []
    agree = 0
    for k in sorted(keys, key=lambda x: tuple(str(p) for p in x)):
        ls, la = legacy.get(k, (0, 0))
        bs, ba = brain.get(k, (0, 0))
        match = (ls, la) == (bs, ba)
        if match:
            agree += 1
        diff_rows.append({
            "key": k,
            "legacy": [ls, la],
            "brain": [bs, ba],
            "match": match,
        })
    return {"rows": diff_rows, "agree": agree, "total": len(keys)}


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="m1_cutover_verify")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--since", type=str, default=None, help="YYYY-MM-DD inclusive")
    p.add_argument("--until", type=str, default=None, help="YYYY-MM-DD inclusive (default today)")
    p.add_argument("--json", action="store_true", help="Machine-readable JSON output")
    args = p.parse_args(argv)

    if args.since:
        start = datetime.strptime(args.since, "%Y-%m-%d").date()
    else:
        start = date.today() - timedelta(days=args.days - 1)
    end = date.today() if not args.until else datetime.strptime(args.until, "%Y-%m-%d").date()

    legacy = aggregate_from_jsonl(start, end)
    brain = aggregate_from_brain(start, end)

    by_day_diff = _diff_counts(legacy["by_day"], brain["by_day"])
    by_agent_diff = _diff_counts(legacy["by_agent"], brain["by_agent"])

    if args.json:
        print(json.dumps({
            "window": {"since": start.isoformat(), "until": end.isoformat()},
            "by_day": by_day_diff,
            "by_agent": by_agent_diff,
        }, indent=2))
        return 0

    print(f"window: {start} → {end}")
    print()
    print("by_day (date, tree) — legacy [surf, acted] vs brain [surf, acted]:")
    for row in by_day_diff["rows"]:
        marker = "✓" if row["match"] else "△"
        k = row["key"]
        print(f"  {marker}  {k[0]:11} {k[1]:8}  legacy={str(row['legacy']):>10}  brain={str(row['brain']):>10}")
    print(f"  agree {by_day_diff['agree']} / {by_day_diff['total']}")
    print()
    print("by_agent (date, tree, agent_id):")
    for row in by_agent_diff["rows"]:
        marker = "✓" if row["match"] else "△"
        k = row["key"]
        print(f"  {marker}  {k[0]:11} {k[1]:8} {k[2]:14}  legacy={str(row['legacy']):>10}  brain={str(row['brain']):>10}")
    print(f"  agree {by_agent_diff['agree']} / {by_agent_diff['total']}")
    print()
    print(f"VERDICT: by_day {by_day_diff['agree']}/{by_day_diff['total']}, "
          f"by_agent {by_agent_diff['agree']}/{by_agent_diff['total']} agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
