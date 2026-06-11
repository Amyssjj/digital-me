"""brain_learnings must behave correctly when the brain DB is missing or
when $DIGITAL_ME_BRAIN_DB points at a non-existent path — a fresh
open-source user has neither OpenClaw nor a populated learnings table.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from dream_cycle.brain_learnings import (
    DEFAULT_BRAIN_DB_PATH,
    resolve_brain_db_path,
    run_brain_learnings,
)
from dream_cycle.config import load_config


def test_resolve_brain_db_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DIGITAL_ME_BRAIN_DB", raising=False)
    assert resolve_brain_db_path() == DEFAULT_BRAIN_DB_PATH


def test_resolve_brain_db_env_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    target = tmp_path / "custom-brain.db"
    monkeypatch.setenv("DIGITAL_ME_BRAIN_DB", str(target))
    assert resolve_brain_db_path() == target


def test_run_brain_learnings_graceful_skip_when_missing(
    monkeypatch: pytest.MonkeyPatch, fixture_wiki: Path, tmp_path: Path, capsys
) -> None:
    monkeypatch.setenv("DIGITAL_ME_BRAIN_DB", str(tmp_path / "no-such.db"))
    cfg = load_config(wiki_root=fixture_wiki)
    result = run_brain_learnings(cfg)
    out = capsys.readouterr().out
    assert "Brain DB not found" in out
    assert result["materialized"] == 0
    assert result["total"] == 0


def test_run_brain_learnings_processes_seeded_rows(
    monkeypatch: pytest.MonkeyPatch, fixture_wiki: Path, tmp_path: Path
) -> None:
    """An empty `learnings` table is the realistic v1 brain-db shape;
    confirm the materializer copes with zero rows."""
    db_path = tmp_path / "brain.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """CREATE TABLE learnings (
            id TEXT PRIMARY KEY,
            agent_id TEXT,
            kind TEXT,
            text TEXT,
            why TEXT,
            apply_when TEXT,
            source_context TEXT,
            confidence REAL,
            proposed_wiki_path TEXT,
            created_at INTEGER
        )"""
    )
    conn.commit()
    conn.close()

    monkeypatch.setenv("DIGITAL_ME_BRAIN_DB", str(db_path))
    cfg = load_config(wiki_root=fixture_wiki)
    result = run_brain_learnings(cfg)
    assert result["total"] == 0
    assert result["materialized"] == 0
    assert str(db_path) in result["db"]
