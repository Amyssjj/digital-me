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
    """goals: [(goal_id, name, created_at, source_workflow_id, tasks)], where each
    task is (task_name, output[, status, failure_reason[, attempt_summaries]]).
    attempt_summaries are the output_summary of attempts 1..n, oldest first."""
    db = tmp_path / "brain.db"
    con = sqlite3.connect(db)
    con.executescript(
        "CREATE TABLE goals (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
        "created_at INTEGER NOT NULL, source_workflow_id TEXT);"
        "CREATE TABLE tasks (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, "
        "name TEXT NOT NULL, latest_output TEXT, "
        "status TEXT NOT NULL DEFAULT 'completed', failure_reason TEXT);"
        "CREATE TABLE attempts (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, "
        "attempt_number INTEGER NOT NULL, output_summary TEXT);"
    )
    for gid, name, created, wf, tasks in goals:
        con.execute("INSERT INTO goals VALUES (?, ?, ?, ?)", (gid, name, created, wf))
        for i, (tname, out, *state) in enumerate(tasks):
            status, reason, summaries = (*state, ())[:3] if state else ("completed", None, ())
            con.execute(
                "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)",
                (f"{gid}-{i}", gid, tname, out, status, reason),
            )
            for n, summary in enumerate(summaries, start=1):
                con.execute(
                    "INSERT INTO attempts VALUES (?, ?, ?, ?)",
                    (f"{gid}-{i}-a{n}", f"{gid}-{i}", n, summary),
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


# ── An expired CLI login is called out in the fallback digest ───────────────
# The live failure_reason from the 2026-10-10 run (and 10-08, 10-09). Before
# the alert, each of those mornings shipped a normal-looking regex digest.
OAUTH_EXPIRED = (
    "Command failed: /opt/homebrew/bin/node /x/cli-exec-worker.mjs /x/spec.json\n"
    "claude-code-cli exited 1\n"
    "Failed to authenticate: OAuth session expired and could not be refreshed\n\n"
)


def _failed_run(gid, created, reason):
    return (
        gid,
        "Single morning digest in 3 steps",
        created,
        dd.DIGEST_WORKFLOW_ID,
        [(STAGE, None), (SUMMARIZE, None, "failed", reason), (PUBLISH, None)],
    )


def test_reads_the_auth_failure_line(tmp_path, monkeypatch):
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_failed_run("g1", 1, OAUTH_EXPIRED)]))

    assert dd.load_summarizer_auth_failure() == (
        "Failed to authenticate: OAuth session expired and could not be refreshed", None,
    )


def test_reads_the_not_logged_in_variant(tmp_path, monkeypatch):
    """Early in the 07-02 and 08-14 lapses the CLI said this instead."""
    reason = "claude-code-cli exited 1\nNot logged in · Please run /login\n"
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_failed_run("g1", 1, reason)]))

    assert dd.load_summarizer_auth_failure() == ("Not logged in · Please run /login", None)


def test_other_failures_are_not_auth_failures(tmp_path, monkeypatch):
    reason = "claude-code-cli exited 2\nmissing completion marker: DIGITAL_ME_EXEC_OK\n"
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_failed_run("g1", 1, reason)]))

    assert dd.load_summarizer_auth_failure() is None


def test_a_retry_that_completed_is_not_an_auth_failure(tmp_path, monkeypatch):
    """failure_reason can outlive a successful retry; only `failed` counts."""
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [(
        "g1", "digest", 1, dd.DIGEST_WORKFLOW_ID,
        [(SUMMARIZE, _envelope(_payload()), "completed", OAUTH_EXPIRED)],
    )]))

    assert dd.load_summarizer_auth_failure() is None


def test_an_older_runs_auth_failure_is_not_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [
        _failed_run("old", 1, OAUTH_EXPIRED),
        _run("new", 2, _envelope(_payload())),
    ]))

    assert dd.load_summarizer_auth_failure() is None


def test_auth_failure_read_without_brain_db(tmp_path, monkeypatch):
    monkeypatch.setattr(dd, "BRAIN_DB", tmp_path / "absent.db")

    assert dd.load_summarizer_auth_failure() is None


def test_auth_failure_read_never_raises(tmp_path, monkeypatch, capsys):
    db = tmp_path / "brain.db"
    sqlite3.connect(db).close()  # exists, but no goals/tasks tables
    monkeypatch.setattr(dd, "BRAIN_DB", db)

    assert dd.load_summarizer_auth_failure() is None
    assert "brain.db read failed" in capsys.readouterr().out


def _publish_dry_run(tmp_path, monkeypatch, capsys):
    """`--publish --dry-run` with the regex render stubbed to a fixed card."""
    monkeypatch.setattr(dd, "_LLM_DISABLED", False)  # restored after the test
    monkeypatch.setattr(dd, "render_full", lambda _date: ("# regex md", {}))
    monkeypatch.setattr(dd, "render_components", lambda _s: {
        "title": "📰 Daily Digest — 2026-10-10",
        "tone": "success",
        "blocks": [{"type": "text", "text": "regex-rendered body"}],
    })
    staging = tmp_path / "staging.json"
    staging.write_text(json.dumps({"date": "2026-10-10"}), encoding="utf-8")

    assert dd.main(["--publish", str(staging), "--date", "2026-10-10", "--dry-run"]) == 0

    out = capsys.readouterr().out
    shipped = json.loads(out.split("[publish dry-run] presentation:\n", 1)[1])
    return out, shipped


