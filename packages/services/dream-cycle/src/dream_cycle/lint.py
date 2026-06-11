"""Health checks for the wiki.

Checks: staleness, orphans, quality (missing sections),
skill-wiki drift, and optionally LLM-powered contradiction detection.
"""

import re
from datetime import date
from pathlib import Path
from typing import Optional

from dream_cycle.config import load_config, Config
from dream_cycle.index import collect_entries, _days_ago

# Mirrored from dream_cycle/backfill_types.py — kept here to avoid a circular
# import at the lint level. If you extend the taxonomy, update both files
# AND the digital-me-protocol entry.
MEMORY_TYPES = ("user", "feedback", "project", "reference")

# `feedback` and `project` entries are the decay-prone types — Claude Code
# enforces a structured body shape (Rule + Why + How to apply) so the *why*
# survives edge-case reasoning. We mirror that here as warn-only lint: any
# entry whose body is missing the **Why:** OR **How to apply:** marker is
# flagged. `user` and `reference` are static-ish; free-form is fine.
STRUCTURED_BODY_TYPES = ("feedback", "project")


def check_staleness(entries: list[dict], threshold_days: int) -> list[dict]:
    """Find entries not updated within threshold."""
    stale = []
    for e in entries:
        updated = e.get('updated') or e.get('created')
        days = _days_ago(updated)
        if days is not None and days > threshold_days:
            stale.append({
                "entry": e.get('title', 'Untitled'),
                "path": str(e['_rel_path']),
                "last_updated": str(updated),
                "days_ago": days,
                "severity": "warning",
            })
    return stale


def check_orphans(entries: list[dict]) -> list[dict]:
    """Find entries with no related links."""
    orphans = []
    for e in entries:
        if not e.get('related'):
            orphans.append({
                "entry": e.get('title', 'Untitled'),
                "path": str(e['_rel_path']),
                "severity": "info",
            })
    return orphans


def check_quality(entries: list[dict]) -> list[dict]:
    """Find entries missing key sections."""
    issues = []
    for e in entries:
        body = e.get('_body', '')
        missing = []
        if '## Rule' not in body and '## rule' not in body.lower():
            missing.append('Rule')
        if '## Apply when' not in body and '## apply when' not in body.lower():
            missing.append('Apply when')

        if missing:
            issues.append({
                "entry": e.get('title', 'Untitled'),
                "path": str(e['_rel_path']),
                "missing_sections": missing,
                "severity": "warning",
            })

    # Check for entries with no title
    for e in entries:
        if not e.get('title') or e.get('title') == 'Untitled':
            issues.append({
                "entry": "(no title)",
                "path": str(e['_rel_path']),
                "missing_sections": ["title"],
                "severity": "error",
            })

    return issues


# `## Apply when` is the retrieval contract — memory_search and the side-query
# selector both rank against it. A sparse Apply-when section makes the entry
# invisible regardless of how good its Rule is. We require at least 2 bulleted
# phrasings OR a sufficiently long prose body (so single-purpose entries with
# a clear paragraph aren't punished).
APPLY_WHEN_MIN_BULLETS = 2
APPLY_WHEN_MIN_CHARS = 80


def _extract_apply_when_body(body: str) -> Optional[str]:
    """Return the text between `## Apply when` and the next H2 (or EOF)."""
    m = re.search(
        r'^## Apply when\s*\n(.+?)(?=\n## [A-Z]|\Z)',
        body, re.DOTALL | re.MULTILINE | re.IGNORECASE,
    )
    return m.group(1).strip() if m else None


def check_apply_when_quality(entries: list[dict]) -> list[dict]:
    """Flag entries whose `## Apply when` section is too sparse to be retrievable.

    Quality bar: ≥ APPLY_WHEN_MIN_BULLETS bullet phrasings, OR
                 ≥ APPLY_WHEN_MIN_CHARS of body text.
    Entries missing `## Apply when` entirely are already caught by check_quality;
    this only flags entries where the section exists but is too thin.
    """
    issues = []
    for e in entries:
        body = e.get('_body', '')
        apply_body = _extract_apply_when_body(body)
        if apply_body is None:
            continue  # absence handled by check_quality

        # Count bullet lines (lines starting with `-` or `*`)
        bullets = sum(
            1 for line in apply_body.splitlines()
            if re.match(r'^\s*[-*]\s+\S', line)
        )
        char_count = len(apply_body)

        if bullets < APPLY_WHEN_MIN_BULLETS and char_count < APPLY_WHEN_MIN_CHARS:
            issues.append({
                "entry": e.get('title', 'Untitled'),
                "path": str(e['_rel_path']),
                "bullets": bullets,
                "chars": char_count,
                "severity": "warning",
            })
    return issues


