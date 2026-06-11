"""CLI helper: import a workflow.json file into the openclaw brain.

Wraps :class:`dream_cycle.brain_client.BrainClient`'s ``import_workflow``
so users don't need an MCP-connected agent session to land their workflow
template — they can just run ``digital-me dream-cycle import-workflow
<path>``.

Examples::

    # Import the bundled dream-cycle workflow
    digital-me dream-cycle import-workflow \\
        $(python -c "import dream_cycle, pathlib; print(pathlib.Path(dream_cycle.__file__).parent / 'workflow.json')")

    # Import a custom workflow.json
    digital-me dream-cycle import-workflow /path/to/my-workflow.json

Exit codes:
    0  success
    1  the gateway rejected the workflow (validation failure)
    2  CLI usage error / file unreadable
    3  gateway unreachable or auth error
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional

from dream_cycle.brain_client import BrainClient, BrainClientError


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="digital-me dream-cycle import-workflow",
        description="Import a workflow.json into the openclaw brain via the gateway HTTP API.",
    )
    parser.add_argument(
        "workflow_path",
        type=Path,
        help="Path to a workflow.json file. The file must be valid JSON conforming "
        "to the brain-orchestrator workflow template schema.",
    )
    return parser


def _load_template(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"workflow file not found: {path}")
    raw = path.read_text(encoding="utf-8")
    try:
        template = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"{path} is not valid JSON: {e}") from e
    if not isinstance(template, dict):
        raise ValueError(f"{path} must contain a JSON object, got {type(template).__name__}")
    return template


def run(workflow_path: Path, client: Optional[BrainClient] = None) -> int:
    """Library-callable entry point. Returns the process exit code."""
    try:
        template = _load_template(workflow_path)
    except (FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    template_id = template.get("id", "<unknown>")
    print(
        f"Importing workflow '{template_id}' from {workflow_path}",
        file=sys.stderr,
    )

    try:
        client = client or BrainClient()
        result = client.import_workflow(template)
    except BrainClientError as e:
        print(f"gateway error: {e}", file=sys.stderr)
        return 3

    # The builder result lands inside `result` either directly or via
    # the MCP envelope's content[].text. We surface whatever we got;
    # callers can inspect stderr if the import was rejected.
    if isinstance(result, dict) and result.get("ok") is False:
        print(f"workflow rejected: {result.get('error', result)}", file=sys.stderr)
        return 1
    print(f"OK: {result}", file=sys.stderr)
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    return run(args.workflow_path)


if __name__ == "__main__":
    sys.exit(main())
