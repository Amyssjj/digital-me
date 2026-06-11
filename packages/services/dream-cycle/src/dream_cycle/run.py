"""Dream Cycle orchestrator — runs the full pipeline.

Pipeline: brain_learnings -> compile -> index -> citations -> crosslink ->
lint -> drift_check -> consolidate -> reindex -> codex_integration

Invocations::

  python -m dream_cycle.run                            # full cycle
  digital-me-dream-cycle                               # same, via console script
  python -m dream_cycle.run --no-compile               # skip the LLM compile step
  python -m dream_cycle.run --compile-limit-transcript 6
  python -m dream_cycle.run --compile-limit-other 10
  python -m dream_cycle.run --compile-limit 10         # deprecated: applies to both classes
  python -m dream_cycle.run --taste-limit 20
  python -m dream_cycle.run --recent-days 1            # only inbox files mtime'd in last N days
  python -m dream_cycle.run --no-drift-check
  python -m dream_cycle.run --llm                      # enable LLM-powered consolidation
  python -m dream_cycle.run --wiki-root /tmp/wiki      # override DIGITAL_ME_WIKI_ROOT
  python -m dream_cycle.run --config-path /tmp/c.yaml  # override DIGITAL_ME_CONFIG_PATH
"""

import argparse
import sys
import time
from datetime import date
from pathlib import Path
from typing import Optional

from dream_cycle.config import load_config