def check_type_field(entries: list[dict]) -> list[dict]:
    """Flag entries missing `type:` or with an invalid value.

    Closed taxonomy — anything outside MEMORY_TYPES is treated like a typo.
    """
    issues = []
    for e in entries:
        t = e.get("type")
        if t is None:
            issues.append({
                "entry": e.get("title", "Untitled"),
                "path": str(e["_rel_path"]),
                "problem": "missing type:",
                "severity": "warning",
            })
        elif t not in MEMORY_TYPES:
            issues.append({
                "entry": e.get("title", "Untitled"),
                "path": str(e["_rel_path"]),
                "problem": f"invalid type: {t!r}",
                "severity": "warning",
            })
    return issues


def check_body_structure(entries: list[dict]) -> list[dict]:
    """For feedback/project entries, flag bodies missing the *why* + *when*
    scaffolding.

    Two formats both satisfy the check — digital-me's section style is the
    primary convention; Claude Code's inline-marker style is also accepted
    for compatibility with memory entries graduated up from auto-memory:

    | Need | digital-me section | Claude Code inline |
    |------|-------------------|--------------------|
    | why  | `## How it came up` | `**Why:**`          |
    | when | `## Apply when`     | `**How to apply:**` |

    Free-form bodies degrade fast without this scaffolding — edge-case
    reasoning needs the *why* the rule exists.
    """
    issues = []
    for e in entries:
        t = e.get("type")
        if t not in STRUCTURED_BODY_TYPES:
            continue
        body = e.get("_body", "")
        missing = []
        has_why = (
            re.search(r"^##\s+How it came up", body, re.MULTILINE | re.IGNORECASE)
            or re.search(r"\*\*Why:?\*\*", body, re.IGNORECASE)
        )
        has_when = (
            re.search(r"^##\s+Apply when", body, re.MULTILINE | re.IGNORECASE)
            or re.search(r"\*\*How to apply:?\*\*", body, re.IGNORECASE)
        )
        if not has_why:
            missing.append("why (## How it came up or **Why:**)")
        if not has_when:
            missing.append("when (## Apply when or **How to apply:**)")
        if missing:
            issues.append({
                "entry": e.get("title", "Untitled"),
                "path": str(e["_rel_path"]),
                "type": t,
                "missing": missing,
                "severity": "warning",
            })
    return issues


def check_zero_citations(entries: list[dict]) -> list[dict]:
    """Find entries that have never been cited."""
    zero = []
    for e in entries:
        citations = e.get('citations', 0) or 0
        if citations == 0:
            updated = e.get('updated') or e.get('created')
            days = _days_ago(updated)
            zero.append({
                "entry": e.get('title', 'Untitled'),
                "path": str(e['_rel_path']),
                "age_days": days,
                "severity": "info",
            })
    return zero


