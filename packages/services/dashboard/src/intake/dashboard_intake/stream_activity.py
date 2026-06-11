"""Step 4/4: stream_activity — brain + taste tree → dashboard.db `activity` snapshot.

Reads the openclaw brain SQLite DB directly (it is a primary source from the
intake's perspective, like the runtime transcripts and hook logs the other
steps read) and writes flat rows into dashboard.db's `activity` table for the
Feed view.

This step OWNS the coupling to the brain's internal schema. The dashboard
server + frontend never touch the brain — they read the `activity` snapshot
like every other metric. A brain schema change is absorbed here, in one place.

Four streams are merged (each upserted by source-event id, so re-runs over an
overlapping window never duplicate cards):

  • captured  — `learning_captured` traces ⨝ `learnings` (the insight text/why)
  • applied   — `knowledge_surfaced` m1_events (an agent recalled + used knowledge)
  • workflow  — `goals` grouped by `workflow_template` (one rolled-up card per
                workflow, latest run + run count)
  • taste     — distilled taste-principle leaf files under the tastes tree
                (the dream-cycle's `apply_taste` output; NOT in the brain DB,
                so this stream reads the filesystem and runs even with no brain)

Path resolution (tiered, per the decouple-filesystem-paths pattern):
  --brain-db   ARG  >  $OPENCLAW_BRAIN_DB    >  ~/.openclaw/data/brain.db
  --wiki-dir   ARG  >  $DIGITAL_ME_WIKI_DIR  >  ~/digital-me/wiki
  --tastes-dir ARG  >  <wiki-dir>/../tastes  (i.e. ~/digital-me/tastes)

Degrades gracefully: if the brain DB is absent (a fresh install with no
openclaw runtime yet) the three brain streams are skipped but the taste stream
still runs. A stream whose table/columns/dir is missing is skipped without
failing the others.

Usage:
  python -m dashboard_intake.stream_activity [--brain-db PATH] [--db PATH]
      [--wiki-dir PATH] [--tastes-dir PATH] [--limit N]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import yaml

from . import db_path
from .db import (
    connect,
    prune_legacy_captured_rows,
    prune_legacy_workflow_rows,
    upsert_activity,
)


DEFAULT_LIMIT = 200
# Cap snapshotted markdown so a pathological file can't bloat the feed DB.
MARKDOWN_CAP = 50_000
# Cap distinct learnings carried per event (keeps an over-eager recall sane).
MAX_ATTACHMENTS = 20


def _resolve_brain_db(arg: Optional[Path]) -> Path:
    if arg is not None:
        return arg
    override = os.environ.get("OPENCLAW_BRAIN_DB")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".openclaw" / "data" / "brain.db"


def _resolve_wiki_root(arg: Optional[Path]) -> Path:
    """Wiki root used to resolve relative `proposed_wiki_path` values. Tiered:
    --wiki-dir ARG > $DIGITAL_ME_WIKI_DIR > ~/digital-me/wiki."""
    if arg is not None:
        return arg.expanduser()
    override = os.environ.get("DIGITAL_ME_WIKI_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / "digital-me" / "wiki"


def _resolve_tastes_root(arg: Optional[Path], wiki_root: Path) -> Path:
    """Tastes tree (the dream-cycle's taste-leaf output). Tiered:
    --tastes-dir ARG > $DIGITAL_ME_TASTES_DIR > <wiki-root>/../tastes."""
    if arg is not None:
        return arg.expanduser()
    override = os.environ.get("DIGITAL_ME_TASTES_DIR")
    if override:
        return Path(override).expanduser()
    return wiki_root.parent / "tastes"


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def _basename(p: str) -> str:
    clean = p.replace("\\", "/").rstrip("/")
    segs = [s for s in clean.split("/") if s and s != ".."]
    return segs[-1] if segs else p


def _title_from_basename(b: str) -> str:
    """Filename → readable title: 'pdf-skill.md' → 'pdf skill'."""
    stem = b[:-3] if b.lower().endswith(".md") else b
    return stem.replace("-", " ").replace("_", " ").strip() or b


# ── Markdown resolution. Recalled/proposed paths point at real `.md` files
#    under $HOME (wiki entries AND the shared-memory learnings tree). We resolve
#    each to an absolute file, sandbox it to an allowed root, and snapshot the
#    content so the feed can render it offline (no live read on the request
#    path). ───────────────────────────────────────────────────────────────────


def _resolve_md(path_str: str, *, roots: list[Path], wiki_root: Path) -> Optional[Path]:
    """Resolve a recorded path to an absolute `.md` file inside an allowed root.

    Handles the two shapes the brain stores:
      • recall entries — relative paths that embed an absolute home anchor, e.g.
        '../../~HOME~/digital-me/wiki/dev/foo.md' → the resolved absolute file.
      • proposed_wiki_path — short relative forms like 'wiki/ops/x.md' or
        'dev/foo.md', resolved under `wiki_root`.

    Returns None if the path has no markdown target or escapes every allowed
    root (path-traversal guard)."""
    norm = (path_str or "").replace("\\", "/").strip()
    if not norm:
        return None

    cand: Optional[Path] = None
    for anchor in ("/Users/", "/home/", "/root/"):
        i = norm.find(anchor)
        if i != -1:
            cand = Path(norm[i:])
            break
    if cand is None:
        rel = norm
        marker = "/wiki/"
        j = norm.find(marker)
        if j != -1:
            rel = norm[j + len(marker):]
        elif norm.startswith("wiki/"):
            rel = norm[len("wiki/"):]
        cand = wiki_root / rel

    try:
        resolved = cand.resolve()
    except OSError:
        return None
    if resolved.suffix.lower() != ".md":
        return None
    for root in roots:
        if resolved == root or root in resolved.parents:
            return resolved
    return None


def _read_md(p: Path) -> Optional[str]:
    try:
        txt = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    txt = txt.strip()
    return txt[:MARKDOWN_CAP] if txt else None


def _compose_learning_md(*, text: str, why: Optional[str], apply_when: Optional[str],
                         kind: Optional[str]) -> str:
    """Fallback render for a captured learning whose wiki file doesn't exist yet
    (the dream-cycle hasn't compiled it). Build readable markdown from the raw
    learning fields so the preview still shows *real* content.

    The insight text is emitted as-is (NOT wrapped in an `# H1`): learnings
    routinely embed their own markdown — fenced code blocks, inline code, bold —
    and forcing the whole thing into a heading flattened code into a giant serif
    blob. Rendering it as body markdown lets the preview show real code blocks."""
    parts = [text.strip() or "Captured learning"]
    if why and why.strip():
        parts.append(f"## Why it matters\n\n{why.strip()}")
    if apply_when and apply_when.strip():
        parts.append(f"## Apply when\n\n{apply_when.strip()}")
    if kind and kind.strip():
        parts.append(f"_Kind: {kind.strip()}_")
    return "\n\n".join(parts)


# ── Taste-leaf parsing. Taste principles live as `.md` files with YAML
#    frontmatter (domain, title, status, created/updated) + a body whose first
#    `## Principle` section is the headline insight. Mirrors the frontmatter
#    contract scan_knowledge_trees.py reads. ──────────────────────────────────

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_PRINCIPLE_RE = re.compile(r"^##+\s*Principle\s*\n+(.+?)(?=\n##\s|\Z)", re.DOTALL | re.MULTILINE)


def _frontmatter(text: str) -> dict:
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}
    try:
        fm = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return {}
    return fm if isinstance(fm, dict) else {}


def _fm_date_iso(val) -> Optional[str]:
    """Frontmatter dates are YAML date objects or 'YYYY-MM-DD' strings → ISO."""
    d: Optional[date] = None
    if isinstance(val, datetime):
        d = val.date()
    elif isinstance(val, date):
        d = val
    elif isinstance(val, str):
        try:
            d = datetime.strptime(val.strip(), "%Y-%m-%d").date()
        except ValueError:
            return None
    if d is None:
        return None
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc).isoformat()


def _principle_line(text: str) -> Optional[str]:
    """First paragraph of the `## Principle` section — the feed body preview."""
    m = _PRINCIPLE_RE.search(text)
    if not m:
        return None
    para = m.group(1).strip().split("\n\n", 1)[0].strip()
    return para or None


def _open_brain_ro(brain_db: Path) -> sqlite3.Connection:
    """Open the brain read-only via URI so the intake never mutates it."""
    conn = sqlite3.connect(f"file:{brain_db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


# ── Stream extractors. Each returns a list of activity-row dicts; each is
#    wrapped so a missing table/column in an older brain skips that stream
#    without failing the others. ───────────────────────────────────────────


def _safe(label: str, fn):
    try:
        return fn()
    except sqlite3.Error as e:
        print(f"stream-activity: {label} stream unavailable: {e}", file=sys.stderr)
        return []


def _captured(brain: sqlite3.Connection, limit: int, *,
              roots: list[Path], wiki_root: Path) -> list[dict]:
    # One card per *learning*, not per trace. A single learning can carry more
    # than one `learning_captured` trace — the handler auto-pairs one when the
    # `learning_capture` tool runs, and an agent may then record its own richer
    # trace (topic/source) via `traces_record` for the same learning_id. Both
    # are legitimate traces, but rendering both as feed cards shows the user a
    # duplicate capture. ROW_NUMBER keeps the newest trace per learning_id; the
    # card is keyed by learning_id (`cap::<id>`) so it stays a single, stable
    # row no matter how many traces reference it. `kind` is read from the
    # learning row (authoritative) — the manual trace omits `learning_kind`.
    rows = brain.execute(
        """
        WITH ranked AS (
          SELECT t.id AS id, t.agent_id AS agent_id, t.t AS ts_ms,
                 json_extract(t.payload, '$.learning_id') AS learning_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY json_extract(t.payload, '$.learning_id')
                   ORDER BY t.t DESC, t.id DESC
                 ) AS rn
            FROM traces t
           WHERE t.kind = 'learning_captured'
             AND json_extract(t.payload, '$.learning_id') IS NOT NULL
        )
        SELECT r.id AS id, r.agent_id AS agent_id, r.ts_ms AS ts_ms,
               r.learning_id AS learning_id,
               l.kind AS lkind, l.text AS text, l.why AS why,
               l.apply_when AS apply_when, l.proposed_wiki_path AS path
          FROM ranked r
          LEFT JOIN learnings l ON l.id = r.learning_id
         WHERE r.rn = 1
         ORDER BY r.ts_ms DESC
         LIMIT ?
        """,
        (limit,),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        title = (r["text"] or "").strip() or "Captured a learning"
        meta_bits = [b for b in (r["lkind"], _basename(r["path"]) if r["path"] else None) if b]
        # The captured learning, rendered: prefer the published wiki file; fall
        # back to composing markdown from the raw fields if it isn't compiled yet.
        markdown: Optional[str] = None
        if r["path"]:
            resolved = _resolve_md(r["path"], roots=roots, wiki_root=wiki_root)
            if resolved is not None:
                markdown = _read_md(resolved)
        if markdown is None:
            markdown = _compose_learning_md(
                text=r["text"] or title, why=r["why"], apply_when=r["apply_when"],
                kind=r["lkind"],
            )
        attachments = [{
            "title": title,
            "path": _basename(r["path"]) if r["path"] else None,
            "markdown": markdown,
        }]
        out.append({
            "id": f"cap::{r['learning_id']}",
            "ts": _iso(r["ts_ms"]),
            "agent_id": r["agent_id"],
            "activity": "captured",
            "title": title,
            "description": ((r["why"] or r["apply_when"]) or "").strip() or None,
            "meta": " · ".join(meta_bits) if meta_bits else None,
            "attachments": json.dumps(attachments),
        })
    return out


def _applied(brain: sqlite3.Connection, limit: int, *,
             roots: list[Path], wiki_root: Path) -> list[dict]:
    rows = brain.execute(
        """
        SELECT event_id AS id, agent_id AS agent_id, t AS ts_ms,
               entries_json AS entries_json
          FROM m1_events
         WHERE event_type = 'knowledge_surfaced'
           AND json_array_length(entries_json) > 0
         ORDER BY t DESC
         LIMIT ?
        """,
        (limit,),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        names: list[str] = []
        attachments: list[dict] = []
        seen: set[str] = set()
        try:
            entries = json.loads(r["entries_json"])
        except (json.JSONDecodeError, TypeError):
            entries = []
        for e in entries:
            p = e.get("path") if isinstance(e, dict) else None
            if not p:
                continue
            b = _basename(p)
            if b in seen:
                continue
            seen.add(b)
            names.append(b)
            if len(attachments) >= MAX_ATTACHMENTS:
                continue
            # Each recalled learning becomes its own separately-previewable card.
            resolved = _resolve_md(p, roots=roots, wiki_root=wiki_root)
            markdown = _read_md(resolved) if resolved is not None else None
            entry_title = (e.get("title") or "").strip() if isinstance(e, dict) else ""
            attachments.append({
                "title": entry_title or _title_from_basename(b),
                "path": b,
                "markdown": markdown,
            })
        n = len(names)
        out.append({
            "id": r["id"],
            "ts": _iso(r["ts_ms"]),
            "agent_id": r["agent_id"],
            "activity": "applied",
            "title": f"Applied {n} learning{'' if n == 1 else 's'}",
            "description": ", ".join(names) if names else None,
            "meta": "recalled",
            "attachments": json.dumps(attachments) if attachments else None,
        })
    return out


def _workflow(brain: sqlite3.Connection, limit: int) -> list[dict]:
    """Workflow stream — one card per `workflow_template`, showing its most
    recent run.

    A workflow *run* is a `goals` row instantiated from a template
    (`source_workflow_id` set); the orchestrator creates these on schedule, so
    there are tens of thousands of them. The old query excluded `orchestrator`
    entirely — which dropped every real workflow run and left only stale
    one-off `intake` goals (newest 2026-05-18). Here we instead JOIN to
    `workflow_templates`, group by template, and surface the latest run, so the
    feed reflects *current* workflow activity (one card per workflow, newest
    first) joined to the human-readable template name.

    Every template is surfaced, including the per-minute dashboard-intake
    self-ingest workflow: per-template grouping collapses its tens of thousands
    of runs into a single rolled-up card, so it informs (\"dashboard is alive\")
    rather than floods — the original reason it was filtered as noise."""
    rows = brain.execute(
        """
        SELECT g.source_workflow_id AS wf_id,
               MAX(g.created_at)     AS ts_ms,
               COUNT(*)              AS run_count,
               wt.name               AS wf_name,
               wt.description        AS wf_desc
          FROM goals g
          JOIN workflow_templates wt ON wt.id = g.source_workflow_id
         WHERE g.source_workflow_id IS NOT NULL
         GROUP BY g.source_workflow_id
         ORDER BY ts_ms DESC
         LIMIT ?
        """,
        (limit,),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        runs = r["run_count"] or 0
        out.append({
            # Keyed by template, not run, so the card updates in place as the
            # workflow runs again (no per-run pile-up in the snapshot).
            "id": f"wf::{r['wf_id']}",
            "ts": _iso(r["ts_ms"]),
            "agent_id": "orchestrator",
            "activity": "workflow",
            "title": (r["wf_name"] or "").strip() or str(r["wf_id"]) or "Workflow",
            "description": (r["wf_desc"] or "").strip() or None,
            "meta": f"{runs} run{'' if runs == 1 else 's'}",
            "attachments": None,
        })
    return out


def _taste(tastes_root: Path, limit: int) -> list[dict]:
    """Taste-capture stream — one card per distilled taste-principle leaf file.

    Reads the filesystem (not the brain): the dream-cycle's `apply_taste` step
    writes/promotes these leaves under <tastes_root>/<domain>/<slug>.md. The
    full leaf markdown is snapshotted as the attachment so the Feed preview
    renders the real principle, the same way captured/applied learnings do."""
    if not tastes_root.exists():
        return []
    out: list[dict] = []
    for f in sorted(tastes_root.rglob("*.md")):
        if not f.is_file():
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            continue
        if not text:
            continue
        fm = _frontmatter(text)
        title = str(
            fm.get("title") or fm.get("principle_fingerprint") or _title_from_basename(f.name)
        ).strip()
        domain = fm.get("domain")
        if isinstance(domain, list):
            domain = domain[0] if domain else None
        domain = str(domain).strip() if domain else f.parent.name
        status = str(fm.get("status")).strip() if fm.get("status") else None
        ts = _fm_date_iso(fm.get("updated")) or _fm_date_iso(fm.get("created"))
        if ts is None:
            ts = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc).isoformat()
        meta_bits = [b for b in (domain, status) if b]
        rel = f.relative_to(tastes_root).as_posix()
        out.append({
            "id": f"taste::{rel}",
            "ts": ts,
            "agent_id": "dream-cycle",
            "activity": "taste",
            "title": title,
            "description": _principle_line(text),
            "meta": " · ".join(meta_bits) if meta_bits else None,
            "attachments": json.dumps([{
                "title": title,
                "path": f.name,
                "markdown": text[:MARKDOWN_CAP],
            }]),
        })
    out.sort(key=lambda r: r["ts"], reverse=True)
    return out[:limit]


def _parse_args(argv: Optional[list[str]]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="dashboard-intake-stream-activity",
        description=__doc__.split("\n", 1)[0],
    )
    p.add_argument("--brain-db", type=Path, default=None,
                   help="Path to the openclaw brain DB. Default $OPENCLAW_BRAIN_DB "
                        "or ~/.openclaw/data/brain.db.")
    p.add_argument("--db", type=Path, default=None,
                   help="Dashboard DB to upsert into. Default DASHBOARD_DB or the "
                        "canonical ~/digital-me/.data/dashboard.db.")
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                   help=f"Max rows pulled per stream (default {DEFAULT_LIMIT}).")
    p.add_argument("--wiki-dir", type=Path, default=None,
                   help="Wiki root for resolving learning markdown. Default "
                        "$DIGITAL_ME_WIKI_DIR or ~/digital-me/wiki.")
    p.add_argument("--tastes-dir", type=Path, default=None,
                   help="Tastes tree for the taste-capture stream. Default "
                        "$DIGITAL_ME_TASTES_DIR or <wiki-dir>/../tastes.")
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    dash_db = args.db if args.db else db_path()
    brain_db = _resolve_brain_db(args.brain_db)
    wiki_root = _resolve_wiki_root(args.wiki_dir)
    tastes_root = _resolve_tastes_root(args.tastes_dir, wiki_root)
    limit = args.limit if args.limit and args.limit > 0 else DEFAULT_LIMIT

    # Allowed roots for reading learning markdown: the wiki root and $HOME (the
    # shared-memory learnings tree lives under HOME too). Anything resolving
    # outside these is refused — a path-traversal guard on the recorded paths.
    roots = [wiki_root.resolve(), Path.home().resolve()]

    rows: list[dict] = []

    # Brain streams (captured/applied/workflow). The brain may be absent on a
    # fresh install — that's fine; the taste stream below still runs.
    if brain_db.exists():
        brain = _open_brain_ro(brain_db)
        try:
            rows += (
                _safe("captured", lambda: _captured(brain, limit, roots=roots, wiki_root=wiki_root))
                + _safe("applied", lambda: _applied(brain, limit, roots=roots, wiki_root=wiki_root))
                + _safe("workflow", lambda: _workflow(brain, limit))
            )
        finally:
            brain.close()
    else:
        print(
            f"stream-activity: brain DB not found at {brain_db}; skipping the "
            f"captured/applied/workflow streams (taste stream still runs).",
            file=sys.stderr,
        )

    # Taste stream — filesystem-sourced, independent of the brain.
    rows += _safe("taste", lambda: _taste(tastes_root, limit))

    if not rows:
        print(
            "stream-activity: no rows from any stream; leaving existing snapshot "
            "intact.",
            file=sys.stderr,
        )
        return 0

    with connect(dash_db) as conn:
        # The brain ran ⇒ the workflow stream was refreshed under the new
        # per-template id scheme; drop any stale legacy per-goal workflow cards.
        if brain_db.exists():
            pruned = prune_legacy_workflow_rows(conn)
            if pruned:
                print(f"stream-activity: pruned {pruned} legacy workflow row(s).", file=sys.stderr)
            # The captured stream now keys one card per learning (`cap::<id>`);
            # drop any stale per-trace captured cards from the old id scheme.
            pruned_cap = prune_legacy_captured_rows(conn)
            if pruned_cap:
                print(f"stream-activity: pruned {pruned_cap} legacy captured row(s).", file=sys.stderr)
        for r in rows:
            upsert_activity(conn, **r)

    print(
        f"stream-activity: upserted {len(rows)} activity row(s) into {dash_db} "
        f"(brain={brain_db if brain_db.exists() else 'absent'}, tastes={tastes_root}).",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
