"""Import bundled workflow templates into the openclaw brain.

Called by `digital-me install --runtime dream-cycle` after the venv +
pip install steps succeed. Walks `dream_cycle/workflows/*.json`, applies
client-side variable substitution (the brain only interpolates
promptTemplate, not dispatch.command/cwd/env — same gap as
via_agents.py handles), and POSTs `workflow_import` for each.

Concrete payoff: a fresh `digital-me install --runtime dream-cycle
--wiki-root ~/digital-me` results in a brain with `dream-cycle-nightly`
already imported, exec commands pointing at the just-created venv,
ready to be scheduled. No manual `workflow_import` step.

Variables auto-supplied:
  python_path   = sys.executable (the venv we're running from)
  wiki_root     = CLI flag, or $DIGITAL_ME_WIKI_ROOT, or default

Optional variables flow from CLI flags or kept at workflow defaults.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable, Optional

from dream_cycle.brain_client import BrainClient, BrainClientError
from dream_cycle.config import resolve_wiki_root
from dream_cycle.workers import WORKER_AGENT_PREFERENCE, detect_worker_agent_id
from dream_cycle.via_agents import materialize_workflow


def _bundled_workflows_dir() -> Path:
    """The workflows/ directory shipped inside the installed package."""
    return Path(__file__).parent / "workflows"


def discover_bundled_workflows(directory: Optional[Path] = None) -> list[Path]:
    """List bundled workflow JSON files, sorted for deterministic install order.

    Excludes sibling `<name>.schedule.json` files — those are companion
    schedule definitions handled by _register_sibling_schedule, not
    workflow templates."""
    d = directory or _bundled_workflows_dir()
    if not d.exists():
        return []
    return sorted(
        p for p in d.glob("*.json")
        if p.is_file() and not p.name.endswith(".schedule.json")
    )


def _build_install_vars(
    wiki_root: Path,
    python_path: str,
    overrides: Optional[dict[str, str]] = None,
) -> dict[str, str]:
    """Mandatory vars + caller-overrideable extras."""
    vars: dict[str, str] = {
        "wiki_root": str(wiki_root),
        "python_path": python_path,
    }
    if overrides:
        vars.update(overrides)
    return vars


def _apply_template_defaults(
    template: dict[str, Any], vars: dict[str, str]
) -> dict[str, Any]:
    """Merge `defaultValue` from the template's `variables` array into
    `vars`, but only for keys not already supplied by the caller.

    Why this exists: the brain's instantiateWorkflow does this merge at
    run_workflow time for promptTemplate substitution. But install_workflows
    materializes dispatch fields client-side BEFORE workflow_import, and
    the brain doesn't interpolate dispatch — so defaults must be applied
    here too. Otherwise `{{classifier_agent_id}}` (with defaultValue
    "claude-code") stays as a literal placeholder in the stored dispatch.
    """
    merged = dict(vars)
    for v in template.get("variables", []) or []:
        if not isinstance(v, dict):
            continue
        name = v.get("name")
        default = v.get("defaultValue")
        if (
            isinstance(name, str)
            and isinstance(default, str)
            and name not in merged
        ):
            merged[name] = default
    return merged


def _hash_file(path: Path) -> str:
    """sha256 of a file's raw bytes, as lowercase hex."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _package_version() -> Optional[str]:
    """Installed dream-cycle version, when resolvable. Best-effort: a source
    checkout that was never pip-installed has no distribution metadata."""
    try:
        from importlib.metadata import PackageNotFoundError, version

        return version("digital-me-dream-cycle")
    except Exception:
        return None


def _sibling_schedule_path(wf_path: Path) -> Path:
    """Convention: workflows/foo.json's companion schedule lives at
    workflows/foo.schedule.json. Returns the expected path (may not exist)."""
    return wf_path.with_suffix(".schedule.json")


