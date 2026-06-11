"""Step 3/4: derive_application_rate — hook logs + brain.db.m1_events →
                                                    application_rate
                                                    + application_rate_by_domain
                                                    + application_rate_by_agent.

Reads M1 application_rate signal from TWO sources and unions the path
sets per (date, tree, [domain|agent]):

  1. **brain.db.m1_events** (canonical source, since 2026-05-27): the
     M1 universal protocol's primary store. Every runtime emits
     `knowledge_surfaced` and `assistant_ack` events to this table.
     See wiki: infrastructure/m1-universal-event-protocol.md

  2. **Per-runtime JSONL** (legacy + WAL): each runtime's recall plugin
     also appends an aggregate JSONL line per session. Currently kept
     for two reasons: (a) historical days before brain.db.m1_events
     existed (~2026-05-22 → 2026-05-26), and (b) as a local
     write-ahead-log durability layer for the brain.

The two sources merge by **union of path sets per key** — brain wins
where they overlap (canonical), JSONL fills the historical gap. Eventually
(once brain has several weeks of history), the JSONL read can retire.

Cutover plan:
  - default --source=both  (read both sources, union by path)
  - --source=brain         (canonical-only; for rollouts where JSONL is gone)
  - --source=jsonl         (legacy-only; for rollback)

Daily metric split three ways:

  - by tree:    wiki vs tastes (the top-line dual-line chart)
  - by domain:  hover-drilldown for which areas land
  - by agent:   hover-drilldown for which runtime applies best

JSONL log shape (canonical schema, see `dm_application_rate.sh`):

  {
    "ts": "2026-05-26T19:00:00-07:00",
    "session_id": "...",
    "session_date": "2026-05-26",
    "surfaced_unique": N,
    "acted_unique": N,
    "application_rate": <float or null>,
    "acted_paths":   ["wiki/<domain>/<slug>.md", "tastes/<domain>/<slug>.md", ...],
    "ignored_paths": ["wiki/<domain>/<slug>.md", ...],
    "source": "live"
  }

Brain event shape (m1_events table, see m1-universal-event-protocol):

  event_type IN ('knowledge_surfaced','assistant_ack')
  entries_json = JSON-array of {path, title?, score?, source?}
  agent_id    = "claude-code" | "openclaw" | "hermes" | ...
  runtime     = same as agent_id today (one process per runtime)
  t           = epoch ms

Idempotent: groups all sessions/events for a given (date, tree, [domain|agent])
and upserts. Re-running on the same day overwrites — no double-counting.

Usage:
  python -m dashboard_intake.derive_application_rate [--days N] [--db PATH]
                                                    [--source brain|jsonl|both]
                                                    [--brain-db PATH]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from . import db_path
from .db import (
    connect,
    upsert_application_rate,
    upsert_application_rate_by_agent,
    upsert_application_rate_by_domain,
)


# Hook log location per runtime. Each runtime emits its own JSONL log; the
# agent_id is implicit per file.
#
# Layout note: claude-code keeps its log under its own .claude/hooks/, while
# the openclaw + hermes recall plugins both write to ~/.openclaw/data/
# (regardless of the agent runtime, because the openclaw gateway provides
# the writer). Codex doesn't ship an application_rate hook yet.
HOOK_LOGS: dict[str, str] = {
    "claude-code": ".claude/hooks/application_rate.log",
    "openclaw":    ".openclaw/data/application_rate_openclaw.log",
    "hermes":      ".openclaw/data/application_rate_hermes.log",
}


def _iter_log_records(p: Path) -> Iterable[dict]:
    """Yield parsed JSONL records from a hook log. Skips bad lines silently."""
    if not p.exists():
        return
    try:
        with p.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def _classify_path(raw: str) -> tuple[str, str] | None:
    """Map a surfaced/acted path to (tree, domain) or return None to drop it.

      - wiki/<domain>/<slug>.md            → ('wiki', '<domain>')   (post-§A)
      - tastes/<domain>/<slug>.md          → ('tastes', '<domain>') (post-§A)
      - .../*/wiki/<domain>/<slug>.md      → ('wiki', '<domain>')   (brain cwd-relative encoding)
      - .../*/tastes/<domain>/<slug>.md    → ('tastes', '<domain>') (same)
      - memory/*                           → None                    (filtered noise)
      - absolute paths                     → None                    (unmappable)
      - bare <domain>/<slug>.md            → ('wiki', '<domain>')   (pre-§A backfill)

    The bare-path branch lets us backfill pre-§A hook log records, which
    pre-date the `wiki/` tree prefix that §A added. At that time the
    tastes tree didn't exist yet — every surfaced/acted path was a wiki
    path — so re-classifying bare paths as wiki is correct.

    The cwd-relative-prefix branch (2026-05-27) handles brain-encoded
    paths like ``"../../../../../home/<user>/digital-me/wiki/<domain>/<slug>.md"``
    that the brain's memory_search returns. Without it, those paths fall
    into the bare-path branch and get bucketed under a phantom ``..``
    domain — corrupting the by-domain breakdown chart. See wiki:
    evaluation/metric-integrity-and-calibration-protocol.md ("calibration
    gap resolution").

    memory/* paths are dropped per the dashboard wiki rule "Filter
    Knowledge Noise" (frontend/technical-implementation-of-mission-control-goal-panels).
    """
    if not raw:
        return None
    # Drop per-agent auto-memory paths (they're agent state, not wiki
    # corpus — including them inflates the denominator).
    if raw.startswith("memory/"):
        return None
    # Drop absolute filesystem paths we can't classify.
    if raw.startswith("/"):
        return None
    # Cwd-relative encoding from the brain — strip anything before
    # "/wiki/" or "/tastes/" and bucket by the canonical domain segment.
    if "/wiki/" in raw:
        rest = raw.split("/wiki/", 1)[1]
        parts = rest.split("/", 1)
        if len(parts) >= 1 and parts[0]:
            return "wiki", parts[0]
    if "/tastes/" in raw:
        rest = raw.split("/tastes/", 1)[1]
        parts = rest.split("/", 1)
        if len(parts) >= 1 and parts[0]:
            return "tastes", parts[0]
    if raw.startswith("wiki/"):
        rest = raw[len("wiki/"):]
        parts = rest.split("/", 1)
        if len(parts) >= 1 and parts[0]:
            return "wiki", parts[0]
    if raw.startswith("tastes/"):
        rest = raw[len("tastes/"):]
        parts = rest.split("/", 1)
        if len(parts) >= 1 and parts[0]:
            return "tastes", parts[0]
    # Bare-path backcompat: treat any other prefix-less *.md path as a
    # wiki entry (its first segment as the domain). Excludes "." and
    # ".." which would slip through when the path lacks the infix.
    parts = raw.split("/", 1)
    if len(parts) >= 1 and parts[0] and parts[0] not in (".", ".."):
        return "wiki", parts[0]
    return None


def aggregate(
    home: Path, start: date, end: date,
) -> tuple[
    dict[tuple[str, str], tuple[int, int]],
    dict[tuple[str, str, str], tuple[int, int]],
    dict[tuple[str, str, str], tuple[int, int]],
]:
    """Pure aggregator. Reads logs in the window and returns three maps:

      by_day[(date, tree)] = (surfaced_unique, acted_unique)
      by_day_domain[(date, tree, domain)] = (surfaced, acted)
      by_day_agent[(date, tree, agent_id)] = (surfaced, acted)

    Per-session sets are unioned across the day before summing. (A path
    surfaced in 3 sessions counts once for the day, not 3 times.)
    """
    # Collect raw per-day path SETS first, then collapse to counts.
    surfaced_paths: dict[tuple[str, str], set[str]] = defaultdict(set)         # (date,tree)
    acted_paths: dict[tuple[str, str], set[str]] = defaultdict(set)
    surfaced_by_domain: dict[tuple[str, str, str], set[str]] = defaultdict(set)  # (date,tree,domain)
    acted_by_domain: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    surfaced_by_agent: dict[tuple[str, str, str], set[str]] = defaultdict(set)   # (date,tree,agent)
    acted_by_agent: dict[tuple[str, str, str], set[str]] = defaultdict(set)

    for agent_id, rel in HOOK_LOGS.items():
        log = home / rel
        for rec in _iter_log_records(log):
            d_str = rec.get("session_date")
            if not d_str:
                continue
            try:
                from datetime import datetime
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
                tree, domain = cls
                acted_paths[(iso, tree)].add(path)
                acted_by_domain[(iso, tree, domain)].add(path)
                acted_by_agent[(iso, tree, agent_id)].add(path)
                # An acted path was also surfaced — record it on the surfaced
                # side too. (Hook records the union as acted_paths ∪ ignored_paths.)
                surfaced_paths[(iso, tree)].add(path)
                surfaced_by_domain[(iso, tree, domain)].add(path)
                surfaced_by_agent[(iso, tree, agent_id)].add(path)
            for path in (rec.get("ignored_paths") or []):
                cls = _classify_path(path)
                if cls is None:
                    continue
                tree, domain = cls
                surfaced_paths[(iso, tree)].add(path)
                surfaced_by_domain[(iso, tree, domain)].add(path)
                surfaced_by_agent[(iso, tree, agent_id)].add(path)

    by_day = {k: (len(surfaced_paths[k]), len(acted_paths.get(k, set())))
              for k in surfaced_paths}
    by_day_domain = {k: (len(surfaced_by_domain[k]),
                         len(acted_by_domain.get(k, set())))
                     for k in surfaced_by_domain}
    by_day_agent = {k: (len(surfaced_by_agent[k]),
                        len(acted_by_agent.get(k, set())))
                    for k in surfaced_by_agent}
    return by_day, by_day_domain, by_day_agent


# ─── Brain.db aggregator (M1 universal protocol) ─────────────────────────


# Default brain.db path. Override via DIGITAL_ME_BRAIN_DB env or --brain-db flag.
DEFAULT_BRAIN_DB = ".openclaw/data/brain.db"


def aggregate_from_brain(
    brain_db_path: Path, start: date, end: date,
) -> tuple[
    dict[tuple[str, str], tuple[int, int]],
    dict[tuple[str, str, str], tuple[int, int]],
    dict[tuple[str, str, str], tuple[int, int]],
]:
    """Aggregate the same way as `aggregate()`, but from brain.db.m1_events.

    Reads `knowledge_surfaced` + `assistant_ack` events in the time window
    and unions their `entries[].path` lists per (date, tree, [domain|agent]).
    Returns three maps matching the JSONL aggregator's contract:

      by_day[(date, tree)] = (surfaced_unique, acted_unique)
      by_day_domain[(date, tree, domain)] = (surfaced, acted)
      by_day_agent[(date, tree, agent_id)] = (surfaced, acted)

    Missing brain.db → all empty maps. Agent_id comes from `m1_events.runtime`
    (claude-code, hermes, openclaw — same keys as HOOK_LOGS).

    See wiki: infrastructure/m1-universal-event-protocol.md
    """
    if not brain_db_path.exists():
        return {}, {}, {}

    start_ms = int(
        datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).timestamp() * 1000
    )
    end_ms = int(
        datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc).timestamp() * 1000
    )

    surfaced_paths: dict[tuple[str, str], set[str]] = defaultdict(set)
    acted_paths: dict[tuple[str, str], set[str]] = defaultdict(set)
    surfaced_by_domain: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    acted_by_domain: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    surfaced_by_agent: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    acted_by_agent: dict[tuple[str, str, str], set[str]] = defaultdict(set)

    conn = sqlite3.connect(str(brain_db_path))
    try:
        cursor = conn.execute(
            """
            SELECT t, runtime, event_type, entries_json
              FROM m1_events
             WHERE event_type IN ('knowledge_surfaced', 'assistant_ack')
               AND t >= ? AND t < ?
            """,
            (start_ms, end_ms),
        )
        rows = cursor.fetchall()
    except sqlite3.OperationalError:
        # m1_events table doesn't exist yet — brain hasn't migrated.
        return {}, {}, {}
    finally:
        conn.close()

    for t_ms, runtime, event_type, entries_json in rows:
        d_iso = datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).date().isoformat()
        try:
            entries = json.loads(entries_json or "[]")
        except json.JSONDecodeError:
            continue
        if not isinstance(entries, list):
            continue
        for e in entries:
            if not isinstance(e, dict):
                continue
            path = e.get("path") or ""
            if not isinstance(path, str) or not path:
                continue
            cls = _classify_path(path)
            if cls is None:
                continue
            tree, domain = cls
            if event_type == "knowledge_surfaced":
                surfaced_paths[(d_iso, tree)].add(path)
                surfaced_by_domain[(d_iso, tree, domain)].add(path)
                surfaced_by_agent[(d_iso, tree, runtime)].add(path)
            elif event_type == "assistant_ack":
                # Acted is the subset of immediately-preceding surfaced;
                # record on both sides (matches the JSONL aggregator's
                # logical superset semantic).
                acted_paths[(d_iso, tree)].add(path)
                acted_by_domain[(d_iso, tree, domain)].add(path)
                acted_by_agent[(d_iso, tree, runtime)].add(path)
                surfaced_paths[(d_iso, tree)].add(path)
                surfaced_by_domain[(d_iso, tree, domain)].add(path)
                surfaced_by_agent[(d_iso, tree, runtime)].add(path)

    by_day = {k: (len(surfaced_paths[k]), len(acted_paths.get(k, set())))
              for k in surfaced_paths}
    by_day_domain = {k: (len(surfaced_by_domain[k]), len(acted_by_domain.get(k, set())))
                     for k in surfaced_by_domain}
    by_day_agent = {k: (len(surfaced_by_agent[k]), len(acted_by_agent.get(k, set())))
                    for k in surfaced_by_agent}
    return by_day, by_day_domain, by_day_agent


# ─── WAL aggregator (raw event JSONL — per-turn, same shape as brain) ────


# Per-runtime raw event WAL paths. Emitted by each runtime's M1 emitter
# as canonical events (knowledge_surfaced + assistant_ack), same shape
# as brain.db.m1_events rows. Reading from these here means the
# JSONL-side aggregator produces IDENTICAL numbers to the brain-side
# aggregator — closing the calibration gap the legacy session-aggregate
# log introduced (per-session boundary vs per-turn boundary, see wiki:
# evaluation/metric-integrity-and-calibration-protocol.md).
#
# Daemon-style runtimes (hermes Discord, openclaw cron) emit per-turn
# regardless of whether their session_end ever fires — so these WALs
# stay complete where the legacy session-aggregate log was structurally
# incomplete (see infrastructure/hermes-runtime-onsessionend-hook-limitations.md).
M1_EVENT_WALS: dict[str, str] = {
    "claude-code": ".openclaw/data/m1_events_claude_code.jsonl",
    "openclaw":    ".openclaw/data/m1_events_openclaw.jsonl",
    "hermes":      ".openclaw/data/m1_events_hermes.jsonl",
}


def aggregate_from_wal(
    home: Path, start: date, end: date,
) -> tuple[
    dict[tuple[str, str], tuple[int, int]],
    dict[tuple[str, str, str], tuple[int, int]],
    dict[tuple[str, str, str], tuple[int, int]],
]:
    """Aggregate from the per-runtime raw event WALs (the canonical
    per-turn event stream that's also written to brain.db.m1_events).

    Returns the SAME three maps as `aggregate()` and `aggregate_from_brain()`,
    so all three are mergeable through `merge_count_maps`.

    This is the durable local copy of brain's m1_events — same shape,
    same semantics, same numbers. Reading from it makes the JSONL-side
    aggregator produce identical counts to the brain-side aggregator,
    eliminating the silent-redefinition gap the legacy session-aggregate
    log introduced.
    """
    surfaced_paths: dict[tuple[str, str], set[str]] = defaultdict(set)
    acted_paths: dict[tuple[str, str], set[str]] = defaultdict(set)
    surfaced_by_domain: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    acted_by_domain: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    surfaced_by_agent: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    acted_by_agent: dict[tuple[str, str, str], set[str]] = defaultdict(set)

    for agent_id, rel in M1_EVENT_WALS.items():
        log = home / rel
        if not log.exists():
            continue
        with log.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                event_type = ev.get("event_type")
                if event_type not in ("knowledge_surfaced", "assistant_ack"):
                    continue
                t_ms = ev.get("t")
                if not isinstance(t_ms, (int, float)):
                    continue
                d_iso = datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).date().isoformat()
                d = datetime.strptime(d_iso, "%Y-%m-%d").date()
                if d < start or d > end:
                    continue
                entries = ev.get("entries") or []
                if not isinstance(entries, list):
                    continue
                for e in entries:
                    if not isinstance(e, dict):
                        continue
                    p = e.get("path") or ""
                    if not isinstance(p, str) or not p:
                        continue
                    cls = _classify_path(p)
                    if cls is None:
                        continue
                    tree, domain = cls
                    if event_type == "knowledge_surfaced":
                        surfaced_paths[(d_iso, tree)].add(p)
                        surfaced_by_domain[(d_iso, tree, domain)].add(p)
                        surfaced_by_agent[(d_iso, tree, agent_id)].add(p)
                    elif event_type == "assistant_ack":
                        acted_paths[(d_iso, tree)].add(p)
                        acted_by_domain[(d_iso, tree, domain)].add(p)
                        acted_by_agent[(d_iso, tree, agent_id)].add(p)
                        # acted IS surfaced (logical superset)
                        surfaced_paths[(d_iso, tree)].add(p)
                        surfaced_by_domain[(d_iso, tree, domain)].add(p)
                        surfaced_by_agent[(d_iso, tree, agent_id)].add(p)

    by_day = {k: (len(surfaced_paths[k]), len(acted_paths.get(k, set())))
              for k in surfaced_paths}
    by_day_domain = {k: (len(surfaced_by_domain[k]), len(acted_by_domain.get(k, set())))
                     for k in surfaced_by_domain}
    by_day_agent = {k: (len(surfaced_by_agent[k]), len(acted_by_agent.get(k, set())))
                    for k in surfaced_by_agent}
    return by_day, by_day_domain, by_day_agent


def merge_count_maps(*maps: dict) -> dict:
    """Take per-key max() of (surfaced, acted) tuples across multiple
    aggregators. Brain typically wins for days it has data; JSONL fills
    the gap for historical days where brain is empty.

    Why max() and not sum(): both aggregators compute the SAME quantity
    (the daily union of paths) — they just measure it from different
    sources. Summing would double-count overlap. Taking max() lets each
    source contribute on days where it has more data than the other,
    while overlap (same paths in both) naturally collapses to the same
    number. The two values are within 1-2 of each other on overlap days
    in practice.
    """
    out: dict = {}
    for m in maps:
        for k, v in m.items():
            if k not in out:
                out[k] = v
            else:
                out[k] = (max(out[k][0], v[0]), max(out[k][1], v[1]))
    return out


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="dashboard-intake-derive-application-rate",
        description=__doc__.split("\n", 1)[0],
    )
    p.add_argument("--days", type=int, default=60)
    p.add_argument("--db", type=Path, default=None)
    p.add_argument("--home", type=Path, default=None)
    p.add_argument(
        "--source", choices=["brain", "wal", "legacy", "jsonl", "all", "both"],
        default="all",
        help=(
            "Which aggregator(s) to run. Default 'all' (brain ∪ wal ∪ legacy). "
            "'brain' = brain.db.m1_events only. "
            "'wal'   = per-runtime raw event WALs only (same shape as brain). "
            "'legacy' = legacy session-aggregate application_rate_*.log only. "
            "'jsonl' = alias for both WAL and legacy. "
            "'both'  = legacy backward-compat alias for 'all'."
        ),
    )
    p.add_argument(
        "--brain-db", type=Path, default=None,
        help=f"Path to brain.db (default: ~/{DEFAULT_BRAIN_DB})",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    home = args.home if args.home else Path.home()
    today = date.today()
    start = today - timedelta(days=args.days - 1)
    db_file = args.db if args.db else db_path()
    brain_db = args.brain_db if args.brain_db else (home / DEFAULT_BRAIN_DB)

    # Resolve which sources to run for this invocation.
    src = args.source
    run_brain  = src in ("brain", "all", "both")
    run_wal    = src in ("wal", "jsonl", "all", "both")
    run_legacy = src in ("legacy", "jsonl", "all", "both")

    by_day_legacy: dict = {}
    by_dom_legacy: dict = {}
    by_agent_legacy: dict = {}
    by_day_wal: dict = {}
    by_dom_wal: dict = {}
    by_agent_wal: dict = {}
    by_day_brain: dict = {}
    by_dom_brain: dict = {}
    by_agent_brain: dict = {}

    if run_legacy:
        by_day_legacy, by_dom_legacy, by_agent_legacy = aggregate(home, start, today)
    if run_wal:
        by_day_wal, by_dom_wal, by_agent_wal = aggregate_from_wal(home, start, today)
    if run_brain:
        by_day_brain, by_dom_brain, by_agent_brain = aggregate_from_brain(
            brain_db, start, today,
        )

    by_day  = merge_count_maps(by_day_legacy,  by_day_wal,  by_day_brain)
    by_dom  = merge_count_maps(by_dom_legacy,  by_dom_wal,  by_dom_brain)
    by_agent = merge_count_maps(by_agent_legacy, by_agent_wal, by_agent_brain)

    with connect(db_file) as conn:
        for (d, tree), (surf, acted) in sorted(by_day.items()):
            upsert_application_rate(
                conn, date=d, tree=tree,
                surfaced_unique=surf, acted_unique=acted,
            )
        for (d, tree, domain), (surf, acted) in sorted(by_dom.items()):
            upsert_application_rate_by_domain(
                conn, date=d, tree=tree, domain=domain,
                surfaced_unique=surf, acted_unique=acted,
            )
        for (d, tree, agent), (surf, acted) in sorted(by_agent.items()):
            upsert_application_rate_by_agent(
                conn, date=d, tree=tree, agent_id=agent,
                surfaced_unique=surf, acted_unique=acted,
            )

    print(
        f"derive-application-rate [source={args.source}]: "
        f"{len(by_day)} top-line, {len(by_dom)} by-domain, "
        f"{len(by_agent)} by-agent rows upserted to {db_file} "
        f"(legacy={len(by_day_legacy)} wal={len(by_day_wal)} "
        f"brain={len(by_day_brain)} merged={len(by_day)})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
