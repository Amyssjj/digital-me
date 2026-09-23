"""Tests for the intake's data-root resolution (dashboard_intake/__init__.py).

Run via pytest (from the intake/ directory):
  python -m pytest dashboard_intake/test_paths.py
"""

from __future__ import annotations

from pathlib import Path

import pytest

from dashboard_intake import digital_me_root, tastes_root, wiki_root

_VARS = ("DIGITAL_ME_WIKI_ROOT", "DIGITAL_ME_WIKI_DIR", "DIGITAL_ME_TASTES_DIR")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for var in _VARS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))


def test_defaults_to_home_digital_me(tmp_path: Path) -> None:
    root = tmp_path / "home" / "digital-me"
    assert digital_me_root() == root
    assert wiki_root() == root / "wiki"
    assert tastes_root() == root / "tastes"


def test_wiki_root_env_names_the_data_root(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The contract value brain-host exports: trees live UNDER it."""
    root = tmp_path / "dm"
    (root / "wiki").mkdir(parents=True)
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(root))
    assert digital_me_root() == root
    assert wiki_root() == root / "wiki"
    assert tastes_root() == root / "tastes"


def test_legacy_wiki_dir_spelling_is_tolerated(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    wiki = tmp_path / "dm" / "wiki"
    wiki.mkdir(parents=True)
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(wiki))
    assert digital_me_root() == tmp_path / "dm"
    assert wiki_root() == wiki
    assert tastes_root() == tmp_path / "dm" / "tastes"


def test_a_root_named_wiki_that_holds_a_wiki_tree_stays_the_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    root = tmp_path / "wiki"
    (root / "wiki").mkdir(parents=True)
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(root))
    assert digital_me_root() == root
    assert wiki_root() == root / "wiki"


def test_tree_dir_overrides_win(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(tmp_path / "dm"))
    monkeypatch.setenv("DIGITAL_ME_WIKI_DIR", str(tmp_path / "elsewhere" / "w"))
    monkeypatch.setenv("DIGITAL_ME_TASTES_DIR", str(tmp_path / "elsewhere" / "t"))
    assert wiki_root() == tmp_path / "elsewhere" / "w"
    assert tastes_root() == tmp_path / "elsewhere" / "t"
