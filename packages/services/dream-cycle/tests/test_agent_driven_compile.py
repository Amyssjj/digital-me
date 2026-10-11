"""Tests for the agent-driven compile path: staged compile (no inline LLM),
apply_compile (write + commit + inline fallback), and the nightly workflow shape.
"""

from __future__ import annotations

import json
from pathlib import Path

from dream_cycle import apply_compile
from dream_cycle import compile as C
from dream_cycle.config import load_config

VALID_ENTRY = """---
title: Agent Compiled Principle
domain: [infra]
tags: [test]
---

## Rule
Prefer deterministic fallbacks for agent-spawn steps.
"""


def test_build_prompt_is_pure_and_parse_roundtrips() -> None:
    raw = {"title": "T", "body": "some body"}
    prompt = C.build_compile_prompt(raw, "src-name", "")
    assert "Compile this raw knowledge" in prompt
    assert "src-name" in prompt
    # parse handles fences + ---SPLIT--- and keeps only frontmatter chunks
    out = C.parse_compile_response(
        "```\n" + VALID_ENTRY + "\n```\n---SPLIT---\n" + VALID_ENTRY + "\n---SPLIT---\nnot an entry"
    )
    assert len(out) == 2
    assert all(e.startswith("---") for e in out)


def test_apply_entries_writes_and_commits(fixture_wiki: Path, tmp_path: Path) -> None:
    cfg = load_config(wiki_root=fixture_wiki)
    staging = tmp_path / "compile-staging.json"
    staging.write_text(json.dumps({
        "wiki_manifest": "",
        "candidates": [
            {"content_key": "src:Test", "source_name": "src", "title": "Test",
             "prompt": "p", "entries": [VALID_ENTRY]},
        ],
        "deferred_hashes": {"src:Test": "abc123"},
    }))
    stats = apply_compile.apply_entries(staging, cfg)
    assert stats["new"] == 1
    assert stats["hashes_committed"] == 1
    assert C._load_compiled_hashes(cfg).get("src:Test") == "abc123"
    assert list((cfg.wiki_dir / "infra").glob("*.md"))


def test_apply_entries_inline_fallback_when_null(fixture_wiki: Path, tmp_path: Path, monkeypatch) -> None:
    cfg = load_config(wiki_root=fixture_wiki)

    class FakeEngine:
        def llm_call(self, prompt: str, system: str = "") -> str:
            return VALID_ENTRY

    monkeypatch.setattr("dream_cycle.engine.get_engine", lambda config: FakeEngine())
    staging = tmp_path / "c.json"
    staging.write_text(json.dumps({
        "wiki_manifest": "",
        "candidates": [
            {"content_key": "s:T", "source_name": "s", "title": "T",
             "prompt": "do extraction", "entries": None},
        ],
        "deferred_hashes": {"s:T": "h1"},
    }))
    stats = apply_compile.apply_entries(staging, cfg)
    assert stats["fallback_candidates"] == 1
    assert stats["new"] == 1
    assert C._load_compiled_hashes(cfg).get("s:T") == "h1"


def test_apply_entries_error_leaves_hash_uncommitted(fixture_wiki: Path, tmp_path: Path, monkeypatch) -> None:
    cfg = load_config(wiki_root=fixture_wiki)

    class BoomEngine:
        def llm_call(self, prompt: str, system: str = "") -> str:
            raise RuntimeError("HTTP Error 429")

    monkeypatch.setattr("dream_cycle.engine.get_engine", lambda config: BoomEngine())
    staging = tmp_path / "c.json"
    staging.write_text(json.dumps({
        "wiki_manifest": "",
        "candidates": [
            {"content_key": "s:T", "source_name": "s", "title": "T",
             "prompt": "p", "entries": None},
        ],
        "deferred_hashes": {"s:T": "h1"},
    }))
    stats = apply_compile.apply_entries(staging, cfg)
    assert stats["errors"] == 1
    assert stats["hashes_committed"] == 0
    assert C._load_compiled_hashes(cfg).get("s:T") is None


