"""Shared pytest fixtures for the dream-cycle test suite."""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent

import pytest


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
