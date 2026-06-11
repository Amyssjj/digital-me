"""Tests for the install_workflows module."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from dream_cycle.brain_client import BrainClientError
from dream_cycle.install_workflows import (
    _apply_template_defaults,
    _build_install_vars,
    discover_bundled_workflows,
    install_workflows,
)


# ── _apply_template_defaults ─────────────────────────────────────────────


def test_apply_template_defaults_fills_missing_vars() -> None:
    template = {
        "variables": [
            {"name": "wiki_root", "required": True},
            {"name": "classifier_agent_id", "defaultValue": "claude-code"},
            {"name": "compile_limit", "defaultValue": "10"},
        ]
    }
    vars = {"wiki_root": "/tmp/w", "python_path": "/p"}
    merged = _apply_template_defaults(template, vars)
    assert merged["wiki_root"] == "/tmp/w"  # caller value preserved
    assert merged["python_path"] == "/p"  # caller value preserved
    assert merged["classifier_agent_id"] == "claude-code"  # default applied
    assert merged["compile_limit"] == "10"  # default applied


def test_apply_template_defaults_doesnt_override_caller_value() -> None:
    template = {
        "variables": [
            {"name": "classifier_agent_id", "defaultValue": "claude-code"},
        ]
    }
    vars = {"classifier_agent_id": "coo"}  # user override
    merged = _apply_template_defaults(template, vars)
    assert merged["classifier_agent_id"] == "coo"  # user wins


def test_apply_template_defaults_tolerates_missing_variables_section() -> None:
    """A template with no `variables` field shouldn't crash."""
    template = {"id": "wf-no-vars", "steps": []}
    vars = {"x": "y"}
    merged = _apply_template_defaults(template, vars)
    assert merged == {"x": "y"}


def test_apply_template_defaults_skips_required_without_default() -> None:
    """A required var without defaultValue stays absent — it's the caller's
    responsibility to supply it. We don't fabricate defaults out of thin air."""
    template = {
        "variables": [
            {"name": "wiki_root", "required": True},
            {"name": "optional", "defaultValue": "default"},
        ]
    }
    merged = _apply_template_defaults(template, {})
    assert "wiki_root" not in merged
    assert merged["optional"] == "default"


def _make_workflow_file(directory: Path, name: str, template: dict) -> Path:
    p = directory / f"{name}.json"
    p.write_text(json.dumps(template))
    return p


# ── discover_bundled_workflows ────────────────────────────────────────────


def test_discover_returns_empty_when_no_dir(tmp_path: Path) -> None:
    nonexistent = tmp_path / "no-such-dir"
    assert discover_bundled_workflows(nonexistent) == []


def test_discover_returns_sorted_json_files(tmp_path: Path) -> None:
    _make_workflow_file(tmp_path, "z-second", {"id": "z"})
    _make_workflow_file(tmp_path, "a-first", {"id": "a"})
    (tmp_path / "notes.md").write_text("not a workflow")  # ignored
    paths = discover_bundled_workflows(tmp_path)
    assert [p.name for p in paths] == ["a-first.json", "z-second.json"]


def test_discover_finds_real_bundled_nightly() -> None:
    """The real bundled workflows/nightly.json must exist + be JSON."""
    paths = discover_bundled_workflows()
    names = {p.name for p in paths}
    assert "nightly.json" in names, f"nightly.json missing from {names}"
    nightly = next(p for p in paths if p.name == "nightly.json")
    template = json.loads(nightly.read_text())
    assert template["id"] == "dream-cycle-nightly"


# ── _build_install_vars ───────────────────────────────────────────────────


def test_build_install_vars_supplies_required_pair() -> None:
    vars = _build_install_vars(Path("/tmp/w"), "/venv/bin/python")
    assert vars["wiki_root"] == "/tmp/w"
    assert vars["python_path"] == "/venv/bin/python"


def test_build_install_vars_merges_overrides() -> None:
    vars = _build_install_vars(
        Path("/tmp/w"),
        "/venv/bin/python",
        overrides={"classifier_agent_id": "coo", "compile_limit": "25"},
    )
    assert vars["classifier_agent_id"] == "coo"
    assert vars["compile_limit"] == "25"
    # Required pair still present
    assert vars["wiki_root"] == "/tmp/w"


# ── install_workflows ─────────────────────────────────────────────────────


def test_install_workflows_materializes_and_imports(tmp_path: Path) -> None:
    template = {
        "id": "wf-a",
        "name": "A",
        "steps": [
            {
                "stepKey": "s",
                "dispatch": {
                    "mode": "exec",
                    "command": ["{{python_path}}", "-m", "x"],
                    "cwd": "{{wiki_root}}",
                },
            }
        ],
    }
    wf_path = _make_workflow_file(tmp_path, "wf-a", template)

    client = MagicMock()
    client.import_workflow.return_value = {"ok": True}
    results = install_workflows(
        [wf_path],
        vars={"wiki_root": "/tmp/w", "python_path": "/venv/bin/python"},
        client=client,
    )
    assert len(results) == 1
    path, ok, msg = results[0]
    assert ok is True
    assert "wf-a" in msg
    # Verify import was called with the materialized template
    imported = client.import_workflow.call_args.args[0]
    assert imported["steps"][0]["dispatch"]["command"] == [
        "/venv/bin/python",
        "-m",
        "x",
    ]
    assert imported["steps"][0]["dispatch"]["cwd"] == "/tmp/w"


def test_install_workflows_continues_on_per_file_failure(tmp_path: Path) -> None:
    """If one workflow fails to import, the next one still runs."""
    template_ok = {"id": "wf-ok", "steps": []}
    template_bad = {"id": "wf-bad", "steps": []}
    wf_ok = _make_workflow_file(tmp_path, "wf-ok", template_ok)
    wf_bad = _make_workflow_file(tmp_path, "wf-bad", template_bad)

    client = MagicMock()
    # First call (wf-bad alphabetically? actually wf-bad < wf-ok lexically):
    # Set return values in order matching alphabetical iteration
    paths = sorted([wf_ok, wf_bad])
    call_results = []
    for p in paths:
        if "bad" in p.name:
            call_results.append(BrainClientError("schema rejected"))
        else:
            call_results.append({"ok": True})
    client.import_workflow.side_effect = call_results

    results = install_workflows(
        paths,
        vars={"wiki_root": "/tmp/w", "python_path": "/venv/bin/python"},
        client=client,
    )
    assert len(results) == 2
    # Both got attempted; one ok, one fail
    ok_count = sum(1 for _, ok, _ in results if ok)
    fail_count = sum(1 for _, ok, _ in results if not ok)
    assert ok_count == 1
    assert fail_count == 1
    fail_path, _, fail_msg = next(r for r in results if not r[1])
    assert "bad" in fail_path.name
    assert "schema rejected" in fail_msg


def test_install_workflows_reports_file_errors(tmp_path: Path) -> None:
    bad_json = tmp_path / "broken.json"
    bad_json.write_text("{not json}")
    client = MagicMock()
    results = install_workflows(
        [bad_json], vars={"wiki_root": "/", "python_path": "/p"}, client=client
    )
    assert len(results) == 1
    path, ok, msg = results[0]
    assert ok is False
    assert "failed to read/parse" in msg
    # Gateway should NOT have been called for a bad file
    client.import_workflow.assert_not_called()


def test_install_workflows_handles_empty_input() -> None:
    client = MagicMock()
    results = install_workflows([], vars={"wiki_root": "/", "python_path": "/p"}, client=client)
    assert results == []
    client.import_workflow.assert_not_called()
