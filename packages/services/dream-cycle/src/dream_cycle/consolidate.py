"""Consolidation: domain normalization, duplicate detection, conflict detection.

Three passes:
1. Domain normalization (deterministic, always applied)
   - Merges variants like videoproduction/video-production/video_production
2. Duplicate detection (LLM-assisted, flag-only by default)
   - Uses embeddings + LLM review to find semantic duplicates
   - With --apply: merges them, picks higher-citation or newer as canonical
3. Conflict detection (LLM-assisted)
   - Finds entries giving contradictory rules on the same topic
   - Marks older one with superseded_by pointing to newer

Run modes:
  python -m dream_cycle.consolidate                  # domain normalize + detect + flag
  python -m dream_cycle.consolidate --llm            # + LLM-powered dupe/conflict detection
  python -m dream_cycle.consolidate --llm --apply    # + auto-apply merges/supersedes
  python -m dream_cycle.consolidate --overviews      # + regenerate LLM overviews
"""

import re
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Optional

import yaml

from dream_cycle.config import load_config, Config
from dream_cycle.engine import get_engine, Engine
from dream_cycle.index import collect_entries, _first_sentence, _days_ago, _parse_frontmatter


# ---------------------------------------------------------------------------
# Pass 1: Domain Normalization (deterministic)
# ---------------------------------------------------------------------------

def normalize_domain_name(domain: str) -> str:
    """Normalize a domain name to canonical form.

    Rules:
    - Lowercase
    - Replace underscores with hyphens
    - Strip trailing/leading hyphens
    - Collapse 'videoproduction' -> 'video-production' via known aliases
    """
    d = domain.lower().strip()
    d = d.replace('_', '-').replace(' ', '-')
    d = re.sub(r'-+', '-', d).strip('-')

    # Known aliases — expand over time via config
    aliases = {
        'videoproduction': 'video-production',
        'videoprod': 'video-production',
        'video-generation': 'video-production',
        'videogen': 'video-production',
        'media': 'video-production',
        'animation': 'video-production',
        'graphics': 'video-production',
        'visualization': 'video-production',
        'videoprod': 'video-production',
        'agent-communications': 'agents',
        'agent-orchestration': 'agents',
        'agent-architecture': 'agents',
        'inter-agent-comms': 'agents',
        'orchestration': 'agents',
        'ops': 'infrastructure',
        'devops': 'infrastructure',
        'team-health': 'monitoring',
        'incident-response': 'monitoring',
        'system-stability': 'monitoring',
        'system': 'infrastructure',
        'tooling': 'tools',
        'engineering': 'development',
        'software-engineering': 'development',
        'workflow': 'project-management',
        'publishing': 'content',
        'writing': 'content',
        'social-media': 'content',
        'documentation': 'content',
        'reporting': 'content',
        'maintenance': 'infrastructure',
        'scripting': 'tools',
        'security': 'infrastructure',
        'performance': 'infrastructure',
        'memory-management': 'knowledge-management',
        'webapi': 'api',
        'openclaw': 'infrastructure',
    }
    return aliases.get(d, d)