def test_nightly_workflow_is_agent_driven() -> None:
    import dream_cycle
    nightly = json.loads(
        (Path(dream_cycle.__file__).parent / "workflows" / "nightly.json").read_text()
    )
    assert nightly["version"] >= 2
    steps = {s["stepKey"]: s for s in nightly["steps"]}
    assert set(steps) == {"stage", "compile-extract", "taste-distill", "apply"}
    # Compile extraction is agent-driven, not inline. It dispatches via a
    # CLI-exec alias (mode=exec + agentId), NOT mode=spawn: the bare in-gateway
    # spawn agent has no exec tools and no brain MCP, so it can neither read the
    # staging file nor call tasks.handoff, and stalls until the watchdog fires.
    compile_dispatch = steps["compile-extract"]["dispatch"]
    assert compile_dispatch["mode"] == "exec"
    assert compile_dispatch["agentId"] == "{{compiler_agent_id}}"
    # apply waits on BOTH spawns and runs even if one fails
    assert set(steps["apply"]["blockedByKeys"]) == {"compile-extract", "taste-distill"}
    assert steps["apply"]["onUpstreamFailure"] == "continue"
    # stage now also stages compile candidates
    assert "--stage-compile-path" in steps["stage"]["dispatch"]["command"]
    # apply uses the combined entrypoint
    assert "dream_cycle.apply" in steps["apply"]["dispatch"]["command"]
    names = {v["name"] for v in nightly["variables"]}
    assert {"compile_staging_path", "compiler_agent_id"} <= names


def test_nightly_workflow_materializes_compile_vars() -> None:
    """materialize_workflow must substitute the new compile vars in the stage
    exec command (the brain only interpolates promptTemplate, not dispatch)."""
    from dream_cycle.via_agents import _load_bundled_workflow, materialize_workflow

    template = _load_bundled_workflow()
    vars = {v["name"]: v.get("defaultValue", "") for v in template.get("variables", [])}
    vars.update({"wiki_root": "/wr", "python_path": "/py",
                 "compile_staging_path": "/tmp/c.json"})
    mat = materialize_workflow(template, vars)
    stage = next(s for s in mat["steps"] if s["stepKey"] == "stage")
    assert "/tmp/c.json" in stage["dispatch"]["command"]
    assert "{{compile_staging_path}}" not in json.dumps(stage["dispatch"])


# ── B: handoff-channel (agent returns via tasks.handoff; apply folds it in) ──

def test_extract_json_fenced_and_raw() -> None:
    from dream_cycle import apply as A
    fenced = "preamble\n```json\n{\"entries\": {\"k\": [\"---\\ntitle: X\"]}}\n```\ntrailing"
    assert A._extract_json(fenced) == {"entries": {"k": ["---\ntitle: X"]}}
    raw = 'noise {"outcomes": [{"transcript_index": 0}]} more'
    assert A._extract_json(raw) == {"outcomes": [{"transcript_index": 0}]}
    assert A._extract_json("no json here") is None
    assert A._extract_json("") is None


def test_inject_handoffs_folds_into_staging(tmp_path: Path, monkeypatch) -> None:
    from dream_cycle import apply as A
    compile_path = tmp_path / "compile.json"
    taste_path = tmp_path / "taste.json"
    compile_path.write_text(json.dumps({
        "wiki_manifest": "",
        "candidates": [
            {"content_key": "s:A", "source_name": "s", "title": "A", "prompt": "p", "entries": None},
            {"content_key": "s:B", "source_name": "s", "title": "B", "prompt": "p", "entries": None},
        ],
        "deferred_hashes": {"s:A": "h", "s:B": "h2"},
        "staged_at": 1000,
    }))
    taste_path.write_text(json.dumps({"transcripts": [{}], "outcomes": None, "staged_at": 1003}))

    floors: list[int] = []

    def fake_read(since_ms: int) -> dict:
        floors.append(since_ms)
        return {
            "_goal_id": "g1",
            "compile": {"entries": {"s:A": [VALID_ENTRY], "s:B": []}},
            "taste": {"outcomes": [{"transcript_index": 0, "outcome": "neither"}]},
        }

    monkeypatch.setattr(A, "_read_spawn_handoffs", fake_read)
    info = A._inject_handoffs(str(compile_path), str(taste_path))
    assert floors == [1003]  # discovery floor = the later of the two staging stamps
    assert info["compile_injected"] == 2  # both candidates got their entries set
    assert info["taste_injected"] == 1

    staged_c = json.loads(compile_path.read_text())
    assert staged_c["candidates"][0]["entries"] == [VALID_ENTRY]
    assert staged_c["candidates"][1]["entries"] == []
    staged_t = json.loads(taste_path.read_text())
    assert staged_t["outcomes"] == [{"transcript_index": 0, "outcome": "neither"}]


