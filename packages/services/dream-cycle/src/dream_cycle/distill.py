"""Proactive taste distillation — user-initiated counterpart to compile.py.

Where compile.py runs nightly over inbox transcripts (batch, automated),
distill.py runs on demand over arbitrary text (interactive, user-initiated).

Both paths share the same REVERSE_ENGINEER_SYSTEM prompt, the same JSON
outcome shape, and the same apply_skill_outcome() routing — so a proactively
distilled principle lands in the same flat `tastes/<domain>/<slug>.md` tree
(`status: candidate|promoted` in frontmatter) as an auto-extracted one and is
indistinguishable downstream. (The legacy `skills-proposals/{_holding,bundles}`
staging dirs were removed in the §A unification.)

Three call surfaces:
  1. Python function: `taste_distill(text, apply=False)`
  2. Slash skill: `/taste-distill` (loads ~/.agents/skills/taste-distill/SKILL.md)
  3. MCP tool (future): `mcp__openclaw-brain__taste_distill` —
     wrapper lives in the openclaw task-orchestrator extension where
     learning_capture already lives.

Symmetry with the brain's existing surfaces:
  - knowledge: memory_search / memory_get (read) + learning_capture (write)
  - taste:     taste_consult / taste_judge_prompt (read) + taste_distill (write)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

from dream_cycle.bundles import VALID_DOMAINS, _read_leaf, load_leaves
from dream_cycle.compile import (
    REVERSE_ENGINEER_SYSTEM,
    SKILL_PROPOSALS_DIR,
    apply_skill_outcome,
    build_principles_manifest,
    extract_skill_update,
)
from dream_cycle.config import load_config
from dream_cycle.engine import get_engine


def _synthesize_transcript_entry(text: str, label: str = "interactive-distill") -> dict:
    """Wrap arbitrary text in the shape extract_skill_update() expects."""
    return {
        "title": f"Interactive distill ({label})",
        "body": text,
        "source_name": label,
        "source_format": "interactive",
        "user_turns": 99,         # exempt from is_taste_eligible gating
        "assistant_turns": 99,
        "body_chars": len(text),
    }


def _surface_match_candidates(text: str, top_k: int = 3) -> list[dict]:
    """Cheap keyword-shaped pre-match against existing leaves so the user
    can SEE which existing principles look related before applying.
    """
    text_lower = text.lower()
    scored: list[tuple[int, dict]] = []
    for leaf in load_leaves():
        score = 0
        for sig in leaf.fire_signature:
            sig_lower = sig.lower().strip("\"'")
            if sig_lower and sig_lower in text_lower:
                score += 2
        # Fingerprint word overlap
        fp_tokens = {t for t in leaf.fingerprint.lower().split() if len(t) > 4}
        text_tokens = set(text_lower.split())
        score += len(fp_tokens & text_tokens)
        if score >= 2:
            scored.append((score, {
                "domain": leaf.domain,
                "slug": leaf.slug,
                "fingerprint": leaf.fingerprint,
                "evidence_count": leaf.evidence_count,
                "match_score": score,
            }))
    scored.sort(reverse=True, key=lambda r: r[0])
    return [d for _, d in scored[:top_k]]


def taste_distill(
    text: str,
    *,
    user_hint_domain: Optional[str] = None,
    apply: bool = False,
    label: str = "interactive-distill",
) -> dict:
    """Proactively distill a taste principle from arbitrary text.

    Args:
        text: The text to distill — a conversation excerpt, an owner
            observation, an artifact under review, a meeting note.
        user_hint_domain: Optional bias toward one of the four domains.
            If provided, the prompt receives it as a constraint hint.
        apply: If True, write the result into the flat `tastes/<domain>/`
            tree (`status: candidate|promoted`), same as the dream-cycle
            auto-pipeline. If False, return the proposed outcome for the
            user to review.
        label: Short identifier for the source. Shows up in evidence
            records' `project_id` field so distilled principles are
            traceable to the interactive session that produced them.

    Returns:
        {
          "outcome": "candidate" | "evidence" | "neither",
          "domain": str | None,
          "principle_fingerprint": str | None,
          "rationale": str,
          "confidence": float | None,
          "evidence_record": dict | None,
          "rubric_item_candidates": list,
          "near_miss_observed": str | None,
          "fire_signature_hints": list,
          "matched_existing_fingerprint": str | None,
          "surface_matched_leaves": [{slug, fingerprint, ...}],
          "apply_action": str | None,
          "applied_path": str | None,
          "preview_only": bool,
        }
    """
    if not text or not text.strip():
        return {
            "outcome": "neither",
            "rationale": "Empty input — nothing to distill.",
            "preview_only": not apply,
        }

    config = load_config()
    engine = get_engine(config)

    transcript = _synthesize_transcript_entry(text, label=label)

    # Optional user hint biases the LLM toward a specific domain
    if user_hint_domain and user_hint_domain in VALID_DOMAINS:
        transcript["body"] = (
            f"[USER HINT: target domain = {user_hint_domain}]\n\n" + transcript["body"]
        )

    principles_manifest = build_principles_manifest()
    outcome = extract_skill_update(engine, transcript, principles_manifest) or {}

    # Add surface-matched leaves so the user can see related principles
    # that the LLM may have missed
    outcome["surface_matched_leaves"] = _surface_match_candidates(text)
    outcome["preview_only"] = not apply

    if not apply or outcome.get("outcome") == "neither":
        outcome["apply_action"] = None
        outcome["applied_path"] = None
        return outcome

    applied = apply_skill_outcome(outcome)
    if applied is None:
        outcome["apply_action"] = "rejected"
        outcome["applied_path"] = None
        return outcome
    path, action = applied
    outcome["apply_action"] = action
    outcome["applied_path"] = str(path)
    return outcome


if __name__ == "__main__":
    args = sys.argv[1:]
    apply = "--apply" in args
    if apply:
        args.remove("--apply")
    user_hint_domain = None
    for i, a in enumerate(list(args)):
        if a == "--domain" and i + 1 < len(args):
            user_hint_domain = args[i + 1]
            args = [x for x in args if x not in ("--domain", user_hint_domain)]
            break
    text = " ".join(args) if args else sys.stdin.read()
    result = taste_distill(text, user_hint_domain=user_hint_domain, apply=apply)
    print(json.dumps(result, indent=2, ensure_ascii=False))
