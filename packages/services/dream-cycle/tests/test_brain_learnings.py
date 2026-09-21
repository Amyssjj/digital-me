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


def test_resolve_brain_db_rule(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """env → <wiki-root>/.data/brain.db → legacy ~/.openclaw/data/brain.db (only
    while that alone exists) → canonical. Twin of contracts resolveBrainDbPath."""
    monkeypatch.delenv("DIGITAL_ME_BRAIN_DB", raising=False)
    wiki = tmp_path / "digital-me"
    oc = tmp_path / ".openclaw"
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(wiki))
    monkeypatch.setenv("OPENCLAW_HOME", str(oc))
    canonical = wiki.resolve() / ".data" / "brain.db"
    legacy = oc / "data" / "brain.db"
    assert resolve_brain_db_path() == canonical  # fresh machine: never under ~/.openclaw
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"")
    assert resolve_brain_db_path() == legacy  # pre-move install keeps working
    canonical.parent.mkdir(parents=True)
    canonical.write_bytes(b"")
    assert resolve_brain_db_path() == canonical  # canonical wins once it exists


def test_legacy_fallback_uses_the_module_default_without_openclaw_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("DIGITAL_ME_BRAIN_DB", raising=False)
    monkeypatch.delenv("OPENCLAW_HOME", raising=False)
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(tmp_path / "wiki-root"))
    legacy = tmp_path / "legacy-brain.db"
    legacy.write_bytes(b"")
    from dream_cycle import brain_learnings

    monkeypatch.setattr(brain_learnings, "DEFAULT_BRAIN_DB_PATH", legacy)
    assert resolve_brain_db_path() == legacy


def test_default_brain_db_path_is_the_legacy_orchestrator_location() -> None:
    """The legacy fallback is the openclaw plugin's brain.db — never the retired
    task-orchestrator.db (a stale copy on old hosts, nothing on fresh ones)."""
    assert DEFAULT_BRAIN_DB_PATH.parts[-3:] == (".openclaw", "data", "brain.db")


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
