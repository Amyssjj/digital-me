"""Reading the summarize handoff back out of brain.db.

Pins the 2026-10 outage: the publisher picked its handoff with
`t.name LIKE '%summar%' ... LIMIT 1`, which also matches the stage step
("Gather raw data and stage for the summarizer"). The stage task sorts first
and has no output, so every run logged "no valid agent handoff" and published
the deterministic render even when the summarizer completed with a valid
presentation.
"""

import json
import sqlite3
from pathlib import Path

from digest import daily_digest as dd

# The live workflow's step names, in materialization order (stage gets the
# lowest rowid — the tie the old LIMIT 1 resolved in the stage task's favour).
STAGE = "Gather raw data and stage for the summarizer"
SUMMARIZE = "Summarizer builds the presentation from staged data"
PUBLISH = "Validate the handoff and publish the digest to Discord"


def _payload(title="📰 Daily Digest — 2026-10-10"):
    return {
        "presentation": {
            "title": title,
            "tone": "success",
            "blocks": [
                # A fenced table INSIDE a block — the handoff fence regex must
                # still capture the whole object, as on the live 10-11 run.
                {"type": "text", "text": "```\nAgents  Wiki+\n     2     25\n```"},
                {"type": "divider"},
                {"type": "header", "text": "Wiki"},
                {"type": "text", "text": "1. [created] **Foo** — _infra_"},
            ],
        },
        "markdown": "# Daily Digest\n\n1. created Foo",
    }


def _envelope(payload):
    """The cli-exec-worker's tasks.handoff envelope: payload fenced in summary."""
    summary = "```json\n" + json.dumps(payload, ensure_ascii=False) + "\n```"
    return json.dumps(
        {
            "deliverableState": "complete",
            "summary": summary,
            "recommendedNextStep": "publish digest",
        },
        ensure_ascii=False,
    )


def _brain(tmp_path, goals):
    """goals: [(goal_id, name, created_at, source_workflow_id, [(task_name, output)])]."""
    db = tmp_path / "brain.db"
    con = sqlite3.connect(db)
    con.executescript(
        "CREATE TABLE goals (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
        "created_at INTEGER NOT NULL, source_workflow_id TEXT);"
        "CREATE TABLE tasks (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, "
        "name TEXT NOT NULL, latest_output TEXT);"
    )
    for gid, name, created, wf, tasks in goals:
        con.execute("INSERT INTO goals VALUES (?, ?, ?, ?)", (gid, name, created, wf))
        for i, (tname, out) in enumerate(tasks):
            con.execute(
                "INSERT INTO tasks VALUES (?, ?, ?, ?)", (f"{gid}-{i}", gid, tname, out),
            )
    con.commit()
    con.close()
    return db


def _run(gid, created, summarize_output, wf=dd.DIGEST_WORKFLOW_ID):
    return (
        gid,
        "Single morning digest in 3 steps. Step 1 (stage, exec): gather",
        created,
        wf,
        [(STAGE, None), (SUMMARIZE, summarize_output), (PUBLISH, None)],
    )


def test_workflow_id_matches_the_shipped_workflow():
    """The goal scope is only as good as this id: renaming the workflow must
    fail here, not silently send every digest down the regex fallback."""
    shipped = Path(dd.__file__).parent / "workflows" / "digest.json"
    assert json.loads(shipped.read_text(encoding="utf-8"))["id"] == dd.DIGEST_WORKFLOW_ID


def test_picks_summarizer_output_not_the_stage_task(tmp_path, monkeypatch):
    payload = _payload()
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_run("g1", 1, _envelope(payload))]))

    pres, md = dd.load_coo_handoff()

    assert pres == payload["presentation"]
    assert md == payload["markdown"]
    assert dd.validate_presentation(pres) == []


def test_latest_run_without_handoff_does_not_resurrect_older_day(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [
        _run("old", 1, _envelope(_payload("📰 Daily Digest — 2026-10-09"))),
        _run("new", 2, None),  # today's summarizer failed / stalled
    ]))

    assert dd.load_coo_handoff() == (None, None)
    assert "no summarize handoff" in capsys.readouterr().out


def test_unparseable_output_is_not_a_handoff(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_run("g1", 1, "summarizer crashed")]))

    assert dd.load_coo_handoff() == (None, None)
    assert "1 task output(s) checked" in capsys.readouterr().out


def test_goal_scope_is_the_workflow_id_not_the_goal_name(tmp_path, monkeypatch):
    """A newer ad-hoc goal whose NAME mentions the digest (e.g. an intake fix
    goal) must not shadow the latest real digest run."""
    payload = _payload()
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [
        _run("g1", 1, _envelope(payload)),
        ("fix-ops", "daily-activity-digest schedule failed at latest run", 2, None,
         [("summarize the failure", "investigating")]),
    ]))

    pres, _ = dd.load_coo_handoff()

    assert pres == payload["presentation"]


def test_markdown_only_handoff_returns_markdown(tmp_path, monkeypatch):
    out = json.dumps({"summary": "```json\n" + json.dumps({"markdown": "# md"}) + "\n```"})
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_run("g1", 1, out)]))

    assert dd.load_coo_handoff() == (None, "# md")


def test_missing_brain_db(tmp_path, monkeypatch):
    monkeypatch.setattr(dd, "BRAIN_DB", tmp_path / "absent.db")

    assert dd.load_coo_handoff() == (None, None)


def test_unreadable_brain_db_never_raises(tmp_path, monkeypatch, capsys):
    db = tmp_path / "brain.db"
    sqlite3.connect(db).close()  # exists, but no goals/tasks tables
    monkeypatch.setattr(dd, "BRAIN_DB", db)

    assert dd.load_coo_handoff() == (None, None)
    assert "brain.db read failed" in capsys.readouterr().out


def test_publish_uses_the_agent_handoff(tmp_path, monkeypatch, capsys):
    """End to end through `--publish`: the summarizer's presentation is what
    ships, and the deterministic fallback is never reached."""
    payload = _payload()
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_run("g1", 1, _envelope(payload))]))
    staging = tmp_path / "staging.json"
    staging.write_text(json.dumps({"date": "2026-10-10"}), encoding="utf-8")

    assert dd.main(["--publish", str(staging), "--date", "2026-10-10", "--dry-run"]) == 0

    out = capsys.readouterr().out
    assert "using agent summarize handoff (brain.db)" in out
    assert "no valid agent handoff" not in out
    assert "**Foo**" in out  # a summarizer-authored block, not the regex render
