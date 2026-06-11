"""Tests for scan_knowledge_trees aggregate + stale-alias cleanup.

Run via pytest (from the intake/ directory):
  python -m pytest dashboard_intake/test_scan_knowledge_trees.py
"""

from __future__ import annotations

import sqlite3
import textwrap
from datetime import date, timedelta
from pathlib import Path

import pytest

from dashboard_intake.scan_knowledge_trees import (
    TASTE_DOMAIN_ALIASES,
    aggregate,
    main,
)


# ── Schema helper ────────────────────────────────────────────────────────────


def _create_schema(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS knowledge_taste_distribution (
            tree   TEXT NOT NULL,
            domain TEXT NOT NULL,
            total  INTEGER NOT NULL DEFAULT 0,
            as_of  TEXT NOT NULL,
            PRIMARY KEY (tree, domain)
        );
        CREATE TABLE IF NOT EXISTS knowledge_taste_changes (
            date    TEXT NOT NULL,
            tree    TEXT NOT NULL,
            domain  TEXT NOT NULL,
            created INTEGER NOT NULL DEFAULT 0,
            updated INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, tree, domain)
        );
    """)
    conn.commit()
    conn.close()


def _distribution_domains(db_path: Path) -> set[tuple[str, str]]:
    conn = sqlite3.connect(str(db_path))
    rows = conn.execute(
        "SELECT tree, domain FROM knowledge_taste_distribution"
    ).fetchall()
    conn.close()
    return {(r[0], r[1]) for r in rows}


def _md(domain_dir: Path, slug: str, created: str) -> None:
    domain_dir.mkdir(parents=True, exist_ok=True)
    (domain_dir / f"{slug}.md").write_text(
        textwrap.dedent(f"""\
            ---
            created: {created}
            ---
            body
        """),
        encoding="utf-8",
    )


def _taste_md(
    domain_dir: Path,
    slug: str,
    *,
    created: str,
    updated: str | None = None,
    evidence_dates: list[str] | None = None,
) -> None:
    """Write a taste file with frontmatter dates and an optional Evidence
    block carrying activity (source) dates, mirroring dream-cycle output."""
    domain_dir.mkdir(parents=True, exist_ok=True)
    fm_updated = updated if updated is not None else created
    body = textwrap.dedent(f"""\
        ---
        created: {created}
        updated: {fm_updated}
        title: {slug}
        ---

        ## Principle
        body
    """)
    if evidence_dates is not None:
        records = ",\n".join(
            f'  {{"project_id": "p{i}", "date": "{d}", "wiki_paths": [],'
            f' "what_happened": "x", "what_triggers_principle": "y"}}'
            for i, d in enumerate(evidence_dates)
        )
        body += "\n## Evidence\n\n```json\n[\n" + records + "\n]\n```\n"
    (domain_dir / f"{slug}.md").write_text(body, encoding="utf-8")


def _changes_for(db_path: Path) -> dict[tuple[str, str, str], tuple[int, int]]:
    conn = sqlite3.connect(str(db_path))
    rows = conn.execute(
        "SELECT date, tree, domain, created, updated FROM knowledge_taste_changes"
    ).fetchall()
    conn.close()
    return {(r[0], r[1], r[2]): (r[3], r[4]) for r in rows}


# ── Tests ────────────────────────────────────────────────────────────────────


def test_alias_map_is_nonempty() -> None:
    assert TASTE_DOMAIN_ALIASES, "TASTE_DOMAIN_ALIASES must not be empty"
    assert TASTE_DOMAIN_ALIASES["infra"] == "infrastructure"
    assert TASTE_DOMAIN_ALIASES["knowledge"] == "knowledge-management"


def test_aggregate_normalises_taste_domains(tmp_path: Path) -> None:
    wiki = tmp_path / "wiki"
    tastes = tmp_path / "tastes"
    today = date.today().isoformat()

    _md(wiki / "infrastructure", "w1", today)
    _md(tastes / "infra", "t1", today)
    _md(tastes / "knowledge", "t2", today)

    _, dist = aggregate(wiki, tastes, date.today(), date.today())

    # Short domain names must NOT appear; only canonical names should.
    taste_domains = {domain for (tree, domain) in dist if tree == "tastes"}
    assert "infra" not in taste_domains, "raw 'infra' key should be aliased away"
    assert "knowledge" not in taste_domains, "raw 'knowledge' key should be aliased away"
    assert "infrastructure" in taste_domains
    assert "knowledge-management" in taste_domains


def test_taste_attributed_to_evidence_date_not_frontmatter(tmp_path: Path) -> None:
    """The reported bug: dream cycle writes a 5/31 taste at 02:47 on 6/1.
    Frontmatter says created 6/1, but the evidence record says 5/31. The
    daily-flow chart must count it under 5/31, matching the daily digest."""
    wiki = tmp_path / "wiki"
    tastes = tmp_path / "tastes"
    activity = "2026-05-31"
    materialized = "2026-06-01"

    _taste_md(
        tastes / "design",
        "t1",
        created=materialized,
        updated=materialized,
        evidence_dates=[activity],
    )

    start = date(2026, 5, 1)
    end = date(2026, 6, 30)
    changes, _ = aggregate(wiki, tastes, start, end)

    # Counted under the activity date, NOT the materialization date.
    assert changes[(activity, "tastes", "design")] == {"created": 1, "updated": 1}
    assert (materialized, "tastes", "design") not in changes


def test_taste_created_and_updated_span_evidence_range(tmp_path: Path) -> None:
    """A promoted taste with multiple evidence records: earliest evidence
    seeds 'created', latest reflects the most recent 'update'."""
    wiki = tmp_path / "wiki"
    tastes = tmp_path / "tastes"

    _taste_md(
        tastes / "design",
        "t1",
        created="2026-06-01",
        updated="2026-06-01",
        evidence_dates=["2026-05-12", "2026-05-31"],
    )

    changes, _ = aggregate(wiki, tastes, date(2026, 5, 1), date(2026, 6, 30))

    assert changes[("2026-05-12", "tastes", "design")] == {"created": 1, "updated": 0}
    assert changes[("2026-05-31", "tastes", "design")] == {"created": 0, "updated": 1}


def test_taste_without_evidence_falls_back_to_frontmatter(tmp_path: Path) -> None:
    """No Evidence block → frontmatter dates remain the source of truth."""
    wiki = tmp_path / "wiki"
    tastes = tmp_path / "tastes"

    _taste_md(
        tastes / "design",
        "t1",
        created="2026-05-20",
        updated="2026-05-20",
        evidence_dates=None,
    )

    changes, _ = aggregate(wiki, tastes, date(2026, 5, 1), date(2026, 6, 30))

    assert changes[("2026-05-20", "tastes", "design")] == {"created": 1, "updated": 1}


def test_wiki_ignores_evidence_uses_frontmatter(tmp_path: Path) -> None:
    """Evidence-date attribution is tastes-only; wiki entries (which never
    carry an evidence block anyway) stay on frontmatter dates."""
    wiki = tmp_path / "wiki"
    tastes = tmp_path / "tastes"

    # Even if a wiki file somehow contained an evidence block, the wiki tree
    # must not use it — frontmatter is authoritative for wiki.
    _taste_md(
        wiki / "infrastructure",
        "w1",
        created="2026-05-20",
        updated="2026-05-20",
        evidence_dates=["2026-01-01"],
    )

    changes, _ = aggregate(wiki, tastes, date(2026, 1, 1), date(2026, 6, 30))

    assert changes[("2026-05-20", "wiki", "infrastructure")] == {"created": 1, "updated": 1}
    assert ("2026-01-01", "wiki", "infrastructure") not in changes


def test_main_removes_stale_distribution_rows(tmp_path: Path) -> None:
    """Upgraded DBs that already hold (tastes, infra) and (tastes, knowledge)
    rows must have those rows removed after the first post-alias scan so the
    radar does not show duplicate axes."""
    wiki = tmp_path / "wiki"
    tastes = tmp_path / "tastes"
    db_path = tmp_path / "dashboard.db"
    today = date.today().isoformat()

    # Seed markdown files so the scan emits canonical distribution rows.
    _md(wiki / "infrastructure", "w1", today)
    _md(tastes / "infra", "t1", today)
    _md(tastes / "knowledge", "t2", today)

    # Seed the DB as it would look before this PR: short-domain rows present.
    _create_schema(db_path)
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT INTO knowledge_taste_distribution (tree, domain, total, as_of)"
        " VALUES ('tastes', 'infra', 5, '2026-01-01')"
    )
    conn.execute(
        "INSERT INTO knowledge_taste_distribution (tree, domain, total, as_of)"
        " VALUES ('tastes', 'knowledge', 3, '2026-01-01')"
    )
    conn.commit()
    conn.close()

    # Confirm stale rows are in the DB before the scan.
    domains_before = _distribution_domains(db_path)
    assert ("tastes", "infra") in domains_before
    assert ("tastes", "knowledge") in domains_before

    # Run the scan.
    rc = main(["--db", str(db_path), "--wiki", str(wiki), "--tastes", str(tastes)])
    assert rc == 0

    # Stale short-domain rows must be gone; canonical rows must be present.
    domains_after = _distribution_domains(db_path)
    assert ("tastes", "infra") not in domains_after, "stale 'infra' row should be deleted"
    assert ("tastes", "knowledge") not in domains_after, "stale 'knowledge' row should be deleted"
    assert ("tastes", "infrastructure") in domains_after
    assert ("tastes", "knowledge-management") in domains_after
    assert ("wiki", "infrastructure") in domains_after


def test_wiki_update_counts_only_on_real_body_change(tmp_path: Path) -> None:
    """Regression: the nightly consolidate/reindex rewrites a wiki file's
    frontmatter `updated:` (and `related:`) without changing the knowledge.
    That must NOT register as a dashboard `updated` — only a genuine body edit
    does. (Pre-fix, every consolidation-touched file counted as an update,
    inflating wiki numbers far past the daily digest.)"""
    import sqlite3
    from datetime import date as _date

    from dashboard_intake.scan_knowledge_trees import (
        _resolve_wiki_change_dates,
        aggregate,
    )

    wiki = tmp_path / "wiki"
    tastes = tmp_path / "tastes"
    dom = wiki / "infrastructure"
    dom.mkdir(parents=True)
    f = dom / "x.md"
    today = _date.today()

    def write(body: str, updated: str) -> None:
        f.write_text(
            f"---\ncreated: 2026-01-01\nupdated: {updated}\n---\n\n{body}\n",
            encoding="utf-8",
        )

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row

    # 1. First observation → seeded, no known genuine update yet.
    write("## Rule\nOriginal body.", "2026-01-01")
    cd = _resolve_wiki_change_dates(wiki, conn)
    assert cd[str(f)] is None

    # 2. Consolidation bumps `updated:` to today; BODY UNCHANGED → no update.
    write("## Rule\nOriginal body.", today.isoformat())
    cd = _resolve_wiki_change_dates(wiki, conn)
    assert cd[str(f)] is None
    changes, _ = aggregate(wiki, tastes, today, today, cd)
    assert (
        changes.get((today.isoformat(), "wiki", "infrastructure"), {}).get("updated", 0)
        == 0
    )

    # 3. Real body edit → counts as one update today.
    write("## Rule\nRewritten — genuinely different content.", today.isoformat())
    cd = _resolve_wiki_change_dates(wiki, conn)
    assert cd[str(f)] == today
    changes, _ = aggregate(wiki, tastes, today, today, cd)
    assert changes[(today.isoformat(), "wiki", "infrastructure")]["updated"] == 1
