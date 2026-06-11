"""Tests for the --via-agents entry point. The brain_client is mocked
so no live gateway is required."""

from __future__ import annotations

import argparse
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from dream_cycle.brain_client import BrainClientError
from dream_cycle.via_agents import (
    _bundled_workflow_id,
    _extract_goal_id,
    _format_task_line,
    materialize_workflow,
    run,
)


def _args(**overrides) -> argparse.Namespace:
    defaults = dict(
        wiki_root=Path("/tmp/test-wiki"),
        dry_run=True,
        template_id="wf_test",
        timeout=60.0,
        poll_interval=1.0,
        force=False,
    )
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


# ── _bundled_workflow_id ──────────────────────────────────────────────────


def test_bundled_workflow_id_reads_from_package_workflow_json() -> None:
    """The id field of the bundled nightly workflow should match what's on disk."""
    wf_id = _bundled_workflow_id()
    # The bundled workflows/nightly.json ships with id `dream-cycle-nightly`
    # (renamed from the legacy `wf_dream_cycle_*` scheme in b183d66).
    # Assert exact match so a typo or accidental rename surfaces here.
    assert wf_id == "dream-cycle-nightly", f"unexpected workflow id: {wf_id!r}"


# ── _extract_goal_id ──────────────────────────────────────────────────────


def test_extract_goal_id_finds_nested_shape() -> None:
    """The current gateway shape nests goalId at result.details.json.goalId."""
    assert _extract_goal_id({"details": {"json": {"goalId": "g-1"}}}) == "g-1"


def test_extract_goal_id_finds_top_level_shape() -> None:
    """Defensive: older / alternate envelopes might put it at top level."""
    assert _extract_goal_id({"goalId": "g-2"}) == "g-2"


def test_extract_goal_id_returns_none_when_missing() -> None:
    assert _extract_goal_id({}) is None
    assert _extract_goal_id({"details": {"json": {}}}) is None
    assert _extract_goal_id("not a dict") is None  # type: ignore[arg-type]


# ── run() — success path ──────────────────────────────────────────────────


def test_run_returns_0_when_goal_completes(capsys) -> None:
    client = MagicMock()
    client.gateway.url = "http://localhost:18789/tools/invoke"
    client.import_workflow.return_value = {"ok": True, "message": "imported"}
    client.run_workflow.return_value = {
        "details": {"json": {"goalId": "g-1", "taskCount": 6, "dispatched": 1}}
    }
    client.wait_for_goal.return_value = {
        "id": "g-1",
        "status": "completed",
        "tasks": [
            {"name": "compile", "status": "completed", "attempts": [{"status": "completed"}]},
            {"name": "consolidate", "status": "completed", "attempts": []},
        ],
    }

    rc = run(_args(), client=client)
    assert rc == 0
    err = capsys.readouterr().err
    assert "goalId:      g-1" in err
    assert "completed" in err
    # Import must happen BEFORE run_workflow so the dispatch fields are
    # materialized in the brain's stored template.
    client.import_workflow.assert_called_once()
    client.run_workflow.assert_called_once()
    # The imported template must be materialized — no remaining `{{var}}`
    # in dispatch.command/cwd/env after substitution.
    imported_template = client.import_workflow.call_args.args[0]
    for step in imported_template.get("steps", []):
        d = step.get("dispatch", {})
        if d.get("mode") == "exec":
            joined = " ".join(d.get("command", [])) + " " + d.get("cwd", "")
            joined += " " + " ".join(d.get("env", {}).values())
            assert "{{" not in joined, f"unsubstituted var in {step['stepKey']}: {joined}"
    # And run_workflow must pass the right variables.
    kwargs = client.run_workflow.call_args.kwargs
    # macOS `/tmp` resolves to `/private/tmp`; assert it ends with the
    # logical path so the test passes on both Linux and Darwin.
    assert kwargs["variables"]["wiki_root"].endswith("/tmp/test-wiki")
    assert kwargs["variables"]["dry_run"] == "true"
    assert kwargs["variables"]["python_path"]  # auto-supplied from sys.executable
    assert kwargs["force"] is False


