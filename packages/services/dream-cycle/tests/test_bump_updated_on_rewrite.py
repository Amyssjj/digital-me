"""Tests for the 'bump updated: on rewrite' producer-side fix.

Regression: dream-cycle's auto-rewrite paths (crosslink for `related:`,
consolidate for `domain:` / `supersedes:`) used to leave frontmatter
`updated:` stuck at the original distillation date even after rewriting
the file content. The dashboard intake (which trusts frontmatter dates
since 2026-05-28's cleanup) then silently dropped that activity from
the per-day knowledge + taste flow chart.

After the fix, both writers bump `updated:` to today when they rewrite,
so the producer is the source of truth and the consumer trusts it.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
import yaml

from dream_cycle.crosslink import update_frontmatter_related
from dream_cycle.consolidate import _update_frontmatter_field


SAMPLE_FRONTMATTER = """---
title: A sample principle
domain: infra
status: promoted
created: '2026-04-01'
updated: '2026-04-15'
tags:
- taste
---


## Body
Some body text here.
"""


def _read_fm(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    parts = raw.split("---", 2)
    assert len(parts) >= 3, f"file has no frontmatter: {raw!r}"
    return yaml.safe_load(parts[1]) or {}


# ── crosslink.update_frontmatter_related ─────────────────────────────────────


def test_crosslink_bumps_updated_to_today(tmp_path: Path) -> None:
    """Rewriting `related:` must bump `updated:` to today's ISO date."""
    f = tmp_path / "principle.md"
    f.write_text(SAMPLE_FRONTMATTER, encoding="utf-8")

    update_frontmatter_related(f, related=["other-principle.md"])

    fm = _read_fm(f)
    assert fm["related"] == ["other-principle.md"]
    assert fm["updated"] == date.today().isoformat()


def test_crosslink_preserves_existing_fields(tmp_path: Path) -> None:
    """Bumping updated: must not clobber unrelated frontmatter fields."""
    f = tmp_path / "principle.md"
    f.write_text(SAMPLE_FRONTMATTER, encoding="utf-8")

    update_frontmatter_related(f, related=["foo.md", "bar.md"])

    fm = _read_fm(f)
    assert fm["title"] == "A sample principle"
    assert fm["domain"] == "infra"
    assert fm["status"] == "promoted"
    assert fm["created"] == "2026-04-01"  # created stays stable
    assert fm["tags"] == ["taste"]


def test_crosslink_preserves_body(tmp_path: Path) -> None:
    """The body content after the frontmatter must round-trip unchanged."""
    f = tmp_path / "principle.md"
    f.write_text(SAMPLE_FRONTMATTER, encoding="utf-8")

    update_frontmatter_related(f, related=["x.md"])

    raw = f.read_text(encoding="utf-8")
    assert "## Body" in raw
    assert "Some body text here." in raw


def test_crosslink_noop_on_missing_frontmatter(tmp_path: Path) -> None:
    """No-op when the file doesn't start with '---' — no exception, no write."""
    f = tmp_path / "bare.md"
    f.write_text("just a body\n", encoding="utf-8")

    # Should not raise, should not write
    update_frontmatter_related(f, related=["x.md"])
    assert f.read_text() == "just a body\n"


# ── consolidate._update_frontmatter_field ────────────────────────────────────


def test_consolidate_bumps_updated_to_today(tmp_path: Path) -> None:
    """Updating a single field (e.g. `domain:`) must bump `updated:` to today."""
    f = tmp_path / "principle.md"
    f.write_text(SAMPLE_FRONTMATTER, encoding="utf-8")

    _update_frontmatter_field(f, "domain", "infrastructure")

    fm = _read_fm(f)
    assert fm["domain"] == "infrastructure"
    assert fm["updated"] == date.today().isoformat()


def test_consolidate_preserves_other_fields(tmp_path: Path) -> None:
    """Single-field update must not touch other frontmatter fields."""
    f = tmp_path / "principle.md"
    f.write_text(SAMPLE_FRONTMATTER, encoding="utf-8")

    _update_frontmatter_field(f, "supersedes", "old-principle.md")

    fm = _read_fm(f)
    assert fm["supersedes"] == "old-principle.md"
    assert fm["title"] == "A sample principle"
    assert fm["domain"] == "infra"  # unchanged
    assert fm["created"] == "2026-04-01"


def test_consolidate_noop_on_malformed_yaml(tmp_path: Path) -> None:
    """Silently no-op when the YAML between --- markers is unparseable."""
    f = tmp_path / "broken.md"
    f.write_text("---\nthis is: : : not [valid yaml\n---\nbody\n", encoding="utf-8")

    # Should not raise, should not write
    _update_frontmatter_field(f, "domain", "x")
    assert "this is" in f.read_text()  # original content preserved
