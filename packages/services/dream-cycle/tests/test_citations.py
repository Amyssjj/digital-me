"""citations must read the brain DB through the shared resolver (the retired
task-orchestrator.db default is gone), ignore the newer trace kinds that carry
no per-hit path, and account for every entry with traces in its summary.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
import yaml

from dream_cycle import brain_learnings
from dream_cycle.citations import run_citations
from dream_cycle.config import load_config


# Same shape as brain-orchestrator's `createTracesStore` (and the legacy
# task-orchestrator copy it was migrated from).
TRACES_DDL = """
CREATE TABLE traces (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  task_id     TEXT,
  goal_id     TEXT,
  duration_ms INTEGER,
  t           INTEGER NOT NULL
)
"""

T_MAY_12 = 1778608934481  # 2026-05-12 UTC
T_MAY_14 = 1778780000000  # 2026-05-14 UTC
T_MAY_15 = 1778880556473  # 2026-05-15 UTC


def _hit(agent: str, file_path: str) -> str:
    return json.dumps({"toolName": "memory_search", "query": "q", "filePath": file_path})


def _seed_brain_db(path: Path) -> Path:
    conn = sqlite3.connect(path)
    conn.execute(TRACES_DDL)
    rows = [
        # Legacy per-hit rows: the only shape this step can use.
        ("t1", "coo", "tool_call", _hit("coo", "agents/foo.md"), T_MAY_12),
        ("t2", "claude-code", "tool_call", _hit("claude-code", "agents/foo.md"), T_MAY_15),
        # Deep-cwd escape that normalizes onto the same entry (merge branch).
        ("t3", "coo", "tool_call",
         _hit("coo", "../../../../home/someone/digital-me/wiki/agents/foo.md"), T_MAY_14),
        # Excluded by the query: memory/ paths are Claude Code's own memory.
        ("t4", "coo", "tool_call", _hit("coo", "memory/notes.md"), T_MAY_15),
        # Live producers (2026-09): query + hitCount only, no filePath.
        ("t5", "coo", "memory_search",
         json.dumps({"query": "HEARTBEAT", "hitCount": 0, "sessionKey": "agent:coo:main"}),
         T_MAY_15),
        ("t6", "claude-code", "mcp_tool_call",
         json.dumps({"toolName": "memory_search", "query": "q", "hitCount": 5, "isError": False}),
         T_MAY_15),
        # Absolute path outside the wiki: dropped by normalization.
        ("t7", "coo", "tool_call", _hit("coo", "/etc/outside.md"), T_MAY_15),
        # Trace for an entry that no longer exists.
        ("t8", "coo", "tool_call", _hit("coo", "ghost/missing.md"), T_MAY_15),
        # Trace for a generated file without frontmatter.
        ("t9", "coo", "tool_call", _hit("coo", "agents/_OVERVIEW.md"), T_MAY_15),
    ]
    conn.executemany(
        "INSERT INTO traces (id, agent_id, kind, payload, t) VALUES (?, ?, ?, ?, ?)", rows
    )
    conn.commit()
    conn.close()
    return path


FOO_MD = """---
title: Foo
domain: [agents]
citations: 1
---