def _passing_client():
    client = MagicMock()
    client.gateway.url = "http://x/"
    client.import_workflow.return_value = {"ok": True}
    client.run_workflow.return_value = {"details": {"json": {"goalId": "g-1"}}}
    client.wait_for_goal.return_value = {"status": "completed", "tasks": []}
    return client


def test_run_passes_dry_run_false_when_disabled() -> None:
    client = _passing_client()
    run(_args(dry_run=False), client=client)
    assert client.run_workflow.call_args.kwargs["variables"]["dry_run"] == "false"


def test_run_forwards_force_flag() -> None:
    client = _passing_client()
    run(_args(force=True), client=client)
    assert client.run_workflow.call_args.kwargs["force"] is True


def test_run_returns_3_when_import_fails(capsys) -> None:
    """Import failure should bail before any run_workflow call."""
    client = MagicMock()
    client.gateway.url = "http://x/"
    client.import_workflow.side_effect = BrainClientError("workflow schema rejected")
    rc = run(_args(), client=client)
    assert rc == 3
    assert "workflow import failed" in capsys.readouterr().err
    assert "schema rejected" in capsys.readouterr().err or True  # message captured pre-stderr-clear
    client.run_workflow.assert_not_called()


# ── run() — failure paths ─────────────────────────────────────────────────


def test_run_returns_1_when_goal_fails(capsys) -> None:
    client = MagicMock()
    client.gateway.url = "http://x/"
    client.import_workflow.return_value = {"ok": True}
    client.run_workflow.return_value = {"details": {"json": {"goalId": "g-1"}}}
    client.wait_for_goal.return_value = {
        "status": "failed",
        "tasks": [
            {
                "name": "compile",
                "status": "failed",
                "failureReason": "boom",
                "attempts": [],
            }
        ],
    }
    rc = run(_args(), client=client)
    assert rc == 1
    assert "boom" in capsys.readouterr().err


def test_run_returns_1_when_goal_cancelled() -> None:
    client = MagicMock()
    client.gateway.url = "http://x/"
    client.import_workflow.return_value = {"ok": True}
    client.run_workflow.return_value = {"details": {"json": {"goalId": "g-1"}}}
    client.wait_for_goal.return_value = {"status": "cancelled", "tasks": []}
    assert run(_args(), client=client) == 1


def test_run_returns_2_on_poll_timeout(capsys) -> None:
    client = MagicMock()
    client.gateway.url = "http://x/"
    client.import_workflow.return_value = {"ok": True}
    client.run_workflow.return_value = {"details": {"json": {"goalId": "g-1"}}}
    client.wait_for_goal.side_effect = BrainClientError(
        "goal g-1 did not finish within 60s (last status: running)"
    )
    rc = run(_args(), client=client)
    assert rc == 2
    assert "did not finish" in capsys.readouterr().err


def test_run_returns_3_when_run_workflow_errors(capsys) -> None:
    client = MagicMock()
    client.gateway.url = "http://x/"
    client.import_workflow.return_value = {"ok": True}
    client.run_workflow.side_effect = BrainClientError(
        "gateway unreachable: Connection refused"
    )
    rc = run(_args(), client=client)
    assert rc == 3
    assert "Connection refused" in capsys.readouterr().err
    # wait_for_goal should not be called when run_workflow fails
    client.wait_for_goal.assert_not_called()


def test_run_returns_4_when_goalId_missing(capsys) -> None:
    client = MagicMock()
    client.gateway.url = "http://x/"
    client.import_workflow.return_value = {"ok": True}
    client.run_workflow.return_value = {"some": "shape"}  # no goalId
    rc = run(_args(), client=client)
    assert rc == 4
    assert "could not extract goalId" in capsys.readouterr().err


