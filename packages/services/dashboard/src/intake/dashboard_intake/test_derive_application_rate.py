"""Tests for derive_application_rate's dual-source aggregation.

Two aggregators:
  - aggregate()              — legacy JSONL union (existing).
  - aggregate_from_brain()   — new brain.db.m1_events reader.

Plus merge_count_maps() that takes the per-key max across both.

These tests focus on the NEW brain-side path and the merge logic.
The JSONL aggregator is exercised end-to-end by the other tests in the
intake package; we only smoke-test it here for the merge semantics.

Run via:
  python3 -c "
  import sys, importlib, tempfile
  from pathlib import Path
  sys.path.insert(0, '.')
  mod = importlib.import_module('dashboard_intake.test_derive_application_rate')
  for name in dir(mod):
      if not name.startswith('test_'): continue
      fn = getattr(mod, name)
      if fn.__code__.co_argcount == 1:
          with tempfile.TemporaryDirectory() as td: fn(Path(td))
      else: fn()
      print('  OK', name)
  "
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path

from dashboard_intake.derive_application_rate import (
    aggregate_from_brain,
    aggregate_from_wal,
    merge_count_maps,
    _classify_path,
    M1_EVENT_WALS,
)


# ── Helpers ─────────────────────────────────────────────────────────────


def _epoch_ms(d: date) -> int:
    return int(
        datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc).timestamp() * 1000
    ) + 60_000  # 1 minute past midnight UTC


def _make_brain_db(tmp_path: Path, events: list[dict]) -> Path:
    """Construct a m1_events-only SQLite with the supplied events."""
    db_path = tmp_path / "brain.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE m1_events (
            event_id      TEXT PRIMARY KEY,
            schema_version INT NOT NULL DEFAULT 1,
            metric        TEXT NOT NULL DEFAULT 'm1_application_rate',
            runtime       TEXT NOT NULL,
            agent_id      TEXT NOT NULL,
            session_id    TEXT NOT NULL,
            turn_id       TEXT,
            event_type    TEXT NOT NULL,
            entries_json  TEXT NOT NULL DEFAULT '[]',
            ack_signal    TEXT,
            extra_json    TEXT NOT NULL DEFAULT '{}',
            t             INTEGER NOT NULL
        );
        """
    )
    for i, ev in enumerate(events):
        conn.execute(
            """INSERT INTO m1_events
                 (event_id, runtime, agent_id, session_id, turn_id, event_type,
                  entries_json, ack_signal, t)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                ev.get("event_id", f"ev{i}"),
                ev["runtime"],
                ev.get("agent_id", ev["runtime"]),
                ev.get("session_id", f"sess{i}"),
                ev.get("turn_id", str(i)),
                ev["event_type"],
                json.dumps(ev.get("entries", [])),
                ev.get("ack_signal"),
                ev["t"],
            ),
        )
    conn.commit()
    conn.close()
    return db_path


# ── aggregate_from_brain ────────────────────────────────────────────────


def test_aggregate_from_brain_returns_empty_when_db_missing(tmp_path: Path):
    """Missing brain.db → all three maps are empty (graceful no-op)."""
    by_day, by_dom, by_agent = aggregate_from_brain(
        tmp_path / "does_not_exist.db",
        start=date(2026, 5, 27),
        end=date(2026, 5, 27),
    )
    assert by_day == {}
    assert by_dom == {}
    assert by_agent == {}


def test_aggregate_from_brain_returns_empty_when_table_missing(tmp_path: Path):
    """DB exists but m1_events table missing (e.g. brain not migrated yet)
    → graceful empty maps, no exception."""
    db_path = tmp_path / "brain.db"
    sqlite3.connect(str(db_path)).close()  # empty DB
    by_day, _, _ = aggregate_from_brain(db_path, date(2026, 5, 27), date(2026, 5, 27))
    assert by_day == {}


def test_knowledge_surfaced_event_populates_surfaced_only(tmp_path: Path):
    """knowledge_surfaced event paths go to surfaced sets only, not acted."""
    db = _make_brain_db(
        tmp_path,
        [{
            "runtime": "claude-code",
            "event_type": "knowledge_surfaced",
            "entries": [{"path": "wiki/infrastructure/foo.md"}],
            "t": _epoch_ms(date(2026, 5, 27)),
        }],
    )
    by_day, by_dom, by_agent = aggregate_from_brain(
        db, date(2026, 5, 27), date(2026, 5, 27),
    )
    assert by_day[("2026-05-27", "wiki")] == (1, 0)
    assert by_dom[("2026-05-27", "wiki", "infrastructure")] == (1, 0)
    assert by_agent[("2026-05-27", "wiki", "claude-code")] == (1, 0)


def test_assistant_ack_populates_both_acted_and_surfaced(tmp_path: Path):
    """assistant_ack entries are the acted subset — they go to acted AND
    surfaced (acted IS surfaced, by definition).
    """
    db = _make_brain_db(
        tmp_path,
        [{
            "runtime": "hermes",
            "event_type": "assistant_ack",
            "entries": [{"path": "wiki/infrastructure/foo.md"}],
            "t": _epoch_ms(date(2026, 5, 27)),
        }],
    )
    by_day, _, by_agent = aggregate_from_brain(
        db, date(2026, 5, 27), date(2026, 5, 27),
    )
    assert by_day[("2026-05-27", "wiki")] == (1, 1)  # surfaced=1, acted=1
    assert by_agent[("2026-05-27", "wiki", "hermes")] == (1, 1)


def test_surfaced_acted_union_per_day(tmp_path: Path):
    """Multiple events on the same day union their entry paths."""
    t = _epoch_ms(date(2026, 5, 27))
    db = _make_brain_db(
        tmp_path,
        [
            {"runtime": "claude-code", "event_type": "knowledge_surfaced",
             "entries": [{"path": "wiki/infra/a.md"}, {"path": "wiki/infra/b.md"}],
             "t": t},
            {"runtime": "claude-code", "event_type": "knowledge_surfaced",
             "entries": [{"path": "wiki/infra/b.md"}, {"path": "wiki/infra/c.md"}],
             "t": t + 1000},
            {"runtime": "claude-code", "event_type": "assistant_ack",
             "entries": [{"path": "wiki/infra/a.md"}],
             "t": t + 2000},
        ],
    )
    by_day, _, _ = aggregate_from_brain(
        db, date(2026, 5, 27), date(2026, 5, 27),
    )
    # a, b, c all surfaced; a is acted.
    assert by_day[("2026-05-27", "wiki")] == (3, 1)


def test_partitions_by_runtime(tmp_path: Path):
    """Different runtimes partition the by_agent map cleanly."""
    t = _epoch_ms(date(2026, 5, 27))
    db = _make_brain_db(
        tmp_path,
        [
            {"runtime": "claude-code", "event_type": "knowledge_surfaced",
             "entries": [{"path": "wiki/x/a.md"}], "t": t},
            {"runtime": "hermes", "event_type": "knowledge_surfaced",
             "entries": [{"path": "wiki/x/b.md"}], "t": t},
            {"runtime": "openclaw", "event_type": "assistant_ack",
             "entries": [{"path": "wiki/x/c.md"}], "t": t},
        ],
    )
    _, _, by_agent = aggregate_from_brain(
        db, date(2026, 5, 27), date(2026, 5, 27),
    )
    assert by_agent[("2026-05-27", "wiki", "claude-code")] == (1, 0)
    assert by_agent[("2026-05-27", "wiki", "hermes")] == (1, 0)
    assert by_agent[("2026-05-27", "wiki", "openclaw")] == (1, 1)


def test_filters_memory_paths(tmp_path: Path):
    """memory/* paths are per-agent state, not corpus — must be dropped."""
    t = _epoch_ms(date(2026, 5, 27))
    db = _make_brain_db(
        tmp_path,
        [{"runtime": "claude-code", "event_type": "knowledge_surfaced",
          "entries": [
              {"path": "wiki/infra/keep.md"},
              {"path": "memory/2026-05-27.md"},  # filtered
          ], "t": t}],
    )
    by_day, _, _ = aggregate_from_brain(
        db, date(2026, 5, 27), date(2026, 5, 27),
    )
    assert by_day[("2026-05-27", "wiki")] == (1, 0)


def test_time_window_filtering(tmp_path: Path):
    """Events outside [start, end] are excluded."""
    db = _make_brain_db(
        tmp_path,
        [
            {"runtime": "hermes", "event_type": "knowledge_surfaced",
             "entries": [{"path": "wiki/x/a.md"}], "t": _epoch_ms(date(2026, 5, 25))},
            {"runtime": "hermes", "event_type": "knowledge_surfaced",
             "entries": [{"path": "wiki/x/b.md"}], "t": _epoch_ms(date(2026, 5, 27))},
        ],
    )
    by_day, _, _ = aggregate_from_brain(
        db, start=date(2026, 5, 27), end=date(2026, 5, 27),
    )
    # Only the 5-27 event made it in
    assert by_day.get(("2026-05-25", "wiki")) is None
    assert by_day[("2026-05-27", "wiki")] == (1, 0)


def test_distinguishes_wiki_vs_tastes_trees(tmp_path: Path):
    """wiki/* and tastes/* must go to separate (date, tree) keys."""
    t = _epoch_ms(date(2026, 5, 27))
    db = _make_brain_db(
        tmp_path,
        [{"runtime": "claude-code", "event_type": "knowledge_surfaced",
          "entries": [
              {"path": "wiki/foo/x.md"},
              {"path": "tastes/foo/y.md"},
          ], "t": t}],
    )
    by_day, _, _ = aggregate_from_brain(
        db, date(2026, 5, 27), date(2026, 5, 27),
    )
    assert by_day[("2026-05-27", "wiki")] == (1, 0)
    assert by_day[("2026-05-27", "tastes")] == (1, 0)


# ── _classify_path (calibration: strip brain's cwd-relative prefix) ─────


def test_classify_strips_cwd_relative_wiki_prefix():
    """Brain encodes paths like '../../../../../home/test/digital-me/wiki/foo/bar.md'.
    Without the strip, this falls into the bare-path branch and gets
    bucketed under domain '..' — a phantom row in the by-domain chart."""
    raw = "../../../../../home/test/digital-me/wiki/infrastructure/foo.md"
    assert _classify_path(raw) == ("wiki", "infrastructure")


def test_classify_strips_cwd_relative_tastes_prefix():
    raw = "../../../../../home/test/digital-me/tastes/storytelling/x.md"
    assert _classify_path(raw) == ("tastes", "storytelling")


def test_classify_handles_canonical_wiki_prefix():
    assert _classify_path("wiki/infrastructure/foo.md") == ("wiki", "infrastructure")


def test_classify_handles_bare_path():
    """Pre-§A back-compat: 'infrastructure/foo.md' (no prefix) → wiki tree."""
    assert _classify_path("infrastructure/foo.md") == ("wiki", "infrastructure")


def test_classify_drops_memory_paths():
    assert _classify_path("memory/2026-05-27.md") is None


def test_classify_drops_absolute_paths():
    assert _classify_path("/etc/passwd") is None


def test_classify_drops_dot_and_double_dot_in_bare_branch():
    """An edge case the old code hit: '../foo.md' would return ('wiki', '..').
    With the prefix-strip + extended dot/dotdot guard, both are now dropped."""
    assert _classify_path("../foo.md") is None
    assert _classify_path("./foo.md") is None


# ── aggregate_from_wal ──────────────────────────────────────────────────


def _wal_path_for_test(home: Path, runtime: str) -> Path:
    rel = M1_EVENT_WALS[runtime]
    p = home / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _write_wal(path: Path, events: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


def test_wal_aggregator_returns_empty_when_no_files(tmp_path: Path):
    """No WAL files at all → all three maps are empty (graceful no-op)."""
    by_day, by_dom, by_agent = aggregate_from_wal(
        tmp_path, date(2026, 5, 27), date(2026, 5, 27),
    )
    assert by_day == {}
    assert by_dom == {}
    assert by_agent == {}


def test_wal_aggregator_reads_knowledge_surfaced(tmp_path: Path):
    wal = _wal_path_for_test(tmp_path, "hermes")
    _write_wal(wal, [{
        "event_type": "knowledge_surfaced",
        "entries": [{"path": "wiki/infrastructure/foo.md"}],
        "t": _epoch_ms(date(2026, 5, 27)),
    }])
    by_day, by_dom, by_agent = aggregate_from_wal(
        tmp_path, date(2026, 5, 27), date(2026, 5, 27),
    )
    assert by_day[("2026-05-27", "wiki")] == (1, 0)
    assert by_dom[("2026-05-27", "wiki", "infrastructure")] == (1, 0)
    assert by_agent[("2026-05-27", "wiki", "hermes")] == (1, 0)


def test_wal_aggregator_reads_assistant_ack_as_both_surfaced_and_acted(tmp_path: Path):
    wal = _wal_path_for_test(tmp_path, "claude-code")
    _write_wal(wal, [{
        "event_type": "assistant_ack",
        "entries": [{"path": "wiki/infra/foo.md"}],
        "t": _epoch_ms(date(2026, 5, 27)),
    }])
    by_day, _, by_agent = aggregate_from_wal(
        tmp_path, date(2026, 5, 27), date(2026, 5, 27),
    )
    # Acted IS surfaced — both counts incremented.
    assert by_day[("2026-05-27", "wiki")] == (1, 1)
    assert by_agent[("2026-05-27", "wiki", "claude-code")] == (1, 1)


def test_wal_aggregator_partitions_by_runtime(tmp_path: Path):
    """Each per-runtime WAL contributes to its own agent_id bucket."""
    t = _epoch_ms(date(2026, 5, 27))
    _write_wal(_wal_path_for_test(tmp_path, "hermes"), [
        {"event_type": "knowledge_surfaced",
         "entries": [{"path": "wiki/x/a.md"}], "t": t},
    ])
    _write_wal(_wal_path_for_test(tmp_path, "openclaw"), [
        {"event_type": "knowledge_surfaced",
         "entries": [{"path": "wiki/x/b.md"}], "t": t},
    ])
    _, _, by_agent = aggregate_from_wal(
        tmp_path, date(2026, 5, 27), date(2026, 5, 27),
    )
    assert by_agent[("2026-05-27", "wiki", "hermes")] == (1, 0)
    assert by_agent[("2026-05-27", "wiki", "openclaw")] == (1, 0)


def test_wal_aggregator_filters_time_window(tmp_path: Path):
    wal = _wal_path_for_test(tmp_path, "hermes")
    _write_wal(wal, [
        {"event_type": "knowledge_surfaced",
         "entries": [{"path": "wiki/x/old.md"}],
         "t": _epoch_ms(date(2026, 5, 20))},
        {"event_type": "knowledge_surfaced",
         "entries": [{"path": "wiki/x/new.md"}],
         "t": _epoch_ms(date(2026, 5, 27))},
    ])
    by_day, _, _ = aggregate_from_wal(
        tmp_path, date(2026, 5, 27), date(2026, 5, 27),
    )
    # Only the in-window event made it
    assert by_day.get(("2026-05-20", "wiki")) is None
    assert by_day[("2026-05-27", "wiki")] == (1, 0)


def test_wal_aggregator_strips_brain_cwd_relative_paths(tmp_path: Path):
    """The big calibration fix: WAL paths come from brain via memory_search
    in cwd-relative form ('../../../...../wiki/<domain>/...md'). The
    classifier must strip the prefix; no phantom '..' domain row."""
    wal = _wal_path_for_test(tmp_path, "openclaw")
    _write_wal(wal, [{
        "event_type": "knowledge_surfaced",
        "entries": [{"path": "../../../../../home/test/digital-me/wiki/infrastructure/m1.md"}],
        "t": _epoch_ms(date(2026, 5, 27)),
    }])
    _, by_dom, _ = aggregate_from_wal(
        tmp_path, date(2026, 5, 27), date(2026, 5, 27),
    )
    assert ("2026-05-27", "wiki", "infrastructure") in by_dom
    assert ("2026-05-27", "wiki", "..") not in by_dom  # phantom row gone


def test_wal_aggregator_skips_bad_json_lines(tmp_path: Path):
    wal = _wal_path_for_test(tmp_path, "hermes")
    with wal.open("w") as f:
        f.write("not json\n")
        f.write(json.dumps({
            "event_type": "knowledge_surfaced",
            "entries": [{"path": "wiki/x/a.md"}],
            "t": _epoch_ms(date(2026, 5, 27)),
        }) + "\n")
        f.write("{broken json\n")
    by_day, _, _ = aggregate_from_wal(
        tmp_path, date(2026, 5, 27), date(2026, 5, 27),
    )
    # 1 valid event made it in; 2 bad lines silently skipped
    assert by_day[("2026-05-27", "wiki")] == (1, 0)


# ── merge_count_maps ────────────────────────────────────────────────────


def test_merge_takes_max_per_key():
    """When both sources have the same key, take max() of both counts.
    Avoids double-counting on overlap, and lets each source contribute on
    days where it has more data."""
    jsonl = {("2026-05-27", "wiki"): (10, 2)}
    brain = {("2026-05-27", "wiki"): (12, 3)}
    merged = merge_count_maps(jsonl, brain)
    assert merged == {("2026-05-27", "wiki"): (12, 3)}


def test_merge_unions_disjoint_keys():
    """JSONL-only keys (historical days) and brain-only keys (recent
    days where JSONL hasn't aggregated yet) BOTH show up in the merge."""
    jsonl = {("2026-05-25", "wiki"): (5, 1)}  # historical
    brain = {("2026-05-27", "wiki"): (3, 1)}  # recent
    merged = merge_count_maps(jsonl, brain)
    assert merged[("2026-05-25", "wiki")] == (5, 1)
    assert merged[("2026-05-27", "wiki")] == (3, 1)


def test_merge_handles_empty_input():
    """Merging with an empty map is a no-op for non-empty sources."""
    jsonl = {("2026-05-27", "wiki"): (5, 2)}
    assert merge_count_maps(jsonl, {}) == jsonl
    assert merge_count_maps({}, jsonl) == jsonl
    assert merge_count_maps({}, {}) == {}


def test_merge_max_protects_against_partial_undercount():
    """Cutover scenario: brain has more surfaced (because it captured a
    new event), JSONL has fewer surfaced but more acted (legacy
    aggregator gave fewer-but-fully-counted). max() per dimension
    preserves both source strengths."""
    jsonl = {("2026-05-27", "wiki"): (3, 2)}   # better acted detection
    brain = {("2026-05-27", "wiki"): (5, 1)}   # better surfaced coverage
    merged = merge_count_maps(jsonl, brain)
    assert merged == {("2026-05-27", "wiki"): (5, 2)}  # max of each dimension
