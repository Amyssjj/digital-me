"""Backfill `type:` frontmatter field on all wiki entries.

Classifies each entry into the closed 4-type taxonomy adopted from Claude Code:
    user | feedback | project | reference

The set is mirrored from `~/.claude/projects/.../memdir/memoryTypes.ts:14-19`.
The set is enforced at lint time (see dream_cycle/lint.py:check_type_field).

Usage:
    python -m dream_cycle.backfill_types               # dry-run (no writes)
    python -m dream_cycle.backfill_types --apply       # write type: into frontmatter
    python -m dream_cycle.backfill_types --apply --force  # re-classify entries that already have type:

Batched: groups N=10 entries per LLM call to keep prompts small and parses
predictable. Skips entries with an existing valid type unless --force.
"""

import argparse
import json
import re
from pathlib import Path
from typing import Optional

import yaml

from dream_cycle.config import load_config, Config
from dream_cycle.engine import get_engine, Engine
from dream_cycle.index import collect_entries


# Closed taxonomy. Mirrored from Claude Code's MEMORY_TYPES. Do not extend
# without also updating lint.py and the digital-me-protocol entry.
MEMORY_TYPES = ("user", "feedback", "project", "reference")

# Per-batch size. 5 (not 10) — gemini-3-flash returns truncated JSON on
# noisier batches even at 8192 output tokens, and the failure mode is
# unrecoverable mid-stream. Smaller batches halve the per-batch failure
# blast radius at 2× the call count (~30s vs ~50s total for 166 entries).
BATCH_SIZE = 5

# How many times to retry a batch that returns invalid JSON. Transient
# truncations recover; persistent failures (e.g. one entry triggers a
# safety filter) won't.
BATCH_RETRIES = 1

# Confidence below this surfaces in the summary as "needs review" — written
# anyway, but flagged so the user can audit edge cases.
LOW_CONF_THRESHOLD = 0.7


CLASSIFY_SYSTEM = """You are classifying wiki entries from a cross-agent knowledge base ("digital-me").
The closed 4-type taxonomy is adopted from Claude Code's auto-memory:

- **user**: information about the user (the owner) — role, goals, expertise, communication style, personal preferences.
- **reference**: lookup pointers to external systems — API endpoints, dashboard URLs, third-party docs, configuration paths in other systems. The entry's primary purpose is "go here / use this field name / this is the path."
- **project**: current decisions, contracts, architectural designs, ongoing initiatives, postmortems / incident retrospectives. Content that captures the WHY behind a system's current shape and may evolve as decisions are revised. Examples: API contracts, system layer designs, retrospectives, migration plans.
- **feedback**: durable operational guidance for agents — "do X / never Y / use Z" directives, technical recipes, validated approaches. Steady-state rules that hold across versions.

Apply this decision tree IN ORDER. Stop at the first match:

1. Is this primarily about the user personally? → **user**
2. Is the entry's main purpose to point at an external API endpoint, dashboard URL, config file path, or third-party schema? → **reference**
3. Does the entry capture a current architectural decision, system contract, design proposal, ongoing initiative, or postmortem — content whose value comes from documenting WHY a system is the way it is, and which would be revised if the underlying decision changed? → **project**
4. Otherwise (operational do-X-not-Y rules, recipes, anti-patterns) → **feedback**

Concrete examples:
- "RSS.com API v4 episode field naming" → **reference** (external API schema)
- "Brain API Contract v1→v2" → **project** (architectural design + active decisions)
- "Company Layers — the AI-native operating model" → **project** (design framework)
- "Cron-blackout recovery — cancel zombies before re-dispatch" → **feedback** (recovery recipe; the rule is the load-bearing part)
- "Use bun not npm for installs" → **feedback** (steady-state directive)
- "MacOS sandbox restrictions for launchd services" → **reference** (external system constraint)
- "Digital Me Protocol" → **project** (protocol contract for agents)
- "Standardize Discord Components V2 on Shape B" → **feedback** (operational directive)

Return ONLY valid JSON, no markdown fences, no prose before or after:
{
  "classifications": [
    {"path": "<exact relative path>", "type": "user|feedback|project|reference", "confidence": 0.0-1.0, "reason": "<one short sentence>"}
  ]
}"""


def _build_batch_prompt(entries: list[dict]) -> str:
    lines = ["Classify each entry below into exactly one type:\n"]
    for e in entries:
        path = str(e["_rel_path"])
        title = e.get("title", "Untitled")
        domain = ", ".join(e.get("domain", []) or [e.get("_domain", "")])
        tags = ", ".join(e.get("tags", []) or [])
        body_preview = (e.get("_body", "") or "")[:600].strip()
        lines.append(f"---\nPATH: {path}\nTITLE: {title}\nDOMAINS: {domain}\nTAGS: {tags}\nBODY (truncated):\n{body_preview}")
    lines.append("\n---\nReturn JSON with one classification per entry, in the same order.")
    return "\n".join(lines)


def _parse_response(raw: str, expected_paths: list[str]) -> list[dict]:
    """Parse LLM JSON output. Strip code fences if present. Validate types."""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"LLM did not return valid JSON: {e}\nRaw: {raw[:300]}")

    classifications = data.get("classifications")
    if not isinstance(classifications, list):
        raise ValueError(f"Response missing 'classifications' array. Raw: {raw[:300]}")

    by_path = {c.get("path"): c for c in classifications if isinstance(c, dict)}
    out: list[dict] = []
    for path in expected_paths:
        c = by_path.get(path)
        if c is None:
            out.append({"path": path, "type": None, "confidence": 0.0, "reason": "missing from response"})
            continue
        t = c.get("type")
        if t not in MEMORY_TYPES:
            out.append({"path": path, "type": None, "confidence": 0.0, "reason": f"invalid type: {t!r}"})
            continue
        out.append({
            "path": path,
            "type": t,
            "confidence": float(c.get("confidence", 0.0)),
            "reason": str(c.get("reason", ""))[:200],
        })
    return out


