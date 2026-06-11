"""Importing every module under dream_cycle must succeed.

This catches any regressions where the dist of the package fails to find
a referenced sibling — e.g. a stale `sys.path.insert` strip leaving an
unresolved import.
"""

from __future__ import annotations

import importlib


MODULES = [
    "dream_cycle",
    "dream_cycle.apply_taste",
    "dream_cycle.backfill_types",
    "dream_cycle.brain_learnings",
    "dream_cycle.bundles",
    "dream_cycle.citations",
    "dream_cycle.compile",
    "dream_cycle.config",
    "dream_cycle.consolidate",
    "dream_cycle.crosslink",
    "dream_cycle.distill",
    "dream_cycle.drift_check",
    "dream_cycle.engine",
    "dream_cycle.health_detector",
    "dream_cycle.index",
    "dream_cycle.integrations.codex",
    "dream_cycle.lint",
    "dream_cycle.run",
]


def test_every_module_imports() -> None:
    failures: list[str] = []
    for name in MODULES:
        try:
            importlib.import_module(name)
        except Exception as e:  # noqa: BLE001 — surface in the assertion msg.
            failures.append(f"{name}: {type(e).__name__}: {e}")
    assert not failures, "\n".join(failures)