def test_fallback_digest_leads_with_the_relogin_notice(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_failed_run("g1", 1, OAUTH_EXPIRED)]))

    out, shipped = _publish_dry_run(tmp_path, monkeypatch, capsys)

    assert "summarizer failed on CLI auth" in out
    assert shipped["tone"] == "warning"
    notice = shipped["blocks"][0]["text"]
    assert "login has expired" in notice
    assert "OAuth session expired" in notice
    assert "/login" in notice
    assert shipped["blocks"][1] == {"type": "divider"}
    assert "regex-rendered body" in shipped["blocks"][2]["text"]
    assert dd.validate_presentation(shipped) == []


def test_fallback_for_other_reasons_has_no_notice(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_run("g1", 1, None)]))

    out, shipped = _publish_dry_run(tmp_path, monkeypatch, capsys)

    assert "no valid agent handoff" in out
    assert shipped["tone"] == "success"
    assert "login has expired" not in out


def test_agent_digest_never_carries_the_notice(tmp_path, monkeypatch, capsys):
    """When the agent's presentation ships, the login worked; a failed sibling
    task in the same run doesn't change that."""
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [(
        "g1", "digest", 1, dd.DIGEST_WORKFLOW_ID,
        [(SUMMARIZE, _envelope(_payload())), ("extra", None, "failed", OAUTH_EXPIRED)],
    )]))

    out, shipped = _publish_dry_run(tmp_path, monkeypatch, capsys)

    assert "using agent summarize handoff (brain.db)" in out
    assert "login has expired" not in out
    assert shipped["tone"] == "success"


# ── …including when a fallback CLI covered for it ───────────────────────────
# Verbatim worker stdout (→ attempts.output_summary) from the 2026-10-11 e2e:
# claude failed on auth, codex-cli did the work, the task completed.
COVERED_SUMMARY = (
    "fallback: running codex-cli because claude-code-cli failed: "
    "Failed to authenticate: OAuth session expired and could not be refreshed\n"
    "DIGITAL_ME_EXEC_OK claude-code-cli e2e-task\n"
    "handoff=/x/artifacts/handoff.json\n"
    "log=/x/artifacts/worker.log\n"
    "finalMessage=/x/artifacts/final-message.txt\n"
)
CLEAN_SUMMARY = "DIGITAL_ME_EXEC_OK claude-code-cli t\nhandoff=/x/handoff.json\n"


def _covered_run(summaries, output=None):
    return (
        "g1", "digest", 1, dd.DIGEST_WORKFLOW_ID,
        [(STAGE, None), (SUMMARIZE, output, "completed", None, summaries), (PUBLISH, None)],
    )


def test_reads_an_auth_failure_a_fallback_covered(tmp_path, monkeypatch):
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_covered_run([COVERED_SUMMARY])]))

    assert dd.load_summarizer_auth_failure() == (
        "Failed to authenticate: OAuth session expired and could not be refreshed", "codex-cli",
    )


def test_only_the_latest_attempt_speaks_for_a_completed_task(tmp_path, monkeypatch):
    """Attempt 1 fell back; attempt 2 ran on claude again — the login is fine."""
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [
        _covered_run([COVERED_SUMMARY, CLEAN_SUMMARY]),
    ]))

    assert dd.load_summarizer_auth_failure() is None


def test_a_fallback_for_other_reasons_is_not_an_auth_failure(tmp_path, monkeypatch):
    summary = "fallback: running codex-cli because claude-code-cli failed: exit 4\nDIGITAL_ME_EXEC_OK x\n"
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_covered_run([summary])]))

    assert dd.load_summarizer_auth_failure() is None


def test_covered_digest_credits_the_fallback_and_still_asks_for_login(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [
        _covered_run([COVERED_SUMMARY], output=_envelope(_payload())),
    ]))

    out, shipped = _publish_dry_run(tmp_path, monkeypatch, capsys)

    assert "using agent summarize handoff (brain.db)" in out
    assert shipped["tone"] == "warning"
    notice = shipped["blocks"][0]["text"]
    assert "`codex-cli` built this digest instead" in notice
    assert "/login" in notice
    assert "fail the same way" not in notice
    assert any("**Foo**" in b.get("text", "") for b in shipped["blocks"])  # the agent's own content
    assert dd.validate_presentation(shipped) == []


def test_unusable_fallback_output_is_not_credited(tmp_path, monkeypatch, capsys):
    """codex completed but left no usable presentation → regex render; the
    notice must not claim codex built it."""
    monkeypatch.setattr(dd, "BRAIN_DB", _brain(tmp_path, [_covered_run([COVERED_SUMMARY])]))

    out, shipped = _publish_dry_run(tmp_path, monkeypatch, capsys)

    assert "no valid agent handoff" in out
    notice = shipped["blocks"][0]["text"]
    assert "so this digest was built without it" in notice
    assert "codex-cli" not in notice