def _register_sibling_schedule(
    wf_path: Path,
    wf_id: str,
    vars: dict[str, str],
    client: BrainClient,
) -> Optional[str]:
    """If a sibling <name>.schedule.json exists, materialize + register the
    schedule. Returns a human-readable status string, or None if no
    sibling file. Idempotent: removes any prior schedule with the same id."""
    sched_path = _sibling_schedule_path(wf_path)
    if not sched_path.exists():
        return None
    try:
        sched = json.loads(sched_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return f"schedule sibling unreadable: {e}"

    schedule_id = sched.get("scheduleId")
    cron_expr = sched.get("cronExpr")
    if not (isinstance(schedule_id, str) and isinstance(cron_expr, str)):
        return "schedule sibling missing scheduleId/cronExpr"

    # Materialize {{var}} placeholders inside schedule variables using
    # the same install-time vars the workflow was materialized with.
    # Layer template defaults from .json over our installer vars in case
    # the schedule.json references them.
    schedule_vars: dict[str, str] = dict(sched.get("variables", {}) or {})
    for k, v in vars.items():
        if k not in schedule_vars:
            schedule_vars[k] = v

    enabled = bool(sched.get("enabled", True))
    # IANA timezone (e.g. "America/Los_Angeles"). If the sibling declares one we
    # MUST forward it — the brain defaults to UTC otherwise, so a `0 7 * * *`
    # local-morning cron would silently re-register at 7am UTC on every
    # re-install. None → brain keeps its UTC default (unchanged behavior).
    tz_raw = sched.get("timezone")
    timezone = tz_raw if isinstance(tz_raw, str) and tz_raw.strip() else None

    # Guard against creating a SECOND schedule for the same workflow.
    #
    # Install no longer tears down every schedule referencing the workflow
    # (upsert made that unnecessary, and the teardown destroyed hand-tuned
    # schedules). But that removes the accident that used to mask a rename:
    # if the live schedule carries an id different from the bundled
    # sibling's, a blind add would leave BOTH in place and the workflow
    # would fire twice a night.
    #
    # So: if some other schedule already targets this workflow, leave it
    # alone and say so. Destroying a live schedule and silently doubling one
    # are both worse than declining and reporting.
    try:
        for sched in client.schedule_list():
            if not isinstance(sched, dict):
                continue
            # MCP returns camelCase; be defensive.
            ref = sched.get("workflowId") or sched.get("workflow_id")
            if ref != wf_id:
                continue
            existing_id = sched.get("id") or sched.get("scheduleId")
            if isinstance(existing_id, str) and existing_id != schedule_id:
                return (
                    f"schedule '{existing_id}' already targets this workflow "
                    f"(bundled id is '{schedule_id}') — left as-is; "
                    f"remove one to converge"
                )
    except BrainClientError:
        # Can't enumerate: fall through to the id-scoped replace below,
        # which is the pre-existing behavior.
        pass

    # Idempotent install: drop any prior schedule with this id, then
    # re-create. Swallow not-found on first install.
    try:
        client.schedule_remove(schedule_id)
    except BrainClientError:
        pass
    try:
        client.schedule_add(
            schedule_id=schedule_id,
            template_id=wf_id,
            cron_expr=cron_expr,
            variables=schedule_vars,
            enabled=enabled,
            timezone=timezone,
        )
    except BrainClientError as e:
        return f"schedule_add failed: {e}"
    tz_note = f" tz='{timezone}'" if timezone else ""
    return f"+ schedule '{schedule_id}' cron='{cron_expr}'{tz_note}"


def install_workflows(
    workflow_paths: Iterable[Path],
    vars: dict[str, str],
    client: Optional[BrainClient] = None,
) -> list[tuple[Path, bool, str]]:
    """Materialize + import each workflow. Returns one tuple per file:
    (path, ok, message). Doesn't raise — caller decides how to react to
    partial failures (CLI surfaces non-zero exit on any failure).

    Each template's own `variables.defaultValue` entries are applied for
    any vars the caller didn't supply, mirroring the brain's runtime
    behavior. This means optional vars in nightly.json (e.g.
    classifier_agent_id, taste_staging_path) get their defaults
    materialized into dispatch fields automatically.

    Bundled-schedule convention: if a sibling <workflow-name>.schedule.json
    file exists, the schedule is registered (idempotently) after import.
    This lets `digital-me install --runtime dashboard` land a ticking cron
    in one shot — no separate `tasks.schedule_add` step required."""
    client = client or BrainClient()
    results: list[tuple[Path, bool, str]] = []
    for wf_path in workflow_paths:
        try:
            template = json.loads(wf_path.read_text(encoding="utf-8"))
            effective_vars = _apply_template_defaults(template, vars)
            materialized = materialize_workflow(template, effective_vars)
            wf_id = template.get("id", "?")
            # Stamp provenance so `digital-me doctor` can tell whether the
            # live template still matches the file it came from. The hash is
            # of the file's RAW bytes, pre-substitution: it answers "has the
            # source changed since import", which is the question drift asks.
            materialized["source"] = {
                "path": str(wf_path.resolve()),
                "hash": _hash_file(wf_path),
                "version": _package_version(),
            }
            # Upsert replaces the template and its steps in place. The old
            # path here was delete-then-import, which required first removing
            # EVERY schedule referencing the workflow (the brain refuses to
            # delete an workflow an enabled schedule points at) and then
            # re-registering only what the sibling .schedule.json describes —
            # so any live schedule with no sibling, or with hand-tuned
            # variables, was silently destroyed by a routine re-install.
            # Upsert keeps schedules untouched and removes the window where
            # the workflow does not exist.
            client.import_workflow(materialized, upsert=True)
        except (OSError, json.JSONDecodeError) as e:
            results.append((wf_path, False, f"failed to read/parse: {e}"))
            continue
        except BrainClientError as e:
            results.append((wf_path, False, f"gateway error: {e}"))
            continue
        # Workflow imported. Try the sibling schedule if one ships.
        sched_status = _register_sibling_schedule(wf_path, wf_id, effective_vars, client)
        message = f"imported '{wf_id}'"
        if sched_status:
            message = f"{message}; {sched_status}"
        results.append((wf_path, True, message))
    return results


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="digital-me-dream-cycle install-workflows",
        description=(
            "Import bundled dream-cycle workflows into the openclaw brain. "
            "Run by `digital-me install --runtime dream-cycle`."
        ),
    )
    parser.add_argument(
        "--wiki-root",
        type=Path,
        default=None,
        help="Wiki root path (overrides $DIGITAL_ME_WIKI_ROOT; defaults to ~/digital-me).",
    )
    parser.add_argument(
        "--workflows-dir",
        type=Path,
        default=None,
        help="Override bundled workflows directory (default: dream_cycle/workflows/).",
    )
    parser.add_argument(
        "--classifier-agent-id",
        type=str,
        default=None,
        help="Override the agentId for the taste-distill step (detected worker applies otherwise).",
    )
    parser.add_argument(
        "--compiler-agent-id",
        type=str,
        default=None,
        help="Override the agentId for the compile-extract step (detected worker applies otherwise).",
    )
    parser.add_argument(
        "--dashboard-db",
        type=Path,
        default=None,
        help=(
            "Absolute path to the dashboard SQLite DB. Supplied to workflows "
            "that declare a `dashboard_db` variable (e.g. dashboard-intake). "
            "Ignored by workflows that don't reference it."
        ),
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    wiki_root = resolve_wiki_root(args.wiki_root)
    python_path = sys.executable

    overrides: dict[str, str] = {}
    if args.classifier_agent_id:
        overrides["classifier_agent_id"] = args.classifier_agent_id
    if args.compiler_agent_id:
        overrides["compiler_agent_id"] = args.compiler_agent_id
    if args.dashboard_db:
        overrides["dashboard_db"] = str(args.dashboard_db)

    # Bind the agent steps to a worker that actually exists on this machine.
    # Explicit flags win; otherwise detect. Failing loudly here beats importing
    # a workflow whose agent steps cannot run: an unresolvable exec alias falls
    # through to the step's placeholder command, and a placeholder that exits 0
    # would make the nightly report success while doing nothing.
    detected = detect_worker_agent_id(wiki_root)
    explicit = bool(args.classifier_agent_id and args.compiler_agent_id)
    if detected is None and not explicit:
        print(
            "install-workflows: no CLI worker alias configured.\n"
            f"  Looked for {' or '.join(WORKER_AGENT_PREFERENCE)} under "
            f"cli_exec_aliases in {wiki_root / 'config.yaml'}.\n"
            "  The agent steps (wiki extraction, taste distillation) cannot run "
            "without one.\n"
            "  Fix: install the Claude Code CLI or the Codex CLI and re-run "
            "`digital-me setup`, which registers the alias.\n"
            "  Override: pass --classifier-agent-id / --compiler-agent-id "
            "to name a worker explicitly.",
            file=sys.stderr,
        )
        return 4
    if detected is not None:
        overrides.setdefault("classifier_agent_id", detected)
        overrides.setdefault("compiler_agent_id", detected)
        print(
            f"install-workflows: worker agent = {detected} (detected)",
            file=sys.stderr,
        )

    vars = _build_install_vars(wiki_root, python_path, overrides)
    paths = discover_bundled_workflows(args.workflows_dir)

    if not paths:
        print(
            "install-workflows: no bundled workflows found — "
            "check that the package installed correctly.",
            file=sys.stderr,
        )
        return 0  # not an error per se; just nothing to do.

    print(f"install-workflows: wiki_root={wiki_root}", file=sys.stderr)
    print(f"install-workflows: python_path={python_path}", file=sys.stderr)
    print(f"install-workflows: found {len(paths)} workflow(s)", file=sys.stderr)

    try:
        results = install_workflows(paths, vars)
    except BrainClientError as e:
        print(f"install-workflows: gateway unreachable: {e}", file=sys.stderr)
        return 3

    exit_code = 0
    for path, ok, msg in results:
        marker = "[OK]" if ok else "[FAIL]"
        print(f"  {marker} {path.name}: {msg}", file=sys.stderr)
        if not ok:
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