def test_inject_handoffs_missing_leaves_staging_for_fallback(tmp_path: Path, monkeypatch) -> None:
    from dream_cycle import apply as A
    compile_path = tmp_path / "c.json"
    compile_path.write_text(json.dumps({
        "wiki_manifest": "", "candidates": [
            {"content_key": "s:A", "source_name": "s", "title": "A", "prompt": "p", "entries": None}],
        "deferred_hashes": {"s:A": "h"},
    }))
    monkeypatch.setattr(A, "_read_spawn_handoffs", lambda since_ms: {})  # no handoff
    info = A._inject_handoffs(str(compile_path), None)
    assert info["compile_injected"] == 0
    # staging untouched → entries still None → apply_compile inline fallback covers it
    assert json.loads(compile_path.read_text())["candidates"][0]["entries"] is None


def test_inject_handoffs_without_staging_never_reads_the_brain(tmp_path: Path, monkeypatch) -> None:
    """No readable staging file = no batch to anchor on, so discovery must not
    run at all (an unanchored scan is exactly what re-folded stale handoffs)."""
    from dream_cycle import apply as A

    def boom(since_ms: int) -> dict:
        raise AssertionError("discovery ran without a staging anchor")

    monkeypatch.setattr(A, "_read_spawn_handoffs", boom)
    info = A._inject_handoffs(str(tmp_path / "missing.json"), None)
    assert info == {"compile_injected": 0, "taste_injected": 0, "goal_id": None}


def test_staged_at_ms_prefers_the_stamp_then_mtime(tmp_path: Path) -> None:
    import os
    from dream_cycle import apply as A

    stamped = tmp_path / "stamped.json"
    stamped.write_text(json.dumps({"staged_at": 1234, "outcomes": None}))
    assert A._staged_at_ms(str(stamped)) == 1234

    # Staged before the stamp existed → fall back to when the file was written.
    legacy = tmp_path / "legacy.json"
    legacy.write_text(json.dumps({"outcomes": None}))
    os.utime(legacy, (1_700_000_000.5, 1_700_000_000.5))
    assert A._staged_at_ms(str(legacy)) == 1_700_000_000_500

    garbled = tmp_path / "garbled.json"
    garbled.write_text("{not json")
    not_a_dict = tmp_path / "list.json"
    not_a_dict.write_text("[]")
    assert A._staged_at_ms(str(garbled)) is None
    assert A._staged_at_ms(str(not_a_dict)) is None
    assert A._staged_at_ms(str(tmp_path / "missing.json")) is None
    assert A._staged_at_ms(None) is None


def test_stage_stamps_both_staging_files(fixture_wiki: Path, tmp_path: Path, monkeypatch) -> None:
    import time
    from dream_cycle import compile as C

    monkeypatch.setattr(C, "get_engine", lambda config: object())
    monkeypatch.setattr(C, "build_principles_manifest", lambda: "")
    monkeypatch.setattr(C, "collect_raw_entries", lambda config, recent_days=None: [])
    taste_path, compile_path = tmp_path / "taste.json", tmp_path / "compile.json"

    before = int(time.time() * 1000)
    C.run_compile(
        config=load_config(wiki_root=fixture_wiki),
        stage_taste_path=str(taste_path),
        stage_compile_path=str(compile_path),
    )
    after = int(time.time() * 1000)

    taste_stamp = json.loads(taste_path.read_text())["staged_at"]
    assert before <= taste_stamp <= after
    assert json.loads(compile_path.read_text())["staged_at"] == taste_stamp


def test_extract_json_unwraps_handoff_envelope() -> None:
    """The real handoff latest_output is an envelope whose payload is a fenced
    json block nested inside the `summary` string."""
    from dream_cycle import apply as A
    envelope = json.dumps({
        "deliverableState": "complete",
        "summary": "```json\n{\"entries\": {\"s:A\": [\"---\\ntitle: X\"]}}\n```",
    })
    got = A._extract_json(envelope)
    assert got == {"entries": {"s:A": ["---\ntitle: X"]}}
    env2 = json.dumps({"summary": "done\n```json\n{\"outcomes\": [{\"transcript_index\": 0}]}\n```"})
    assert A._extract_json(env2) == {"outcomes": [{"transcript_index": 0}]}


