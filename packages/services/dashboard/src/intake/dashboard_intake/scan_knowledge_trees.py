"""Step 2/4: scan_knowledge_trees — walk wiki/ + tastes/ → knowledge_taste_changes
                                                          + knowledge_taste_distribution.

Reads frontmatter from every *.md in ~/digital-me/{wiki,tastes}/<domain>/<slug>.md
(post §A unification — both trees share the same frontmatter schema), then:

  - per (date, tree, domain) → counts of files attributed to that date.
    Upserts knowledge_taste_changes.

    Attribution date = the tree's own chronology: frontmatter `created` for
    creations (mtime as last resort), and the body-hash store for updates
    (count an update only on the day a file's BODY genuinely changed) — for
    BOTH trees.

    Rejected alternative (the 2026-07-03 incident): tastes used to be
    attributed to their embedded evidence-record dates (the *activity date*
    of the source conversation) so a taste materialized at 02:47 on 6/1 for
    a 5/31 conversation counted under 5/31. That assumed the dream cycle
    processes yesterday's transcripts tonight. Once the taste pipeline went
    staged/batchy it started materializing leaves DAYS after their source
    conversations (e.g. evidence dated 06-30 appended on 07-02), so every
    new leaf and update was back-dated out of the chart's recent window —
    the taste flow read 0 all July while leaves were landing on disk.
    Activity-date attribution rewrote history instead of showing flow;
    the tree's frontmatter chronology is the truth a human can verify
    (and what motus-data-sweep gates against).

  - per (tree, domain) → total file count today. Refreshes
    knowledge_taste_distribution. This is inventory ("what exists on disk
    as of today"), so it intentionally stays materialization-based.

Idempotent: window upserts on conflict; distribution upserts on conflict.

Usage:
  python -m dashboard_intake.scan_knowledge_trees [--days N]
                                                  [--db PATH]
                                                  [--wiki PATH]
                                                  [--tastes PATH]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable, Optional

import yaml

from . import db_path, tastes_root, wiki_root
from .db import (
    connect,
    upsert_knowledge_taste_change,
    upsert_knowledge_taste_distribution,
)

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)


def _parse_frontmatter(md: Path) -> Optional[dict]:
    try:
        text = md.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    m = FRONTMATTER_RE.match(text)
    if not m:
        return None
    try:
        fm = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return None
    if not isinstance(fm, dict):
        return None
    return fm


def _body_hash(md: Path) -> Optional[str]:
    """SHA-256 of an entry's BODY (markdown after the frontmatter), whitespace-
    normalized. Frontmatter is excluded on purpose: the nightly consolidate /
    reindex pass churns `updated`, `related`, `citations`, `evidence_count`
    without touching the knowledge itself — hashing the body lets us tell a real
    content change from a maintenance rewrite, so the dashboard stops counting
    those rewrites as `updated` events (which over-counted vs the daily digest)."""
    try:
        text = md.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    m = FRONTMATTER_RE.match(text)
    body = text[m.end():] if m else text
    return hashlib.sha256(body.strip().encode("utf-8")).hexdigest()


def _resolve_change_dates(
    root: Path, tree: str, conn,
) -> dict[str, Optional[date]]:
    """Body-hash store for a knowledge tree. Returns {path: content_change_date}.

    Frontmatter `updated` cannot be trusted for update counting: the nightly
    consolidate/reindex (wiki) and apply_taste evidence_count refresh (tastes)
    rewrite that field on every file they touch, showing up as hundreds of
    phantom updates per day. Instead we remember each file's body hash + the
    day its body last actually changed:
      - first time we see a file -> seed (no known update yet -> None).
      - body hash differs from the stored one -> a real edit happened today
        (for tastes that includes an appended evidence record — the Evidence
        block lives in the body).
      - body hash unchanged -> keep the previously recorded change date
        (None if it has never genuinely changed since we started tracking).
    Self-managed table (an internal scanner detail, not part of the dashboard
    schema owned by migrate.ts)."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS knowledge_body_hashes ("
        "  path TEXT PRIMARY KEY, tree TEXT, body_hash TEXT, changed_date TEXT)"
    )
    today_iso = date.today().isoformat()
    out: dict[str, Optional[date]] = {}
    for _domain, _fm, path in _iter_entries(root, tree):
        h = _body_hash(path)
        if h is None:
            continue
        key = str(path)
        row = conn.execute(
            "SELECT body_hash, changed_date FROM knowledge_body_hashes WHERE path = ?",
            (key,),
        ).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO knowledge_body_hashes (path, tree, body_hash, changed_date)"
                " VALUES (?, ?, ?, NULL)",
                (key, tree, h),
            )
            out[key] = None
        elif row["body_hash"] != h:
            conn.execute(
                "UPDATE knowledge_body_hashes SET body_hash = ?, changed_date = ? WHERE path = ?",
                (h, today_iso, key),
            )
            out[key] = date.fromisoformat(today_iso)
        else:
            cd = row["changed_date"]
            out[key] = date.fromisoformat(cd) if cd else None
    return out


