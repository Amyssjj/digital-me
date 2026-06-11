"""Apply COO-produced taste outcomes from a staging file, then run the
final dream-cycle housekeeping steps (consolidate, reindex, codex_integration).

Step 3 of the split dream cycle workflow. The staging file is produced by
step 1 (`dream_cycle.run --stage-taste-path ... --skip-final-steps`) and
filled in by step 2 (COO spawn).

Staging file shape (input):
  {
    "principles_manifest": "...",
    "valid_domains": ["infra", "knowledge", "storytelling", "design"],
    "transcripts": [{title, source_file, body, user_turns, ...}, ...],
    "outcomes": [
      {
        "transcript_index": int,
        "outcome": "candidate" | "evidence" | "neither",
        "domain": str,
        "principle_fingerprint": str | null,
        "matched_existing_fingerprint": str | null,
        "evidence_record": {project_id, date, wiki_paths, what_happened, what_triggers_principle},
        "fire_signature_hints": [str, ...],
        "rubric_item_candidates": [str, ...],
        "near_miss_observed": str | null,
        "rationale": str
      },
      ...
    ]
  }

Usage:
  python -m dream_cycle.apply_taste --from /tmp/dream-cycle-taste-staging.json
"""

from __future__ import annotations

import json
import sys
import time
from datetime import date
from pathlib import Path

from dream_cycle.config import load_config
from dream_cycle.compile import apply_skill_outcome, _load_compiled_hashes, _save_compiled_hashes


def _generate_outcomes_inline(payload: dict, config) -> list[dict]:
    """Classify staged transcripts inline when the classifier spawn didn't
    deliver outcomes. Reuses the same reverse-engineer engine the inline
    compile path uses, so the output conforms to the outcome contract."""
    from dream_cycle.compile import extract_skill_update
    from dream_cycle.engine import get_engine

    engine = get_engine(config)
    manifest = payload.get("principles_manifest") or ""
    transcripts = payload.get("transcripts") or []
    outcomes: list[dict] = []
    for idx, entry in enumerate(transcripts):
        try:
            outcome = extract_skill_update(engine, entry, manifest)
        except Exception as e:  # noqa: BLE001 — one bad transcript must not abort the batch
            print(f"  [inline {idx + 1}/{len(transcripts)}] ERROR: {e}")
            continue
        if not outcome:
            continue
        outcome.setdefault("transcript_index", idx)
        outcomes.append(outcome)
    print(
        f"  inline fallback produced {len(outcomes)} outcomes "
        f"from {len(transcripts)} staged transcripts"
    )
    return outcomes


def apply_outcomes(staging_path: Path, config) -> dict:
    """Read outcomes from staging file and apply each via apply_skill_outcome.

    Also commits deferred hashes (set by step 1's staged compile) for any
    transcript whose outcome was successfully applied OR was "neither" (still
    a valid processing result). Parse/apply errors leave the hash uncommitted,
    so the transcript re-enters next night's stage.
    """
    if not staging_path.exists():
        raise SystemExit(f"staging file not found: {staging_path}")
    payload = json.loads(staging_path.read_text(encoding="utf-8"))
    outcomes = payload.get("outcomes")
    if outcomes is None:
        # Deterministic fallback: the classifier spawn (step 2) is best-effort
        # polish, not a hard dependency. If it stalled (watchdog kill) or never
        # wrote outcomes, classify the staged transcripts inline here with the
        # same reverse-engineer engine, so one stalled agent no longer drops the
        # whole night's taste distillation. Mirrors the daily-digest fallback.
        print(
            "[apply_taste] staging.outcomes is null (classifier step "
            "skipped/stalled) — generating outcomes inline as fallback"
        )
        outcomes = _generate_outcomes_inline(payload, config)
    if not isinstance(outcomes, list):
        raise SystemExit(f"staging.outcomes must be a list, got {type(outcomes)}")

    transcripts = payload.get("transcripts") or []
    deferred_hashes: dict[str, str] = payload.get("deferred_hashes") or {}

    stats = {
        "candidate-new": 0,
        "candidate-merged": 0,
        "evidence-appended": 0,
        "promoted-to-leaf": 0,
        "neither": 0,
        "errors": 0,
    }
    skill_files: list[str] = []
    # content_keys whose hash we WILL commit (successful or "neither" outcomes).
    keys_to_commit: list[str] = []

    def _key_for(outcome: dict, idx: int) -> str | None:
        """Look up the transcript's content_key from its index."""
        ti = outcome.get("transcript_index")
        if not isinstance(ti, int) or ti < 0 or ti >= len(transcripts):
            # Fall back to using the outcome's own index in the outcomes list,
            # in case COO numbered them implicitly.
            ti = idx
        if 0 <= ti < len(transcripts):
            return transcripts[ti].get("content_key")
        return None

    for i, outcome in enumerate(outcomes):
        if not isinstance(outcome, dict):
            stats["errors"] += 1
            print(f"  [{i+1}/{len(outcomes)}] ERROR: outcome is not a dict — hash NOT committed (will retry)")
            continue
        kind = outcome.get("outcome", "?")
        ck = _key_for(outcome, i)
        if kind == "neither":
            stats["neither"] += 1
            if ck:
                keys_to_commit.append(ck)
            print(f"  [{i+1}/{len(outcomes)}] NEITHER — "
                  f"{(outcome.get('rationale') or '')[:80]}")
            continue
        try:
            applied = apply_skill_outcome(outcome)
        except Exception as e:
            stats["errors"] += 1
            print(f"  [{i+1}/{len(outcomes)}] ERROR applying outcome: {e} — hash NOT committed (will retry)")
            continue
        if applied:
            path, action = applied
            stats[action] = stats.get(action, 0) + 1
            skill_files.append(str(path))
            if ck:
                keys_to_commit.append(ck)
            rel = path.relative_to(Path.home()) if Path.home() in path.parents else path
            print(f"  [{i+1}/{len(outcomes)}] {action.upper()} → {rel}")
        else:
            stats["errors"] += 1
            print(f"  [{i+1}/{len(outcomes)}] apply_skill_outcome returned None — hash NOT committed (will retry)")

    # Commit hashes for processed transcripts only. Load → merge → save so we
    # don't clobber any hashes that landed via other compile runs.
    if keys_to_commit:
        existing = _load_compiled_hashes(config)
        committed = 0
        for ck in keys_to_commit:
            if ck in deferred_hashes:
                existing[ck] = deferred_hashes[ck]
                committed += 1
        _save_compiled_hashes(config, existing)
        print(f"  Committed {committed} hashes to compiled-hashes cache")
    deferred_unused = len(deferred_hashes) - len(keys_to_commit)
    if deferred_unused > 0:
        print(f"  {deferred_unused} deferred hashes NOT committed (those transcripts re-enter next stage)")

    return {
        **stats,
        "skill_files": skill_files,
        "hashes_committed": len(keys_to_commit),
        "hashes_deferred_unused": deferred_unused,
    }


