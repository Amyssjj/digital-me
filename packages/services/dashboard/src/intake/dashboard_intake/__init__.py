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


def wiki_root() -> Path:
    """Resolve the active wiki root. Respects DIGITAL_ME_WIKI_ROOT or
    falls back to ~/digital-me/wiki/."""
    override = os.environ.get("DIGITAL_ME_WIKI_ROOT")
    if override:
        return Path(override).expanduser()
    return Path.home() / "digital-me" / "wiki"


def tastes_root() -> Path:
    """Resolve the tastes tree (lives next to the wiki under ~/digital-me/)."""
    wiki = wiki_root()
    return wiki.parent / "tastes"
