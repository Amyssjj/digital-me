"""Combined apply step for the agent-driven dream cycle (workflow step 3).

Runs, in order:
  1. apply_compile  — write the compiler agent's staged wiki entries
  2. apply_taste    — materialize the classifier agent's taste outcomes
  3. final housekeeping (consolidate + reindex + codex integration)

Order matters: compile entries must land BEFORE the reindex in housekeeping
so freshly-written entries get embedded/indexed/crosslinked in the same night.

Both apply_compile and apply_taste commit their own deferred hashes via a
load→merge→save against the shared compiled-hashes cache; running compile
first means taste's load picks up compile's commits (no clobber).

Usage:
  python -m dream_cycle.apply \
    --compile-from /tmp/dream-cycle-compile-staging.json \
    --taste-from   /tmp/dream-cycle-taste-staging.json \
    --wiki-root    ~/digital-me
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from datetime import date
from pathlib import Path
from typing import Optional

from dream_cycle.config import load_config


def _arg(argv: list[str], flag: str) -> Optional[str]:
    for i, a in enumerate(argv):
        if a == flag and i + 1 < len(argv):
            return argv[i + 1]
    return None


def _brain_db_path() -> Path:
    home = os.environ.get("OPENCLAW_HOME") or os.path.expanduser("~/.openclaw")
    return Path(home) / "data" / "brain.db"


def _wanted(obj) -> bool:
    return isinstance(obj, dict) and ("entries" in obj or "outcomes" in obj)


def _extract_json(text: str, _depth: int = 0) -> Optional[dict]:
    """Pull the {entries|outcomes} JSON out of a handoff record.

    The handoff `latest_output` is an ENVELOPE — typically
    `{"deliverableState":"complete","summary":"```json\\n{...}```"}` — where the
    payload we want is nested inside the `summary` string (itself a fenced
    block). So: (1) if the whole text parses to an envelope dict, unwrap its
    `summary` and recurse; (2) else pull a ```json fenced block; (3) else the
    widest {...} span. Return only a dict that actually carries entries/outcomes."""
    if not text or _depth > 3:
        return None
    # 1. Envelope: parse whole text; if it's the payload, done; if it has a
    #    `summary` string, recurse into it.
    try:
        obj = json.loads(text)
        if _wanted(obj):
            return obj
        if isinstance(obj, dict) and isinstance(obj.get("summary"), str):
            inner = _extract_json(obj["summary"], _depth + 1)
            if inner is not None:
                return inner
    except (json.JSONDecodeError, ValueError):
        pass
    # 2. Fenced ```json block.
    m = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.S)
    if m:
        try:
            obj = json.loads(m.group(1).strip())
            if isinstance(obj, dict):
                return obj
        except (json.JSONDecodeError, ValueError):
            pass
    # 3. Widest {...} span.
    first, last = text.find("{"), text.rfind("}")
    if first != -1 and last > first:
        try:
            obj = json.loads(text[first:last + 1])
            if isinstance(obj, dict):
                return obj
        except (json.JSONDecodeError, ValueError):
            pass
    return None


def _read_spawn_handoffs() -> dict:
    """Read the compiler/classifier agents' handoff outputs from the brain.

    Discovery is CONTENT-BASED and goal-scoped, NOT task-name-based: we find the
    most recent task whose latest_output is a real {entries}/{outcomes} handoff,
    take its goal, then collect that same goal's compile ({entries}) and taste
    ({outcomes}) handoffs. Why: matching tasks by a hardcoded name prefix breaks
    the instant a step is relabeled (e.g. routing the spawn through a cli_exec
    alias like claude-code-cli renames the task), silently picking an OLDER
    goal — including stalled runs that produced no handoff — so the night falls
    back to the inline engine and discards the agent's work. Content-based
    discovery is rename-proof and naturally skips handoff-less runs. Best-effort:
    any miss returns {} and the caller falls back to the inline engine path.
    Read-only; WAL-safe."""
    out: dict = {}
    db = _brain_db_path()
    if not db.exists():
        return out
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    except sqlite3.Error:
        return out
    try:
        # Newest-first scan of tasks whose output looks like a handoff. Narrowed
        # by a cheap LIKE so we don't parse every task's latest_output.
        rows = con.execute(
            "SELECT goal_id, latest_output FROM tasks "
            "WHERE latest_output IS NOT NULL AND latest_output != '' "
            "AND (latest_output LIKE '%entries%' OR latest_output LIKE '%outcomes%') "
            "ORDER BY COALESCE(started_at, 0) DESC LIMIT 60",
        ).fetchall()
        # The goal of the newest row carrying a real handoff = the current run.
        goal_id = None
        for gid, lo in rows:
            if _wanted(_extract_json(lo)):
                goal_id = gid
                break
        if not goal_id:
            return out
        # Collect that goal's compile + taste handoffs by payload shape.
        for gid, lo in rows:
            if gid != goal_id:
                continue
            parsed = _extract_json(lo)
            if not isinstance(parsed, dict):
                continue
            if "entries" in parsed and "compile" not in out:
                out["compile"] = parsed
            if "outcomes" in parsed and "taste" not in out:
                out["taste"] = parsed
        out["_goal_id"] = goal_id
    except sqlite3.Error:
        return {}
    finally:
        con.close()
    return out


