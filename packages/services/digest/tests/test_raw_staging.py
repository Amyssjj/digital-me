"""The summarize worker Reads the digest staging file, so it must stay inside
the worker's cwd (the wiki root) and not inflate non-ASCII into \\u escapes
that eat the Read tool's per-call token budget."""

from __future__ import annotations

import json
from pathlib import Path

import digest
from digest import daily_digest as dd


def test_write_raw_staging_keeps_non_ascii_raw(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(dd, "_parse_dream_cycle_log", lambda date_str: {})
    monkeypatch.setattr(dd, "_wiki_entries_created_on", lambda date_iso: [])
    monkeypatch.setattr(dd, "_taste_entries_created_on", lambda date_iso: [])
    monkeypatch.setattr(dd, "_load_transcript_sources", lambda: {
        name: {"path": str(tmp_path / name)}
        for name in ("claude-code-jsonl", "codex-jsonl", "openclaw-agent-jsonl", "hermes-session-json")
    })
    monkeypatch.setattr(dd, "_claude_code_raw_prompts", lambda *a: ["整理一下今天的工作"])
    monkeypatch.setattr(dd, "_codex_raw_prompts", lambda *a: [])
    monkeypatch.setattr(dd, "_openclaw_agents_raw_prompts", lambda *a: {})
    monkeypatch.setattr(dd, "_hermes_raw_prompts", lambda *a: [])
    monkeypatch.setattr(dd, "_codex_last_seen_iso", lambda root: None)

    path = tmp_path / ".data" / "staging" / "daily-digest-staging.json"
    dd.write_raw_staging(path, "2026-10-11", "2026-10-12")

    raw = path.read_text(encoding="utf-8")
    assert "整理一下今天的工作" in raw
    assert "\\u" not in raw
    assert json.loads(raw)["agent_raw_prompts"] == {"Claude Code CLI": ["整理一下今天的工作"]}


def test_bundled_staging_default_lives_under_the_wiki_root() -> None:
    wf = json.loads((Path(digest.__file__).parent / "workflows" / "digest.json").read_text())
    defaults = {v["name"]: v.get("defaultValue") for v in wf["variables"]}
    assert defaults["staging_path"] == "{{wiki_root}}/.data/staging/daily-digest-staging.json"
    assert "/tmp/" not in json.dumps(wf)
    summarize = next(s for s in wf["steps"] if s["stepKey"] == "summarize")
    assert "`offset`/`limit`" in summarize["promptTemplate"]
