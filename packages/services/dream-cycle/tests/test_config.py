"""Verify the wiki_root + config_path resolution contract.

The dream-cycle package must point at ANY wiki, not just the source-file's
ancestor. These tests guard the arg → env → default ordering.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from dream_cycle.config import (
    DEFAULT_WIKI_ROOT,
    load_config,
    resolve_config_path,
    resolve_wiki_root,
)


def test_resolve_wiki_root_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DIGITAL_ME_WIKI_ROOT", raising=False)
    assert resolve_wiki_root() == DEFAULT_WIKI_ROOT


def test_resolve_wiki_root_env_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(tmp_path))
    assert resolve_wiki_root() == tmp_path.resolve()


def test_resolve_wiki_root_arg_beats_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", "/does/not/exist")
    explicit = tmp_path / "explicit"
    explicit.mkdir()
    assert resolve_wiki_root(explicit) == explicit.resolve()


def test_resolve_config_path_falls_back_to_wiki_root(tmp_path: Path) -> None:
    assert resolve_config_path(wiki_root=tmp_path) == tmp_path / "config.yaml"


def test_resolve_config_path_env_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    custom = tmp_path / "elsewhere.yaml"
    monkeypatch.setenv("DIGITAL_ME_CONFIG_PATH", str(custom))
    assert resolve_config_path(wiki_root=tmp_path) == custom.resolve()


def test_resolve_config_path_arg_beats_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("DIGITAL_ME_CONFIG_PATH", "/nope/config.yaml")
    explicit = tmp_path / "explicit.yaml"
    assert resolve_config_path(explicit, wiki_root=tmp_path) == explicit.resolve()


def test_load_config_uses_provided_wiki_root(fixture_wiki: Path) -> None:
    cfg = load_config(wiki_root=fixture_wiki)
    assert cfg.wiki_root == fixture_wiki.resolve()
    assert cfg.wiki_dir == fixture_wiki.resolve() / "wiki"
    assert cfg.engine == "standalone"
    assert cfg.standalone.api_key_env == "GEMINI_API_KEY"


def test_load_config_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_config(wiki_root=tmp_path)
