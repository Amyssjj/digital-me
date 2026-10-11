"""apply_skill_outcome: evidence outcomes must resolve their fingerprint from
`matched_existing_fingerprint` when the classifier leaves
`principle_fingerprint` null.

Regression for the 2026-09-21 nightly (goal 51f6eca0): four evidence
outcomes with `principle_fingerprint: null` + a verbatim
`matched_existing_fingerprint` were all dropped with
`apply_skill_outcome returned None`, so the daily log showed
`evidence-appended: 0, errors: 4` even though every matched leaf existed.

Also pins idempotency (bottom of file): re-applying an outcome whose record is
already on file must be a no-op tagged `evidence-duplicate`. On 2026-10-08..10
a stale-handoff re-fold re-applied 10-07's outcomes three times, stacking
identical records and promoting candidates on a single real observation.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from dream_cycle import compile as compile_mod
from dream_cycle.apply_taste import apply_outcomes
from dream_cycle.compile import (
    _load_compiled_hashes,
    _read_evidence_records,
    _read_frontmatter,
    apply_skill_outcome,
)
from dream_cycle.config import load_config

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


# ── idempotency ──────────────────────────────────────────────────────────────


def _seeded_record_outcome(**record_overrides) -> dict:
    """An evidence outcome whose record IS the one `_seed_candidate` wrote."""
    record = {
        "project_id": "seed-project",
        "date": "2026-09-01",
        "wiki_paths": [],
        "what_happened": "Removed dividers; used whitespace to group.",
        "what_triggers_principle": "reaching for a border",
    }
    record.update(record_overrides)
    return _evidence_outcome(evidence_record=record)


def test_reapplied_record_is_duplicate_and_never_promotes(tastes_dir: Path) -> None:
    """The fake-triangulation case: a candidate with ONE real record sees that
    same record again (whitespace drift included). It must not count as the
    second record that crosses the promotion threshold."""
    seeded = _seed_candidate(tastes_dir)
    before = seeded.read_bytes()

    result = apply_skill_outcome(_seeded_record_outcome(
        what_happened="  Removed dividers;\n  used whitespace   to group. ",
    ))

    assert result == (seeded, "evidence-duplicate")
    # Untouched: no append, no hint merges, no `updated` bump, no status flip.
    assert seeded.read_bytes() == before
    fm = _read_frontmatter(seeded)
    assert fm is not None
    assert fm["status"] == "candidate"
    assert fm["evidence_count"] == 1


def test_refold_of_same_outcome_appends_exactly_once(tastes_dir: Path) -> None:
    """Replays the 10-08..10 incident: one outcome applied four times (the
    original night + three stale re-folds) yields one record, not four."""
    path = tastes_dir / "design" / "hierarchy-through-space-not-chrome.md"
    compile_mod._write_principle_file(path, {
        "principle_fingerprint": FINGERPRINT,
        "status": "candidate",
        "evidence_count": 0,
    }, [], None)
    outcome = _evidence_outcome()

    assert apply_skill_outcome(outcome) == (path, "evidence-appended")
    for _ in range(3):
        assert apply_skill_outcome(outcome) == (path, "evidence-duplicate")

    fm = _read_frontmatter(path)
    assert fm is not None
    assert fm["status"] == "candidate"
    assert fm["evidence_count"] == 1
    assert len(_read_evidence_records(path)) == 1


def test_reapplied_candidate_outcome_is_duplicate(tastes_dir: Path) -> None:
    """A candidate outcome re-applied finds its own file by fingerprint; the
    second pass must not merge the record in and promote it."""
    outcome = _evidence_outcome(
        outcome="candidate",
        principle_fingerprint="Name things for the reader, not the author.",
        matched_existing_fingerprint=None,
    )

    created = apply_skill_outcome(outcome)
    assert created is not None
    path, action = created
    assert action == "candidate-new"

    assert apply_skill_outcome(outcome) == (path, "evidence-duplicate")
    fm = _read_frontmatter(path)
    assert fm is not None
    assert fm["status"] == "candidate"
    assert fm["evidence_count"] == 1
    assert sorted(p.name for p in (tastes_dir / "design").glob("*.md")) == [path.name]


def test_dateless_record_reapplied_same_day_is_duplicate(tastes_dir: Path) -> None:
    """A missing date is stored as today; a same-day retry compares against
    that stored date, so it still dedupes."""
    _seed_candidate(tastes_dir)
    outcome = _evidence_outcome(evidence_record={
        "project_id": "digital-me-os",
        "what_happened": "Settings page swapped outlined groups for spacing.",
    })

    first = apply_skill_outcome(outcome)
    assert first is not None and first[1] == "promoted-to-leaf"
    assert _read_evidence_records(first[0])[-1]["date"] == date.today().isoformat()

    assert apply_skill_outcome(outcome) == (first[0], "evidence-duplicate")
    assert len(_read_evidence_records(first[0])) == 2


@pytest.mark.parametrize("override", [
    {"date": "2026-09-02"},
    {"project_id": "motus-ai-web"},
    {"what_happened": "Removed dividers; used whitespace to group sections."},
])
def test_record_differing_in_any_key_field_is_appended(
    tastes_dir: Path, override: dict,
) -> None:
    """Same story on another day / in another project / with different text
    is a genuine new record — the dedup must not swallow it."""
    seeded = _seed_candidate(tastes_dir)

    result = apply_skill_outcome(_seeded_record_outcome(**override))

    assert result == (seeded, "promoted-to-leaf")
    assert len(_read_evidence_records(seeded)) == 2


def test_non_dict_evidence_entries_are_ignored_by_dedup(tastes_dir: Path) -> None:
    """A hand-edited Evidence block with junk entries must not crash the
    duplicate scan; real records alongside still dedupe."""
    seeded = _seed_candidate(tastes_dir)
    fm = _read_frontmatter(seeded)
    assert fm is not None
    records = ["stray note", None, *_read_evidence_records(seeded)]
    compile_mod._write_principle_file(seeded, fm, records, None)

    assert apply_skill_outcome(_seeded_record_outcome()) == (seeded, "evidence-duplicate")


def test_retried_apply_step_commits_hash_and_reports_duplicate(
    tastes_dir: Path, fixture_wiki: Path,
) -> None:
    """A retried apply_taste step re-reads the staging file whose outcomes were
    already applied. The retry must count them as duplicates, leave
    skill_files empty (nothing was touched), and still commit the hash so the
    transcript does not re-enter the next stage."""
    seeded = _seed_candidate(tastes_dir)
    cfg = load_config(wiki_root=fixture_wiki)
    staging = fixture_wiki / "taste-staging.json"
    staging.write_text(json.dumps({
        "transcripts": [{"content_key": "transcripts/abc.jsonl"}],
        "deferred_hashes": {"transcripts/abc.jsonl": "hash-abc"},
        "outcomes": [_evidence_outcome()],
    }), encoding="utf-8")

    first = apply_outcomes(staging, cfg)
    assert first["promoted-to-leaf"] == 1
    assert first["skill_files"] == [str(seeded)]
    after_first = seeded.read_bytes()

    # Simulate the retry: the first attempt's hash commit is lost.
    (cfg.cache_dir / "compiled_hashes.json").unlink()

    retry = apply_outcomes(staging, cfg)
    assert retry["evidence-duplicate"] == 1
    assert retry["promoted-to-leaf"] == 0
    assert retry["evidence-appended"] == 0
    assert retry["errors"] == 0
    assert retry["skill_files"] == []
    assert retry["hashes_committed"] == 1
    assert _load_compiled_hashes(cfg) == {"transcripts/abc.jsonl": "hash-abc"}
    assert seeded.read_bytes() == after_first


def test_inline_run_compile_counts_duplicate_without_touching(
    tastes_dir: Path, fixture_wiki: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Inline (non-staged) taste path: a duplicate is counted on its own
    stat, kept out of skill_files, and does not rebuild the manifest; a
    genuinely new record in the same run still promotes as before."""
    seeded = _seed_candidate(tastes_dir)
    # The inline path prints paths relative to $HOME; keep tastes under it.
    monkeypatch.setenv("HOME", str(tastes_dir.parent))
    manifest_builds: list[int] = []
    outcomes = {
        "replayed": _seeded_record_outcome(),
        "fresh": _evidence_outcome(),
        "invalid": _evidence_outcome(domain="not-a-domain"),
    }

    monkeypatch.setattr(compile_mod, "get_engine", lambda config: object())
    monkeypatch.setattr(
        compile_mod, "build_principles_manifest",
        lambda: manifest_builds.append(1) or "",
    )
    monkeypatch.setattr(compile_mod, "collect_raw_entries", lambda config, recent_days=None: [{
        "source_name": "claude-code",
        "source_file": f"/sessions/{title}.jsonl",
        "source_format": "transcript-jsonl",
        "title": title,
        "body": title * 1_000,
        "user_turns": 12,
        "assistant_turns": 12,
        "body_chars": 6_000,
    } for title in outcomes])
    monkeypatch.setattr(
        compile_mod, "extract_skill_update",
        lambda engine, raw, manifest: outcomes[raw["title"]],
    )

    stats = compile_mod.run_compile(
        config=load_config(wiki_root=fixture_wiki), max_entries_transcript=0,
    )

    assert stats["skill_evidence_duplicate"] == 1
    assert stats["skill_promotions"] == 1  # "fresh" is the real 2nd record
    assert stats["skill_evidence_appended"] == 0
    assert stats["skill_files"] == [str(seeded)]  # the duplicate is not listed
    assert stats["errors"] == 0
    # Initial build + one rebuild after the promotion; none for the duplicate.
    assert manifest_builds == [1, 1]
    assert len(_read_evidence_records(seeded)) == 2
