"""Update wiki frontmatter `citations`/`cited_by`/`last_cited_at` from real
cross-agent usage recorded in the brain `traces` table.

Source: the brain DB resolved by
`dream_cycle.brain_learnings.resolve_brain_db_path()` (`$DIGITAL_ME_BRAIN_DB`,
else the orchestrator's live `~/.openclaw/data/brain.db`), table `traces`. A
per-hit `memory_search` trace is a `tool_call` row with `payload.filePath` set
to the wiki entry's relative path (e.g. `agents/foo.md`). This step aggregates
those rows and writes the counts back into the entry's YAML frontmatter so the
next read of the wiki sees real, derived citation data.

The retired `~/.openclaw/data/task-orchestrator.db` is no longer read: on old
hosts it is a frozen copy (the same rows every night), on fresh installs it
does not exist. brain.db carries the same `traces` schema (brain-orchestrator's
`createTracesStore`), so the query is unchanged.

What the live table holds (checked 2026-09-21): the current producers -- the
openclaw recall hook (`kind = 'memory_search'`) and the MCP proxy
(`kind = 'mcp_tool_call'`) -- record only `query` + `hitCount`, never a per-hit
`filePath`. So this step only ever sees the legacy per-hit `tool_call` rows
that `digital-me migrate` copied into brain.db (469 rows from May 2026 on the
reference host, none on a fresh install). Re-pointing the reader is therefore
bounded: it rewrites nothing new on that host and is a no-op elsewhere. Real
citation tracking returns only when a producer emits `filePath` per hit again;
that is producer work, not a reader change.

Idempotent: re-running on the same trace state produces the same wiki state.
The frontmatter body is preserved byte-for-byte except inside the YAML block.
The summary accounts for every entry that has traces:
updated + skipped_unchanged + skipped_unparseable + len(missing_entries)
== entries_with_traces. Entries whose file has no parseable frontmatter (the
generated `_OVERVIEW.md` files, for one) used to vanish from the totals.
"""

import argparse
import json
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import yaml

from dream_cycle.brain_learnings import resolve_brain_db_path
from dream_cycle.config import load_config, Config


CITATIONS_QUERY = """
SELECT
    json_extract(payload, '$.filePath')   AS path,
    COUNT(*)                              AS total_hits,
    COUNT(DISTINCT agent_id)              AS agent_count,
    GROUP_CONCAT(DISTINCT agent_id)       AS agents,
    MAX(t)                                AS last_cited_at
FROM traces
WHERE kind = 'tool_call'
  AND json_extract(payload, '$.toolName') = 'memory_search'
  AND json_extract(payload, '$.filePath') IS NOT NULL
  AND json_extract(payload, '$.filePath') NOT LIKE 'memory/%'
  AND json_extract(payload, '$.filePath') != 'MEMORY.md'
GROUP BY path
"""


# Path normalization for legacy/polluted trace rows. Producer-side fixes
# may not have shipped yet; hits arrive with multiple shapes that all
# reference the same wiki entry:
#   1. clean wiki-relative:        agents/foo.md
#   2. deep-cwd relative escape:   ../../../../../<HOME>/digital-me/wiki/agents/foo.md
# Same with absolute paths from agents that reported full paths. Normalize
# everything to wiki-relative so per-entry hit counts collapse to one row.
def _normalize_wiki_relative(raw: str, wiki_dir: Path) -> Optional[str]:
    """Return wiki-relative path string, or None if the path is outside the wiki."""
    if not raw:
        return None
    wiki_marker = "/digital-me/wiki/"
    if wiki_marker in raw:
        # Both ../../../<HOME>/digital-me/wiki/X.md and
        # /<HOME>/digital-me/wiki/X.md collapse to X.md.
        return raw.split(wiki_marker, 1)[1]
    # Already-clean wiki-relative path (e.g. "agents/foo.md").
    # Reject if it traverses upward (defensive) or is absolute.
    if raw.startswith("../") or raw.startswith("/"):
        return None
    return raw


