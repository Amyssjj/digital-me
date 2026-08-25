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
    _register_sibling_schedule,
    discover_bundled_workflows,
    install_workflows,
    main,
)
from dream_cycle.workers import WORKER_AGENT_PREFERENCE, detect_worker_agent_id


# ── _register_sibling_schedule: timezone forwarding ──────────────────────────


def _write_sibling(tmp_path: Path, wf_name: str, sched: dict) -> Path:
    wf = tmp_path / wf_name
    wf.write_text(json.dumps({"id": sched.get("scheduleId", "wf")}), encoding="utf-8")
    wf.with_suffix(".schedule.json").write_text(json.dumps(sched), encoding="utf-8")
    return wf


def test_sibling_schedule_forwards_declared_timezone(tmp_path: Path) -> None:
    """A schedule.json declaring `timezone` must forward it to schedule_add —
    otherwise the brain defaults to UTC and a local-morning cron drifts hours."""
    wf = _write_sibling(
        tmp_path,
        "digest.json",
        {
            "scheduleId": "daily-activity-digest",
            "cronExpr": "0 7 * * *",
            "timezone": "America/Los_Angeles",
            "enabled": True,
        },
    )
    client = MagicMock()
    status = _register_sibling_schedule(wf, "daily-activity-digest", {}, client)
    kwargs = client.schedule_add.call_args.kwargs
    assert kwargs["timezone"] == "America/Los_Angeles"
    assert kwargs["cron_expr"] == "0 7 * * *"
    assert "tz='America/Los_Angeles'" in (status or "")


def test_sibling_schedule_without_timezone_passes_none(tmp_path: Path) -> None:
    """No `timezone` key → None forwarded (brain keeps its UTC default; the
    dream-cycle nightly schedule relies on this unchanged behavior)."""
    wf = _write_sibling(
        tmp_path,
        "nightly.json",
        {"scheduleId": "dream-cycle-nightly", "cronExpr": "0 3 * * *", "enabled": True},
    )
    client = MagicMock()
    _register_sibling_schedule(wf, "dream-cycle-nightly", {}, client)
    assert client.schedule_add.call_args.kwargs["timezone"] is None


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


def test_real_bundled_schedule_declares_timezone() -> None:
    """The real bundled nightly.schedule.json must declare an IANA timezone.

    _register_sibling_schedule only forwards a timezone when the sibling
    declares one; otherwise the brain falls back to UTC. The bundled cron is
    `0 3 * * *`, meant as 3am LOCAL to match config.yaml's dream_cycle
    schedule — shipped without a timezone it silently registers as 3am UTC
    (8pm PT the previous evening). test_sibling_schedule_forwards_declared_
    timezone covers the plumbing with a synthetic file; this covers the real
    artifact users actually install.
    """
    nightly = next(p for p in discover_bundled_workflows() if p.name == "nightly.json")
    sched_path = nightly.with_suffix(".schedule.json")
    assert sched_path.exists(), f"missing sibling schedule at {sched_path}"
    sched = json.loads(sched_path.read_text())
    tz = sched.get("timezone")
    assert isinstance(tz, str) and tz.strip(), (
        "bundled nightly.schedule.json must declare a timezone; "
        "without one the brain registers this cron in UTC"
    )
    assert "/" in tz, f"expected an IANA zone like 'America/Los_Angeles', got {tz!r}"


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


def test_install_stamps_provenance_and_upserts(tmp_path: Path) -> None:
    """Every import carries a source stamp (path + sha256 of the RAW file)
    and uses upsert, so `doctor` can detect drift and schedules survive."""
    import hashlib

    template = {
        "id": "wf-prov",
        "name": "Prov",
        "steps": [{"stepKey": "s", "dispatch": {"mode": "manual"}}],
    }
    wf_path = _make_workflow_file(tmp_path, "wf-prov", template)

    client = MagicMock()
    client.import_workflow.return_value = {"ok": True}
    results = install_workflows(
        [wf_path],
        vars={"wiki_root": "/tmp/w", "python_path": "/venv/bin/python"},
        client=client,
    )
    assert results[0][1] is True

    imported = client.import_workflow.call_args.args[0]
    src = imported["source"]
    assert src["path"] == str(wf_path.resolve())
    # hash is of the raw bytes on disk, NOT the materialized dict
    assert src["hash"] == hashlib.sha256(wf_path.read_bytes()).hexdigest()

    assert client.import_workflow.call_args.kwargs.get("upsert") is True


