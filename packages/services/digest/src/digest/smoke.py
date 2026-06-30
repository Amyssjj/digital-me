"""Post-update / post-install smoke gate for the daily digest.

The recurring digest outage was structural: an openclaw update (or any
re-materialize of the worker/overlay layer) silently desynced the
summarizer→publisher contract, and nobody noticed until the 7am cron failed
closed. This smoke gate moves that detection EARLIER — it runs at update/install
time and fails loudly if the digest can no longer produce a postable artifact.

It is deliberately HERMETIC: no brain, no LLM, no chat transport, no network.
It asserts the invariants whose violation caused real outages:

  1. The installed package imports and ships its schema file (catches a wheel
     that dropped presentation.schema.json).
  2. The in-code validator still agrees with that schema (catches drift between
     the prompt's declared contract and what the publisher enforces).
  3. The fail-open floor (`_minimal_presentation`) satisfies the schema and
     renders visible text — so a missing/garbage handoff still yields a digest.
  4. The publisher still accepts a `content`-keyed summarizer block — the exact
     shape that caused the 2026-06-28 "no visible text blocks" outage.

A best-effort live check (5) also confirms the registered workflow still
dispatches this package, when the brain DB is readable.

Exit 0 = the digest can still publish. Non-zero = a regression caught here
instead of at 7am.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from typing import Optional


def _check_contract() -> list[str]:
    """Hermetic invariant checks (1–4). Returns a list of failure messages."""
    failures: list[str] = []

    from digest import daily_digest as dd

    # 1. package ships its schema file
    schema_path = Path(dd.__file__).parent / "presentation.schema.json"
    if not schema_path.exists():
        failures.append(
            "presentation.schema.json missing from the installed package "
            "(wheel/packaging regression)"
        )
        # Without the schema we can't run check 2, but 3 + 4 still apply.
        schema = None
    else:
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            failures.append(f"presentation.schema.json unreadable/invalid: {e}")
            schema = None

    # 2. validator agrees with the schema file (no prompt↔validator drift)
    if schema is not None:
        try:
            schema_tones = set(schema["properties"]["tone"]["enum"])
            schema_types = set(
                schema["properties"]["blocks"]["items"]["properties"]["type"]["enum"]
            )
            if dd._VALID_TONES != schema_tones:
                failures.append(
                    f"validator tones {dd._VALID_TONES} drifted from schema {schema_tones}"
                )
            if dd._VALID_BLOCK_TYPES != schema_types:
                failures.append(
                    f"validator block types {dd._VALID_BLOCK_TYPES} drifted from "
                    f"schema {schema_types}"
                )
        except (KeyError, TypeError) as e:
            failures.append(f"schema shape unexpected (cannot compare to validator): {e}")

    # 3. fail-open floor is schema-valid AND renders visible text
    floor = dd._minimal_presentation("2026-01-01")
    floor_errors = dd.validate_presentation(floor)
    if floor_errors:
        failures.append(f"fail-open floor violates the schema: {floor_errors}")
    floor_norm = dd._normalize_presentation(floor)
    if not _has_visible_text(dd, floor_norm):
        failures.append("fail-open floor produces no visible text after normalize")

    # 4. the 2026-06-28 outage shape: a `content`-keyed block must survive
    content_block = {
        "title": "smoke",
        "tone": "info",
        "blocks": [{"type": "text", "content": "digest smoke probe"}],
    }
    content_norm = dd._normalize_presentation(content_block)
    if "digest smoke probe" not in _joined_text(dd, content_norm):
        failures.append(
            "publisher no longer accepts `content`-keyed summarizer blocks "
            "(the 2026-06-28 'no visible text blocks' outage shape)"
        )

    return failures


def _has_visible_text(dd, presentation: dict) -> bool:
    return any(
        dd._block_text(b).strip()
        for b in presentation.get("blocks") or []
        if isinstance(b, dict) and b.get("type") == "text"
    )


def _joined_text(dd, presentation: dict) -> str:
    return " ".join(
        dd._block_text(b) for b in presentation.get("blocks") or [] if isinstance(b, dict)
    )


def _check_live_dispatch() -> Optional[str]:
    """Best-effort (5): confirm the registered workflow still dispatches THIS
    package. Returns a warning string, or None when OK/unknown. Never fails the
    gate on its own — the brain may legitimately be absent at update time."""
    from digest import daily_digest as dd

    brain_db = dd.BRAIN_DB
    if not brain_db.exists():
        return None  # no brain to check against — not a regression
    try:
        con = sqlite3.connect(f"file:{brain_db}?mode=ro", uri=True)
        try:
            rows = con.execute(
                "SELECT dispatch FROM workflow_step_templates "
                "WHERE workflow_id='daily-activity-digest' AND step_key='publish'"
            ).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return None  # unreadable (locked/old schema) — don't fail the gate
    if not rows:
        return "no 'daily-activity-digest' workflow registered in the brain"
    if "digest.daily_digest" not in (rows[0][0] or ""):
        return (
            "registered digest workflow does NOT dispatch this package "
            "(publish step points elsewhere) — re-run "
            "`python -m digest.install_workflows`"
        )
    return None


def run_smoke() -> int:
    failures = _check_contract()
    for f in failures:
        print(f"[digest-smoke] FAIL: {f}", file=sys.stderr)

    warning = _check_live_dispatch()
    if warning:
        print(f"[digest-smoke] WARN: {warning}", file=sys.stderr)

    if failures:
        print(
            f"[digest-smoke] {len(failures)} regression(s) — the digest may not "
            "publish. See above.",
            file=sys.stderr,
        )
        return 1
    print("[digest-smoke] OK: publisher contract intact, fail-open floor postable.")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    return run_smoke()


if __name__ == "__main__":
    sys.exit(main())
