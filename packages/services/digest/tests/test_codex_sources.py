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
    _codex_sqlite_rows,
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


def _write_rollout(sessions: Path, name: str, body: str) -> Path:
    import os
    rollout = sessions / name
    rollout.write_text(body)
    mtime_s = (WINDOW_START + 1000) / 1000
    os.utime(rollout, (mtime_s, mtime_s))
    return rollout


def test_rollout_already_counted_is_not_double_counted(tmp_path):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    rollout = _write_rollout(sessions, "rollout-c.jsonl", "")
    mtime_s = int((WINDOW_START + 1000) / 1000)

    _make_state_db(tmp_path, [
        ("t3", str(rollout), mtime_s, mtime_s, "duplicate thread", "Dup"),
    ])

    # The union path counts the session exactly once...
    prompts = _codex_raw_prompts(WINDOW_START, WINDOW_END, sessions)
    assert len(prompts) == 1
    # ...and takes the threads-table text, because the JSONL had nothing usable.
    assert prompts == ["duplicate thread"]


def test_wrapper_only_rollout_falls_back_to_threads_table(tmp_path):
    """Regression (2026-08-19): newer codex builds open a session with an
    injected `<recommended_plugins>` turn. The JSONL walk returned that
    boilerplate and the threads row holding the real prompt was discarded as a
    duplicate, so every Codex session was reported as "reviewed a list of
    plugins" instead of the work the user actually asked for."""
    import json
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    wrapper = json.dumps({
        "type": "response_item",
        "payload": {
            "role": "user",
            "content": [{"type": "input_text",
                         "text": "<recommended_plugins>\nAirtable, Apollo.io"}],
        },
    })
    rollout = _write_rollout(sessions, "rollout-d.jsonl", wrapper + "\n")
    mtime_s = int((WINDOW_START + 1000) / 1000)

    _make_state_db(tmp_path, [
        ("t4", str(rollout), mtime_s, mtime_s,
         "analyze the Jeff Su channel", "Analyze Jeff Su"),
    ])

    assert _codex_raw_prompts(WINDOW_START, WINDOW_END, sessions) == [
        "analyze the Jeff Su channel"
    ]


def test_threads_rows_that_are_only_wrappers_are_dropped(tmp_path):
    """The threads table carries harness boilerplate too; it used to be
    filtered on the JSONL path only, so it surfaced verbatim as a topic."""
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    in_window_s = (WINDOW_START + 3_600_000) // 1000
    _make_state_db(tmp_path, [
        ("t5", "", in_window_s, in_window_s,
         "The following is the Codex agent history whose request action...", ""),
        ("t6", "", in_window_s, in_window_s, "ship the release notes", "Ship"),
    ])

    rows = _codex_sqlite_rows(WINDOW_START, WINDOW_END, sessions)
    assert [text for _, text in rows] == ["ship the release notes"]


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