def classify_batch(engine: Engine, entries: list[dict]) -> list[dict]:
    """Classify one batch via LLM. Returns one result dict per entry, in order.

    Retries once on JSON parse failure — gemini-3-flash truncates non-deterministically.
    """
    prompt = _build_batch_prompt(entries)
    expected = [str(e["_rel_path"]) for e in entries]
    last_err: Optional[Exception] = None
    for attempt in range(BATCH_RETRIES + 1):
        try:
            raw = engine.llm_call(prompt, system=CLASSIFY_SYSTEM)
            return _parse_response(raw, expected)
        except ValueError as e:
            last_err = e
            continue
    raise last_err  # re-raise the last failure for the caller's error path


def _split_frontmatter(content: str) -> Optional[tuple[dict, str]]:
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
    return fm, parts[2]


def _write_type(path: Path, new_type: str) -> bool:
    """Write `type:` into the entry's frontmatter, preserving everything else.

    Returns True if the file was modified. Idempotent — same input, same output.
    """
    content = path.read_text(encoding="utf-8")
    parsed = _split_frontmatter(content)
    if parsed is None:
        return False
    fm, body = parsed
    if fm.get("type") == new_type:
        return False
    fm["type"] = new_type
    new_yaml = yaml.safe_dump(
        fm, sort_keys=False, allow_unicode=True, default_flow_style=False,
    )
    path.write_text(f"---\n{new_yaml}---{body}", encoding="utf-8")
    return True


def run_backfill(
    config: Optional[Config] = None,
    *,
    apply: bool = False,
    force: bool = False,
) -> dict:
    config = config or load_config()
    all_entries = collect_entries(config)

    if force:
        targets = all_entries
        skipped_existing = 0
    else:
        targets = [e for e in all_entries if e.get("type") not in MEMORY_TYPES]
        skipped_existing = len(all_entries) - len(targets)

    if not targets:
        print(f"All {len(all_entries)} entries already have a valid type. Nothing to do.")
        return {"total": len(all_entries), "to_classify": 0, "written": 0}

    print(f"Classifying {len(targets)} entries "
          f"({skipped_existing} skipped — already typed). "
          f"Mode: {'APPLY' if apply else 'DRY-RUN'}.")

    engine = get_engine(config)

    results: list[dict] = []
    for batch_start in range(0, len(targets), BATCH_SIZE):
        batch = targets[batch_start:batch_start + BATCH_SIZE]
        print(f"  Batch {batch_start // BATCH_SIZE + 1}/"
              f"{(len(targets) + BATCH_SIZE - 1) // BATCH_SIZE} "
              f"({len(batch)} entries)...", flush=True)
        try:
            batch_results = classify_batch(engine, batch)
        except Exception as e:
            print(f"    ERROR: {e}")
            batch_results = [
                {"path": str(b["_rel_path"]), "type": None, "confidence": 0.0,
                 "reason": f"batch error: {e}"}
                for b in batch
            ]
        results.extend(batch_results)

    type_counts: dict[str, int] = {t: 0 for t in MEMORY_TYPES}
    unclassified = 0
    low_conf: list[dict] = []
    written = 0

    by_path_meta = {str(e["_rel_path"]): e for e in targets}
    for r in results:
        t = r.get("type")
        path_rel = r.get("path")
        if t is None:
            unclassified += 1
            continue
        type_counts[t] += 1
        if r.get("confidence", 0.0) < LOW_CONF_THRESHOLD:
            low_conf.append(r)
        if apply:
            entry = by_path_meta.get(path_rel)
            if entry is None:
                continue
            abs_path = entry["_path"]
            try:
                if _write_type(abs_path, t):
                    written += 1
            except Exception as e:
                print(f"    ERROR writing {path_rel}: {e}")

    print()
    print(f"Summary ({'WROTE' if apply else 'WOULD WRITE'}):")
    for t in MEMORY_TYPES:
        print(f"  {t:10s}: {type_counts[t]:3d}")
    print(f"  {'(unclassified)':10s}: {unclassified:3d}")
    print(f"  Low-confidence (<{LOW_CONF_THRESHOLD}): {len(low_conf)}")
    if apply:
        print(f"  Files written: {written}")
    print()

    if low_conf:
        print("Low-confidence classifications — review these manually:")
        for r in low_conf[:25]:
            print(f"  [{r['type']:9s} @ {r['confidence']:.2f}] {r['path']}")
            print(f"    reason: {r['reason']}")
        if len(low_conf) > 25:
            print(f"  ... and {len(low_conf) - 25} more")

    return {
        "total": len(all_entries),
        "to_classify": len(targets),
        "written": written,
        "type_counts": type_counts,
        "unclassified": unclassified,
        "low_confidence": len(low_conf),
        "results": results,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill type: frontmatter via LLM classification.")
    parser.add_argument("--apply", action="store_true", help="Actually write into frontmatter.")
    parser.add_argument("--force", action="store_true", help="Re-classify entries that already have a valid type.")
    args = parser.parse_args()
    run_backfill(apply=args.apply, force=args.force)
