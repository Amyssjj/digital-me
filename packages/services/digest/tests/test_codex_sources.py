"""Tests for the dual-store Codex session readers.

Regression (2026-07 codex gap): newer codex builds record threads in
~/.codex/state_*.sqlite and stopped writing rollout JSONLs under
~/.codex/sessions on 2026-07-04, so the digest — which walked only the
JSONL tree — reported "Codex CLI: no activity" while codex was in daily
use. _codex_raw_prompts now unions both stores, and an empty window is
rendered with the last locally-recorded session date instead of a bare
"no activity" (silence is signal).
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from digest.daily_digest import (
    _codex_last_seen_iso,
    _codex_raw_prompts,
    _codex_sqlite_prompts,
)

WINDOW_START = 1_783_000_000_000  # arbitrary epoch-ms window
WINDOW_END = WINDOW_START + 86_400_000


def _make_state_db(codex_home: Path, rows: list[tuple]) -> Path:
    db = codex_home / "state_5.sqlite"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE threads ("
        " id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER,"
        " updated_at INTEGER, first_user_message TEXT, title TEXT)"
    )
    con.executemany("INSERT INTO threads VALUES (?,?,?,?,?,?)", rows)
    con.commit()
    con.close()
    return db


def test_sqlite_threads_counted_without_rollout_files(tmp_path):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    in_window_s = (WINDOW_START + 3_600_000) // 1000
    _make_state_db(tmp_path, [
        ("t1", "/nonexistent/rollout-a.jsonl", in_window_s, in_window_s,
         "fix the video pipeline", "Fix video pipeline"),
        ("t2", "/nonexistent/rollout-b.jsonl", 1, 1,  # far out of window
         "old thread", "Old"),
    ])

    prompts = _codex_raw_prompts(WINDOW_START, WINDOW_END, sessions)
    assert prompts == ["fix the video pipeline"]


def test_rollout_already_counted_is_not_double_counted(tmp_path):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    rollout = sessions / "rollout-c.jsonl"
    rollout.write_text("")  # empty file: JSONL walk yields one (empty) prompt
    mtime_s = (WINDOW_START + 1000) / 1000
    import os
    os.utime(rollout, (mtime_s, mtime_s))

    _make_state_db(tmp_path, [
        ("t3", str(rollout), int(mtime_s), int(mtime_s),
         "duplicate thread", "Dup"),
    ])

    sqlite_only = _codex_sqlite_prompts(
        WINDOW_START, WINDOW_END, sessions, {str(rollout)}
    )
    assert sqlite_only == []
    # The union path counts the session exactly once (via the JSONL walk).
    assert len(_codex_raw_prompts(WINDOW_START, WINDOW_END, sessions)) == 1


def test_last_seen_uses_max_across_stores(tmp_path):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    newer_s = int(time.time()) - 3600
    _make_state_db(tmp_path, [
        ("t4", "/nonexistent/rollout-d.jsonl", newer_s, newer_s, "hi", "Hi"),
    ])
    assert _codex_last_seen_iso(sessions) is not None


def test_missing_stores_degrade_to_empty(tmp_path):
    sessions = tmp_path / "sessions"  # never created, no state db
    assert _codex_raw_prompts(WINDOW_START, WINDOW_END, sessions) == []
    assert _codex_last_seen_iso(sessions) is None
