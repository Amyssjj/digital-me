"""Cross-runtime parity: write digital-me protocol context into ~/.codex/CODEX.md.

Codex sessions don't have a SessionStart-equivalent hook the way Claude Code
does, and Codex doesn't run inside the OpenClaw gateway where the
proactive-learning plugin's Hook 0c can inject Active Policies. The standing
instructions surface for Codex is ~/.codex/CODEX.md — read at every session
start.

This module rewrites the *managed section* of CODEX.md on each dream cycle,
preserving any manual content the user has added outside the markers.
Mirrors the SessionStart hook's content for Claude Code: protocol reminder
+ Active Policies block (extracted verbatim from ~/digital-me/_INDEX.md).

Idempotent — re-running with no changes to _INDEX.md is a no-op (mtime stays).
"""

from pathlib import Path
from typing import Optional

from dream_cycle.config import load_config, Config


CODEX_INSTRUCTIONS_PATH = Path.home() / ".codex" / "CODEX.md"
DM_INDEX_PATH = Path.home() / "digital-me" / "_INDEX.md"

BEGIN_MARKER = "<!-- BEGIN digital-me auto-generated section — DO NOT EDIT MANUALLY -->"
END_MARKER = "<!-- END digital-me auto-generated section -->"

# Codex preamble — the same protocol reminder Claude Code's SessionStart hook
# injects, but rendered as markdown (not JSON additionalContext). Codex reads
# this once at session start; same shape as `~/.codex/CODEX.md` already uses.
PROTOCOL_REMINDER = """\
## Digital Me Protocol

This Codex session is part of the cross-agent Digital Me knowledge fleet.
Before any non-trivial task:

1. **Browse `~/digital-me/_INDEX.md`** — domain-grouped TOC of all wiki entries.
2. **Read entries directly** when the index reveals a match (faster than blind search).
3. **Fall back to `memory_search`** MCP tool only when the index doesn't help.
4. **Active Policies are mandatory** — the section below is injected verbatim from `_INDEX.md`.

When you discover a generalizable pattern, call the `learning_capture` MCP tool
(via the `openclaw-brain` server) with `kind`, `text`, `why`, `apply_when`,
and `proposed_wiki_path`. The brain stores the capture; the next dream cycle
materializes it into the wiki.

Full protocol: `~/digital-me/wiki/knowledge-management/digital-me-protocol.md`
"""


def _extract_active_policies(index_text: str) -> str:
    """Extract the ACTIVE POLICIES block from _INDEX.md.

    dream_cycle/index.py writes exactly three `===` fence lines around the
    policies section. Capture fence 1 through fence 3 inclusive. Same
    algorithm as the OpenClaw Hook 0c extractor and Claude Code's awk
    SessionStart hook — keep all three in sync if the fence format changes.
    """
    lines = index_text.split("\n")
    out: list[str] = []
    fence = 0
    for line in lines:
        stripped = line.strip()
        if stripped and set(stripped) == {"="}:
            fence += 1
            if fence == 1 or fence == 3:
                out.append(line)
            if fence == 3:
                break
            continue
        if 1 <= fence < 3:
            out.append(line)
    if fence < 3:
        return ""
    return "\n".join(out).strip()


def build_managed_section() -> str:
    """Compose the full managed-section content."""
    if not DM_INDEX_PATH.exists():
        return ""
    try:
        index_text = DM_INDEX_PATH.read_text(encoding="utf-8")
    except OSError:
        return ""

    policies = _extract_active_policies(index_text)
    parts = [BEGIN_MARKER, "", PROTOCOL_REMINDER.strip()]
    if policies:
        parts.append("")
        parts.append(policies)
    parts.append("")
    parts.append(END_MARKER)
    return "\n".join(parts) + "\n"


def update_codex_instructions(
    *, dry_run: bool = False, force_create: bool = True,
) -> dict:
    """Write/update the managed section in ~/.codex/CODEX.md.

    Preserves any manual content outside the markers. If the file doesn't
    exist and force_create is True, creates a minimal file containing only
    the managed section.

    Returns a stats dict describing what changed.
    """
    if not DM_INDEX_PATH.exists():
        print(f"  SKIP codex integration — _INDEX.md not found at {DM_INDEX_PATH}")
        return {"status": "skipped_no_index"}

    new_section = build_managed_section()
    if not new_section.strip():
        print("  SKIP codex integration — could not extract managed-section content")
        return {"status": "skipped_no_content"}

    CODEX_INSTRUCTIONS_PATH.parent.mkdir(parents=True, exist_ok=True)

    if not CODEX_INSTRUCTIONS_PATH.exists():
        if not force_create:
            return {"status": "skipped_no_codex_file"}
        # Brand-new file: just the managed section + a leading comment
        content = (
            "# Codex Instructions\n\n"
            "<!-- Manual content above this line is preserved across "
            "dream cycle runs. The section below is auto-generated. -->\n\n"
            + new_section
        )
        action = "created"
    else:
        existing = CODEX_INSTRUCTIONS_PATH.read_text(encoding="utf-8")

        if BEGIN_MARKER in existing and END_MARKER in existing:
            # Replace existing managed section in place
            before = existing.split(BEGIN_MARKER, 1)[0]
            after = existing.split(END_MARKER, 1)[1]
            content = before + new_section + after.lstrip("\n")
            action = "updated"
        else:
            # No managed section yet — append below existing content
            sep = "" if existing.endswith("\n\n") else ("\n" if existing.endswith("\n") else "\n\n")
            content = existing + sep + new_section
            action = "appended"

        if content == existing:
            print(f"  codex integration: no changes ({CODEX_INSTRUCTIONS_PATH})")
            return {"status": "unchanged", "path": str(CODEX_INSTRUCTIONS_PATH)}

    if dry_run:
        print(f"  [DRY-RUN] would {action} {CODEX_INSTRUCTIONS_PATH} ({len(new_section)} byte section)")
        return {
            "status": f"dry_run_{action}",
            "path": str(CODEX_INSTRUCTIONS_PATH),
            "section_bytes": len(new_section),
        }

    CODEX_INSTRUCTIONS_PATH.write_text(content, encoding="utf-8")
    print(f"  codex integration: {action} {CODEX_INSTRUCTIONS_PATH} ({len(new_section)} byte section)")
    return {
        "status": action,
        "path": str(CODEX_INSTRUCTIONS_PATH),
        "section_bytes": len(new_section),
    }


def run_codex_integration(config: Optional[Config] = None) -> dict:
    """Entry point for dream_cycle.run wiring."""
    return update_codex_instructions()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Refresh ~/.codex/CODEX.md from digital-me Active Policies.")
    parser.add_argument("--dry-run", action="store_true", help="Report only, no writes.")
    args = parser.parse_args()
    result = update_codex_instructions(dry_run=args.dry_run)
    import json
    print(json.dumps(result, indent=2, default=str))
