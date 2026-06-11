"""CLI helper tests for dream_cycle.workflow_import."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from dream_cycle.brain_client import BrainClientError
from dream_cycle.workflow_import import _load_template, run


def test_load_template_parses_valid_file(tmp_path: Path) -> None:
    p = tmp_path / "wf.json"
    p.write_text(json.dumps({"id": "wf_a", "name": "A", "steps": []}))
    template = _load_template(p)
    assert template == {"id": "wf_a", "name": "A", "steps": []}


def test_load_template_missing_file(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="not found"):
        _load_template(tmp_path / "no-such.json")


def test_load_template_invalid_json(tmp_path: Path) -> None:
    p = tmp_path / "broken.json"
    p.write_text("{not valid json")
    with pytest.raises(ValueError, match="not valid JSON"):
        _load_template(p)


def test_load_template_top_level_not_object(tmp_path: Path) -> None:
    p = tmp_path / "array.json"
    p.write_text("[1, 2, 3]")
    with pytest.raises(ValueError, match="must contain a JSON object"):
        _load_template(p)


def test_run_returns_0_on_success(tmp_path: Path, capsys) -> None:
    p = tmp_path / "wf.json"
    p.write_text(json.dumps({"id": "wf_b", "name": "B", "steps": []}))
    client = MagicMock()
    client.import_workflow.return_value = {"ok": True, "message": "Imported wf_b"}
    rc = run(p, client=client)
    assert rc == 0
    client.import_workflow.assert_called_once()
    err = capsys.readouterr().err
    assert "wf_b" in err
    assert "OK" in err


def test_run_returns_1_on_builder_rejection(tmp_path: Path, capsys) -> None:
    p = tmp_path / "wf.json"
    p.write_text(json.dumps({"id": "wf_c"}))
    client = MagicMock()
    client.import_workflow.return_value = {"ok": False, "error": "missing steps"}
    rc = run(p, client=client)
    assert rc == 1
    assert "missing steps" in capsys.readouterr().err


def test_run_returns_2_on_file_error(tmp_path: Path, capsys) -> None:
    rc = run(tmp_path / "nope.json", client=MagicMock())
    assert rc == 2
    assert "not found" in capsys.readouterr().err


def test_run_returns_3_on_gateway_unreachable(tmp_path: Path, capsys) -> None:
    p = tmp_path / "wf.json"
    p.write_text(json.dumps({"id": "wf_d", "name": "D", "steps": []}))
    client = MagicMock()
    client.import_workflow.side_effect = BrainClientError("gateway unreachable: Connection refused")
    rc = run(p, client=client)
    assert rc == 3
    err = capsys.readouterr().err
    assert "gateway error" in err
    assert "Connection refused" in err
