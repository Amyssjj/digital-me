"""Shared pytest fixtures for the dream-cycle test suite."""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent

import pytest

from dream_cycle import brain_learnings


@pytest.fixture(autouse=True)
def _isolate_from_host_brain(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory
) -> None:
    """Keep every test off the host's live wiki root and brain.db.

    `resolve_brain_db_path()` prefers `<wiki-root>/.data/brain.db` whenever it
    exists, and the wiki root defaults to `~/digital-me` -- on a dev host that
    is the live DB, so a test that only patched the legacy default silently
    read production rows (CI has no such file, which hid it). Point the wiki
    root at an empty tmp dir, drop the env overrides, and aim the legacy
    `~/.openclaw` rung at a missing file. Tests that need a DB still set
    `DIGITAL_ME_BRAIN_DB` / `OPENCLAW_HOME` / `DEFAULT_BRAIN_DB_PATH` themselves.
    """
    isolated = tmp_path_factory.mktemp("isolated-wiki-root")
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(isolated))
    monkeypatch.delenv("DIGITAL_ME_BRAIN_DB", raising=False)
    monkeypatch.delenv("DIGITAL_ME_CONFIG_PATH", raising=False)
    monkeypatch.delenv("OPENCLAW_HOME", raising=False)
    monkeypatch.setattr(
        brain_learnings, "DEFAULT_BRAIN_DB_PATH", isolated / "no-legacy" / "brain.db"
    )


MINIMAL_CONFIG_YAML = dedent("""\
    engine: standalone
    standalone:
      llm_provider: gemini
      llm_model: gemini-2.0-flash
      embedding_provider: gemini
      embedding_model: gemini-embedding-001
      api_key_env: GEMINI_API_KEY
    sources: []
    dream_cycle:
      schedule: "0 3 * * *"
      staleness_threshold_days: 30
      auto_archive: false
""")


@pytest.fixture
def fixture_wiki(tmp_path: Path) -> Path:
    """A minimal wiki layout: wiki_root/{wiki/,config.yaml}."""
    wiki_root = tmp_path / "wiki-root"
    (wiki_root / "wiki").mkdir(parents=True)
    (wiki_root / "config.yaml").write_text(MINIMAL_CONFIG_YAML)
    return wiki_root