def test_install_no_longer_tears_down_schedules(tmp_path: Path) -> None:
    """Regression: the old delete-then-import path removed every schedule
    referencing the workflow, destroying any with hand-tuned variables or no
    sibling .schedule.json. Upsert must touch neither."""
    template = {
        "id": "wf-keep",
        "name": "Keep",
        "steps": [{"stepKey": "s", "dispatch": {"mode": "manual"}}],
    }
    wf_path = _make_workflow_file(tmp_path, "wf-keep", template)

    client = MagicMock()
    client.import_workflow.return_value = {"ok": True}
    install_workflows(
        [wf_path],
        vars={"wiki_root": "/tmp/w", "python_path": "/venv/bin/python"},
        client=client,
    )

    client.delete_workflow.assert_not_called()
    client.schedule_remove.assert_not_called()


def test_sibling_schedule_declines_when_another_id_targets_the_workflow(
    tmp_path: Path,
) -> None:
    """A live schedule under a different id must not be duplicated. Install
    leaves it alone and reports, rather than double-firing the workflow."""
    template = {
        "id": "wf-sched",
        "name": "Sched",
        "steps": [{"stepKey": "s", "dispatch": {"mode": "manual"}}],
    }
    wf_path = _make_workflow_file(tmp_path, "wf-sched", template)
    (tmp_path / "wf-sched.schedule.json").write_text(
        json.dumps(
            {"scheduleId": "bundled-id", "cronExpr": "0 3 * * *"}
        ),
        encoding="utf-8",
    )

    client = MagicMock()
    client.import_workflow.return_value = {"ok": True}
    client.schedule_list.return_value = [
        {"id": "renamed-live-id", "workflowId": "wf-sched"}
    ]

    results = install_workflows(
        [wf_path],
        vars={"wiki_root": "/tmp/w", "python_path": "/venv/bin/python"},
        client=client,
    )

    _, ok, msg = results[0]
    assert ok is True
    assert "renamed-live-id" in msg
    assert "left as-is" in msg
    client.schedule_add.assert_not_called()
    client.schedule_remove.assert_not_called()


def test_sibling_schedule_replaces_when_id_matches(tmp_path: Path) -> None:
    """The ordinary re-install path still replaces the schedule in place."""
    template = {
        "id": "wf-sched2",
        "name": "Sched2",
        "steps": [{"stepKey": "s", "dispatch": {"mode": "manual"}}],
    }
    wf_path = _make_workflow_file(tmp_path, "wf-sched2", template)
    (tmp_path / "wf-sched2.schedule.json").write_text(
        json.dumps({"scheduleId": "same-id", "cronExpr": "0 3 * * *"}),
        encoding="utf-8",
    )

    client = MagicMock()
    client.import_workflow.return_value = {"ok": True}
    client.schedule_list.return_value = [
        {"id": "same-id", "workflowId": "wf-sched2"}
    ]

    results = install_workflows(
        [wf_path],
        vars={"wiki_root": "/tmp/w", "python_path": "/venv/bin/python"},
        client=client,
    )
    assert results[0][1] is True
    client.schedule_add.assert_called_once()


# ── worker agent detection ───────────────────────────────────────────────────


def _write_config(tmp_path: Path, aliases: object) -> Path:
    import yaml as _yaml

    (tmp_path / "config.yaml").write_text(
        _yaml.safe_dump({"cli_exec_aliases": aliases}), encoding="utf-8"
    )
    return tmp_path


def test_detect_prefers_claude_code_cli_over_codex(tmp_path: Path) -> None:
    _write_config(tmp_path, {"codex-cli": {"binary": "codex"}, "claude-code-cli": {"binary": "claude"}})
    assert detect_worker_agent_id(tmp_path) == "claude-code-cli"