def _coerce_date(val) -> Optional[date]:
    """Frontmatter dates may be YAML date objects or 'YYYY-MM-DD' strings."""
    if isinstance(val, date):
        return val
    if isinstance(val, str):
        try:
            return datetime.strptime(val, "%Y-%m-%d").date()
        except ValueError:
            return None
    return None


# Taste files carry their provenance inline: a `## Evidence` section holding
# a JSON array of records, each with a `date` field = the activity date of
# the conversation that produced (or reinforced) the principle. The dream
# cycle round-trips this block via dream_cycle.compile._read_evidence_records;
# we re-parse it here with the same contract rather than import across the
# service boundary (dashboard intake must not depend on dream-cycle internals).
# Since the 2026-07-03 lag incident these dates are only a `created` FALLBACK
# for taste files that lack a frontmatter `created` — never the primary
# attribution (see the module docstring's rejected-alternative note).
_EVIDENCE_RE = re.compile(
    r"^## Evidence\b.*?\n```json\s*\n(.*?)\n```",
    re.MULTILINE | re.DOTALL,
)


def _evidence_activity_dates(path: Path) -> Optional[tuple[date, date]]:
    """Return (earliest, latest) evidence-record dates for a taste file.

    These are *activity* dates — when the producing conversations happened —
    used to attribute the file's creation/update to the right day on the
    daily-flow chart, independent of when the dream cycle materialized the
    file. The earliest record seeds "created"; the latest reflects the most
    recent "update". Returns None when the file has no evidence block or no
    parseable dates (caller then falls back to frontmatter/mtime).
    """
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    m = _EVIDENCE_RE.search(text)
    if not m:
        return None
    try:
        records = json.loads(m.group(1))
    except json.JSONDecodeError:
        return None
    if not isinstance(records, list):
        return None
    dates = [
        d
        for rec in records
        if isinstance(rec, dict)
        for d in (_coerce_date(rec.get("date")),)
        if d is not None
    ]
    if not dates:
        return None
    return min(dates), max(dates)


# Tastes were historically distilled with a shorter domain vocabulary
# than the wiki (`infra` vs `infrastructure`, `knowledge` vs
# `knowledge-management`). Both names describe the same concept, but
# without normalization the dashboard radar shows duplicate axes
# (one wiki, one tastes) for each pair, making the cross-tree
# distribution unreadable.
#
# Normalize at intake time so the two trees converge on the wiki
# vocabulary (the larger of each pair, and the one the wiki has used
# canonically). The dream-cycle producer keeps writing the short form
# in its own dirs — that's a follow-up cleanup — but the dashboard
# downstream sees a single unified axis per concept.
TASTE_DOMAIN_ALIASES: dict[str, str] = {
    "infra": "infrastructure",
    "knowledge": "knowledge-management",
}


def _iter_entries(root: Path, tree: str) -> Iterable[tuple[str, dict, Path]]:
    """Yield (domain, frontmatter, path) for every entry in a tree.

    For the tastes tree, domain names are passed through
    TASTE_DOMAIN_ALIASES so the dashboard's wiki↔tastes comparison
    radar collapses synonymous domain pairs onto one axis.
    """
    if not root.exists():
        return
    for md in root.rglob("*.md"):
        if md.name.startswith("_"):
            continue
        domain = md.parent.name
        if domain == root.name:
            domain = "root"
        if tree == "tastes":
            domain = TASTE_DOMAIN_ALIASES.get(domain, domain)
        fm = _parse_frontmatter(md)
        if fm:
            yield domain, fm, md