def generate_lint_report(
    stale: list,
    orphans: list,
    quality: list,
    zero_citations: list,
    apply_when_thin: list,
    type_issues: list,
    body_structure_issues: list,
    total: int,
) -> str:
    """Generate a markdown lint report."""
    today = date.today().isoformat()
    errors = sum(1 for q in quality if q.get('severity') == 'error')
    warnings = (
        len(stale)
        + sum(1 for q in quality if q.get('severity') == 'warning')
        + len(apply_when_thin)
        + len(type_issues)
        + len(body_structure_issues)
    )

    lines = [
        f"# Lint Report — {today}",
        f"> {total} entries scanned | {errors} errors | {warnings} warnings",
        "",
    ]

    if stale:
        lines.append(f"## Stale ({len(stale)} entries)")
        for s in stale:
            lines.append(f"- **{s['entry']}** — {s['last_updated']} ({s['days_ago']}d ago)")
        lines.append("")

    if quality:
        lines.append(f"## Quality Issues ({len(quality)} entries)")
        for q in quality:
            if q.get('missing_sections'):
                lines.append(f"- **{q['entry']}** — missing: {', '.join(q['missing_sections'])}")
        lines.append("")

    if type_issues:
        lines.append(f"## Type field issues ({len(type_issues)} entries)")
        lines.append(f"> Closed taxonomy: {', '.join(MEMORY_TYPES)}")
        for ti in type_issues:
            lines.append(f"- **{ti['entry']}** — {ti['problem']} ({ti['path']})")
        lines.append("")

    if body_structure_issues:
        lines.append(f"## Body structure issues ({len(body_structure_issues)} entries)")
        lines.append(
            f"> `feedback` and `project` bodies should include "
            f"`**Why:**` and `**How to apply:**` markers — preserves the *why* "
            f"so edge-case reasoning survives decay."
        )
        for bi in body_structure_issues:
            lines.append(
                f"- **{bi['entry']}** [{bi['type']}] — missing: {', '.join(bi['missing'])} ({bi['path']})"
            )
        lines.append("")

    if apply_when_thin:
        lines.append(f"## Thin `## Apply when` ({len(apply_when_thin)} entries)")
        lines.append(
            f"> Below retrieval threshold "
            f"(<{APPLY_WHEN_MIN_BULLETS} bullets AND <{APPLY_WHEN_MIN_CHARS} chars). "
            f"`## Apply when` is what memory_search ranks against — sparse = invisible."
        )
        for a in apply_when_thin:
            lines.append(
                f"- **{a['entry']}** — {a['bullets']} bullets, {a['chars']} chars "
                f"({a['path']})"
            )
        lines.append("")

    if orphans:
        lines.append(f"## Orphans ({len(orphans)} entries)")
        for o in orphans:
            lines.append(f"- {o['entry']} ({o['path']})")
        lines.append("")

    if zero_citations:
        lines.append(f"## Zero Citations ({len(zero_citations)} entries)")
        for z in zero_citations:
            age = f", {z['age_days']}d old" if z.get('age_days') else ""
            lines.append(f"- {z['entry']}{age}")
        lines.append("")

    if not (stale or quality or orphans or zero_citations or apply_when_thin
            or type_issues or body_structure_issues):
        lines.append("All clear! No issues found.")

    return "\n".join(lines)


def run_lint(config: Optional[Config] = None) -> dict:
    """Run all lint checks and generate report."""
    config = config or load_config()
    entries = collect_entries(config)

    threshold = config.dream_cycle.staleness_threshold_days

    stale = check_staleness(entries, threshold)
    orphans = check_orphans(entries)
    quality = check_quality(entries)
    zero_citations = check_zero_citations(entries)
    apply_when_thin = check_apply_when_quality(entries)
    type_issues = check_type_field(entries)
    body_structure_issues = check_body_structure(entries)

    report = generate_lint_report(
        stale, orphans, quality, zero_citations, apply_when_thin,
        type_issues, body_structure_issues, len(entries),
    )

    config.logs_dir.mkdir(parents=True, exist_ok=True)
    report_path = config.logs_dir / f"lint-{date.today().isoformat()}.md"
    report_path.write_text(report)

    print(f"Lint: {len(stale)} stale, {len(quality)} quality issues, "
          f"{len(orphans)} orphans, {len(zero_citations)} zero-citation, "
          f"{len(apply_when_thin)} thin apply-when, "
          f"{len(type_issues)} type-field issues, "
          f"{len(body_structure_issues)} body-structure issues")
    print(f"Report: {report_path}")

    return {
        "total": len(entries),
        "stale": len(stale),
        "quality_issues": len(quality),
        "orphans": len(orphans),
        "zero_citations": len(zero_citations),
        "apply_when_thin": len(apply_when_thin),
        "type_issues": len(type_issues),
        "body_structure_issues": len(body_structure_issues),
        "report": str(report_path),
    }


if __name__ == "__main__":
    run_lint()