def _handoff(payload: dict) -> str:
    """A real tasks.handoff latest_output: payload fenced inside `summary`."""
    return json.dumps(
        {"deliverableState": "complete",
         "summary": "```json\n" + json.dumps(payload) + "\n```"}
    )


def _seed_tasks(tmp_path: Path, monkeypatch, rows: list[tuple]) -> None:
    """Point the brain resolver at a throwaway tasks table. Pinned via
    DIGITAL_ME_BRAIN_DB so a host with a real <wiki-root>/.data/brain.db
    can't leak into the test."""
    import sqlite3

    db = tmp_path / "brain.db"
    monkeypatch.setenv("DIGITAL_ME_BRAIN_DB", str(db))
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE tasks (goal_id TEXT, name TEXT, latest_output TEXT, started_at INTEGER)"
    )
    con.executemany("INSERT INTO tasks VALUES (?,?,?,?)", rows)
    con.commit()
    con.close()


def test_read_spawn_handoffs_is_content_based_and_rename_proof(tmp_path, monkeypatch):
    """Discovery must follow handoff CONTENT, not task NAME: a newer run whose
    spawn step was relabeled (e.g. routed through a cli_exec alias) must win over
    an older run that happens to match a legacy name prefix. Regression for the
    bug where renaming the step to 'Compiler (claude-code-cli) ...' made apply
    read an older goal's (missing) handoffs and fall back to the inline engine."""
    from dream_cycle import apply as A

    _seed_tasks(tmp_path, monkeypatch, [
        # Older goal with the LEGACY task name + a handoff.
        ("g_old", "Compiler agent extracts wiki entries",
         _handoff({"entries": {"old": ["x"]}}), 100),
        # Newer goal whose compile step was RENAMED (claude-code-cli) + taste handoff.
        ("g_new", "Compiler (claude-code-cli) extracts wiki entries",
         _handoff({"entries": {"new": ["y"]}}), 200),
        ("g_new", "Classifier (claude-code-cli) distills taste",
         _handoff({"outcomes": [{"transcript_index": 0, "outcome": "neither"}]}), 201),
    ])

    h = A._read_spawn_handoffs(0)
    assert h.get("_goal_id") == "g_new"                       # newest-with-handoff, not g_old
    assert h["compile"]["entries"] == {"new": ["y"]}          # rename-proof
    assert len(h["taste"]["outcomes"]) == 1


def test_failed_spawns_never_refold_the_previous_nights_handoffs(tmp_path, monkeypatch):
    """2026-10-08..10: both spawns failed (claude CLI OAuth expired), so the
    current goal had no handoff and discovery fell through to the previous
    night's goal — re-applying its taste outcomes by transcript_index onto a
    different batch. Handoffs that started before this batch was staged belong
    to an older run and must be ignored, leaving staging null for the inline
    fallback."""
    from dream_cycle import apply as A

    _seed_tasks(tmp_path, monkeypatch, [
        # Previous night: both agents handed off.
        ("g_prev", "Compiler agent extracts wiki entries",
         _handoff({"entries": {"s:A": ["---\ntitle: stale"]}}), 100),
        ("g_prev", "Classifier distills taste",
         _handoff({"outcomes": [{"transcript_index": 0, "outcome": "evidence"}]}), 101),
        # Tonight: stage wrote at 150, both agents started after and failed.
        ("g_now", "Compiler agent extracts wiki entries", None, 160),
        ("g_now", "Classifier distills taste", "", 161),
    ])
    compile_path, taste_path = tmp_path / "c.json", tmp_path / "t.json"
    compile_path.write_text(json.dumps({
        "candidates": [{"content_key": "s:A", "entries": None}], "staged_at": 150,
    }))
    taste_path.write_text(json.dumps({"transcripts": [{}], "outcomes": None, "staged_at": 150}))

    assert A._read_spawn_handoffs(0)["_goal_id"] == "g_prev"  # the unanchored scan's pick
    info = A._inject_handoffs(str(compile_path), str(taste_path))

    assert info == {"compile_injected": 0, "taste_injected": 0, "goal_id": None}
    assert json.loads(compile_path.read_text())["candidates"][0]["entries"] is None
    assert json.loads(taste_path.read_text())["outcomes"] is None
