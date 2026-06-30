"""Import the bundled digest workflow into the openclaw brain.

Called by `digital-me install --runtime digest` after the venv + pip install
succeed. Discovers `digest/workflows/*.json`, materializes the dispatch
placeholders ({{python_path}}, {{wiki_root}}, plus the workflow's own
defaults), and registers each workflow + its sibling schedule — so a fresh
install lands a ticking 7am digest with no manual `workflow_import` step.

Reuse, not reinvention: the brain client + workflow materialization + the
idempotent delete-then-import + sibling-schedule registration all live in the
dream-cycle package, which is installed in the same venv as the digest (the
digest's optional inline-summary fallback already imports it). We point that
proven machinery at the digest's own workflows directory rather than
duplicating ~200 lines of brain-client code. If that shared infrastructure
ever graduates into its own package, this import line is the only thing that
moves.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional

from digest.config import resolve_wiki_root

# Shared infra from the sibling dream-cycle package (same venv).
from dream_cycle.install_workflows import (  # type: ignore
    _build_install_vars,
    install_workflows,
)
from dream_cycle.brain_client import BrainClientError  # type: ignore


def _bundled_workflows_dir() -> Path:
    """The workflows/ directory shipped inside the installed digest package."""
    return Path(__file__).parent / "workflows"


def discover_bundled_workflows(directory: Optional[Path] = None) -> list[Path]:
    """List bundled workflow JSON files, excluding sibling `*.schedule.json`
    companions (handled during import), sorted for deterministic order."""
    d = directory or _bundled_workflows_dir()
    if not d.exists():
        return []
    return sorted(
        p for p in d.glob("*.json")
        if p.is_file() and not p.name.endswith(".schedule.json")
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="digital-me-digest install-workflows",
        description=(
            "Import the bundled digest workflow into the openclaw brain. "
            "Run by `digital-me install --runtime digest`."
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
        help="Override bundled workflows directory (default: digest/workflows/).",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    wiki_root = resolve_wiki_root(args.wiki_root)
    python_path = sys.executable

    vars = _build_install_vars(wiki_root, python_path)
    paths = discover_bundled_workflows(args.workflows_dir)

    if not paths:
        print(
            "install-workflows: no bundled digest workflows found — "
            "check that the package installed correctly.",
            file=sys.stderr,
        )
        return 0

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
