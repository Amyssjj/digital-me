"""Tests for the intake's data-root resolution (dashboard_intake/__init__.py).

Run via pytest (from the intake/ directory):
  python -m pytest dashboard_intake/test_paths.py
"""

from __future__ import annotations

from pathlib import Path

import pytest

from dashboard_intake import digital_me_root, m1_dir, tastes_root, wiki_root

_VARS = (
    "DIGITAL_ME_WIKI_ROOT", "DIGITAL_ME_WIKI_DIR", "DIGITAL_ME_TASTES_DIR",
    "DIGITAL_ME_M1_DIR", "OPENCLAW_HOME",
)


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


def test_m1_dir_rule(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """$DIGITAL_ME_M1_DIR → <root>/.data/m1 when it exists → legacy
    <OPENCLAW_HOME or ~/.openclaw>/data when it exists → canonical."""
    home = tmp_path / "h"
    canonical = home / "digital-me" / ".data" / "m1"
    legacy = home / ".openclaw" / "data"
    assert m1_dir(home) == canonical  # fresh machine: never under ~/.openclaw
    legacy.mkdir(parents=True)
    assert m1_dir(home) == legacy
    canonical.mkdir(parents=True)
    assert m1_dir(home) == canonical
    monkeypatch.setenv("DIGITAL_ME_M1_DIR", "  ")
    assert m1_dir(home) == canonical  # blank counts as unset
    monkeypatch.setenv("DIGITAL_ME_M1_DIR", str(tmp_path / "explicit"))
    assert m1_dir(home) == tmp_path / "explicit"


def test_m1_dir_honours_wiki_root_openclaw_home_and_real_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    assert m1_dir() == tmp_path / "home" / "digital-me" / ".data" / "m1"  # HOME from the fixture
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(tmp_path / "root"))
    monkeypatch.setenv("OPENCLAW_HOME", str(tmp_path / "oc"))
    (tmp_path / "oc" / "data").mkdir(parents=True)
    assert m1_dir(tmp_path / "h") == tmp_path / "oc" / "data"
    (tmp_path / "root" / ".data" / "m1").mkdir(parents=True)
    assert m1_dir(tmp_path / "h") == tmp_path / "root" / ".data" / "m1"
