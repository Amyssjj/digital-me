"""End-to-end smoke: run_dream_cycle against a tmp fixture wiki.

We disable the LLM-heavy steps (compile, drift_check) and the trailing
consolidate/reindex chain so the test stays hermetic and fast. The point
is not to exercise the LLM — it's to prove that the deterministic data
plumbing (config → wiki_root → outputs) lands the right files in the
right place.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from dream_cycle.run import run_dream_cycle


def test_pipeline_smoke_writes_all_artifacts(
    monkeypatch: pytest.MonkeyPatch, fixture_wiki: Path, tmp_path: Path
) -> None:
    # Make sure brain_learnings can't accidentally use a real user DB.
    monkeypatch.setenv("DIGITAL_ME_BRAIN_DB", str(tmp_path / "no-such.db"))

    results = run_dream_cycle(
        skip_compile=True,
        skip_drift_check=True,
        skip_final_steps=True,
        wiki_root=fixture_wiki,
    )

    # Every non-skipped step must have produced a result entry (and not an
    # error key — error keys would mean the step crashed but the cycle
    # caught the exception).
    for step in ("brain_learnings", "index", "citations", "crosslink", "lint"):
        assert step in results, f"missing result for {step}"
        assert "error" not in results[step], (
            f"{step} errored: {results[step].get('error')}"
        )

    # Artifacts on disk. Note: the index/stats/graph files land at
    # <wiki_root>/, NOT under <wiki_root>/wiki/ — they're meta-indexes
    # over the wiki/ directory, sibling to it.
    assert (fixture_wiki / "_INDEX.md").is_file()
    assert (fixture_wiki / "_STATS.md").is_file()
    assert (fixture_wiki / "_GRAPH.md").is_file()

    # The cycle log lands under <wiki_root>/dream_cycle/logs/<date>.md.
    logs_dir = fixture_wiki / "dream_cycle" / "logs"
    cycle_logs = list(logs_dir.glob("*.md"))
    assert cycle_logs, f"no cycle logs in {logs_dir}"