def normalize_domains(config: Config, entries: list[dict]) -> dict:
    """Pass 1: Rewrite domain dirs + frontmatter to canonical names.

    Returns stats: {merged_dirs, moved_files, updated_frontmatter}
    """
    # Plan moves: old_dir -> canonical_dir
    dir_mapping = {}
    for entry in entries:
        old_domain = entry['_domain']
        new_domain = normalize_domain_name(old_domain)
        if old_domain != new_domain:
            dir_mapping[old_domain] = new_domain

    moved = 0
    merged_dirs = set()

    for entry in entries:
        old_domain = entry['_domain']
        canonical = normalize_domain_name(old_domain)

        # Also check all domain tags in frontmatter
        fm_domains = entry.get('domain', [])
        if isinstance(fm_domains, str):
            fm_domains = [fm_domains]
        normalized_fm_domains = list(dict.fromkeys(
            [normalize_domain_name(d) for d in fm_domains if d]
        ))

        needs_move = old_domain != canonical
        needs_fm_update = normalized_fm_domains != fm_domains

        if not needs_move and not needs_fm_update:
            continue

        src = entry['_path']
        if needs_move:
            new_dir = config.wiki_dir / canonical
            new_dir.mkdir(parents=True, exist_ok=True)
            dest = new_dir / src.name
            # Handle name collisions
            counter = 2
            while dest.exists():
                dest = new_dir / f"{src.stem}-{counter}{src.suffix}"
                counter += 1
            src.rename(dest)
            entry['_path'] = dest
            entry['_domain'] = canonical
            entry['_rel_path'] = dest.relative_to(config.wiki_dir)
            moved += 1
            merged_dirs.add(canonical)

        # Update frontmatter domain field
        if needs_fm_update:
            _update_frontmatter_field(entry['_path'], 'domain', normalized_fm_domains)
            entry['domain'] = normalized_fm_domains

    # Clean up empty old directories
    for old_dir_name in dir_mapping.keys():
        old_dir = config.wiki_dir / old_dir_name
        if old_dir.exists() and old_dir.is_dir():
            try:
                # Only remove if truly empty (no files, no subdirs)
                if not any(old_dir.iterdir()):
                    old_dir.rmdir()
            except OSError:
                pass
            # If only contains _OVERVIEW.md (stale), remove it too
            remaining = list(old_dir.iterdir()) if old_dir.exists() else []
            if len(remaining) == 1 and remaining[0].name == '_OVERVIEW.md':
                remaining[0].unlink()
                try:
                    old_dir.rmdir()
                except OSError:
                    pass

    return {
        "moved_files": moved,
        "merged_dirs": len(merged_dirs),
        "dir_mapping": dir_mapping,
    }


def _update_frontmatter_field(path: Path, field: str, value) -> None:
    """Update a single field in a wiki entry's frontmatter.

    Bumps `updated:` to today as a side-effect — this function is only
    called from semantic-change paths (domain rename via
    merge_domain_directories, supersession marking via dedupe pass).
    Without the bump, the dashboard's per-day knowledge & taste flow
    chart would silently miss these rewrites (the consumer trusts
    frontmatter dates after the 2026-05-28 intake-side cleanup).

    Idempotent on `updated:` — same-day re-runs just rewrite the same
    date. If callers ever need a write that explicitly should NOT bump
    `updated:` (e.g. a purely-derived-field update like crosslink's
    related list), copy this writer's body and skip the `updated:`
    line; better to be explicit at the call site than to silently
    diverge from the schema.
    """
    content = path.read_text()
    if not content.startswith('---'):
        return
    parts = content.split('---', 2)
    if len(parts) < 3:
        return
    try:
        fm = yaml.safe_load(parts[1]) or {}
    except Exception:
        return
    fm[field] = value
    fm['updated'] = date.today().isoformat()
    new_fm = yaml.dump(fm, default_flow_style=False, allow_unicode=True, sort_keys=False)
    path.write_text(f"---\n{new_fm}---\n{parts[2]}")


# ---------------------------------------------------------------------------
# Pass 2: Duplicate Detection (LLM-assisted)
# ---------------------------------------------------------------------------

def find_title_duplicates(entries: list[dict], threshold: float = 0.7) -> list[tuple]:
    """Fast pre-filter: find entries with similar titles (Jaccard)."""
    candidates = []
    seen = set()

    for i, a in enumerate(entries):
        for j, b in enumerate(entries):
            if j <= i:
                continue
            key = (str(a['_rel_path']), str(b['_rel_path']))
            if key in seen:
                continue

            words_a = set(a.get('title', '').lower().split())
            words_b = set(b.get('title', '').lower().split())
            if not words_a or not words_b:
                continue

            intersection = len(words_a & words_b)
            union = len(words_a | words_b)
            similarity = intersection / union if union > 0 else 0

            if similarity >= threshold:
                candidates.append((a, b, similarity))
                seen.add(key)

    return candidates