## Rule
Do foo.
"""


def _seed_wiki(fixture_wiki: Path) -> Path:
    wiki = fixture_wiki / "wiki"
    (wiki / "agents").mkdir()
    (wiki / "agents" / "foo.md").write_text(FOO_MD, encoding="utf-8")
    (wiki / "agents" / "_OVERVIEW.md").write_text("# Agents\n\n- [Foo](foo.md)\n", encoding="utf-8")
    return wiki


def _frontmatter(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8").split("---", 2)[1])


def test_missing_db_via_env_is_a_graceful_noop(
    monkeypatch: pytest.MonkeyPatch, fixture_wiki: Path, tmp_path: Path
) -> None:
    """Fresh install: no brain DB at all → zero counts, no exception, and the
    summary names the path that was resolved (env override honoured)."""
    target = tmp_path / "no-such-brain.db"
    monkeypatch.setenv("DIGITAL_ME_BRAIN_DB", str(target))
    cfg = load_config(wiki_root=fixture_wiki)
    summary = run_citations(cfg)
    assert summary["traces_db"] == str(target)
    assert summary["entries_with_traces"] == 0
    assert summary["updated"] == 0
    assert summary["updated_paths"] == []
    assert summary["skipped_unparseable"] == 0
    assert summary["missing_entries"] == []
    assert "proposed_changes" not in summary


def test_default_path_comes_from_the_shared_resolver(
    monkeypatch: pytest.MonkeyPatch, fixture_wiki: Path, tmp_path: Path
) -> None:
    """With no env override the step reads whatever brain_learnings' default
    is -- one resolver for every dream-cycle brain reader."""
    monkeypatch.delenv("DIGITAL_ME_BRAIN_DB", raising=False)
    db = _seed_brain_db(tmp_path / "brain.db")
    monkeypatch.setattr(brain_learnings, "DEFAULT_BRAIN_DB_PATH", db)
    _seed_wiki(fixture_wiki)
    cfg = load_config(wiki_root=fixture_wiki)
    summary = run_citations(cfg)
    assert summary["traces_db"] == str(db)
    assert summary["updated"] == 1


def test_applies_legacy_hits_and_ignores_pathless_live_kinds(
    monkeypatch: pytest.MonkeyPatch, fixture_wiki: Path, tmp_path: Path
) -> None:
    db = _seed_brain_db(tmp_path / "brain.db")
    monkeypatch.setenv("DIGITAL_ME_BRAIN_DB", str(db))
    wiki = _seed_wiki(fixture_wiki)
    cfg = load_config(wiki_root=fixture_wiki)

    summary = run_citations(cfg)

    # foo.md, ghost/missing.md and agents/_OVERVIEW.md have per-hit rows; the
    # memory/ row is excluded by the query, the absolute path is dropped, and
    # the two live kinds contribute nothing.
    assert summary["entries_with_traces"] == 3
    assert summary["updated"] == 1
    assert summary["updated_paths"] == ["agents/foo.md"]
    assert summary["skipped_unchanged"] == 0
    assert summary["skipped_unparseable"] == 1
    assert summary["missing_entries"] == ["ghost/missing.md"]
    assert (
        summary["updated"] + summary["skipped_unchanged"]
        + summary["skipped_unparseable"] + len(summary["missing_entries"])
        == summary["entries_with_traces"]
    )

    fm = _frontmatter(wiki / "agents" / "foo.md")
    # Distinct agents, not raw hits (3 rows, 2 callers), sorted; latest date.
    assert fm["citations"] == 2
    assert fm["cited_by"] == ["claude-code", "coo"]
    assert fm["last_cited_at"] == "2026-05-15"
    assert fm["title"] == "Foo"
    # Body is untouched and `updated:` is not bumped by derived data.
    assert (wiki / "agents" / "foo.md").read_text(encoding="utf-8").endswith("## Rule\nDo foo.\n")
    assert "updated" not in fm
    # The generated overview is left byte-for-byte alone.
    assert (wiki / "agents" / "_OVERVIEW.md").read_text(encoding="utf-8") == "# Agents\n\n- [Foo](foo.md)\n"

    # Second run on the same trace state is a no-op.
    again = run_citations(cfg)
    assert again["updated"] == 0
    assert again["updated_paths"] == []
    assert again["skipped_unchanged"] == 1
    assert _frontmatter(wiki / "agents" / "foo.md") == fm


def test_dry_run_reports_without_writing(
    monkeypatch: pytest.MonkeyPatch, fixture_wiki: Path, tmp_path: Path
) -> None:
    db = _seed_brain_db(tmp_path / "brain.db")
    monkeypatch.setenv("DIGITAL_ME_BRAIN_DB", str(db))
    wiki = _seed_wiki(fixture_wiki)
    cfg = load_config(wiki_root=fixture_wiki)

    summary = run_citations(cfg, dry_run=True)

    assert summary["updated"] == 1
    assert summary["updated_paths"] == ["agents/foo.md"]
    [change] = summary["proposed_changes"]
    assert change["from"] == {"citations": 1, "cited_by": [], "last_cited_at": None}
    assert change["to"] == {
        "citations": 2,
        "cited_by": ["claude-code", "coo"],
        "last_cited_at": "2026-05-15",
    }
    assert (wiki / "agents" / "foo.md").read_text(encoding="utf-8") == FOO_MD


def test_explicit_db_path_wins_over_env(
    monkeypatch: pytest.MonkeyPatch, fixture_wiki: Path, tmp_path: Path
) -> None:
    monkeypatch.setenv("DIGITAL_ME_BRAIN_DB", str(tmp_path / "ignored.db"))
    db = _seed_brain_db(tmp_path / "explicit.db")
    _seed_wiki(fixture_wiki)
    cfg = load_config(wiki_root=fixture_wiki)
    summary = run_citations(cfg, db_path=db)
    assert summary["traces_db"] == str(db)
    assert summary["updated"] == 1
