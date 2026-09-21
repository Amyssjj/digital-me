"""apply_skill_outcome: evidence outcomes must resolve their fingerprint from
`matched_existing_fingerprint` when the classifier leaves
`principle_fingerprint` null.

Regression for the 2026-09-21 nightly (goal 51f6eca0): four evidence
outcomes with `principle_fingerprint: null` + a verbatim
`matched_existing_fingerprint` were all dropped with
`apply_skill_outcome returned None`, so the daily log showed
`evidence-appended: 0, errors: 4` even though every matched leaf existed.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from dream_cycle import compile as compile_mod
from dream_cycle.compile import (
    _read_evidence_records,
    _read_frontmatter,
    apply_skill_outcome,
)

FINGERPRINT = "Hierarchy comes from spacing and scale, not decorative chrome."


@pytest.fixture
def tastes_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "tastes"
    (root / "design").mkdir(parents=True)
    monkeypatch.setattr(compile_mod, "SKILL_PROPOSALS_DIR", root)
    return root


def _seed_candidate(tastes_dir: Path) -> Path:
    """One candidate leaf with a single evidence record, as the pipeline
    writes it (so status/evidence_count round-trip through the real writer)."""
    path = tastes_dir / "design" / "hierarchy-through-space-not-chrome.md"
    fm = {
        "title": "Hierarchy through space, not chrome",
        "domain": "design",
        "principle_fingerprint": FINGERPRINT,
        "status": "candidate",
        "priority": "search",
        "citations": 0,
        "tags": ["taste"],
        "evidence_count": 1,
        "fire_signature": ["adding borders to separate sections"],
        "rubric_items": [],
        "near_misses": [],
        "parents": [],
        "created": "2026-09-01",
        "updated": "2026-09-01",
    }
    records = [{
        "project_id": "seed-project",
        "date": "2026-09-01",
        "wiki_paths": [],
        "what_happened": "Removed dividers; used whitespace to group.",
        "what_triggers_principle": "reaching for a border",
    }]
    return compile_mod._write_principle_file(path, fm, records, "seed rationale")


def _evidence_outcome(**overrides) -> dict:
    base = {
        "transcript_index": 0,
        "outcome": "evidence",
        "domain": "design",
        # Exactly the shape the nightly classifier emits for evidence.
        "principle_fingerprint": None,
        "matched_existing_fingerprint": FINGERPRINT,
        "evidence_record": {
            "project_id": "digital-me-os",
            "date": "2026-09-21",
            "wiki_paths": ["design/some-entry.md"],
            "what_happened": "Dashboard redesign dropped card borders for spacing.",
            "what_triggers_principle": "boxing content to show grouping",
        },
        "fire_signature_hints": ["wrapping every section in a card"],
        "rubric_item_candidates": ["does grouping survive with borders removed?"],
        "near_miss_observed": None,
        "rationale": "Second independent instance of the spacing principle.",
    }
    base.update(overrides)
    return base


def test_evidence_with_only_matched_fingerprint_is_appended(tastes_dir: Path) -> None:
    seeded = _seed_candidate(tastes_dir)

    result = apply_skill_outcome(_evidence_outcome())

    assert result is not None, "evidence with null principle_fingerprint must not be dropped"
    path, action = result
    assert path == seeded
    # Second evidence record on a candidate crosses the promotion threshold.
    assert action == "promoted-to-leaf"

    fm = _read_frontmatter(seeded)
    assert fm is not None
    assert fm["status"] == "promoted"
    assert fm["evidence_count"] == 2
    assert fm["principle_fingerprint"] == FINGERPRINT
    assert "wrapping every section in a card" in fm["fire_signature"]
    assert "does grouping survive with borders removed?" in fm["rubric_items"]

    records = _read_evidence_records(seeded)
    assert len(records) == 2
    assert records[1]["project_id"] == "digital-me-os"
    assert records[1]["what_happened"].startswith("Dashboard redesign")

    # No stray candidate file was created alongside the matched leaf.
    assert sorted(p.name for p in (tastes_dir / "design").glob("*.md")) == [seeded.name]


def test_evidence_appends_then_second_evidence_promotes(tastes_dir: Path) -> None:
    """Start from a promoted-free tree: first evidence lands as
    evidence-appended on a fresh candidate (count 1 → 2 promotes), so seed a
    leaf with ZERO records to observe the two-step append → promote flow."""
    path = tastes_dir / "design" / "hierarchy-through-space-not-chrome.md"
    fm = {
        "title": "Hierarchy through space, not chrome",
        "domain": "design",
        "principle_fingerprint": FINGERPRINT,
        "status": "candidate",
        "evidence_count": 0,
        "fire_signature": [],
        "rubric_items": [],
        "near_misses": [],
        "created": "2026-09-01",
        "updated": "2026-09-01",
    }
    compile_mod._write_principle_file(path, fm, [], None)

    first = apply_skill_outcome(_evidence_outcome())
    assert first == (path, "evidence-appended")
    fm1 = _read_frontmatter(path)
    assert fm1 is not None
    assert fm1["status"] == "candidate"
    assert fm1["evidence_count"] == 1

    second = apply_skill_outcome(_evidence_outcome(
        evidence_record={
            "project_id": "motus-ai-web",
            "date": "2026-09-22",
            "wiki_paths": [],
            "what_happened": "Landing page hero dropped its outlined panels.",
            "what_triggers_principle": "outlining a hero block",
        },
    ))
    assert second == (path, "promoted-to-leaf")
    fm2 = _read_frontmatter(path)
    assert fm2 is not None
    assert fm2["status"] == "promoted"
    assert fm2["evidence_count"] == 2
    assert [r["project_id"] for r in _read_evidence_records(path)] == [
        "digital-me-os", "motus-ai-web",
    ]


def test_evidence_on_already_promoted_leaf_stays_promoted(tastes_dir: Path) -> None:
    seeded = _seed_candidate(tastes_dir)
    # Flip to promoted with two records already present.
    fm = _read_frontmatter(seeded)
    assert fm is not None
    fm["status"] = "promoted"
    fm["evidence_count"] = 2
    records = _read_evidence_records(seeded) * 2
    compile_mod._write_principle_file(seeded, fm, records, None)

    result = apply_skill_outcome(_evidence_outcome())

    assert result == (seeded, "evidence-appended")
    fm_after = _read_frontmatter(seeded)
    assert fm_after is not None
    assert fm_after["status"] == "promoted"
    assert fm_after["evidence_count"] == 3


def test_evidence_prefers_matched_over_principle_fingerprint(tastes_dir: Path) -> None:
    """When both fields are set, the verbatim manifest match wins over the
    LLM's paraphrase — the paraphrase must not spawn a duplicate candidate."""
    seeded = _seed_candidate(tastes_dir)

    result = apply_skill_outcome(_evidence_outcome(
        principle_fingerprint="Use whitespace for hierarchy instead of borders.",
    ))

    assert result is not None
    assert result[0] == seeded
    assert sorted(p.name for p in (tastes_dir / "design").glob("*.md")) == [seeded.name]


def test_evidence_with_both_fingerprints_empty_is_dropped(tastes_dir: Path) -> None:
    _seed_candidate(tastes_dir)
    assert apply_skill_outcome(_evidence_outcome(matched_existing_fingerprint=None)) is None
    assert apply_skill_outcome(_evidence_outcome(matched_existing_fingerprint="   ")) is None


def test_candidate_still_requires_principle_fingerprint(tastes_dir: Path) -> None:
    """The relaxed resolution is evidence-only; a candidate carrying only a
    matched fingerprint is malformed and must still be rejected."""
    outcome = _evidence_outcome(outcome="candidate")
    assert outcome["principle_fingerprint"] is None
    assert apply_skill_outcome(outcome) is None
