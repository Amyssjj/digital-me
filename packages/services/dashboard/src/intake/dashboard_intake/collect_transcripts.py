"""Step 1/4: collect_transcripts — runtime session counts → daa table.

Walks each runtime's transcript directory and counts unique sessions per
agent_id per day. Idempotent: re-running on the same day overwrites the
row for that (agent_id, date).

Transcript layouts (one entry per runtime — match
packages/cli/src/setup.ts → TRANSCRIPT_SOURCES):

  claude-code: ~/.claude/projects/<project-slug>/*.jsonl  (one file per session)
  codex:       ~/.codex/sessions/<YYYY>/<MM>/<DD>/*.jsonl
  hermes:      ~/.hermes/sessions/<...>  (one dir per session)
  openclaw:    ~/.openclaw/sessions/<...> (one dir per session)

Each runtime's "session" surface differs, but the contract here is just
"give me a count of distinct sessions touched today, by agent_id." A
session counts toward a day if its mtime falls within that day in the
local timezone.

Usage:
  python -m dashboard_intake.collect_transcripts [--date YYYY-MM-DD]
                                                  [--days N]
                                                  [--db PATH]
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable

from . import db_path
from .db import connect, upsert_daa


# Where each agent's transcripts live. Path patterns are globs interpreted
# against $HOME. Multiple patterns per agent are allowed (some runtimes
# nest by date, some don't).
#
# openclaw note: sessions live per-subagent under
# `.openclaw/agents/<subagent>/sessions/<session-id>/` (NOT at
# `.openclaw/sessions/`). We count each subagent session as one
# "openclaw" session — rolling up across coo/youtube/writer/etc. into a
# single runtime bucket. Future enhancement: split openclaw subagents
# into distinct bars (matches the legacy mission-control palette of
# COO/CTO/YouTube/Writer/CPO/Podcast).
TRANSCRIPT_PATTERNS: dict[str, tuple[str, ...]] = {
    "claude-code": (".claude/projects/*/*.jsonl",),
    "codex":       (".codex/sessions/**/*.jsonl",),
    "hermes":      (".hermes/sessions/*",),
    "openclaw":    (".openclaw/agents/*/sessions/*",),
}


def _iter_session_artifacts(agent_id: str, home: Path) -> Iterable[Path]:
    """Yield each session artifact (file or top-level dir) for one agent."""
    for pattern in TRANSCRIPT_PATTERNS.get(agent_id, ()):
        # Use Path.glob — supports ** when separated. Note: globbing from
        # $HOME so patterns like '.codex/sessions/**/*.jsonl' work.
        yield from home.glob(pattern)


def _session_date(p: Path) -> date | None:
    """Determine which calendar date a session artifact 'belongs to'.

    Uses mtime in the local timezone. Returns None if the file is gone
    between glob and stat (rare race)."""
    try:
        ts = p.stat().st_mtime
        return datetime.fromtimestamp(ts).date()
    except OSError:
        return None


def collect_for_window(
    home: Path, start: date, end: date,
) -> dict[tuple[str, str], int]:
    """Return {(agent_id, iso_date): session_count} for the window [start, end].

    Pure: takes a $HOME, returns counts. Caller writes to DB."""
    counts: dict[tuple[str, str], int] = defaultdict(int)
    for agent_id in TRANSCRIPT_PATTERNS:
        for artifact in _iter_session_artifacts(agent_id, home):
            d = _session_date(artifact)
            if d is None:
                continue
            if d < start or d > end:
                continue
            counts[(agent_id, d.isoformat())] += 1
    return counts


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="dashboard-intake-collect-transcripts",
        description=__doc__.split("\n", 1)[0],
    )
    p.add_argument(
        "--date",
        type=str,
        default=None,
        help="Target date YYYY-MM-DD. Default: today.",
    )
    p.add_argument(
        "--days",
        type=int,
        default=1,
        help="How many days back from --date to include. Default: 1.",
    )
    p.add_argument(
        "--db",
        type=Path,
        default=None,
        help="Override DB path (else $DASHBOARD_DB or canonical install path).",
    )
    p.add_argument(
        "--home",
        type=Path,
        default=None,
        help="Override $HOME for testing. Default: real $HOME.",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    home = args.home if args.home else Path.home()
    end = (
        datetime.strptime(args.date, "%Y-%m-%d").date()
        if args.date else date.today()
    )
    start = end - timedelta(days=max(args.days - 1, 0))
    db_file = args.db if args.db else db_path()

    counts = collect_for_window(home, start, end)

    written = 0
    with connect(db_file) as conn:
        for (agent_id, iso), n in sorted(counts.items()):
            upsert_daa(conn, agent_id=agent_id, date=iso, sessions=n)
            written += 1
        # Make sure every agent has SOME row for the window — emit zeros
        # for days/agents with no sessions so the dashboard chart isn't
        # gappy.
        cur = start
        while cur <= end:
            for agent_id in TRANSCRIPT_PATTERNS:
                if (agent_id, cur.isoformat()) not in counts:
                    upsert_daa(conn, agent_id=agent_id, date=cur.isoformat(), sessions=0)
                    written += 1
            cur += timedelta(days=1)

    print(
        f"collect-transcripts: window {start}..{end} -> "
        f"{written} daa upserts to {db_file}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
