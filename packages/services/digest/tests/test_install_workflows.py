"""digest.install_workflows: --wiki-root must reach the brain client."""

from __future__ import annotations

from pathlib import Path

import pytest

import digest.install_workflows as diw


def test_main_passes_resolved_wiki_root_to_install_workflows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The shared installer builds its BrainClient with this wiki root, so a bare
    re-run with a non-default --wiki-root finds brain-host's token file there."""
    wf_dir = tmp_path / "workflows"
    wf_dir.mkdir()
    (wf_dir / "wf.json").write_text("{}", encoding="utf-8")
    seen: dict[str, object] = {}

    def fake_install(paths: object, vars: object, **kwargs: object) -> list:
        seen.update(kwargs)
        return []

    monkeypatch.setattr(diw, "install_workflows", fake_install)
    assert diw.main(["--wiki-root", str(tmp_path), "--workflows-dir", str(wf_dir)]) == 0
    assert seen == {"wiki_root": tmp_path.resolve()}
