"""Verify drift_check's repo-root resolution honors arg → env → config →
defaults, and that path resolution falls back across the configured roots.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from dream_cycle.config import load_config
from dream_cycle.drift_check import (
    _resolve_cited_path,
    resolve_drift_check_roots,
)


def test_defaults_use_wiki_root_and_home(fixture_wiki: Path) -> None:
    cfg = load_config(wiki_root=fixture_wiki)
    roots = resolve_drift_check_roots(cfg)
    assert roots == [fixture_wiki.resolve(), Path.home()]


def test_config_override(tmp_path: Path) -> None:
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        "engine: standalone\n"
        "standalone: {api_key_env: GEMINI_API_KEY}\n"
        "sources: []\n"
        "dream_cycle:\n"
        "  drift_check_repo_roots:\n"
        f"    - {tmp_path / 'a'}\n"
        f"    - {tmp_path / 'b'}\n"
    )
    cfg = load_config(path=cfg_path, wiki_root=tmp_path)
    roots = resolve_drift_check_roots(cfg)
    assert roots == [tmp_path / "a", tmp_path / "b"]


def test_env_beats_config(
    monkeypatch: pytest.MonkeyPatch, fixture_wiki: Path, tmp_path: Path
) -> None:
    monkeypatch.setenv(
        "DIGITAL_ME_DRIFT_CHECK_ROOTS", f"{tmp_path / 'x'}:{tmp_path / 'y'}"
    )
    cfg = load_config(wiki_root=fixture_wiki)
    roots = resolve_drift_check_roots(cfg)
    assert roots == [tmp_path / "x", tmp_path / "y"]


def test_resolve_cited_path_finds_under_first_matching_root(tmp_path: Path) -> None:
    root_a = tmp_path / "a"
    root_b = tmp_path / "b"
    root_a.mkdir()
    root_b.mkdir()
    (root_b / "extensions" / "demo").mkdir(parents=True)
    (root_b / "extensions" / "demo" / "index.ts").write_text("//")
    resolved = _resolve_cited_path("extensions/demo/index.ts", [root_a, root_b])
    assert resolved == root_b / "extensions" / "demo" / "index.ts"


def test_resolve_cited_path_returns_none_when_unreachable(tmp_path: Path) -> None:
    assert _resolve_cited_path("does/not/exist.ts", [tmp_path]) is None