def test_detect_falls_back_to_codex_when_claude_absent(tmp_path: Path) -> None:
    _write_config(tmp_path, {"codex-cli": {"binary": "codex"}})
    assert detect_worker_agent_id(tmp_path) == "codex-cli"


def test_detect_ignores_the_bare_claude_code_spawn_agent(tmp_path: Path) -> None:
    """`claude-code` is the known-broken bare spawn agent — never selectable."""
    assert "claude-code" not in WORKER_AGENT_PREFERENCE
    _write_config(tmp_path, {"claude-code": {"binary": "claude"}})
    assert detect_worker_agent_id(tmp_path) is None


def test_detect_returns_none_when_no_config_file(tmp_path: Path) -> None:
    assert detect_worker_agent_id(tmp_path) is None


def test_detect_returns_none_on_malformed_yaml(tmp_path: Path) -> None:
    (tmp_path / "config.yaml").write_text("cli_exec_aliases: [oops\n", encoding="utf-8")
    assert detect_worker_agent_id(tmp_path) is None


def test_detect_returns_none_when_aliases_not_a_mapping(tmp_path: Path) -> None:
    _write_config(tmp_path, ["claude-code-cli"])
    assert detect_worker_agent_id(tmp_path) is None


def test_detect_ignores_non_mapping_alias_entry(tmp_path: Path) -> None:
    _write_config(tmp_path, {"claude-code-cli": "not-a-mapping"})
    assert detect_worker_agent_id(tmp_path) is None


def test_main_fails_loudly_when_no_worker_configured(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Exit 4 + actionable guidance beats importing a workflow that cannot run."""
    rc = main(["--wiki-root", str(tmp_path)])
    assert rc == 4
    err = capsys.readouterr().err
    assert "no CLI worker alias configured" in err
    assert "claude-code-cli or codex-cli" in err
    assert "digital-me setup" in err


# ── bundled template: the agent steps must not silently no-op ────────────────


def test_bundled_agent_steps_use_a_loudly_failing_placeholder() -> None:
    """Regression guard for the ["true"] placeholder.

    The alias resolver replaces `command` wholesale when the alias resolves; the
    placeholder only survives when the alias is MISSING. A placeholder that
    exits 0 turns an unconfigured install into a green run that did no work.
    """
    import subprocess

    nightly = next(
        p for p in discover_bundled_workflows() if p.name == "nightly.json"
    )
    steps = json.loads(nightly.read_text())["steps"]
    agent_steps = [s for s in steps if s["stepKey"] in ("compile-extract", "taste-distill")]
    assert len(agent_steps) == 2

    for step in agent_steps:
        dispatch = step["dispatch"]
        assert dispatch["mode"] == "exec"
        assert dispatch["command"] != ["true"]
        result = subprocess.run(dispatch["command"], capture_output=True, text=True)
        assert result.returncode != 0, f"{step['stepKey']} placeholder exited 0"
        assert "did NO work" in (result.stdout + result.stderr)


def test_bundled_agent_ids_have_no_default() -> None:
    """A default would silently resurrect the broken bare spawn agent."""
    nightly = next(
        p for p in discover_bundled_workflows() if p.name == "nightly.json"
    )
    variables = json.loads(nightly.read_text()).get("variables", [])
    for name in ("compiler_agent_id", "classifier_agent_id"):
        var = next(v for v in variables if v["name"] == name)
        assert "defaultValue" not in var, f"{name} must not carry a default"


def test_main_skips_detection_when_both_agent_ids_given(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Explicit overrides are an escape hatch for machines we can't detect."""
    rc = main([
        "--wiki-root", str(tmp_path),
        "--classifier-agent-id", "my-worker",
        "--compiler-agent-id", "my-worker",
        "--workflows-dir", str(tmp_path / "empty"),
    ])
    assert rc != 4
    assert "no CLI worker alias configured" not in capsys.readouterr().err


def test_main_still_fails_when_only_one_agent_id_given(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A half-configured override would leave the other step unrunnable."""
    rc = main(["--wiki-root", str(tmp_path), "--classifier-agent-id", "my-worker"])
    assert rc == 4
    assert "no CLI worker alias configured" in capsys.readouterr().err