def _query_citation_stats(db_path: Path, wiki_dir: Optional[Path] = None) -> dict[str, dict]:
    """Aggregate memory_search trace data per wiki entry path.

    Returns: { relative_path: { total_hits, agent_count, agents:[...], last_cited_at:iso } }

    Multiple raw filePath shapes that point to the same wiki entry are
    normalized via `_normalize_wiki_relative` and their hit counts merged.
    """
    if not db_path.exists():
        return {}
    wiki_dir = wiki_dir or Path.home() / "digital-me" / "wiki"
    stats: dict[str, dict] = {}
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        for row in conn.execute(CITATIONS_QUERY):
            path, total_hits, agent_count, agents_csv, last_cited_at = row
            if not path:
                continue
            norm = _normalize_wiki_relative(path, wiki_dir)
            if norm is None:
                continue
            agents_list = {a for a in (agents_csv or "").split(",") if a.strip()}
            existing = stats.get(norm)
            if existing is None:
                stats[norm] = {
                    "total_hits": int(total_hits or 0),
                    "agent_count": int(agent_count or 0),
                    "agents": sorted(agents_list),
                    "last_cited_at": last_cited_at,
                }
            else:
                # Merge two raw rows that normalized to the same wiki entry.
                # agent_count must be recomputed from the unioned set; SUM of
                # per-row agent_count would over-count agents that appear in
                # both rows.
                merged_agents = set(existing["agents"]) | agents_list
                existing["total_hits"] += int(total_hits or 0)
                existing["agents"] = sorted(merged_agents)
                existing["agent_count"] = len(merged_agents)
                if last_cited_at and (
                    existing["last_cited_at"] is None
                    or last_cited_at > existing["last_cited_at"]
                ):
                    existing["last_cited_at"] = last_cited_at
        # Convert last_cited_at epoch-ms to iso date string after merging.
        for entry in stats.values():
            lc = entry["last_cited_at"]
            entry["last_cited_at"] = (
                datetime.fromtimestamp(lc / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
                if lc
                else None
            )
    finally:
        conn.close()
    return stats


def _split_frontmatter(content: str) -> Optional[tuple[dict, str, str]]:
    """Return (parsed_fm, raw_yaml, body) for a wiki entry, or None on parse fail.

    `raw_yaml` is the original YAML text between the `---` markers — preserved
    so we can rewrite only the fields we touch and leave key ordering /
    comments alone where possible.
    """
    if not content.startswith("---"):
        return None
    parts = content.split("---", 2)
    if len(parts) < 3:
        return None
    try:
        fm = yaml.safe_load(parts[1])
    except yaml.YAMLError:
        return None
    if not isinstance(fm, dict):
        return None
    return fm, parts[1], parts[2]


def _serialize_frontmatter(fm: dict) -> str:
    """Dump frontmatter as YAML preserving sensible defaults for lists/strings."""
    return yaml.safe_dump(
        fm,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
    )


def _update_entry(
    md_path: Path,
    stats: dict,
    *,
    dry_run: bool,
) -> Optional[dict]:
    """Apply trace-derived citation stats to a single wiki entry's frontmatter.

    Returns a per-entry change record, or None if the file couldn't be parsed.
    """
    try:
        content = md_path.read_text(encoding="utf-8")
    except OSError:
        return None
    parsed = _split_frontmatter(content)
    if parsed is None:
        return None
    fm, _raw_yaml, body = parsed

    prev_citations = fm.get("citations", 1)
    prev_cited_by = fm.get("cited_by") or []
    prev_last_cited = fm.get("last_cited_at")

    # Use `agent_count` (distinct agents) as the leverage metric, not raw
    # `total_hits`. Raw hits get inflated by single-agent feedback loops —
    # e.g., remotion-production-workflow.md hit 272 because one `youtube`
    # agent looped on near-identical queries 247 times in 24h. agent_count
    # is loop-resistant: it asks "how many distinct callers found this
    # useful?" not "how many tokens of trace did one loop emit?"
    new_citations = stats["agent_count"]
    new_cited_by = stats["agents"]
    new_last_cited = stats["last_cited_at"]

    changed = (
        prev_citations != new_citations
        or list(prev_cited_by) != new_cited_by
        or prev_last_cited != new_last_cited
    )
    if not changed:
        return {"path": str(md_path), "changed": False}

    fm["citations"] = new_citations
    fm["cited_by"] = new_cited_by
    if new_last_cited:
        fm["last_cited_at"] = new_last_cited
    # `updated:` should not change just because a citation count moved —
    # citation count is derived data, not a content edit. Leave updated alone.

    if dry_run:
        return {
            "path": str(md_path),
            "changed": True,
            "from": {
                "citations": prev_citations,
                "cited_by": list(prev_cited_by),
                "last_cited_at": prev_last_cited,
            },
            "to": {
                "citations": new_citations,
                "cited_by": new_cited_by,
                "last_cited_at": new_last_cited,
            },
        }

    new_yaml = _serialize_frontmatter(fm)
    new_content = f"---\n{new_yaml}---{body}"
    md_path.write_text(new_content, encoding="utf-8")
    return {
        "path": str(md_path),
        "changed": True,
        "citations": new_citations,
        "cited_by": new_cited_by,
        "last_cited_at": new_last_cited,
    }


def run_citations(
    config: Config,
    *,
    dry_run: bool = False,
    db_path: Optional[Path] = None,
) -> dict:
    """Update wiki frontmatter from trace-derived citation stats.

    `db_path` defaults to `resolve_brain_db_path()` (`$DIGITAL_ME_BRAIN_DB`,
    else the live brain.db). A missing file is a graceful no-op, not an error.

    Returns a summary dict with counts + per-entry changes (full list when
    dry_run=True so the caller can review proposed edits).
    """
    traces_db = db_path if db_path is not None else resolve_brain_db_path()
    wiki = config.wiki_dir
    stats_by_path = _query_citation_stats(traces_db, wiki)

    summary: dict = {
        "traces_db": str(traces_db),
        "entries_with_traces": len(stats_by_path),
        "updated": 0,
        "updated_paths": [],
        "skipped_unchanged": 0,
        "skipped_unparseable": 0,
        "missing_entries": [],
    }
    changes: list[dict] = []
    for rel_path, stats in stats_by_path.items():
        md_path = wiki / rel_path
        if not md_path.exists():
            summary["missing_entries"].append(rel_path)
            continue
        result = _update_entry(md_path, stats, dry_run=dry_run)
        if result is None:
            summary["skipped_unparseable"] += 1
            continue
        if result["changed"]:
            summary["updated"] += 1
            summary["updated_paths"].append(rel_path)
            changes.append(result)
        else:
            summary["skipped_unchanged"] += 1

    if dry_run:
        summary["proposed_changes"] = changes
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sync wiki citations from traces.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show proposed changes without writing.",
    )
    args = parser.parse_args()

    config = load_config()
    summary = run_citations(config, dry_run=args.dry_run)
    print(json.dumps(summary, indent=2, default=str))