def _inject_handoffs(compile_from: Optional[str], taste_from: Optional[str]) -> dict:
    """Fold the agents' handoff JSON into the staging files so the existing
    apply_compile/apply_taste logic (write + dedup + hash-commit) runs over
    agent-produced output. Leaves staging untouched on any miss → the staging
    inline-engine fallback then covers that step."""
    info = {"compile_injected": 0, "taste_injected": 0, "goal_id": None}
    handoffs = _read_spawn_handoffs()
    info["goal_id"] = handoffs.get("_goal_id")

    # Compile: {"entries": {"<content_key>": ["entry text", ...]}}
    comp = handoffs.get("compile")
    if compile_from and isinstance(comp, dict) and isinstance(comp.get("entries"), dict):
        try:
            p = Path(compile_from)
            staged = json.loads(p.read_text(encoding="utf-8"))
            by_key = comp["entries"]
            n = 0
            for cand in staged.get("candidates", []):
                ck = cand.get("content_key")
                if ck in by_key and cand.get("entries") is None:
                    val = by_key[ck]
                    cand["entries"] = val if isinstance(val, list) else [str(val)]
                    n += 1
            if n:
                p.write_text(json.dumps(staged, indent=2), encoding="utf-8")
                info["compile_injected"] = n
        except (OSError, json.JSONDecodeError):
            pass

    # Taste: {"outcomes": [ {...}, ... ]}
    taste = handoffs.get("taste")
    if taste_from and isinstance(taste, dict) and isinstance(taste.get("outcomes"), list):
        try:
            p = Path(taste_from)
            staged = json.loads(p.read_text(encoding="utf-8"))
            if staged.get("outcomes") is None:
                staged["outcomes"] = taste["outcomes"]
                p.write_text(json.dumps(staged, indent=2), encoding="utf-8")
                info["taste_injected"] = len(taste["outcomes"])
        except (OSError, json.JSONDecodeError):
            pass

    return info


def main(argv: list[str]) -> int:
    compile_from = _arg(argv, "--compile-from")
    taste_from = _arg(argv, "--taste-from")
    wiki_root = _arg(argv, "--wiki-root")
    if not compile_from and not taste_from:
        raise SystemExit(
            "usage: python -m dream_cycle.apply --compile-from <path> "
            "--taste-from <path> [--wiki-root <root>]"
        )

    config = load_config(wiki_root=Path(wiki_root) if wiki_root else None)
    start = time.time()
    today = date.today().isoformat()

    print(f"{'='*60}")
    print(f"  Apply (compile + taste) — {today}")
    print(f"{'='*60}\n")

    # 0. Fold the spawn agents' handoff output into the staging files. The
    #    agents return via tasks.handoff (no interpreter, no file write — avoids
    #    the exec-approval gate that stalled them). If a handoff is missing,
    #    staging keeps entries/outcomes=null and the apply steps below fall back
    #    to the inline engine for that step.
    inject = _inject_handoffs(compile_from, taste_from)
    print(f"[0/3] Folded agent handoffs (goal={inject.get('goal_id')}): "
          f"compile entries injected={inject['compile_injected']}, "
          f"taste outcomes injected={inject['taste_injected']}\n")

    compile_stats: dict = {}
    taste_stats: dict = {}
    final_stats: dict = {}

    # 1. Compile entries (agent-extracted) — before housekeeping/reindex.
    if compile_from:
        from dream_cycle import apply_compile
        print("[1/3] Applying agent-extracted wiki entries...")
        try:
            compile_stats = apply_compile.apply_entries(Path(compile_from), config)
        except SystemExit as e:
            print(f"  apply_compile skipped: {e}")
            compile_stats = {"skipped": str(e)}
        print(f"  Compile stats: {compile_stats}\n")

    # 2. Taste outcomes (agent-classified, with inline fallback already inside).
    if taste_from:
        from dream_cycle.apply_taste import apply_outcomes
        print("[2/3] Applying taste outcomes...")
        try:
            taste_stats = apply_outcomes(Path(taste_from), config)
        except SystemExit as e:
            print(f"  apply_taste skipped: {e}")
            taste_stats = {"skipped": str(e)}
        print(f"  Taste stats: {taste_stats}\n")

    # 3. Final housekeeping — sees the newly-written compile + taste output.
    from dream_cycle.apply_taste import run_final_housekeeping
    print("[3/3] Final housekeeping (consolidate, reindex, codex_integration)...")
    final_stats = run_final_housekeeping(config)
    print()

    elapsed = time.time() - start

    # Append a combined section to today's dream-cycle log.
    log_path = config.logs_dir / f"{today}.md"
    lines = []
    if log_path.exists():
        lines.append(log_path.read_text(encoding="utf-8"))
    else:
        lines.append(f"# Dream Cycle — {today}\n")
    lines.append("\n## apply_compile\n")
    for k, v in (compile_stats or {}).items():
        lines.append(f"- {k}: {v}\n")
    lines.append("\n## apply_taste\n")
    for k, v in (taste_stats or {}).items():
        lines.append(f"- {k}: {v}\n")
    lines.append(f"- apply_elapsed_s: {round(elapsed, 1)}\n")
    lines.append("\n## apply_final_housekeeping\n")
    for step, data in (final_stats or {}).items():
        lines.append(f"### {step}\n")
        if isinstance(data, dict):
            for k, v in data.items():
                lines.append(f"- {k}: {v}\n")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text("".join(lines), encoding="utf-8")

    print(f"{'='*60}")
    print(f"  Apply complete in {elapsed:.1f}s — log: {log_path}")
    print(f"{'='*60}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