def run_final_housekeeping(config) -> dict:
    """Run consolidate + reindex + codex_integration after taste outcomes apply.

    These steps see freshly-promoted principles + any newly-evidenced leaves.
    """
    out: dict = {}
    print("[+] Consolidating...")
    try:
        from dream_cycle.consolidate import run_consolidate
        out["consolidate"] = run_consolidate(config, use_llm=False)
    except Exception as e:
        print(f"  ERROR in consolidate: {e}")
        out["consolidate"] = {"error": str(e)}

    print("[+] Re-indexing after consolidation...")
    try:
        from dream_cycle.index import run_index
        run_index(config)
        out["reindex"] = {"ok": True}
    except Exception as e:
        print(f"  ERROR in re-index: {e}")
        out["reindex"] = {"error": str(e)}

    print("[+] Distributing Active Policies to Codex (CODEX.md)...")
    try:
        from dream_cycle.integrations.codex import run_codex_integration
        out["codex_integration"] = run_codex_integration(config)
    except Exception as e:
        print(f"  ERROR in codex integration: {e}")
        out["codex_integration"] = {"error": str(e)}

    return out


def main(argv: list[str]) -> int:
    staging_path: Path | None = None
    for i, arg in enumerate(argv):
        if arg == "--from" and i + 1 < len(argv):
            staging_path = Path(argv[i + 1])
            break
    if staging_path is None:
        raise SystemExit("usage: python -m dream_cycle.apply_taste --from <staging.json>")

    config = load_config()
    start = time.time()
    today = date.today().isoformat()

    print(f"{'='*60}")
    print(f"  Apply Taste — {today}")
    print(f"  Reading: {staging_path}")
    print(f"{'='*60}\n")

    print("[1/2] Applying COO-produced outcomes...")
    apply_stats = apply_outcomes(staging_path, config)
    print(f"  Stats: {apply_stats}\n")

    print("[2/2] Final housekeeping (consolidate, reindex, codex_integration)...")
    final_stats = run_final_housekeeping(config)
    print()

    elapsed = time.time() - start

    # Append to the existing dream-cycle log for today (or create one).
    log_path = config.logs_dir / f"{today}.md"
    log_lines = []
    if log_path.exists():
        log_lines.append(log_path.read_text(encoding="utf-8"))
    else:
        log_lines.append(f"# Dream Cycle — {today}\n")

    log_lines.append(f"\n## apply_taste\n")
    for k, v in apply_stats.items():
        log_lines.append(f"- {k}: {v}\n")
    log_lines.append(f"- apply_elapsed_s: {round(elapsed, 1)}\n")
    log_lines.append("\n## apply_taste_final_housekeeping\n")
    for step, data in final_stats.items():
        log_lines.append(f"### {step}\n")
        if isinstance(data, dict):
            for k, v in data.items():
                log_lines.append(f"- {k}: {v}\n")

    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text("".join(log_lines), encoding="utf-8")

    print(f"{'='*60}")
    print(f"  Apply Taste complete in {elapsed:.1f}s")
    print(f"  Log: {log_path}")
    print(f"{'='*60}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