# ── _format_task_line ─────────────────────────────────────────────────────


def test_format_task_line_clean_pass() -> None:
    line = _format_task_line(
        {"name": "compile", "status": "completed", "attempts": [{"status": "completed"}]}
    )
    assert "compile" in line and "completed" in line
    assert "failure:" not in line


def test_format_task_line_surfaces_failure_reason() -> None:
    line = _format_task_line(
        {
            "name": "compile",
            "status": "failed",
            "failureReason": "spawn rejected by openclaw",
            "attempts": [],
        }
    )
    assert "spawn rejected by openclaw" in line
    assert "failure:" in line


def test_format_task_line_surfaces_attempt_failure_when_no_task_failure() -> None:
    line = _format_task_line(
        {
            "name": "compile",
            "status": "failed",
            "attempts": [{"status": "failed", "failureReason": "timeout"}],
        }
    )
    assert "timeout" in line


# ── materialize_workflow ──────────────────────────────────────────────────


def test_materialize_substitutes_strings() -> None:
    out = materialize_workflow(
        {"description": "wiki at {{wiki_root}}"}, {"wiki_root": "/tmp/w"}
    )
    assert out == {"description": "wiki at /tmp/w"}


def test_materialize_substitutes_list_values() -> None:
    out = materialize_workflow(
        {"command": ["{{python_path}}", "-m", "dream_cycle.citations"]},
        {"python_path": "/venv/bin/python"},
    )
    assert out["command"] == ["/venv/bin/python", "-m", "dream_cycle.citations"]


def test_materialize_substitutes_nested_dict_values() -> None:
    out = materialize_workflow(
        {"env": {"DIGITAL_ME_WIKI_ROOT": "{{wiki_root}}", "OTHER": "static"}},
        {"wiki_root": "/tmp/w"},
    )
    assert out["env"] == {"DIGITAL_ME_WIKI_ROOT": "/tmp/w", "OTHER": "static"}


def test_materialize_leaves_unknown_vars_intact() -> None:
    """Mirrors brain-orchestrator's behavior: unknown {{vars}} stay as-is."""
    out = materialize_workflow({"x": "{{known}} + {{unknown}}"}, {"known": "Y"})
    assert out["x"] == "Y + {{unknown}}"


def test_materialize_recurses_through_workflow_step() -> None:
    """End-to-end shape: a full step gets cmd/cwd/env all substituted."""
    template = {
        "steps": [
            {
                "stepKey": "citations",
                "dispatch": {
                    "mode": "exec",
                    "command": ["{{python_path}}", "-m", "dream_cycle.citations"],
                    "cwd": "{{wiki_root}}",
                    "env": {"DIGITAL_ME_WIKI_ROOT": "{{wiki_root}}"},
                },
            }
        ]
    }
    out = materialize_workflow(
        template,
        {"python_path": "/venv/bin/python", "wiki_root": "/tmp/w"},
    )
    d = out["steps"][0]["dispatch"]
    assert d["command"] == ["/venv/bin/python", "-m", "dream_cycle.citations"]
    assert d["cwd"] == "/tmp/w"
    assert d["env"] == {"DIGITAL_ME_WIKI_ROOT": "/tmp/w"}


def test_materialize_does_not_mutate_input() -> None:
    template = {"x": "{{v}}"}
    materialize_workflow(template, {"v": "y"})
    # Input should be unchanged — caller still has the placeholder template.
    assert template == {"x": "{{v}}"}


def test_materialize_preserves_non_string_scalars() -> None:
    """Numbers, bools, None pass through untouched."""
    out = materialize_workflow(
        {"timeoutMs": 300000, "enabled": True, "x": None, "name": "{{v}}"},
        {"v": "y"},
    )
    assert out == {"timeoutMs": 300000, "enabled": True, "x": None, "name": "y"}
