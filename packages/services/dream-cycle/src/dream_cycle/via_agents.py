"""`digital-me dream-cycle --via-agents` — orchestrate the dream-cycle via
brain-orchestrator spawn-dispatch instead of inline-Python LLM calls.

Routes:
  1. Reads the bundled workflow.json to get the current template id.
  2. POSTs `tasks(action='run_workflow', ...)` to the openclaw gateway via
     BrainClient. The gateway instantiates the goal AND inline-dispatches
     the first ready spawn task in the same gateway-request context —
     sidestepping the cron-tick subagent-scope bug (see
     wiki/architecture/brain-orchestrator-spawn-dispatch-via-http.md).
  3. Polls the goal's status via `tasks(action='board', format='json')`
     until terminal (completed | failed | cancelled) or timeout.
  4. Surfaces per-task final state + exit code.

Exit codes:
  0  goal completed
  1  goal failed or cancelled
  2  poll timed out before goal terminal
  3  gateway unreachable or returned an error during run_workflow
  4  couldn't parse goalId from gateway response (schema drift)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any, Optional

from dream_cycle.brain_client import BrainClient, BrainClientError
from dream_cycle.config import resolve_wiki_root


_VAR_RE = re.compile(r"\{\{(\w+)\}\}")


def _load_bundled_workflow() -> dict[str, Any]:
    """Load the nightly workflow bundled with this package.

    Per b183d66 the legacy single-file workflow.json was replaced by a
    workflows/ directory; nightly.json is the canonical default.
    """
    wf_path = Path(__file__).parent / "workflows" / "nightly.json"
    return json.loads(wf_path.read_text(encoding="utf-8"))


def _bundled_workflow_id() -> str:
    """Read the workflow id from the bundled nightly workflow. Keeping
    this here (vs. hardcoded) means a workflows/nightly.json version
    bump doesn't require touching via_agents.py."""
    return _load_bundled_workflow()["id"]


def _substitute_vars(s: str, vars: dict[str, str]) -> str:
    """Replace `{{name}}` in `s` with `vars[name]`. Unknown names are
    preserved as-is — mirrors the brain-orchestrator's interpolator
    behavior so a partial pass produces the same final text."""
    return _VAR_RE.sub(lambda m: vars.get(m.group(1), m.group(0)), s)


def materialize_workflow(
    template: dict[str, Any], vars: dict[str, str]
) -> dict[str, Any]:
    """Recursively substitute `{{var}}` in every string value of the
    workflow template. Returns a fresh dict; doesn't mutate input.

    Why this exists: the brain-orchestrator's `instantiateWorkflow`
    only interpolates `task.task` (the promptTemplate). It does NOT
    interpolate `dispatch.command`, `dispatch.cwd`, or `dispatch.env`,
    so workflows that reference `{{wiki_root}}` or `{{python_path}}`
    in their exec dispatches ship the literal `{{var}}` string to the
    executor and fail.

    via_agents handles this client-side by materializing the entire
    template before import. Substituted promptTemplates round-trip
    fine — the brain re-interpolates and finds nothing to substitute."""

    def _walk(node: Any) -> Any:
        if isinstance(node, str):
            return _substitute_vars(node, vars)
        if isinstance(node, list):
            return [_walk(item) for item in node]
        if isinstance(node, dict):
            return {k: _walk(v) for k, v in node.items()}
        return node

    return _walk(template)


def _extract_goal_id(run_workflow_result: dict[str, Any]) -> Optional[str]:
    """Pull goalId out of the gateway envelope. The current shape is
    `result.details.json.goalId` but be defensive — older variants put
    it at the top level."""
    if not isinstance(run_workflow_result, dict):
        return None
    direct = run_workflow_result.get("goalId")
    if isinstance(direct, str) and direct:
        return direct
    details = run_workflow_result.get("details")
    if isinstance(details, dict):
        json_payload = details.get("json")
        if isinstance(json_payload, dict):
            val = json_payload.get("goalId")
            if isinstance(val, str) and val:
                return val
    return None


