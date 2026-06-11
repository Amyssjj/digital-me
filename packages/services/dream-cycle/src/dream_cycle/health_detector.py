"""Knowledge-layer health detector.

Runs a fixed set of wiki invariants against ~/digital-me/wiki. Each failed
invariant opens (or re-opens) one task under the `knowledge` evergreen via
the task-orchestrator's open-task.mjs CLI. Task ids are deterministic so
re-runs are idempotent.

Exits 0 whether invariants pass or fail — invariants are tasks, not errors.
Exit non-zero only if the detector itself breaks (that then becomes a
Validation task via a separate mechanism).

Invariants (v1):
  1. Every entry with `priority: always` is mentioned in _INDEX.md.
  2. _STATS.md stale count < 25.
  3. Broken `related:` links: rolled up into one task if count > 0.
  4. Stale batch: entries older than 180d with citations=1 → one roll-up task.
  5. Duplicate titles across entries.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

WIKI = Path.home() / "digital-me" / "wiki"
INDEX = Path.home() / "digital-me" / "_INDEX.md"
STATS = Path.home() / "digital-me" / "_STATS.md"
OPEN_TASK = (
    Path.home()
    / "openclaw"
    / "extensions"
    / "task-orchestrator"
    / "scripts"
    / "open-task.mjs"
)

STALE_THRESHOLD = 25
STALE_DAYS = 180
KNOWLEDGE_GOAL = "knowledge"


@dataclass
class Invariant:
    task_id: str
    name: str
    description: str
    tags: list[str]
    priority: str = "normal"


def emit(inv: Invariant) -> None:
    """Call open-task.mjs. Returns silently on both 'created' and 'exists'."""
    import json as _json

    cmd = [
        "node",
        str(OPEN_TASK),
        f"--id={inv.task_id}",
        f"--goal={KNOWLEDGE_GOAL}",
        f"--name={inv.name}",
        f"--task={inv.description}",
        "--status=ready",
        f"--priority={inv.priority}",
        f"--tags={_json.dumps(inv.tags)}",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        # Log but keep going — don't let one bad emit stop other invariants.
        print(
            f"[detector] emit failed for {inv.task_id}: {result.stderr.strip()}",
            file=sys.stderr,
        )
    elif result.stdout.strip().startswith("created:"):
        print(f"[detector] {result.stdout.strip()}")


# -- Frontmatter parsing ---------------------------------------------------

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def parse_frontmatter(text: str) -> dict[str, object]:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}
    out: dict[str, object] = {}
    current_key: str | None = None
    for raw in m.group(1).split("\n"):
        if raw.startswith("  - "):
            if current_key and isinstance(out.get(current_key), list):
                out[current_key].append(raw[4:].strip())  # type: ignore[union-attr]
        elif raw.startswith("- "):
            if current_key and isinstance(out.get(current_key), list):
                out[current_key].append(raw[2:].strip())  # type: ignore[union-attr]
        elif ":" in raw:
            key, _, val = raw.partition(":")
            key = key.strip()
            val = val.strip()
            if not val:
                out[key] = []
                current_key = key
            elif val.startswith("["):
                # Inline list
                inner = val.strip("[]")
                items = [s.strip().strip("'\"") for s in inner.split(",") if s.strip()]
                out[key] = items
                current_key = None
            else:
                out[key] = val.strip("'\"")
                current_key = None
    return out


def iter_wiki_entries() -> list[tuple[Path, dict[str, object], str]]:
    """Return (path, frontmatter_dict, full_text) for each .md under wiki/."""
    out = []
    for p in WIKI.rglob("*.md"):
        text = p.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        if fm:
            out.append((p, fm, text))
    return out


# -- Invariants ------------------------------------------------------------


def check_priority_always_indexed(
    entries: list[tuple[Path, dict[str, object], str]],
) -> list[Invariant]:
    """Invariant 1: every entry with priority: always is mentioned in _INDEX.md."""
    if not INDEX.exists():
        return [
            Invariant(
                task_id="knowledge::invariant::missing-index",
                name="_INDEX.md missing from wiki",
                description=f"{INDEX} does not exist. Dream cycle's index.py should regenerate it.",
                tags=["data-integrity", "freshness"],
                priority="high",
            )
        ]
    index_text = INDEX.read_text(encoding="utf-8").lower()
    findings: list[Invariant] = []
    for path, fm, _ in entries:
        if str(fm.get("priority", "")).lower() != "always":
            continue
        title = str(fm.get("title", "")).lower()
        slug = path.stem.lower()
        if title and title in index_text:
            continue
        if slug and slug in index_text:
            continue
        rel = path.relative_to(Path.home() / "digital-me")
        findings.append(
            Invariant(
                task_id=f"knowledge::priority-always-not-indexed::{slug}",
                name=f"Active policy not in _INDEX.md: {title or slug}",
                description=(
                    f"Entry `{rel}` has priority: always but does not appear in "
                    f"_INDEX.md's Active Policies section. Re-run dream cycle "
                    f"index.py, or check for a typo in the entry's title/frontmatter."
                ),
                tags=["freshness", "data-integrity"],
                priority="high",
            )
        )
    return findings


def check_stale_count() -> list[Invariant]:
    """Invariant 2: _STATS.md stale count < threshold."""
    if not STATS.exists():
        return []
    m = re.search(r"\*\*Stale:\*\*\s*(\d+)", STATS.read_text(encoding="utf-8"))
    if not m:
        return []
    count = int(m.group(1))
    if count < STALE_THRESHOLD:
        return []
    return [
        Invariant(
            task_id=f"knowledge::stale-count-over-threshold::{count // 5 * 5}",  # bucket of 5 so re-opens on growth
            name=f"Wiki stale entry count is {count} (threshold: {STALE_THRESHOLD})",
            description=(
                f"_STATS.md reports {count} stale wiki entries (>= {STALE_THRESHOLD}). "
                f"Run the stale-entry refresh workflow, or prune entries that are "
                f"obsolete. Threshold is the signal that distillation has fallen "
                f"behind substrate growth."
            ),
            tags=["freshness", "triage-overflow"],
        )
    ]


def check_broken_related_links(
    entries: list[tuple[Path, dict[str, object], str]],
) -> list[Invariant]:
    """Invariant 3: related: entries resolve to real files."""
    valid_paths: set[str] = set()
    for p, _, _ in entries:
        valid_paths.add(str(p.relative_to(WIKI)))
        valid_paths.add(p.stem)

    broken: list[tuple[str, str]] = []
    for path, fm, _ in entries:
        related = fm.get("related") or []
        if isinstance(related, list):
            for ref in related:
                if not ref:
                    continue
                ref_clean = ref.strip().strip("'\"")
                if not ref_clean:
                    continue
                if ref_clean in valid_paths:
                    continue
                # Check if file exists relative to wiki/
                candidate = WIKI / ref_clean
                if candidate.exists():
                    continue
                # Try with .md suffix
                if (WIKI / f"{ref_clean}.md").exists():
                    continue
                broken.append((str(path.relative_to(WIKI)), ref_clean))

    if not broken:
        return []
    sample = broken[:5]
    sample_lines = "\n".join(f"  - {src} -> {target}" for src, target in sample)
    return [
        Invariant(
            task_id="knowledge::broken-related-links::rollup",
            name=f"{len(broken)} broken `related:` cross-links in wiki",
            description=(
                f"Found {len(broken)} broken `related:` links across wiki entries. "
                f"Sample:\n{sample_lines}\n\n"
                f"Run dream_cycle/crosslink.py to regenerate, or hand-edit."
            ),
            tags=["data-integrity"],
        )
    ]


def check_stale_entries(
    entries: list[tuple[Path, dict[str, object], str]],
) -> list[Invariant]:
    """Invariant 4: entries with updated > 180d ago AND citations <= 1 → roll-up."""
    cutoff = (date.today() - timedelta(days=STALE_DAYS)).isoformat()
    stale: list[str] = []
    for path, fm, _ in entries:
        updated = str(fm.get("updated", ""))
        if not updated or updated > cutoff:
            continue
        citations_raw = fm.get("citations", "0")
        try:
            citations = int(str(citations_raw))
        except ValueError:
            citations = 0
        if citations > 1:
            continue
        stale.append(str(path.relative_to(WIKI)))

    if not stale:
        return []
    signature = hashlib.sha1("|".join(sorted(stale)).encode()).hexdigest()[:8]
    sample = "\n".join(f"  - {s}" for s in stale[:10])
    more = f"\n  ... and {len(stale) - 10} more" if len(stale) > 10 else ""
    return [
        Invariant(
            task_id=f"knowledge::stale-low-citation::{signature}",
            name=f"{len(stale)} wiki entries stale + low-citation",
            description=(
                f"{len(stale)} wiki entries have updated > {STALE_DAYS} days ago "
                f"and citations <= 1 — candidates for refresh or retirement.\n\n"
                f"Sample:\n{sample}{more}"
            ),
            tags=["freshness", "triage-overflow"],
        )
    ]


def check_duplicate_titles(
    entries: list[tuple[Path, dict[str, object], str]],
) -> list[Invariant]:
    """Invariant 5: no two entries share the same title."""
    by_title: dict[str, list[Path]] = {}
    for path, fm, _ in entries:
        title = str(fm.get("title", "")).strip()
        if not title:
            continue
        by_title.setdefault(title.lower(), []).append(path)
    findings: list[Invariant] = []
    for title, paths in by_title.items():
        if len(paths) < 2:
            continue
        signature = hashlib.sha1(title.encode()).hexdigest()[:8]
        path_list = ", ".join(str(p.relative_to(WIKI)) for p in paths)
        findings.append(
            Invariant(
                task_id=f"knowledge::duplicate-title::{signature}",
                name=f"Duplicate wiki title: {title[:60]}",
                description=(
                    f"Multiple entries share title '{title}':\n{path_list}\n\n"
                    f"Merge, rename, or retire the duplicates."
                ),
                tags=["data-integrity"],
            )
        )
    return findings


# -- Main ------------------------------------------------------------------


def main() -> int:
    if not WIKI.exists():
        print(f"[detector] wiki not found: {WIKI}", file=sys.stderr)
        return 2
    entries = iter_wiki_entries()
    if not entries:
        print("[detector] no entries parsed — suspicious, bailing", file=sys.stderr)
        return 2

    print(f"[detector] scanning {len(entries)} wiki entries")

    findings: list[Invariant] = []
    findings.extend(check_priority_always_indexed(entries))
    findings.extend(check_stale_count())
    findings.extend(check_broken_related_links(entries))
    findings.extend(check_stale_entries(entries))
    findings.extend(check_duplicate_titles(entries))

    if not findings:
        print("[detector] all invariants pass")
        return 0

    print(f"[detector] {len(findings)} invariant failures — emitting tasks")
    for inv in findings:
        emit(inv)
    return 0


if __name__ == "__main__":
    sys.exit(main())