def find_semantic_duplicates(
    engine: Engine,
    entries: list[dict],
    threshold: float = 0.85,
) -> list[tuple]:
    """Use embeddings to find semantically similar entries across domains."""
    import math

    # Build text to embed: title + Rule section
    texts = []
    for e in entries:
        title = e.get('title', '')
        body = e.get('_body', '')
        rule_match = re.search(r'## Rule\s*\n(.+?)(?=\n## |\Z)', body, re.DOTALL)
        rule = rule_match.group(1).strip()[:500] if rule_match else body[:500]
        texts.append(f"{title}\n{rule}")

    # Embed in batches of 50
    embeddings = []
    batch_size = 50
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        try:
            embs = engine.embed_batch(batch)
            embeddings.extend(embs)
        except Exception as e:
            print(f"    WARN: embed batch failed at {i}: {e}")
            # Pad with zeros so indices align
            embeddings.extend([[0.0] * 768] * len(batch))

    def cosine(a, b):
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(x * x for x in b))
        if na == 0 or nb == 0:
            return 0.0
        return dot / (na * nb)

    candidates = []
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            sim = cosine(embeddings[i], embeddings[j])
            if sim >= threshold:
                candidates.append((entries[i], entries[j], sim))

    return candidates


def classify_pair_llm(engine: Engine, a: dict, b: dict) -> dict:
    """Use LLM to classify a candidate pair: duplicate, conflict, or unrelated."""
    prompt = f"""Compare these two wiki entries and classify their relationship.

## Entry A
Title: {a.get('title')}
Path: {a['_rel_path']}
Updated: {a.get('updated')}
Body:
{a.get('_body', '')[:800]}

## Entry B
Title: {b.get('title')}
Path: {b['_rel_path']}
Updated: {b.get('updated')}
Body:
{b.get('_body', '')[:800]}

Classify as ONE of:
- "duplicate": Same knowledge, different wording. Should be merged.
- "conflict": Give contradictory advice on the same topic. Newer supersedes older.
- "related": About the same area but complement each other. Keep both, cross-link.
- "unrelated": Different topics, false match.

Return ONLY valid JSON in this exact format:
{{
  "classification": "duplicate" | "conflict" | "related" | "unrelated",
  "reason": "<one sentence>",
  "canonical_path": "<path of the entry to keep, or null if merging needed>",
  "merged_title": "<suggested merged title, or null>"
}}"""

    response = engine.llm_call(prompt)
    # Strip code fences
    response = re.sub(r'^```(?:json)?\s*\n?', '', response.strip())
    response = re.sub(r'\n?```\s*$', '', response).strip()
    try:
        import json
        return json.loads(response)
    except Exception:
        return {"classification": "unrelated", "reason": "parse_error", "canonical_path": None, "merged_title": None}


# When citation gap exceeds this ratio, citations override the date-based
# "newer wins" rule. Real signal from 2026-05-11: agents/share-openclaw-brain-
# mcp-across-clis.md (citations=115) was being archived in favor of a 26-
# citation duplicate that happened to be newer by a few days. Citation count
# is a stronger utility signal than updated-date at this magnitude.
CITATION_OVERRIDE_RATIO = 3


# `priority: always` entries are Active Policies — load-bearing for every
# agent. Treat them as winners regardless of date/citation tiebreakers; a
# duplicate without this flag is the one to archive, even if newer.
def _is_active_policy(e: dict) -> bool:
    return e.get('priority') == 'always'


def _newer_entry(a: dict, b: dict) -> dict:
    """Return the canonical entry for a duplicate pair.

    Resolution order:
      1. `priority: always` (Active Policy) wins outright.
      2. Citation count, if the gap exceeds CITATION_OVERRIDE_RATIO.
      3. Otherwise: later `updated` date; citation count as a tiebreaker.
    """
    a_policy = _is_active_policy(a)
    b_policy = _is_active_policy(b)
    if a_policy and not b_policy:
        return a
    if b_policy and not a_policy:
        return b

    a_cit = a.get('citations', 0) or 0
    b_cit = b.get('citations', 0) or 0
    if a_cit > 0 and b_cit > 0:
        if a_cit >= CITATION_OVERRIDE_RATIO * b_cit:
            return a
        if b_cit >= CITATION_OVERRIDE_RATIO * a_cit:
            return b

    def sort_key(e):
        updated = e.get('updated') or e.get('created') or '0000-00-00'
        citations = e.get('citations', 0) or 0
        return (str(updated), citations)
    return a if sort_key(a) >= sort_key(b) else b


