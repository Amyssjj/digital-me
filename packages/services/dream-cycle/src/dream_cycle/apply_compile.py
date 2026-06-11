"""Apply a compiler-agent's staged wiki entries from a compile staging file.

Agent-driven counterpart to the inline compile path. Step 1
(`dream_cycle.run --stage-compile-path ...`) stages one extraction prompt per
candidate (no inline LLM). Step 2 (the `compile-extract` spawn) fills each
candidate's `entries`. This module (step 3, run inside `dream_cycle.apply`)
parses those entries and writes them to the wiki via the same
`write_compiled_entries` path the inline compiler uses.

Staging file shape (input):
  {
    "wiki_manifest": "...",
    "candidates": [
      {"content_key": str, "source_name": str, "title": str,
       "prompt": str, "entries": [str, ...] | str | null}, ...
    ],
    "deferred_hashes": {content_key: content_hash, ...}
  }

Resilience: if a candidate's `entries` is null (the compiler spawn stalled or
skipped it), classify it inline via the engine using the staged prompt — the
spawn is best-effort, not a hard dependency. Mirrors apply_taste's inline
fallback. Hashes commit only for candidates that processed cleanly; errors
leave the hash uncommitted so the candidate re-stages next night.
"""

from __future__ import annotations

import json
from pathlib import Path

from dream_cycle.compile import (
    COMPILE_PROMPT_SYSTEM,
    _load_compiled_hashes,
    _save_compiled_hashes,
    parse_compile_response,
    write_compiled_entries,
)


def _entry_texts_from_field(field) -> list[str]:
    """Normalize a candidate's `entries` field into a list of entry texts.

    The agent may write a list of entry strings, a single ---SPLIT----joined
    string, or fenced text. Route everything through parse_compile_response so
    the inline and agent paths produce identical entries."""
    if field is None:
        return []
    if isinstance(field, str):
        return parse_compile_response(field)
    if isinstance(field, list):
        return parse_compile_response("\n---SPLIT---\n".join(str(x) for x in field))
    return parse_compile_response(str(field))


def apply_entries(staging_path: Path, config) -> dict:
    """Read the compile staging file, write each candidate's entries, and
    commit the deferred hashes for candidates that processed cleanly."""
    if not staging_path.exists():
        raise SystemExit(f"compile staging file not found: {staging_path}")
    payload = json.loads(staging_path.read_text(encoding="utf-8"))
    candidates = payload.get("candidates") or []
    wiki_manifest = payload.get("wiki_manifest") or ""
    deferred_hashes: dict[str, str] = payload.get("deferred_hashes") or {}

    stats = {
        "candidates": len(candidates),
        "new": 0,
        "updated": 0,
        "noop": 0,
        "skipped_workflow_template": 0,
        "errors": 0,
        "fallback_candidates": 0,
    }
    keys_to_commit: list[str] = []
    engine = None  # lazily created only if an inline fallback is needed

    for i, cand in enumerate(candidates):
        if not isinstance(cand, dict):
            stats["errors"] += 1
            print(f"  [{i+1}/{len(candidates)}] ERROR: candidate is not a dict")
            continue
        ck = cand.get("content_key")
        field = cand.get("entries")
        source_title = cand.get("title", "")
        try:
            if field is None:
                # Inline fallback: the compiler spawn left this candidate
                # unprocessed. Run its staged prompt through the engine.
                if engine is None:
                    from dream_cycle.engine import get_engine
                    engine = get_engine(config)
                prompt = cand.get("prompt") or ""
                if not prompt:
                    raise ValueError("candidate has no entries and no prompt to fall back on")
                response = engine.llm_call(prompt, system=COMPILE_PROMPT_SYSTEM)
                entry_texts = parse_compile_response(response)
                stats["fallback_candidates"] += 1
                print(f"  [{i+1}/{len(candidates)}] INLINE-FALLBACK (spawn left entries null): {source_title[:50]}")
            else:
                entry_texts = _entry_texts_from_field(field)
        except Exception as e:  # noqa: BLE001 — one bad candidate must not abort the batch
            stats["errors"] += 1
            print(f"  [{i+1}/{len(candidates)}] ERROR: {e} — hash NOT committed (will retry)")
            continue

        wstats = write_compiled_entries(
            config, entry_texts, wiki_manifest,
            source_name=cand.get("source_name", ""), source_title=source_title,
        )
        stats["new"] += wstats["new"]
        stats["updated"] += wstats["updated"]
        stats["noop"] += wstats["noop"]
        stats["skipped_workflow_template"] += wstats["skipped_workflow_template"]
        # Candidate processed (wrote entries, or a clean manifest-noop / empty
        # extraction) — safe to commit its hash so it doesn't re-stage.
        if ck:
            keys_to_commit.append(ck)

    if keys_to_commit:
        existing = _load_compiled_hashes(config)
        committed = 0
        for ck in keys_to_commit:
            if ck in deferred_hashes:
                existing[ck] = deferred_hashes[ck]
                committed += 1
        _save_compiled_hashes(config, existing)
        print(f"  Committed {committed} compile hashes to compiled-hashes cache")
    deferred_unused = len(deferred_hashes) - len(keys_to_commit)
    if deferred_unused > 0:
        print(f"  {deferred_unused} deferred compile hashes NOT committed (re-stage next night)")

    return {**stats, "hashes_committed": len(keys_to_commit)}
