"""Tests for the staging-file codec and the workflow wiring around it: the CLI
worker must be able to Read every line of a staging file (no line over the
Read tool's per-call budget), and the files default to a path inside the
worker's cwd (the wiki root) rather than /tmp."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import dream_cycle
from dream_cycle import apply as A
from dream_cycle import apply_compile, apply_taste
from dream_cycle import compile as C
from dream_cycle.config import load_config
from dream_cycle.install_workflows import _apply_template_defaults, install_workflows
from dream_cycle.staging import MAX_PIECE_CHARS, dump_staging, join_text, load_staging, split_text
from dream_cycle.via_agents import run

# Longest line a staged piece can occupy on disk: JSON escaping at most
# doubles it (\n -> \\n), plus indent, quotes and a trailing comma. Either
# way it is far under the Read tool's per-call budget; the pre-fix files had
# 60k+ character lines.
MAX_LINE = 2 * MAX_PIECE_CHARS + 32
LONG_LINE = "x" * (MAX_PIECE_CHARS * 2 + 7)
TRANSCRIPT = "\n".join(f"turn {i}: 用户说了一些话 — and some ASCII too." for i in range(400))


def _workflow(name: str) -> dict:
    return json.loads((Path(dream_cycle.__file__).parent / "workflows" / name).read_text())


# ── split_text / join_text ──────────────────────────────────────────────────


def test_split_text_round_trips_and_caps_every_piece() -> None:
    for text in ("", "short", TRANSCRIPT, LONG_LINE, "a\n" + LONG_LINE + "\nb\r\nc"):
        pieces = split_text(text)
        assert "".join(pieces) == text
        assert all(0 < len(p) <= MAX_PIECE_CHARS for p in pieces)
    assert split_text("") == []
    assert split_text("short") == ["short"]


def test_split_text_breaks_at_line_ends_when_it_can() -> None:
    pieces = split_text("aaaa\nbbbb\ncccc\n", max_chars=10)
    assert pieces == ["aaaa\nbbbb\n", "cccc\n"]
    # A single line longer than the cap is hard-cut, the remainder carried on.
    assert split_text("0123456789AB\nz", max_chars=5) == ["01234", "56789", "AB\nz"]


def test_join_text_accepts_pieces_legacy_strings_and_junk() -> None:
    assert join_text(["a", "b", 3, "c"]) == "abc"
    assert join_text("staged before the piece format") == "staged before the piece format"
    assert join_text(None) == ""


# ── dump_staging / load_staging ─────────────────────────────────────────────


def test_dump_writes_read_pageable_lines_and_load_restores_strings(tmp_path: Path) -> None:
    payload = {
        "principles_manifest": TRANSCRIPT,
        "valid_domains": ["infra", "design"],
        "transcripts": [
            {"title": "长对话", "body": TRANSCRIPT + LONG_LINE, "body_chars": 1},
            {"title": "no body"},
            "not-a-dict",
        ],
        "candidates": [{"content_key": "k", "prompt": LONG_LINE, "entries": None}],
        "wiki_manifest": None,
        "outcomes": None,
        "deferred_hashes": {"k": "h"},
        "staged_at": 1,
    }
    path = tmp_path / "nested" / "dir" / "staging.json"
    dump_staging(path, payload)

    raw = path.read_text(encoding="utf-8")
    assert max(len(line) for line in raw.splitlines()) <= MAX_LINE
    assert "\\u" not in raw  # non-ASCII stays raw, not 6-char escapes
    on_disk = json.loads(raw)
    assert isinstance(on_disk["principles_manifest"], list)
    assert isinstance(on_disk["transcripts"][0]["body"], list)
    assert isinstance(on_disk["candidates"][0]["prompt"], list)
    assert on_disk["valid_domains"] == ["infra", "design"]  # untouched list of strings

    assert load_staging(path) == {**payload, "wiki_manifest": ""}


def test_load_tolerates_a_non_list_item_section(tmp_path: Path) -> None:
    path = tmp_path / "s.json"
    path.write_text(json.dumps({"transcripts": None, "candidates": {"odd": 1}}))
    assert load_staging(path) == {"transcripts": None, "candidates": {"odd": 1}}
    path.write_text("[1, 2]")
    assert load_staging(path) == [1, 2]


# ── stage + apply use the codec ─────────────────────────────────────────────


def test_stage_writes_the_piece_format(fixture_wiki: Path, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(C, "get_engine", lambda config: object())
    monkeypatch.setattr(C, "build_principles_manifest", lambda: TRANSCRIPT)
    monkeypatch.setattr(C, "collect_raw_entries", lambda config, recent_days=None: [])
    taste_path = tmp_path / "staging" / "taste.json"
    C.run_compile(
        config=load_config(wiki_root=fixture_wiki),
        stage_taste_path=str(taste_path),
        stage_compile_path=str(tmp_path / "staging" / "compile.json"),
    )
    assert isinstance(json.loads(taste_path.read_text())["principles_manifest"], list)
    assert load_staging(taste_path)["principles_manifest"] == TRANSCRIPT


def test_apply_compile_fallback_sees_the_joined_prompt(fixture_wiki: Path, tmp_path: Path, monkeypatch) -> None:
    seen: list[str] = []

    class Engine:
        def llm_call(self, prompt: str, system: str = "") -> str:
            seen.append(prompt)
            return ""

    monkeypatch.setattr("dream_cycle.engine.get_engine", lambda config: Engine())
    staging = tmp_path / "c.json"
    dump_staging(staging, {
        "wiki_manifest": "",
        "candidates": [{"content_key": "s:T", "source_name": "s", "title": "T",
                        "prompt": TRANSCRIPT, "entries": None}],
        "deferred_hashes": {},
    })
    apply_compile.apply_entries(staging, load_config(wiki_root=fixture_wiki))
    assert seen == [TRANSCRIPT]


def test_apply_taste_fallback_sees_joined_body_and_manifest(fixture_wiki: Path, tmp_path: Path, monkeypatch) -> None:
    seen: list[tuple[str, str]] = []

    def fake_extract(engine, entry, manifest):
        seen.append((entry["body"], manifest))
        return None

    monkeypatch.setattr("dream_cycle.engine.get_engine", lambda config: object())
    monkeypatch.setattr("dream_cycle.compile.extract_skill_update", fake_extract)
    staging = tmp_path / "t.json"
    dump_staging(staging, {
        "principles_manifest": "manifest\n" + LONG_LINE,
        "transcripts": [{"title": "T", "body": TRANSCRIPT, "content_key": "k"}],
        "outcomes": None,
        "deferred_hashes": {},
    })
    apply_taste.apply_outcomes(staging, load_config(wiki_root=fixture_wiki))
    assert seen == [(TRANSCRIPT, "manifest\n" + LONG_LINE)]


def test_inject_handoffs_keeps_the_piece_format(tmp_path: Path, monkeypatch) -> None:
    compile_path, taste_path = tmp_path / "c.json", tmp_path / "t.json"
    dump_staging(compile_path, {
        "wiki_manifest": LONG_LINE,
        "candidates": [{"content_key": "s:A", "prompt": LONG_LINE, "entries": None}],
        "staged_at": 5,
    })
    dump_staging(taste_path, {"transcripts": [{"body": LONG_LINE}], "outcomes": None, "staged_at": 5})
    monkeypatch.setattr(A, "_read_spawn_handoffs", lambda since_ms: {
        "compile": {"entries": {"s:A": []}},
        "taste": {"outcomes": [{"transcript_index": 0, "outcome": "neither"}]},
    })
    info = A._inject_handoffs(str(compile_path), str(taste_path))
    assert (info["compile_injected"], info["taste_injected"]) == (1, 1)
    for path in (compile_path, taste_path):
        assert max(len(line) for line in path.read_text().splitlines()) <= MAX_LINE
    assert load_staging(compile_path)["candidates"][0] == {"content_key": "s:A", "prompt": LONG_LINE, "entries": []}
    assert load_staging(taste_path)["transcripts"][0]["body"] == LONG_LINE


# ── staging paths default inside the wiki root ─────────────────────────────


def test_template_defaults_resolve_known_vars() -> None:
    template = {"variables": [
        {"name": "staging_path", "defaultValue": "{{wiki_root}}/.data/staging/x.json"},
        {"name": "other", "defaultValue": "{{not_supplied}}/y"},
    ]}
    merged = _apply_template_defaults(template, {"wiki_root": "/w"})
    assert merged["staging_path"] == "/w/.data/staging/x.json"
    assert merged["other"] == "{{not_supplied}}/y"


def test_bundled_staging_defaults_live_under_the_wiki_root() -> None:
    nightly = _workflow("nightly.json")
    defaults = {v["name"]: v.get("defaultValue") for v in nightly["variables"]}
    assert defaults["taste_staging_path"] == "{{wiki_root}}/.data/staging/dream-cycle-taste-staging.json"
    assert defaults["compile_staging_path"] == "{{wiki_root}}/.data/staging/dream-cycle-compile-staging.json"
    assert "/tmp/" not in json.dumps(nightly)


def test_install_materializes_concrete_staging_paths(tmp_path: Path) -> None:
    client = MagicMock()
    client.schedule_list.return_value = []
    wf_path = Path(dream_cycle.__file__).parent / "workflows" / "nightly.json"
    [(_, ok, _msg)] = install_workflows(
        [wf_path], {"wiki_root": "/w", "python_path": "/py", "compiler_agent_id": "a",
                    "classifier_agent_id": "a"}, client=client)
    assert ok
    imported = json.dumps(client.import_workflow.call_args.args[0])
    assert "{{" not in imported
    assert "/w/.data/staging/dream-cycle-taste-staging.json" in imported
    assert "/w/.data/staging/dream-cycle-compile-staging.json" in imported
    sched_vars = client.schedule_add.call_args.kwargs["variables"]
    assert sched_vars["taste_staging_path"] == "/w/.data/staging/dream-cycle-taste-staging.json"


def test_via_agents_resolves_staging_defaults() -> None:
    import argparse

    client = MagicMock()
    client.gateway.url = "http://x/"
    client.run_workflow.return_value = {"details": {"json": {"goalId": "g"}}}
    client.wait_for_goal.return_value = {"status": "completed", "tasks": []}
    args = argparse.Namespace(wiki_root=Path("/w"), dry_run=True, template_id="t",
                              timeout=1.0, poll_interval=1.0, force=False)
    assert run(args, client=client) == 0
    variables = client.run_workflow.call_args.kwargs["variables"]
    assert variables["compile_staging_path"].endswith("/w/.data/staging/dream-cycle-compile-staging.json")
    assert "{{" not in variables["compile_staging_path"]


# ── the agent prompts read with paged Read, never cat ──────────────────────


def test_agent_steps_read_staging_with_paged_read_not_cat() -> None:
    steps = {s["stepKey"]: s for s in _workflow("nightly.json")["steps"]}
    for key, fields in (("compile-extract", ("wiki_manifest", "prompt")),
                        ("taste-distill", ("principles_manifest", "body"))):
        prompt = steps[key]["promptTemplate"]
        assert "Read tool ONLY" in prompt
        assert "`offset`/`limit`" in prompt
        assert "with `cat` ONLY" not in prompt
        assert "Do NOT use Bash" in prompt
        assert "pieces" in prompt
        for field in fields:
            assert f"`{field}`" in prompt
    assert "`transcript_index`" in steps["taste-distill"]["promptTemplate"]
