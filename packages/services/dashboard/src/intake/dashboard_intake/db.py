"""Tiny SQLite helpers shared across the 4 intake steps.

The DB schema is owned by `packages/services/dashboard/src/server/migrate.ts`;
this module just opens connections and provides typed upserts for the
specific tables each step writes.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional


@contextmanager
def connect(db_file: Path) -> Iterator[sqlite3.Connection]:
    """Open a sqlite connection with sensible defaults. Commits on success,
    rolls back on exception. Caller is responsible for table existence
    (handled by `migrate.ts` at install time)."""
    conn = sqlite3.connect(str(db_file))
    conn.row_factory = sqlite3.Row
    # WAL + busy_timeout on the write path so the dashboard server's readonly
    # readers never block writers (and vice versa). Matches migrate.ts.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── Upserts per table — one helper per writer step ────────────────────────


def upsert_daa(
    conn: sqlite3.Connection,
    *,
    agent_id: str,
    date: str,
    sessions: int,
) -> None:
    conn.execute(
        """
        INSERT INTO daa (agent_id, date, sessions, is_active)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_id, date) DO UPDATE SET
          sessions  = excluded.sessions,
          is_active = excluded.is_active
        """,
        (agent_id, date, sessions, 1 if sessions > 0 else 0),
    )


def upsert_knowledge_taste_change(
    conn: sqlite3.Connection,
    *,
    date: str,
    tree: str,
    domain: str,
    created: int,
    updated: int,
) -> None:
    conn.execute(
        """
        INSERT INTO knowledge_taste_changes (date, tree, domain, created, updated)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date, tree, domain) DO UPDATE SET
          created = excluded.created,
          updated = excluded.updated
        """,
        (date, tree, domain, created, updated),
    )


def upsert_knowledge_taste_distribution(
    conn: sqlite3.Connection,
    *,
    tree: str,
    domain: str,
    total: int,
    as_of: str,
) -> None:
    conn.execute(
        """
        INSERT INTO knowledge_taste_distribution (tree, domain, total, as_of)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tree, domain) DO UPDATE SET
          total = excluded.total,
          as_of = excluded.as_of
        """,
        (tree, domain, total, as_of),
    )


def upsert_application_rate(
    conn: sqlite3.Connection,
    *,
    date: str,
    tree: str,
    surfaced_unique: int,
    acted_unique: int,
) -> None:
    rate: Optional[float] = (
        (acted_unique / surfaced_unique) if surfaced_unique > 0 else None
    )
    conn.execute(
        """
        INSERT INTO application_rate (date, tree, surfaced_unique, acted_unique, rate)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date, tree) DO UPDATE SET
          surfaced_unique = excluded.surfaced_unique,
          acted_unique    = excluded.acted_unique,
          rate            = excluded.rate
        """,
        (date, tree, surfaced_unique, acted_unique, rate),
    )


def upsert_application_rate_by_domain(
    conn: sqlite3.Connection,
    *,
    date: str,
    tree: str,
    domain: str,
    surfaced_unique: int,
    acted_unique: int,
) -> None:
    conn.execute(
        """
        INSERT INTO application_rate_by_domain
          (date, tree, domain, surfaced_unique, acted_unique)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date, tree, domain) DO UPDATE SET
          surfaced_unique = excluded.surfaced_unique,
          acted_unique    = excluded.acted_unique
        """,
        (date, tree, domain, surfaced_unique, acted_unique),
    )


def upsert_application_rate_by_agent(
    conn: sqlite3.Connection,
    *,
    date: str,
    tree: str,
    agent_id: str,
    surfaced_unique: int,
    acted_unique: int,
) -> None:
    conn.execute(
        """
        INSERT INTO application_rate_by_agent
          (date, tree, agent_id, surfaced_unique, acted_unique)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date, tree, agent_id) DO UPDATE SET
          surfaced_unique = excluded.surfaced_unique,
          acted_unique    = excluded.acted_unique
        """,
        (date, tree, agent_id, surfaced_unique, acted_unique),
    )


def upsert_activity(
    conn: sqlite3.Connection,
    *,
    id: str,
    ts: str,
    agent_id: str,
    activity: str,
    title: str,
    description: Optional[str],
    meta: Optional[str],
    attachments: Optional[str] = None,
) -> None:
    """Upsert one Delivery-feed row keyed by source-event id, so re-running the
    intake over an overlapping window is idempotent (no duplicate cards).

    `attachments` is a JSON string: the array of learnings carried by this
    event (`[{title, path, markdown}]`), one per separately-previewable card."""
    conn.execute(
        """
        INSERT INTO activity (id, ts, agent_id, activity, title, description, meta, attachments)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ts          = excluded.ts,
          agent_id    = excluded.agent_id,
          activity    = excluded.activity,
          title       = excluded.title,
          description = excluded.description,
          meta        = excluded.meta,
          attachments = excluded.attachments
        """,
        (id, ts, agent_id, activity, title, description, meta, attachments),
    )


def prune_legacy_workflow_rows(conn: sqlite3.Connection) -> int:
    """Drop workflow cards written under the old per-goal id scheme.

    The workflow stream now keys one card per `workflow_template` (`wf::<id>`);
    earlier snapshots stored one card per goal id (stale one-off `intake` goals).
    Without this, those stale cards linger in the snapshot forever, since the
    upsert only ever touches the new `wf::` ids. Returns rows removed."""
    cur = conn.execute(
        "DELETE FROM activity WHERE activity = 'workflow' AND id NOT LIKE 'wf::%'"
    )
    return cur.rowcount or 0


def prune_legacy_captured_rows(conn: sqlite3.Connection) -> int:
    """Drop captured cards written under the old per-trace id scheme.

    The captured stream now keys one card per learning (`cap::<learning_id>`);
    earlier snapshots stored one card per `learning_captured` trace id
    (`trc-…`). A single learning can carry several such traces, so the old
    scheme rendered the same capture more than once. Without this, those stale
    per-trace cards linger forever, since the upsert only ever touches the new
    `cap::` ids. Returns rows removed."""
    cur = conn.execute(
        "DELETE FROM activity WHERE activity = 'captured' AND id NOT LIKE 'cap::%'"
    )
    return cur.rowcount or 0