def run_dream_cycle(
    skip_compile: bool = False,
    use_llm_consolidate: bool = False,
    compile_limit: Optional[int] = None,
    compile_limit_transcript: Optional[int] = None,
    compile_limit_other: Optional[int] = None,
    taste_limit: Optional[int] = None,
    recent_days: Optional[int] = None,
    skip_drift_check: bool = False,
    stage_taste_path: Optional[str] = None,
    stage_compile_path: Optional[str] = None,
    skip_final_steps: bool = False,
    wiki_root: Optional[Path] = None,
    config_path: Optional[Path] = None,
) -> dict:
    """Run the full Dream Cycle pipeline."""
    config = load_config(path=config_path, wiki_root=wiki_root)
    start = time.time()
    today = date.today().isoformat()
    results: dict = {}
    step_timings: list[dict] = []

    def finish_step(name: str, step_start: float) -> None:
        step_timings.append({
            "step": name,
            "duration_s": round(time.time() - step_start, 3),
        })

    print(f"{'='*60}")
    print(f"  Dream Cycle — {today}")
    print(f"  Wiki root: {config.wiki_root}")
    print(f"{'='*60}\n")

    # Step 0: Materialize brain learnings → wiki
    # Runs before compile so materialized entries appear in compile.py's
    # manifest (preventing re-extraction of the same content from transcripts).
    print("[0/6] Materializing brain learnings...")
    step_start = time.time()
    try:
        from dream_cycle.brain_learnings import run_brain_learnings
        results['brain_learnings'] = run_brain_learnings(config)
    except Exception as e:
        print(f"  ERROR in brain_learnings: {e}")
        results['brain_learnings'] = {"error": str(e)}
    finish_step("brain_learnings", step_start)
    print()

    # Step 1: Compile (inbox -> wiki)
    if not skip_compile:
        print("[1/6] Compiling inbox/ -> wiki/...")
        step_start = time.time()
        try:
            from dream_cycle.compile import run_compile
            results['compile'] = run_compile(
                config,
                max_entries=compile_limit,
                max_entries_transcript=compile_limit_transcript,
                max_entries_other=compile_limit_other,
                max_taste_entries=taste_limit,
                recent_days=recent_days,
                stage_taste_path=stage_taste_path,
                stage_compile_path=stage_compile_path,
            )
        except Exception as e:
            print(f"  ERROR in compile: {e}")
            results['compile'] = {"error": str(e)}
        finish_step("compile", step_start)
        print()
    else:
        step_timings.append({"step": "compile", "duration_s": 0.0, "skipped": True})

    # Step 2: Index
    print("[2/6] Generating _INDEX.md and _STATS.md...")
    step_start = time.time()
    try:
        from dream_cycle.index import run_index
        results['index'] = run_index(config)
    except Exception as e:
        print(f"  ERROR in index: {e}")
        results['index'] = {"error": str(e)}
    finish_step("index", step_start)
    print()

    # Step 3: Citations — derive citations/cited_by/last_cited_at from traces
    print("[3/6] Updating citations from traces...")
    step_start = time.time()
    try:
        from dream_cycle.citations import run_citations
        results['citations'] = run_citations(config)
    except Exception as e:
        print(f"  ERROR in citations: {e}")
        results['citations'] = {"error": str(e)}
    finish_step("citations", step_start)
    print()

    # Step 4: Cross-link
    print("[4/6] Cross-linking entries...")
    step_start = time.time()
    try:
        from dream_cycle.crosslink import run_crosslink
        results['crosslink'] = run_crosslink(config)
    except Exception as e:
        print(f"  ERROR in crosslink: {e}")
        results['crosslink'] = {"error": str(e)}
    finish_step("crosslink", step_start)
    print()

    # Step 5: Lint
    print("[5/7] Running health checks...")
    step_start = time.time()
    try:
        from dream_cycle.lint import run_lint
        results['lint'] = run_lint(config)
    except Exception as e:
        print(f"  ERROR in lint: {e}")
        results['lint'] = {"error": str(e)}
    finish_step("lint", step_start)
    print()

    # Step 6: Drift check — LLM audit of high-leverage entries against
    # current code. Mirrors Claude Code's autoDream Phase 2-3 drift
    # instructions (consolidationPrompt.ts:35-51). Bounded scope:
    # priority=always OR citations>=20, cap 25/run. Writes report; flags
    # frontmatter but never auto-rewrites.
    if not skip_drift_check:
        print("[6/7] Drift check (high-leverage entries)...")
        step_start = time.time()
        try:
            from dream_cycle.drift_check import run_drift_check
            results['drift_check'] = run_drift_check(config)
        except Exception as e:
            print(f"  ERROR in drift_check: {e}")
            results['drift_check'] = {"error": str(e)}
        finish_step("drift_check", step_start)
        print()
    else:
        step_timings.append({"step": "drift_check", "duration_s": 0.0, "skipped": True})

    # Steps 7+ (consolidate / reindex / codex_integration) are skipped in
    # split-workflow mode — they run after taste apply in step 3 of the
    # workflow so they see freshly-promoted principles.
    if skip_final_steps:
        print("[7+/...] Skipping consolidate/reindex/codex_integration "
              "(--skip-final-steps). The apply-taste step will run them.")
        step_timings.append({"step": "consolidate", "duration_s": 0.0, "skipped": True})
        step_timings.append({"step": "reindex", "duration_s": 0.0, "skipped": True})
        step_timings.append({"step": "codex_integration", "duration_s": 0.0, "skipped": True})
    else:
        # Step 7: Consolidate
        print("[7/7] Consolidating...")
        step_start = time.time()
        try:
            from dream_cycle.consolidate import run_consolidate
            results['consolidate'] = run_consolidate(config, use_llm=use_llm_consolidate)
        except Exception as e:
            print(f"  ERROR in consolidate: {e}")
            results['consolidate'] = {"error": str(e)}
        finish_step("consolidate", step_start)
        print()

        # Re-index after changes
        print("[+] Re-indexing after consolidation...")
        step_start = time.time()
        try:
            from dream_cycle.index import run_index
            run_index(config)
        except Exception as e:
            print(f"  ERROR in re-index: {e}")
        finish_step("reindex", step_start)

        # Cross-runtime distribution: refresh Codex's standing instructions
        # (~/.codex/CODEX.md) from the freshly-regenerated _INDEX.md so Codex
        # sessions see Active Policies + protocol context at startup. Claude
        # Code reads them via SessionStart hook; OpenClaw via proactive-
        # learning Hook 0c. Codex has no equivalent hook surface — file is
        # the only standing-instructions channel it reads.
        print("[+] Distributing Active Policies to Codex (CODEX.md)...")
        step_start = time.time()
        try:
            from dream_cycle.integrations.codex import run_codex_integration
            results['codex_integration'] = run_codex_integration(config)
        except Exception as e:
            print(f"  ERROR in codex integration: {e}")
            results['codex_integration'] = {"error": str(e)}
        finish_step("codex_integration", step_start)

    elapsed = time.time() - start

    # Write cycle log
    config.logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = config.logs_dir / f"{today}.md"
    log_lines = [
        f"# Dream Cycle — {today}",
        f"> Completed in {elapsed:.1f}s",
        "",
    ]
    for step, data in results.items():
        log_lines.append(f"## {step}")
        if isinstance(data, dict):
            for k, v in data.items():
                log_lines.append(f"- {k}: {v}")
        log_lines.append("")
    log_lines.append("## step_timings")
    for item in step_timings:
        skipped = " (skipped)" if item.get("skipped") else ""
        log_lines.append(f"- {item['step']}: {item['duration_s']:.3f}s{skipped}")
    log_lines.append("")

    log_path.write_text("\n".join(log_lines))

    print(f"{'='*60}")
    print(f"  Dream Cycle complete in {elapsed:.1f}s")
    print(f"  Log: {log_path}")
    print(f"{'='*60}")

    return results


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="digital-me-dream-cycle",
        description="Run the Digital Me dream-cycle knowledge distillation pipeline.",
    )
    parser.add_argument(
        "--wiki-root",
        type=Path,
        default=None,
        help="Wiki root directory (overrides $DIGITAL_ME_WIKI_ROOT; defaults to ~/digital-me).",
    )
    parser.add_argument(
        "--config-path",
        type=Path,
        default=None,
        help="Config YAML path (overrides $DIGITAL_ME_CONFIG_PATH; defaults to <wiki-root>/config.yaml).",
    )
    parser.add_argument("--no-compile", action="store_true", help="Skip the LLM compile step.")
    parser.add_argument("--no-drift-check", action="store_true", help="Skip the LLM drift-check step.")
    parser.add_argument("--llm", action="store_true", help="Enable LLM-powered consolidation.")
    parser.add_argument(
        "--skip-final-steps",
        action="store_true",
        help="Skip consolidate/reindex/codex_integration (split-workflow mode).",
    )
    parser.add_argument("--compile-limit", type=int, default=None, help="(deprecated) cap both transcript + other compile.")
    parser.add_argument("--compile-limit-transcript", type=int, default=None, help="Cap transcript-class compile extractions.")
    parser.add_argument("--compile-limit-other", type=int, default=None, help="Cap non-transcript compile extractions.")
    parser.add_argument("--taste-limit", type=int, default=None, help="Cap taste-extraction LLM calls.")
    parser.add_argument(
        "--recent-days",
        type=int,
        default=None,
        help="Only process inbox files mtime'd in the last N days.",
    )
    parser.add_argument(
        "--stage-taste-path",
        type=str,
        default=None,
        help="Stage taste output at this path instead of writing directly to the wiki.",
    )
    parser.add_argument(
        "--stage-compile-path",
        type=str,
        default=None,
        help="Agent-driven compile: stage one extraction prompt per candidate at "
             "this path (no inline LLM) for a downstream compiler-agent spawn; "
             "apply_compile writes the agent's entries.",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    for flag, value in [
        ("--compile-limit", args.compile_limit),
        ("--compile-limit-transcript", args.compile_limit_transcript),
        ("--compile-limit-other", args.compile_limit_other),
        ("--taste-limit", args.taste_limit),
        ("--recent-days", args.recent_days),
    ]:
        if value is not None and value < 0:
            parser.error(f"{flag} requires a non-negative integer")

    run_dream_cycle(
        skip_compile=args.no_compile,
        use_llm_consolidate=args.llm,
        compile_limit=args.compile_limit,
        compile_limit_transcript=args.compile_limit_transcript,
        compile_limit_other=args.compile_limit_other,
        taste_limit=args.taste_limit,
        recent_days=args.recent_days,
        skip_drift_check=args.no_drift_check,
        stage_taste_path=args.stage_taste_path,
        stage_compile_path=args.stage_compile_path,
        skip_final_steps=args.skip_final_steps,
        wiki_root=args.wiki_root,
        config_path=args.config_path,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