def apply_supersedes(newer: dict, older: dict) -> None:
    """Mark older entry as superseded by newer."""
    _update_frontmatter_field(
        older['_path'],
        'superseded_by',
        str(newer['_rel_path']),
    )

    # Add supersedes list to newer
    existing = newer.get('supersedes', [])
    if isinstance(existing, str):
        existing = [existing]
    existing = list(existing) if existing else []
    if str(older['_rel_path']) not in existing:
        existing.append(str(older['_rel_path']))
    _update_frontmatter_field(newer['_path'], 'supersedes', existing)


def archive_entry(config: Config, entry: dict) -> Optional[Path]:
    """Move an entry to archive/."""
    src = entry['_path']
    if not src.exists():
        return None

    config.archive_dir.mkdir(parents=True, exist_ok=True)
    # Preserve domain in archive path
    domain = entry.get('_domain', 'misc')
    dest_dir = config.archive_dir / domain
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    counter = 2
    while dest.exists():
        dest = dest_dir / f"{src.stem}-{counter}{src.suffix}"
        counter += 1
    src.rename(dest)
    return dest


# ---------------------------------------------------------------------------
# Pass 3: Domain Overviews (LLM)
# ---------------------------------------------------------------------------

def generate_domain_overview_llm(
    engine: Engine,
    domain: str,
    entries: list[dict],
) -> str:
    """Use LLM to generate a rich domain overview."""
    entry_summaries = []
    for e in entries:
        title = e.get('title', 'Untitled')
        body_preview = e.get('_body', '')[:300]
        entry_summaries.append(f"### {title}\n{body_preview}")

    entries_text = "\n\n".join(entry_summaries)

    prompt = f"""Generate a domain overview for the "{domain}" knowledge domain.

There are {len(entries)} entries in this domain:

{entries_text}

Write a concise overview that:
1. Summarizes what this domain covers (1-2 sentences)
2. Lists the key rules/decisions in bullet points
3. Notes any patterns or themes across entries
4. Lists all entries with one-line summaries at the bottom

Format as markdown. Start with # {domain.replace('-', ' ').title()} Overview."""

    return engine.llm_call(prompt)


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def run_consolidate(
    config: Optional[Config] = None,
    use_llm: bool = False,
    apply_merges: bool = False,
    regenerate_overviews: bool = False,
) -> dict:
    """Run consolidation pipeline."""
    config = config or load_config()
    entries = collect_entries(config)

    print(f"Consolidating {len(entries)} entries...")
    log_lines = [
        f"# Consolidation Report — {date.today().isoformat()}",
        "",
    ]

    # -- Pass 1: Domain normalization (always runs, deterministic) ---------
    print("\n[1/3] Normalizing domains...")
    norm_stats = normalize_domains(config, entries)
    print(f"  Moved {norm_stats['moved_files']} files, merged {norm_stats['merged_dirs']} dirs")
    if norm_stats['dir_mapping']:
        print("  Aliases applied:")
        for old, new in norm_stats['dir_mapping'].items():
            print(f"    {old} -> {new}")
    log_lines.append("## Pass 1: Domain Normalization")
    log_lines.append(f"- Files moved: {norm_stats['moved_files']}")
    log_lines.append(f"- Directory aliases applied:")
    for old, new in norm_stats['dir_mapping'].items():
        log_lines.append(f"  - `{old}` -> `{new}`")
    log_lines.append("")

    # Re-collect after moves
    if norm_stats['moved_files'] > 0:
        entries = collect_entries(config)

    # -- Pass 2: Duplicate + conflict detection ----------------------------
    print("\n[2/3] Detecting duplicates and conflicts...")

    # Fast title-based pre-filter
    title_candidates = find_title_duplicates(entries, threshold=0.7)
    print(f"  Title similarity: {len(title_candidates)} candidate pairs")

    # Semantic candidates (only if --llm)
    semantic_candidates = []
    if use_llm:
        engine = get_engine(config)
        print("  Computing embeddings for semantic similarity...")
        try:
            semantic_candidates = find_semantic_duplicates(engine, entries, threshold=0.85)
            print(f"  Semantic similarity: {len(semantic_candidates)} candidate pairs")
        except Exception as e:
            print(f"  WARN: semantic similarity failed: {e}")

    # Combine + dedupe
    all_candidates = {}
    for a, b, sim in title_candidates + semantic_candidates:
        key = tuple(sorted([str(a['_rel_path']), str(b['_rel_path'])]))
        if key not in all_candidates or sim > all_candidates[key][2]:
            all_candidates[key] = (a, b, sim)

    # Classify each candidate via LLM (only if --llm)
    duplicates = []
    conflicts = []
    related_pairs = []

    if use_llm and all_candidates:
        engine = get_engine(config) if 'engine' not in dir() else engine
        print(f"  Classifying {len(all_candidates)} pairs via LLM...")
        for i, (key, (a, b, sim)) in enumerate(all_candidates.items()):
            print(f"    [{i+1}/{len(all_candidates)}] {a.get('title')[:50]} vs {b.get('title')[:50]}")
            try:
                result = classify_pair_llm(engine, a, b)
                cls = result.get('classification', 'unrelated')
                if cls == 'duplicate':
                    duplicates.append((a, b, sim, result))
                elif cls == 'conflict':
                    conflicts.append((a, b, sim, result))
                elif cls == 'related':
                    related_pairs.append((a, b, sim, result))
            except Exception as e:
                print(f"      ERROR: {e}")
    else:
        # Without --llm, just flag high-similarity title matches
        for key, (a, b, sim) in all_candidates.items():
            if sim >= 0.8:
                duplicates.append((a, b, sim, {"classification": "duplicate", "reason": "high title similarity"}))

    log_lines.append("## Pass 2: Duplicate & Conflict Detection")
    log_lines.append(f"- Title candidates: {len(title_candidates)}")
    log_lines.append(f"- Semantic candidates: {len(semantic_candidates)}")
    log_lines.append(f"- Classified duplicates: {len(duplicates)}")
    log_lines.append(f"- Classified conflicts: {len(conflicts)}")
    log_lines.append(f"- Related (keep both): {len(related_pairs)}")
    log_lines.append("")

    # -- Apply merges and supersedes ---------------------------------------
    merged = 0
    superseded = 0

    # Cycle protection: when N entries duplicate each other transitively
    # (e.g., A↔B, B↔C, A↔C), processing in pair-order can apply later pairs
    # against an already-archived entry. Track archived paths and skip any
    # subsequent pair that references one. The first pair to fire establishes
    # the canonical; later pairs get deferred and logged.
    archived_paths: set[str] = set()
    skipped_cyclic: list[tuple] = []

    if duplicates:
        log_lines.append("### Duplicates")
        for a, b, sim, result in duplicates:
            newer = _newer_entry(a, b)
            older = b if newer is a else a
            a_rel = str(a['_rel_path'])
            b_rel = str(b['_rel_path'])
            newer_rel = str(newer['_rel_path'])
            older_rel = str(older['_rel_path'])

            log_lines.append(f"- [{sim:.0%}] **{a.get('title')}** ↔ **{b.get('title')}**")
            log_lines.append(f"  - Reason: {result.get('reason', '')}")

            # Skip if either entry already lost a prior pair (cycle).
            if apply_merges and (a_rel in archived_paths or b_rel in archived_paths):
                skipped_cyclic.append((a, b, sim))
                log_lines.append(f"  - **SKIPPED (cyclic)**: one entry already archived by an earlier pair this run.")
                continue

            log_lines.append(f"  - Keep: `{newer_rel}` (priority/citations/date)")
            log_lines.append(f"  - {'Archived' if apply_merges else 'Would archive'}: `{older_rel}`")

            if apply_merges:
                apply_supersedes(newer, older)
                dest = archive_entry(config, older)
                if dest:
                    merged += 1
                    archived_paths.add(older_rel)

        log_lines.append("")

        if skipped_cyclic:
            log_lines.append(f"### Skipped (cycles) — {len(skipped_cyclic)}")
            log_lines.append(
                "> These pairs reference an entry already archived by an earlier pair. "
                "Likely a transitive duplicate cluster — review manually if the kept canonical seems wrong."
            )
            for a, b, sim in skipped_cyclic:
                log_lines.append(f"- [{sim:.0%}] {a.get('title')[:50]} ↔ {b.get('title')[:50]}")
            log_lines.append("")

    if conflicts:
        log_lines.append("### Conflicts (contradictory rules)")
        for a, b, sim, result in conflicts:
            newer = _newer_entry(a, b)
            older = b if newer is a else a
            log_lines.append(f"- [{sim:.0%}] **{a.get('title')}** ↔ **{b.get('title')}**")
            log_lines.append(f"  - Reason: {result.get('reason', '')}")
            log_lines.append(f"  - Authoritative (newer): `{newer['_rel_path']}` (updated: {newer.get('updated')})")
            log_lines.append(f"  - Older: `{older['_rel_path']}` (updated: {older.get('updated')})")
            log_lines.append(f"  - {'Marked superseded_by' if apply_merges else 'Would mark superseded_by'}")

            if apply_merges:
                apply_supersedes(newer, older)
                superseded += 1

        log_lines.append("")

    if related_pairs:
        log_lines.append("### Related (cross-linked, both kept)")
        for a, b, sim, result in related_pairs:
            log_lines.append(f"- [{sim:.0%}] {a.get('title')} ↔ {b.get('title')} — {result.get('reason', '')}")
        log_lines.append("")

    # -- Pass 3: Domain overviews (only if --overviews) --------------------
    overviews = 0
    if regenerate_overviews and use_llm:
        print("\n[3/3] Regenerating domain overviews...")
        engine = get_engine(config)
        # Re-collect after changes
        entries = collect_entries(config)
        by_domain = defaultdict(list)
        for e in entries:
            by_domain[e['_domain']].append(e)

        for domain, domain_entries in by_domain.items():
            if domain == "root" or len(domain_entries) < 2:
                continue
            print(f"  {domain}/ ({len(domain_entries)} entries)")
            try:
                overview = generate_domain_overview_llm(engine, domain, domain_entries)
                overview_path = config.wiki_dir / domain / "_OVERVIEW.md"
                overview_path.write_text(overview)
                overviews += 1
            except Exception as e:
                print(f"    ERROR: {e}")

        log_lines.append("## Pass 3: Domain Overviews")
        log_lines.append(f"- Regenerated: {overviews}")

    # Write log
    config.logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = config.logs_dir / f"consolidate-{date.today().isoformat()}.md"
    log_path.write_text("\n".join(log_lines))

    print(f"\nDone: {norm_stats['moved_files']} files moved, "
          f"{len(duplicates)} duplicates, {len(conflicts)} conflicts, "
          f"{merged} merged, {superseded} superseded, {overviews} overviews")
    print(f"Report: {log_path}")

    return {
        "entries": len(entries),
        "files_moved": norm_stats['moved_files'],
        "duplicates": len(duplicates),
        "conflicts": len(conflicts),
        "related_pairs": len(related_pairs),
        "merged": merged,
        "superseded": superseded,
        "overviews": overviews,
    }


if __name__ == "__main__":
    use_llm = "--llm" in sys.argv
    apply_merges = "--apply" in sys.argv
    regenerate_overviews = "--overviews" in sys.argv
    run_consolidate(
        use_llm=use_llm,
        apply_merges=apply_merges,
        regenerate_overviews=regenerate_overviews,
    )
