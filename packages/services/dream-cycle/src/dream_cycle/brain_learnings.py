"""Materialize brain `learnings` rows into wiki entries.

Reads `learnings` from a SQLite brain DB — populated by any agent calling
the `learning_capture` MCP tool — and writes one wiki entry per row that
carries a `proposed_wiki_path`.

DB path resolution: `$DIGITAL_ME_BRAIN_DB` env var, then the default
`~/.openclaw/data/task-orchestrator.db`. If the file does not exist (fresh
open-source install with no OpenClaw runtime yet), the step is a graceful
no-op rather than a hard error.

This is the graduation step the brain-api-contract described but no module
implemented. Without it, `learning_capture` was a write-only black hole;
with it, every MCP-mediated capture reaches the wiki on the next dream_cycle.

Pipeline position: runs BEFORE compile.py in dream_cycle.run, so that
materialized entries appear in compile.py's manifest pre-injection (item #1
from the Claude Code memory-pipeline analysis).

Idempotency: each wiki entry carries `learning_id: lrn-xxx` in frontmatter.
We grep the wiki for that ID before writing; if it's already present, skip.
No separate cursor file — the wiki itself is the cursor.

Usage:
    python -m dream_cycle.brain_learnings              # apply
    python -m dream_cycle.brain_learnings --dry-run    # report only
"""

import argparse
import json
import os
import re
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import yaml

from dream_cycle.config import load_config, Config


DEFAULT_BRAIN_DB_PATH = Path.home() / ".openclaw" / "data" / "task-orchestrator.db"


def resolve_brain_db_path() -> Path:
    """`$DIGITAL_ME_BRAIN_DB` overrides; otherwise default OpenClaw location."""
    env = os.environ.get("DIGITAL_ME_BRAIN_DB")
    if env:
        return Path(env).expanduser()
    return DEFAULT_BRAIN_DB_PATH


# Map brain `kind` (which has one extra value, "rejection", relative to the
# wiki's closed type taxonomy) onto a wiki `type:`. "rejection" learnings are
# captured as feedback with anti-pattern framing — the wiki doesn't need a
# separate type for them.
KIND_TO_TYPE = {
    "feedback": "feedback",
    "project": "project",
    "reference": "reference",
    "rejection": "feedback",
}


def _fetch_brain_learnings(db_path: Path) -> list[dict]:
    """Read all learnings from the brain DB. Returns rows as dicts."""
    if not db_path.exists():
        return []
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, agent_id, kind, text, why, apply_when, source_context, "
            "       confidence, proposed_wiki_path, created_at "
            "FROM learnings ORDER BY created_at ASC"
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def _existing_learning_ids(wiki_dir: Path) -> set[str]:
    """Scan wiki frontmatter for already-materialized learning_id values.

    Cheap grep; no need to parse YAML across every file when one regex over
    the frontmatter line suffices.
    """
    seen: set[str] = set()
    pattern = re.compile(r"^learning_id:\s*(lrn-[a-f0-9-]+)\s*$", re.MULTILINE)
    for md in wiki_dir.rglob("*.md"):
        if md.name.startswith("_"):
            continue
        try:
            head = md.read_text(encoding="utf-8")[:2000]  # frontmatter is small
        except OSError:
            continue
        for m in pattern.finditer(head):
            seen.add(m.group(1))
    return seen


def _slug_to_title(slug: str) -> str:
    """`canonical-skills-live-under-agents-skills` → `Canonical Skills Live Under Agents Skills`."""
    words = slug.replace("_", "-").split("-")
    return " ".join(w.capitalize() for w in words if w)


def _derive_title(text: str, proposed_path: str, fallback_id: str) -> str:
    """Best-effort title for the materialized wiki entry.

    Preference order:
      1. The slug of `proposed_wiki_path` (the agent already named this) —
         agents tend to pick concise, search-friendly slugs.
      2. The first complete sentence of the rule text (cut at `. `, not `.`,
         to avoid breaking on file paths or version numbers like `v1.0`).
      3. The id stub as a last resort.

    Caps at 80 chars; anything longer is a sign the agent should have
    proposed a tighter slug.
    """
    if proposed_path:
        # `infrastructure/foo-bar.md` → `foo-bar`
        leaf = proposed_path.rstrip("/").split("/")[-1]
        if leaf.endswith(".md"):
            leaf = leaf[:-3]
        if leaf:
            t = _slug_to_title(leaf)
            return t if len(t) <= 80 else (t[:77] + "...")

    # Fallback: first sentence of text. Match `. ` (with space) so file
    # paths and decimal numbers don't trigger a premature cut.
    first_line = text.strip().split("\n", 1)[0].strip()
    sentence_end = re.search(r"\.\s+", first_line)
    title = first_line[: sentence_end.start()] if sentence_end else first_line
    title = title.strip().rstrip(".:")
    if len(title) > 80:
        title = title[:77] + "..."
    return title or f"Learning {fallback_id[:12]}"


def _derive_domain(proposed_path: str) -> str:
    """Domain = first path segment. 'agents/foo.md' → 'agents'."""
    head = proposed_path.lstrip("./").split("/", 1)[0]
    return head or "uncategorized"


def _ms_to_iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z")


