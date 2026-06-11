"""Tests for stream_activity — brain → dashboard.db `activity` snapshot.

Run via pytest (from the intake/ directory):
  python -m pytest dashboard_intake/test_stream_activity.py
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from dashboard_intake.stream_activity import main


def _create_dashboard_schema(db_path: Path) -> None:
    """Mirror the `activity` table from server/migrate.ts."""
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS activity (
            id           TEXT PRIMARY KEY,
            ts           TEXT NOT NULL,
            agent_id     TEXT NOT NULL,
            activity     TEXT NOT NULL,
            title        TEXT NOT NULL,
            description  TEXT,
            meta         TEXT,
            attachments  TEXT
        );
        """
    )
    conn.commit()
    conn.close()


def _seed_brain(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE traces (
            id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}', t INTEGER NOT NULL
        );
        CREATE TABLE learnings (
            id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
            text TEXT NOT NULL, why TEXT, apply_when TEXT, proposed_wiki_path TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE m1_events (
            event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, event_type TEXT NOT NULL,
            entries_json TEXT NOT NULL DEFAULT '[]', t INTEGER NOT NULL
        );
        CREATE TABLE goals (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending', type TEXT NOT NULL DEFAULT 'project',
            created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
            source_workflow_id TEXT
        );
        CREATE TABLE workflow_templates (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        """
    )
    # captured: trace ⨝ learning
    conn.execute(
        "INSERT INTO learnings (id, agent_id, kind, text, why, proposed_wiki_path, created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        ("lrn-1", "podcast", "project", "Always X before Y", "Prevents Z", "wiki/ops/x.md", 3000),
    )
    conn.execute(
        "INSERT INTO traces (id, agent_id, kind, payload, t) VALUES (?,?,?,?,?)",
        ("trc-1", "podcast", "learning_captured",
         json.dumps({"learning_id": "lrn-1", "learning_kind": "project"}), 3000),
    )
    # A second `learning_captured` trace for the SAME learning — what an agent
    # does when it records its own richer trace via `traces_record` after the
    # `learning_capture` tool already auto-paired one. Must collapse to ONE card.
    conn.execute(
        "INSERT INTO traces (id, agent_id, kind, payload, t) VALUES (?,?,?,?,?)",
        ("trc-1b", "podcast", "learning_captured",
         json.dumps({"learning_id": "lrn-1", "topic": "X before Y", "source": "session"}), 3050),
    )
    # applied: knowledge_surfaced with a duplicate basename (dedup → 2 distinct)
    conn.execute(
        "INSERT INTO m1_events (event_id, agent_id, event_type, entries_json, t) VALUES (?,?,?,?,?)",
        ("evt-1", "claude-code", "knowledge_surfaced",
         json.dumps([{"path": "../../a.md"}, {"path": "x/a.md"}, {"path": "y/b.md"}]), 2000),
    )
    # workflow: a real workflow_template with two orchestrator runs (→ ONE card,
    # run_count=2, latest run wins) + a dashboard-intake self-ingest workflow
    # (→ its own rolled-up card; per-template grouping keeps it from flooding).
    conn.execute(
        "INSERT INTO workflow_templates (id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)",
        ("wf-ops", "Ops Health Detect", "detect ops issues", 500, 500),
    )
    conn.execute(
        "INSERT INTO workflow_templates (id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)",
        ("company-dashboard-intake", "Dashboard Intake", "self ingest", 500, 500),
    )
    conn.execute(
        "INSERT INTO goals (id, name, description, type, created_at, created_by, source_workflow_id)"
        " VALUES (?,?,?,?,?,?,?)",
        ("g-ops-1", "Ops Health Detect", "run", "project", 800, "orchestrator", "wf-ops"),
    )
    conn.execute(
        "INSERT INTO goals (id, name, description, type, created_at, created_by, source_workflow_id)"
        " VALUES (?,?,?,?,?,?,?)",
        ("g-ops-2", "Ops Health Detect", "run", "project", 1000, "orchestrator", "wf-ops"),
    )
    conn.execute(
        "INSERT INTO goals (id, name, description, type, created_at, created_by, source_workflow_id)"
        " VALUES (?,?,?,?,?,?,?)",
        ("g-cron", "Populate dashboard", "recurring", "project", 2500, "orchestrator", "company-dashboard-intake"),
    )
    conn.commit()
    conn.close()


def _rows(db_path: Path) -> list[sqlite3.Row]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM activity ORDER BY ts DESC").fetchall()
    conn.close()
    return rows


def test_merges_streams_and_includes_all_workflows(tmp_path: Path) -> None:
    brain = tmp_path / "brain.db"
    dash = tmp_path / "dashboard.db"
    _seed_brain(brain)
    _create_dashboard_schema(dash)

    # Point --tastes-dir at an empty dir so this test stays brain-only/deterministic.
    rc = main(["--brain-db", str(brain), "--db", str(dash), "--tastes-dir", str(tmp_path / "no-tastes")])
    assert rc == 0

    rows = _rows(dash)
    kinds = [r["activity"] for r in rows]
    # By ts DESC: captured (t=3000) > dashboard-intake workflow (latest run
    # t=2500) > applied (t=2000) > ops workflow (latest run t=1000). Every
    # workflow template is surfaced — none are filtered as noise.
    assert kinds == ["captured", "workflow", "applied", "workflow"]

    by_id = {r["id"]: r for r in rows}
    # captured is keyed by learning_id (`cap::<id>`), not trace id, so the same
    # learning renders as ONE card no matter how many traces reference it.
    assert by_id["cap::lrn-1"]["title"] == "Always X before Y"
    assert by_id["cap::lrn-1"]["description"] == "Prevents Z"
    assert "x.md" in by_id["cap::lrn-1"]["meta"]
    # captured carries one attachment; with no wiki file, markdown is composed
    # from the raw learning fields (still real, renderable content).
    cap_att = json.loads(by_id["cap::lrn-1"]["attachments"])
    assert len(cap_att) == 1
    assert cap_att[0]["title"] == "Always X before Y"
    assert "Prevents Z" in cap_att[0]["markdown"]
    # exactly one captured card despite the duplicate trace seeded below.
    assert kinds.count("captured") == 1
    # applied dedups a.md (two paths) + b.md → 2 distinct, separately previewable.
    assert by_id["evt-1"]["title"] == "Applied 2 learnings"
    assert by_id["evt-1"]["description"] == "a.md, b.md"
    app_att = json.loads(by_id["evt-1"]["attachments"])
    assert [a["path"] for a in app_att] == ["a.md", "b.md"]
    # workflow: one card per template, keyed wf::<id>, no attachments, named
    # from the template, run_count rolled up, attributed to the orchestrator.
    wf = by_id["wf::wf-ops"]
    assert wf["title"] == "Ops Health Detect"
    assert wf["description"] == "detect ops issues"
    assert wf["agent_id"] == "orchestrator"
    assert wf["meta"] == "2 runs"
    assert wf["attachments"] is None
    assert wf["ts"].startswith("1970")  # latest run (t=1000ms) → epoch ISO
    # the dashboard-intake self-ingest workflow gets its own rolled-up card —
    # one per template, latest run wins, NOT filtered out.
    di = by_id["wf::company-dashboard-intake"]
    assert di["title"] == "Dashboard Intake"
    assert di["description"] == "self ingest"
    assert di["meta"] == "1 run"


def test_applied_reads_real_markdown_from_wiki(tmp_path: Path) -> None:
    """An applied event's recalled paths are resolved to real .md files under
    the wiki root and their content is snapshotted per learning."""
    brain = tmp_path / "brain.db"
    dash = tmp_path / "dashboard.db"
    wiki = tmp_path / "wiki"
    (wiki / "dev").mkdir(parents=True)
    (wiki / "dev" / "foo.md").write_text("# Foo rule\n\nThe real body of foo.", encoding="utf-8")

    conn = sqlite3.connect(str(brain))
    conn.executescript(
        """
        CREATE TABLE traces (id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT, payload TEXT, t INTEGER);
        CREATE TABLE learnings (id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT, text TEXT, why TEXT,
                                apply_when TEXT, proposed_wiki_path TEXT, created_at INTEGER);
        CREATE TABLE m1_events (event_id TEXT PRIMARY KEY, agent_id TEXT, event_type TEXT,
                                entries_json TEXT, t INTEGER);
        CREATE TABLE goals (id TEXT PRIMARY KEY, name TEXT, description TEXT, status TEXT,
                            type TEXT, created_at INTEGER, created_by TEXT);
        """
    )
    conn.execute(
        "INSERT INTO m1_events (event_id, agent_id, event_type, entries_json, t) VALUES (?,?,?,?,?)",
        ("evt-md", "claude-code", "knowledge_surfaced",
         json.dumps([
             {"path": "wiki/dev/foo.md", "title": "Foo"},
             {"path": "wiki/dev/missing.md"},
         ]), 5000),
    )
    conn.commit()
    conn.close()
    _create_dashboard_schema(dash)

    rc = main(["--brain-db", str(brain), "--db", str(dash), "--wiki-dir", str(wiki)])
    assert rc == 0

    rows = _rows(dash)
    att = json.loads(rows[0]["attachments"])
    assert len(att) == 2
    assert att[0]["title"] == "Foo"
    assert att[0]["markdown"] == "# Foo rule\n\nThe real body of foo."
    # A path with no file still yields a previewable card (markdown is None).
    assert att[1]["markdown"] is None


def test_taste_stream_reads_leaf_files(tmp_path: Path) -> None:
    """Taste leaves under the tastes tree become `taste` feed rows — with the
    real leaf markdown snapshotted — and run even when the brain is absent."""
    dash = tmp_path / "dashboard.db"
    tastes = tmp_path / "tastes"
    (tastes / "design").mkdir(parents=True)
    leaf = tastes / "design" / "restraint-earns-its-place.md"
    leaf.write_text(
        "---\n"
        "domain: design\n"
        "status: promoted\n"
        "title: Every element earns its place\n"
        "updated: '2026-05-23'\n"
        "---\n\n"
        "## Principle\n\n"
        "Restraint is the default; each element must justify itself.\n\n"
        "## Evidence\n\n[]\n",
        encoding="utf-8",
    )
    _create_dashboard_schema(dash)

    # No brain DB → only the taste stream runs.
    rc = main(["--brain-db", str(tmp_path / "nope.db"), "--db", str(dash), "--tastes-dir", str(tastes)])
    assert rc == 0

    rows = _rows(dash)
    assert len(rows) == 1
    r = rows[0]
    assert r["activity"] == "taste"
    assert r["agent_id"] == "dream-cycle"
    assert r["title"] == "Every element earns its place"
    assert r["description"] == "Restraint is the default; each element must justify itself."
    assert r["meta"] == "design · promoted"
    assert r["ts"].startswith("2026-05-23")
    att = json.loads(r["attachments"])
    assert len(att) == 1
    assert att[0]["path"] == "restraint-earns-its-place.md"
    assert "## Principle" in att[0]["markdown"]


def test_idempotent_upsert(tmp_path: Path) -> None:
    brain = tmp_path / "brain.db"
    dash = tmp_path / "dashboard.db"
    _seed_brain(brain)
    _create_dashboard_schema(dash)

    taste_arg = ["--tastes-dir", str(tmp_path / "no-tastes")]
    assert main(["--brain-db", str(brain), "--db", str(dash), *taste_arg]) == 0
    first = len(_rows(dash))
    # Re-run over the same window must not duplicate.
    assert main(["--brain-db", str(brain), "--db", str(dash), *taste_arg]) == 0
    assert len(_rows(dash)) == first


def test_prunes_legacy_per_goal_workflow_rows(tmp_path: Path) -> None:
    """A stale workflow card from the old per-goal id scheme is removed once the
    brain stream refreshes the new per-template (`wf::`) cards."""
    brain = tmp_path / "brain.db"
    dash = tmp_path / "dashboard.db"
    _seed_brain(brain)
    _create_dashboard_schema(dash)

    # Simulate a snapshot written by the old code: a workflow card keyed by a
    # goal id, plus an unrelated captured card that must survive untouched.
    conn = sqlite3.connect(str(dash))
    conn.execute(
        "INSERT INTO activity VALUES ('g-legacy','2026-05-18T00:00:00Z','intake','workflow','Fix wiki drift',NULL,'project',NULL)"
    )
    conn.commit()
    conn.close()

    rc = main(["--brain-db", str(brain), "--db", str(dash), "--tastes-dir", str(tmp_path / "no-tastes")])
    assert rc == 0

    ids = {r["id"] for r in _rows(dash)}
    assert "g-legacy" not in ids          # legacy per-goal workflow card pruned
    assert "wf::wf-ops" in ids            # replaced by the per-template card
    assert "cap::lrn-1" in ids            # non-workflow cards are left alone


def test_prunes_legacy_per_trace_captured_rows(tmp_path: Path) -> None:
    """A stale captured card from the old per-trace id scheme is removed once the
    brain stream refreshes the new per-learning (`cap::`) card — so a learning
    that previously rendered as several trace cards collapses to one."""
    brain = tmp_path / "brain.db"
    dash = tmp_path / "dashboard.db"
    _seed_brain(brain)
    _create_dashboard_schema(dash)

    # Simulate a snapshot written by the old code: two captured cards keyed by
    # trace id for the same learning (the duplicate the user saw).
    conn = sqlite3.connect(str(dash))
    conn.execute(
        "INSERT INTO activity VALUES ('trc-1','2026-05-18T00:00:00Z','podcast','captured','Always X before Y',NULL,'project',NULL)"
    )
    conn.execute(
        "INSERT INTO activity VALUES ('trc-1b','2026-05-18T00:00:01Z','podcast','captured','Always X before Y',NULL,NULL,NULL)"
    )
    conn.commit()
    conn.close()

    rc = main(["--brain-db", str(brain), "--db", str(dash), "--tastes-dir", str(tmp_path / "no-tastes")])
    assert rc == 0

    rows = _rows(dash)
    ids = {r["id"] for r in rows}
    assert "trc-1" not in ids and "trc-1b" not in ids  # legacy per-trace cards pruned
    assert "cap::lrn-1" in ids                          # replaced by the per-learning card
    assert [r["activity"] for r in rows].count("captured") == 1


def test_missing_brain_is_noop(tmp_path: Path) -> None:
    dash = tmp_path / "dashboard.db"
    _create_dashboard_schema(dash)
    # Pre-existing snapshot must survive a run when the brain is absent.
    conn = sqlite3.connect(str(dash))
    conn.execute(
        "INSERT INTO activity VALUES ('old','2026-01-01T00:00:00Z','cc','applied','Applied 1 learning',NULL,'recalled',NULL)"
    )
    conn.commit()
    conn.close()

    # Empty tastes dir too → no stream produces rows, snapshot must survive.
    rc = main([
        "--brain-db", str(tmp_path / "nope.db"), "--db", str(dash),
        "--tastes-dir", str(tmp_path / "no-tastes"),
    ])
    assert rc == 0
    rows = _rows(dash)
    assert [r["id"] for r in rows] == ["old"]
