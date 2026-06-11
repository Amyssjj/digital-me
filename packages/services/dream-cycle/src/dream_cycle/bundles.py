"""Bundles consumer API — load leaf principles for consult/judge/eval modes.

This module is the agent-facing side of the dream-cycle pipeline:
  - compile.py produces leaves in `bundles/<domain>/<slug>.md` (supply)
  - bundles.py loads + classifies + serves them to agents (demand)

Three modes, all from the same leaf file:
  - consult: pre-action — return principles + discriminators + near-misses
             as a prompt fragment to load into agent context.
  - judge:   post-action — return rubric items + scoring guidance to evaluate
             a produced artifact. The actual LLM scoring is per-runtime.
  - eval:    batch — same as judge, run over multiple artifacts with aggregation.

Designed to be importable from any Python runtime AND wrappable as MCP tools
(`mcp__openclaw-brain__taste_consult`, `mcp__openclaw-brain__taste_judge_prompt`)
so every cross-agent surface (Claude Code, Codex, Hermes, OpenClaw subagents,
Mission Control) consumes the same source of truth.

Naming: the taste-side brain API uses a `taste_*` prefix that mirrors the
knowledge-side `memory_*` prefix. The file name `bundles.py` reflects the
underlying data model (bundles of leaves); the public functions reflect the
agent-facing intent (consulting/judging the owner's taste).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import NamedTuple, Optional

import yaml

# Per NUX scope-down §A (2026-05-26): tastes were unified with the wiki —
# flat tree at ~/digital-me/tastes/<domain>/<slug>.md with status:
# promoted|candidate frontmatter (no more bundles/ vs _holding/ split).
# Promoted tastes (formerly bundles/) are the ones consumers should read by default.
BUNDLES_DIR = Path.home() / "digital-me" / "tastes"
VALID_DOMAINS = ("infra", "knowledge", "storytelling", "design")


class LeafPrinciple(NamedTuple):
    domain: str
    slug: str
    path: Path
    fingerprint: str
    discriminator: str
    fire_signature: list[str]
    rubric_items: list[str]
    near_misses: list[str]
    evidence_count: int


def _read_leaf(md: Path, domain: str) -> Optional[LeafPrinciple]:
    """Parse one leaf file into the LeafPrinciple structure."""
    try:
        text = md.read_text(encoding="utf-8")
    except OSError:
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    try:
        fm = yaml.safe_load(parts[1])
    except yaml.YAMLError:
        return None
    if not fm:
        return None
    # Extract Discriminator section from the markdown body
    disc = ""
    m = re.search(
        r"^## Discriminator\s*\n(.*?)(?=\n## |\Z)",
        parts[2], re.MULTILINE | re.DOTALL,
    )
    if m:
        # First non-empty line, strip italic placeholder template
        for line in m.group(1).strip().splitlines():
            line = line.strip()
            if line and not line.startswith("_"):
                disc = line
                break
    return LeafPrinciple(
        domain=domain,
        slug=md.stem,
        path=md,
        fingerprint=(fm.get("principle_fingerprint") or "").strip(),
        discriminator=disc,
        fire_signature=list(fm.get("fire_signature") or []),
        rubric_items=list(fm.get("rubric_items") or []),
        near_misses=list(fm.get("near_misses") or []),
        evidence_count=int(fm.get("evidence_count") or 0),
    )


def load_leaves(domain: Optional[str] = None) -> list[LeafPrinciple]:
    """Load promoted-status taste principles, optionally filtered by domain.

    Per NUX scope-down §A: tastes live in a flat ~/digital-me/tastes/<domain>/
    tree with both `status: promoted` and `status: candidate` files sharing
    the directory. This loader returns only promoted entries — the "demand
    side" agents see — leaving candidates for the compile/apply pipeline.
    """
    leaves: list[LeafPrinciple] = []
    if not BUNDLES_DIR.exists():
        return leaves
    domains_to_scan = [domain] if domain else VALID_DOMAINS
    for d in domains_to_scan:
        d_dir = BUNDLES_DIR / d
        if not d_dir.exists():
            continue
        for md in sorted(d_dir.glob("*.md")):
            # Quick status filter to skip candidates without paying the full
            # parse cost. _read_leaf does its own frontmatter parse for the
            # fields we expose; we only need status here.
            text = md.read_text(encoding="utf-8", errors="ignore")
            parts = text.split("---", 2)
            if len(parts) < 3:
                continue
            try:
                fm_quick = yaml.safe_load(parts[1]) or {}
            except yaml.YAMLError:
                continue
            if (fm_quick.get("status") or "").strip() != "promoted":
                continue
            leaf = _read_leaf(md, d)
            if leaf and leaf.fingerprint:
                leaves.append(leaf)
    return leaves


_CHEAP_KEYWORDS: dict[str, tuple[str, ...]] = {
    "storytelling": (
        "deck", "speech", "talk", "post", "narrative", "write", "story",
        "article", "essay", "audience", "thesis", "presentation", "blog",
        "substack", "x post", "tweet", "pitch",
    ),
    "design": (
        # Visual artifact surfaces (decks, slides, video are visual too)
        "deck", "slide", "presentation", "video", "animation", "motion",
        # UI / UX explicit
        "ui", "ux", "design", "layout", "dashboard", "visual", "typography",
        "frontend", "component", "interface", "minimalist",
    ),
    "infra": (
        # Words specific to system/code work — avoid "agent" alone since it
        # collides with "agent evaluation" (storytelling topic) vs "agent
        # runtime" (infra topic). Require a stronger signal.
        "debug", "infrastructure", "scheduler", "cron", "workflow", "plugin",
        "mcp", "upgrade", "watchdog", "concurrency", "pipeline", "orchestrator",
        "subagent", "node_modules", "fork", "rebase", "migration",
    ),
    "knowledge": (
        "wiki", "knowledge", "memory", "skill", "distill", "extract",
        "index", "brain", "compile", "consolidate", "rubric", "principle",
    ),
}


def classify_task(task: str, top_k: int = 2) -> list[tuple[str, float]]:
    """Classify a task into bundle domains via fire_signature matching.

    Combines two signals:
      1. Substring match of any leaf's fire_signature phrases in the task.
      2. Cheap keyword fallback if signature matching is weak.

    Returns up to top_k (domain, confidence) tuples sorted by confidence desc.
    Confidence is normalized share of total matching weight.
    """
    task_lower = task.lower()
    scores: dict[str, float] = {d: 0.0 for d in VALID_DOMAINS}

    # Signal 1: fire_signature substring + token match against leaves
    for leaf in load_leaves():
        for sig in leaf.fire_signature:
            sig_lower = sig.lower().strip("\"'")
            if not sig_lower:
                continue
            if sig_lower in task_lower:
                scores[leaf.domain] += 2.0
                continue
            sig_tokens = {t for t in re.split(r"\W+", sig_lower) if len(t) > 3}
            task_tokens = set(re.split(r"\W+", task_lower))
            overlap = len(sig_tokens & task_tokens)
            if overlap >= 2:
                scores[leaf.domain] += float(overlap)

    # Signal 2: cheap keyword fallback (always combined, weighted lower)
    for d, kws in _CHEAP_KEYWORDS.items():
        for kw in kws:
            if kw in task_lower:
                scores[d] += 0.5

    total = sum(scores.values())
    if total == 0:
        return []
    ranked = sorted(
        [(d, s / total) for d, s in scores.items() if s > 0],
        key=lambda x: x[1], reverse=True,
    )
    return ranked[:top_k]


def taste_consult(task: str, top_k_domains: int = 2) -> dict:
    """Pre-action API: classify task → load matching bundles → return a
    consult-mode prompt fragment ready to inject into agent context.

    Returns:
        {
          "task": original task string,
          "classified_domains": [{"domain": ..., "confidence": ...}, ...],
          "leaves_loaded": [{"domain": ..., "slug": ..., "fingerprint": ...}, ...],
          "consult_prompt": ready-to-use prompt fragment (markdown),
        }
    """
    classified = classify_task(task, top_k=top_k_domains)
    sections: list[str] = []
    leaves_meta: list[dict] = []

    if not classified:
        return {
            "task": task,
            "classified_domains": [],
            "leaves_loaded": [],
            "consult_prompt": (
                "_No taste principles matched this task — proceed with "
                "defaults; consider whether the task needs a new bundle._"
            ),
        }

    sections.append(
        "# Taste principles for this task\n\n"
        "Load these BEFORE acting. They reflect the owner's domain-specific "
        "judgment. After producing the artifact, expect to be scored against "
        "the rubric items below — iterate until you pass.\n"
    )

    for domain, confidence in classified:
        leaves = load_leaves(domain)
        if not leaves:
            continue
        sections.append(f"## Domain: **{domain}** (confidence {confidence:.0%})\n")
        for leaf in leaves:
            leaves_meta.append({
                "domain": leaf.domain,
                "slug": leaf.slug,
                "fingerprint": leaf.fingerprint,
            })
            sections.append(f"### {leaf.fingerprint}\n")
            if leaf.discriminator:
                sections.append(f"_Discriminator:_ {leaf.discriminator}\n")
            if leaf.near_misses:
                sections.append(f"_Does NOT apply when:_ {leaf.near_misses[0]}\n")
            if leaf.rubric_items:
                sections.append("Rubric (you'll be scored against):")
                for item in leaf.rubric_items[:3]:
                    sections.append(f"- {item}")
                sections.append("")

    return {
        "task": task,
        "classified_domains": [
            {"domain": d, "confidence": round(c, 3)} for d, c in classified
        ],
        "leaves_loaded": leaves_meta,
        "consult_prompt": "\n".join(sections),
    }


def taste_judge_prompt(artifact_description: str, domains: list[str]) -> dict:
    """Post-action API: return the judge-mode rubric prompt for an artifact.

    The actual LLM scoring is per-runtime — this function returns the prompt
    fragment + the rubric items list that a runtime should ask its LLM to
    answer yes/no on, plus the metadata needed to aggregate results.

    Returns:
        {
          "judge_prompt": markdown fragment to send to the judging LLM,
          "rubric_items": [{"leaf_slug": ..., "domain": ..., "item": ..., "fingerprint": ...}, ...],
        }
    """
    rubric_items: list[dict] = []
    sections = [
        "# Judge this artifact against the loaded rubric.\n",
        "For each rubric item below, return a YES/NO and a one-line reason.\n",
        "\n## Artifact\n",
        artifact_description,
        "\n## Rubric\n",
    ]
    for domain in domains:
        leaves = load_leaves(domain)
        for leaf in leaves:
            sections.append(f"\n### {leaf.fingerprint}  _(leaf: {domain}/{leaf.slug})_")
            for i, item in enumerate(leaf.rubric_items):
                rubric_id = f"{domain}.{leaf.slug}.{i}"
                rubric_items.append({
                    "rubric_id": rubric_id,
                    "leaf_slug": leaf.slug,
                    "domain": leaf.domain,
                    "fingerprint": leaf.fingerprint,
                    "item": item,
                })
                sections.append(f"- [{rubric_id}] {item}")
    return {
        "judge_prompt": "\n".join(sections),
        "rubric_items": rubric_items,
    }


if __name__ == "__main__":
    import json

    # --json flag emits pure JSON (machine-readable, for MCP wrappers etc.)
    # Default mode is human-readable (for terminal use).
    json_mode = "--json" in sys.argv
    if json_mode:
        sys.argv.remove("--json")

    if len(sys.argv) > 1 and sys.argv[1] == "--judge":
        artifact = sys.argv[2] if len(sys.argv) > 2 else "(no artifact provided)"
        domains = sys.argv[3].split(",") if len(sys.argv) > 3 else ["storytelling", "design"]
        out = taste_judge_prompt(artifact, domains)
        if json_mode:
            print(json.dumps(out, ensure_ascii=False))
        else:
            print(out["judge_prompt"])
            print("\n---\nRubric items count:", len(out["rubric_items"]))
    else:
        task = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else \
               "Write a deck for product leaders about agent evaluation."
        result = taste_consult(task)
        if json_mode:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(f"Task: {result['task']}\n")
            print(f"Classified: {json.dumps(result['classified_domains'], indent=2)}\n")
            print(f"Loaded {len(result['leaves_loaded'])} leaves\n")
            print("=" * 70)
            print(result["consult_prompt"])
