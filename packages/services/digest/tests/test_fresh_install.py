"""A fresh install has no legacy files. The digest must never hard-depend on
one: the retired `~/.openclaw/data/task-orchestrator.db` used to be opened
read-only by the deterministic render path, which raises `unable to open
database file` when the file is absent -- taking down the very fallback that
exists for when the summarizer handoff is missing.
"""

import inspect
import re

from digest import daily_digest as dd


def test_no_retired_orchestrator_db_constant():
    assert not hasattr(dd, "ORCH_DB")
    assert not hasattr(dd, "_coo_goals")


def test_only_configured_databases_are_opened():
    """Every sqlite open goes through a config-resolved path (`BRAIN_DB` from
    digest.config) or the codex state DB discovered next to its sessions --
    never a literal home-relative file."""
    src = inspect.getsource(dd)
    assert "task-orchestrator.db" not in src
    opened = set(re.findall(r'sqlite3\.connect\(f"file:\{(\w+)\}\?mode=ro"', src))
    assert opened, "expected at least one read-only sqlite open"
    assert opened <= {"BRAIN_DB", "db"}, opened