def aggregate(
    wiki: Path, tastes: Path, start: date, end: date,
    change_dates: Optional[dict[str, Optional[date]]] = None,
) -> tuple[dict[tuple[str, str, str], dict[str, int]], dict[tuple[str, str], int]]:
    """Pure aggregator. Returns:
      changes[(date, tree, domain)] = {"created": n, "updated": n}
      distribution[(tree, domain)]  = total_file_count

    `change_dates` is the body-hash store's {path: content_change_date} for
    BOTH trees (see _resolve_change_dates); when omitted (direct/test calls)
    updates fall back to frontmatter `updated`/mtime.
    """
    changes: dict[tuple[str, str, str], dict[str, int]] = defaultdict(
        lambda: {"created": 0, "updated": 0}
    )
    distribution: dict[tuple[str, str], int] = defaultdict(int)

    for tree, root in (("wiki", wiki), ("tastes", tastes)):
        for domain, fm, _path in _iter_entries(root, tree):
            distribution[(tree, domain)] += 1

            # Attribute the file to the tree's own chronology — the same
            # truth a human (or motus-data-sweep) checks by reading the
            # file, for BOTH trees:
            #
            #   created — frontmatter `created` (the day the leaf landed);
            #             earliest evidence date, then mtime, as fallbacks
            #             for files without one. Without the mtime resort,
            #             brand-new markdown lacking a date field would
            #             silently vanish from the daily-flow chart.
            #   updated — the body-hash store: count an update ONLY on the
            #             day the BODY genuinely changed (an appended taste
            #             evidence record IS a body change), never when
            #             consolidation/apply_taste rewrote frontmatter.
            #
            # Rejected alternative №1 (max-merge frontmatter/mtime): any
            # maintenance rewrite bumped mtime and showed up as N phantom
            # "updates" every night.
            # Rejected alternative №2 (evidence-date attribution for
            # tastes — the 2026-07-03 incident): once the taste pipeline
            # went staged/batchy, leaves materialized days after their
            # source conversations and every change was back-dated out of
            # the chart's window — the taste flow read 0 while leaves were
            # landing on disk. See the module docstring.
            fm_created = _coerce_date(fm.get("created"))
            fm_updated = _coerce_date(fm.get("updated"))
            mtime_date = _file_mtime_date(_path)

            evidence = (
                _evidence_activity_dates(_path) if tree == "tastes" else None
            )
            created = fm_created or (evidence[0] if evidence else None) or mtime_date
            if change_dates is not None:
                updated = change_dates.get(str(_path))
            else:
                updated = fm_updated or mtime_date

            for kind, d in (("created", created), ("updated", updated)):
                if d is None or d < start or d > end:
                    continue
                changes[(d.isoformat(), tree, domain)][kind] += 1
    return changes, distribution


def _file_mtime_date(path: Path) -> Optional[date]:
    """Return the file's mtime as a calendar date, or None on stat error.
    Used in aggregate() as a fallback / max-merge against frontmatter
    `created` and `updated` dates."""
    try:
        return date.fromtimestamp(path.stat().st_mtime)
    except OSError:
        return None


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="dashboard-intake-scan-knowledge-trees",
        description=__doc__.split("\n", 1)[0],
    )
    p.add_argument(
        "--days", type=int, default=60,
        help="Window of days back from today to include in changes. Default 60.",
    )
    p.add_argument("--db", type=Path, default=None)
    p.add_argument("--wiki", type=Path, default=None)
    p.add_argument("--tastes", type=Path, default=None)
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    today = date.today()
    start = today - timedelta(days=args.days - 1)

    wiki = args.wiki if args.wiki else wiki_root()
    tastes = args.tastes if args.tastes else tastes_root()
    db_file = args.db if args.db else db_path()

    today_iso = today.isoformat()
    with connect(db_file) as conn:
        # Resolve real (body-changed) update dates for BOTH trees first —
        # this also persists the body-hash store that future scans diff
        # against, so maintenance frontmatter rewrites (wiki consolidation,
        # taste evidence_count refresh) stop counting as updates.
        change_dates = _resolve_change_dates(wiki, "wiki", conn)
        change_dates.update(_resolve_change_dates(tastes, "tastes", conn))
        changes, distribution = aggregate(
            wiki, tastes, start, today, change_dates,
        )
        # Reset the window before re-inserting. Upserts alone leave
        # stale rows behind whenever a file's contributing date moves
        # — e.g. a previous scan attributed file F to (2026-05-26,
        # tastes, infrastructure) based on mtime; today's scan reads
        # frontmatter and attributes F to (2026-05-12, tastes,
        # infrastructure), but the 05-26 row still sits in the DB
        # phantom-counting an update that no longer applies. Deleting
        # the window first means every scan is the new source of truth
        # for [start, today]; rows outside the window are preserved.
        conn.execute(
            "DELETE FROM knowledge_taste_changes WHERE date >= ? AND date <= ?",
            (start.isoformat(), today_iso),
        )
        for (d, tree, domain), counts in sorted(changes.items()):
            upsert_knowledge_taste_change(
                conn,
                date=d, tree=tree, domain=domain,
                created=counts["created"],
                updated=counts["updated"],
            )
        # Scrub stale short-domain rows written by pre-alias scans.
        # Without this, upgraded DBs keep the old (tastes, infra) and
        # (tastes, knowledge) primary keys alongside the new canonical
        # ones, and queryDistribution reads all rows, so the radar still
        # shows duplicate axes even after the alias map is in effect.
        if TASTE_DOMAIN_ALIASES:
            placeholders = ",".join("?" * len(TASTE_DOMAIN_ALIASES))
            conn.execute(
                f"DELETE FROM knowledge_taste_distribution"
                f" WHERE tree = 'tastes' AND domain IN ({placeholders})",
                list(TASTE_DOMAIN_ALIASES.keys()),
            )
        for (tree, domain), total in sorted(distribution.items()):
            upsert_knowledge_taste_distribution(
                conn,
                tree=tree, domain=domain,
                total=total, as_of=today_iso,
            )

    print(
        f"scan-knowledge-trees: {len(changes)} changes upserts, "
        f"{len(distribution)} distribution upserts to {db_file}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
