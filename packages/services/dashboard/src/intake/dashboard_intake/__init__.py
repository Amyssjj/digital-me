"""Dashboard intake pipeline (NUX scope-down §B).

Four steps that populate `dashboard.db` from primary sources:

  1. collect_transcripts       — runtime transcripts → daa
  2. scan_knowledge_trees      — ~/digital-me/{wiki,tastes}/ → knowledge_taste_changes
                                                              + knowledge_taste_distribution
  3. derive_application_rate   — ~/.claude/hooks/*.log → application_rate (+ by_domain, by_agent)
  4. stream_activity           — brain (traces ⨝ learnings, m1_events, goals) → activity

Each module is independently runnable as `python -m dashboard_intake.<step>`
or via the entry point scripts registered in pyproject.toml. They share the
small DB helpers in `db.py` and the path/config helpers here.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

__version__ = "0.1.0"

# Canonical install marker — a symlink to the workspace package, used by
# `digital-me doctor`'s runtime expectations. The actual DB now lives
# under ~/digital-me/.data/ (collapsed root, see DEFAULT_DB_PATH below).
DEFAULT_INSTALL_DIR = (
    Path.home() / ".local" / "share" / "digital-me" / "dashboard"
)

# Default DB path. Override via DASHBOARD_DB env var for testing.
# Lives under ~/digital-me/.data/ to keep everything digital-me-owned
# rooted at ~/digital-me/ — same place the wiki + tastes trees live,
# .data/ hidden because it's machine-managed (regenerable from primary
# sources within one cron tick).
DEFAULT_DB_PATH = Path.home() / "digital-me" / ".data" / "dashboard.db"


def db_path() -> Path:
    """Resolve the active dashboard DB path. Respects DASHBOARD_DB if set."""
    override = os.environ.get("DASHBOARD_DB")
    if override:
        return Path(override).expanduser()
    return DEFAULT_DB_PATH


def digital_me_root() -> Path:
    """The Digital Me data root — wiki/, tastes/ and .data/ live under it.

    ``$DIGITAL_ME_WIKI_ROOT`` names this ROOT (docs/CONTRACTS.md; brain-host's
    service env sets it to ``~/digital-me``), default ``~/digital-me``. Until
    2026-09 this module read the variable as the wiki directory itself; once
    brain-host started exporting the contract value, the scan walked all of
    ~/digital-me as "wiki" and looked for tastes beside it. A value that still
    names the wiki directory (``…/wiki`` with no ``wiki/`` inside) is tolerated.
    """
    override = os.environ.get("DIGITAL_ME_WIKI_ROOT")
    if not override:
        return Path.home() / "digital-me"
    root = Path(override).expanduser()
    if root.name == "wiki" and not (root / "wiki").is_dir():
        return root.parent
    return root


def wiki_root() -> Path:
    """The wiki tree: ``$DIGITAL_ME_WIKI_DIR``, else ``<root>/wiki``."""
    override = os.environ.get("DIGITAL_ME_WIKI_DIR")
    if override:
        return Path(override).expanduser()
    return digital_me_root() / "wiki"


def brain_db_path(explicit: Optional[Path] = None) -> Path:
    """Where brain.db lives — the rule every digital-me reader shares
    (Python twin of ``@digital-me/contracts`` ``resolveBrainDbPath``):
    arg → $DIGITAL_ME_BRAIN_DB (or the intake's older $OPENCLAW_BRAIN_DB) →
    <root>/.data/brain.db when it exists → the legacy
    <OPENCLAW_HOME or ~/.openclaw>/data/brain.db when it exists → canonical.
    """
    if explicit is not None:
        return explicit.expanduser()
    override = os.environ.get("DIGITAL_ME_BRAIN_DB") or os.environ.get("OPENCLAW_BRAIN_DB")
    if override:
        return Path(override).expanduser()
    canonical = digital_me_root() / ".data" / "brain.db"
    if canonical.exists():
        return canonical
    oc_home = os.environ.get("OPENCLAW_HOME")
    legacy = (Path(oc_home).expanduser() if oc_home else Path.home() / ".openclaw") / "data" / "brain.db"
    if legacy.exists():
        return legacy
    return canonical


def tastes_root() -> Path:
    """The tastes tree: ``$DIGITAL_ME_TASTES_DIR``, else ``<root>/tastes``."""
    override = os.environ.get("DIGITAL_ME_TASTES_DIR")
    if override:
        return Path(override).expanduser()
    return digital_me_root() / "tastes"