def _build_wiki_content(row: dict) -> str:
    """Render one brain row as a complete wiki entry (frontmatter + body)."""
    learning_id = row["id"]
    kind = (row["kind"] or "feedback").strip()
    wiki_type = KIND_TO_TYPE.get(kind, "feedback")
    proposed = (row["proposed_wiki_path"] or "").strip()
    domain = _derive_domain(proposed) if proposed else "uncategorized"
    title = _derive_title(row["text"] or "", proposed, learning_id)
    today = date.today().isoformat()
    captured_at = _ms_to_iso(int(row["created_at"]))

    apply_when_raw = (row["apply_when"] or "").strip()
    why = (row["why"] or "").strip()
    source_context = (row["source_context"] or "").strip()

    frontmatter = {
        "title": title,
        "domain": [domain],
        "tags": [],
        "type": wiki_type,
        "priority": "search",
        "citations": 0,
        "created": today,
        "updated": today,
        "related": [],
        "source": "brain-learning",
        # Cross-references back to the brain trace
        "learning_id": learning_id,
        "source_agent": row["agent_id"],
        "captured_at": captured_at,
    }
    if row.get("confidence") is not None:
        frontmatter["confidence"] = float(row["confidence"])

    fm_yaml = yaml.safe_dump(
        frontmatter, sort_keys=False, allow_unicode=True, default_flow_style=False,
    )

    body_parts = [f"---\n{fm_yaml}---\n", "## Rule\n", row["text"].strip(), ""]

    # `## How it came up` — combine `why` and `source_context` with labels
    # so future readers can tell origin from rationale.
    if why or source_context:
        body_parts.append("## How it came up\n")
        if why:
            body_parts.append(why)
            body_parts.append("")
        if source_context:
            body_parts.append(f"*Captured from:* {source_context}")
            body_parts.append("")

    # `## Apply when` — preserve the agent's search-friendly phrasings as-is
    # if multi-line, else split a single line on commas into bullets.
    if apply_when_raw:
        body_parts.append("## Apply when\n")
        if "\n" in apply_when_raw or "- " in apply_when_raw:
            body_parts.append(apply_when_raw)
        else:
            for phrase in [p.strip() for p in apply_when_raw.split(",") if p.strip()]:
                body_parts.append(f"- {phrase}")
        body_parts.append("")

    # Rejection-kind framing: a one-line note at the top of the body so the
    # reader knows this is an anti-pattern even though type=feedback.
    if kind == "rejection":
        body_parts.insert(2, "> *Captured as a rejection: future agents should NOT retry the approach this entry rejects.*\n")

    return "\n".join(body_parts).rstrip() + "\n"


def _target_path(config: Config, row: dict) -> Optional[Path]:
    """Where to write the row. None means skip (no proposed_wiki_path)."""
    proposed = (row.get("proposed_wiki_path") or "").strip()
    if not proposed:
        return None
    # Reject anything trying to escape wiki dir
    clean = proposed.lstrip("/").replace("..", "")
    if not clean.endswith(".md"):
        clean = clean + ".md"
    return config.wiki_dir / clean


def run_brain_learnings(
    config: Optional[Config] = None,
    *,
    dry_run: bool = False,
) -> dict:
    config = config or load_config()
    brain_db = resolve_brain_db_path()
    rows = _fetch_brain_learnings(brain_db)
    if not rows:
        if not brain_db.exists():
            print(f"Brain DB not found at {brain_db} — skipping (set $DIGITAL_ME_BRAIN_DB to override).")
        else:
            print(f"No brain learnings found at {brain_db}")
        return {
            "db": str(brain_db),
            "total": 0,
            "already_materialized": 0,
            "no_path": 0,
            "materialized": 0,
            "path_collision_skipped": 0,
        }

    seen_ids = _existing_learning_ids(config.wiki_dir)

    materialized = 0
    already = 0
    no_path = 0
    collisions = 0
    actions: list[str] = []

    for row in rows:
        if row["id"] in seen_ids:
            already += 1
            continue

        target = _target_path(config, row)
        if target is None:
            no_path += 1
            actions.append(f"SKIP no_path  {row['id']} agent={row['agent_id']}")
            continue

        # If a wiki file already exists at the target path AND its frontmatter
        # has a DIFFERENT learning_id (or none), don't overwrite — that's a
        # collision worth surfacing. The agent should have chosen a unique slug.
        if target.exists():
            existing = target.read_text(encoding="utf-8")[:2000]
            existing_id_match = re.search(r"^learning_id:\s*(lrn-[a-f0-9-]+)", existing, re.MULTILINE)
            existing_id = existing_id_match.group(1) if existing_id_match else None
            if existing_id != row["id"]:
                collisions += 1
                actions.append(
                    f"SKIP collide  {row['id']} target={target.relative_to(config.wiki_dir)} "
                    f"existing_learning_id={existing_id}"
                )
                continue
            # Same learning_id → safe to overwrite (idempotent re-run)

        content = _build_wiki_content(row)
        rel = target.relative_to(config.wiki_dir)

        if dry_run:
            actions.append(f"WOULD WRITE  {row['id']} → {rel} ({len(content)} bytes)")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            actions.append(f"WROTE        {row['id']} → {rel}")
            materialized += 1

    print(f"Brain learnings ({'DRY-RUN' if dry_run else 'APPLY'}): "
          f"{materialized} materialized, {already} already-materialized, "
          f"{no_path} no_path, {collisions} collisions, total={len(rows)}")
    for line in actions[-25:]:  # cap output
        print(f"  {line}")

    return {
        "db": str(brain_db),
        "total": len(rows),
        "already_materialized": already,
        "no_path": no_path,
        "materialized": materialized,
        "path_collision_skipped": collisions,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Materialize brain learnings into the wiki.")
    parser.add_argument("--dry-run", action="store_true", help="Report only, no writes.")
    args = parser.parse_args()
    result = run_brain_learnings(dry_run=args.dry_run)
    print(json.dumps(result, indent=2, default=str))