def _format_task_line(task: dict[str, Any]) -> str:
    attempts = task.get("attempts", []) if isinstance(task, dict) else []
    last = attempts[-1] if attempts else None
    fail = ""
    direct_fail = task.get("failureReason") if isinstance(task, dict) else None
    attempt_fail = last.get("failureReason") if isinstance(last, dict) else None
    msg = direct_fail or attempt_fail
    if isinstance(msg, str) and msg:
        fail = f"  failure: {msg[:120]}"
    return f"  {task.get('name', '?'):42s} status={task.get('status', '?'):11s} attempts={len(attempts)}{fail}"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="digital-me dream-cycle --via-agents",
        description=(
            "Run the dream-cycle via brain-orchestrator spawn-dispatch. "
            "Requires the openclaw gateway running with the brain plugin "
            "installed AND the dream-cycle workflow imported "
            "(use `digital-me dream-cycle import-workflow <path>`)."
        ),
    )
    parser.add_argument(
        "--wiki-root",
        type=Path,
        default=None,
        help="Wiki root path (overrides $DIGITAL_ME_WIKI_ROOT; defaults to ~/digital-me).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Pass dry_run=true to the workflow (consolidate proposes only).",
    )
    parser.add_argument(
        "--template-id",
        default=None,
        help="Override the workflow template id (default: read from the bundled workflow.json).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=3600.0,
        help="Max seconds to wait for goal completion (default: 3600).",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=10.0,
        help="Seconds between status polls (default: 10).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Run even if another goal for this workflow is already active.",
    )
    return parser


def run(args: argparse.Namespace, client: Optional[BrainClient] = None) -> int:
    """Library-callable entry. `client` injection enables testing."""
    wiki_root = resolve_wiki_root(args.wiki_root)
    today = date.today().isoformat()
    python_path = sys.executable

    template = _load_bundled_workflow()

    # Build the substitution vars in two passes so the client side matches
    # what brain-orchestrator's instantiateWorkflow() does:
    #   1. Seed defaults from template.variables[].defaultValue — this
    #      keeps optional knobs (compile_limit, taste_limit, recent_days,
    #      taste_staging_path, classifier_agent_id) substituted in
    #      dispatch.command without the user having to pass each one.
    #   2. Layer the per-invocation values on top.
    # python_path is auto-supplied so workflow.json's exec dispatches
    # resolve to the venv where dream_cycle is actually installed — not
    # whichever python3 the gateway daemon's PATH happens to find first.
    vars: dict[str, str] = {}
    for v in template.get("variables", []):
        name = v.get("name")
        default = v.get("defaultValue")
        if isinstance(name, str) and isinstance(default, str):
            vars[name] = default
    vars.update({
        "wiki_root": str(wiki_root),
        "date": today,
        "dry_run": "true" if args.dry_run else "false",
        "python_path": python_path,
    })

    materialized = materialize_workflow(template, vars)
    template_id = args.template_id or materialized["id"]

    client = client or BrainClient()
    print(f"gateway:     {client.gateway.url}", file=sys.stderr)
    print(f"template:    {template_id}", file=sys.stderr)
    print(f"wiki_root:   {wiki_root}", file=sys.stderr)
    print(f"python_path: {python_path}", file=sys.stderr)
    print(f"dry_run:     {args.dry_run}", file=sys.stderr)
    print(f"force:       {args.force}", file=sys.stderr)
    print("", file=sys.stderr)

    # Import (or overwrite) the materialized template every run. The brain
    # only interpolates promptTemplate at run_workflow time, so dispatch
    # fields need to be substituted client-side BEFORE the template gets
    # stored.
    print("importing materialized workflow...", file=sys.stderr)
    try:
        client.import_workflow(materialized)
    except BrainClientError as e:
        print(f"workflow import failed: {e}", file=sys.stderr)
        return 3

    try:
        result = client.run_workflow(
            template_id=template_id,
            variables=vars,
            force=args.force,
        )
    except BrainClientError as e:
        print(f"run_workflow failed: {e}", file=sys.stderr)
        return 3

    goal_id = _extract_goal_id(result)
    if not goal_id:
        print(
            f"could not extract goalId from gateway response: {result}",
            file=sys.stderr,
        )
        return 4

    details_json = (
        result.get("details", {}).get("json", {}) if isinstance(result, dict) else {}
    )
    print(f"goalId:      {goal_id}", file=sys.stderr)
    print(
        f"dispatched:  {details_json.get('dispatched', 0)} of "
        f"{details_json.get('taskCount', 0)}",
        file=sys.stderr,
    )
    print("", file=sys.stderr)
    print(f"polling for completion (timeout {args.timeout:.0f}s)...", file=sys.stderr)

    try:
        goal = client.wait_for_goal(
            goal_id,
            timeout_s=args.timeout,
            poll_interval_s=args.poll_interval,
        )
    except BrainClientError as e:
        # Distinguish timeout from goal-vanished: both surface as
        # BrainClientError, but the message differs. Keep the exit-code
        # mapping simple — 2 covers both "didn't finish in time" cases.
        print(f"wait failed: {e}", file=sys.stderr)
        return 2

    status = goal.get("status") if isinstance(goal, dict) else None
    print("", file=sys.stderr)
    print(f"goal final status: {status}", file=sys.stderr)
    for t in goal.get("tasks", []) if isinstance(goal, dict) else []:
        print(_format_task_line(t), file=sys.stderr)

    return 0 if status == "completed" else 1


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
