"""Compile inbox/ raw sources into wiki/ structured entries.

This is the core of the Karpathy-inspired pipeline:
  inbox/ (raw agent data) -> LLM compile -> wiki/ (structured knowledge)

Reads through inbox symlinks, parses each source format,
calls LLM to compile into wiki entry format, dedup-checks
against existing wiki entries.
"""

import hashlib
import json
import os
import re
import sys
from datetime import date
from pathlib import Path
from textwrap import dedent
from typing import Optional

import yaml

from dream_cycle.config import load_config, Config, Source
from dream_cycle.engine import get_engine, Engine


# Canonical home for taste skills (per Sprint 4 decision 2026-05-11).
# Other runtimes' skill dirs (~/.codex/skills/, ~/.claude/skills/) are symlinks.
SKILLS_DIR = Path.home() / ".agents" / "skills"

# Per NUX scope-down §A (2026-05-26): tastes live in a flat tree at
# ~/digital-me/tastes/<domain>/<slug>.md. Candidates and promoted tastes share
# the same directory; `status: candidate|promoted` in frontmatter is the only
# distinction. Code that used to walk both bundles/ and _holding/ now filters
# by frontmatter instead of by directory.
SKILL_PROPOSALS_DIR = Path.home() / "digital-me" / "tastes"

# Transcript filters for taste-eligible runs. Stricter than the wiki-extraction
# threshold (user_turns > 3) — taste extraction needs back-and-forth substance
# on BOTH sides, plus enough total content to reveal a mental model.
TASTE_MIN_USER_TURNS = 8
TASTE_MIN_ASSISTANT_TURNS = 4
TASTE_MIN_CHARS = 5_000

# Minimum number of characters in a single user message (after stripping
# metadata wrappers + system-instruction templates) before we count it
# as a "real" user turn. Heartbeat pings ("HEARTBEAT_OK", "yes", "ok")
# and bare untrusted-metadata blocks fall below this floor.
TASTE_MIN_USER_MSG_CHARS = 5

# Source-path fragments that mark a transcript as operational rather than
# taste-bearing. Coo's session log + cron outputs routinely pass the
# numerical user_turns/assistant_turns/body_chars thresholds but their
# "user turns" are channel-routing metadata + scheduled heartbeat pings,
# not owner-authored judgment. Empirical 2026-05-13..19: yield from these
# sources was 0 candidates across multiple weeks of staging.
TASTE_EXCLUDED_SOURCE_FRAGMENTS: tuple[str, ...] = (
    "/agents/coo/",         # coo operational sessions (heartbeats + routing)
    "/agents/podcast/",     # podcast agent ops
    "/cron/output/",        # cron-output sessions (templated runs)
    "/.hermes/cron/",       # hermes cron output dirs
)

# Substring markers identifying a user message as a system-instruction
# template (heartbeat ping, hook reminder) rather than user-authored
# content. Match against the message text; if any marker is present,
# the turn is not "real".
HEARTBEAT_INSTRUCTION_MARKERS: tuple[str, ...] = (
    "Read HEARTBEAT.md if it exists",
    "reply HEARTBEAT_OK",
    "Do not infer or repeat old tasks",
)

# Wrapper blocks that show up around real user messages but are not
# user-authored content. We strip these to measure the real user portion.
_METADATA_BLOCK_RE = re.compile(
    r"(?:Conversation info \(untrusted metadata\)|"
    r"Sender \(untrusted metadata\)|"
    r"Untrusted context \(metadata[^)]*\))"
    r":?\s*```(?:json)?.*?```",
    re.DOTALL,
)
_EXTERNAL_UNTRUSTED_RE = re.compile(
    r"<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>.*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>",
    re.DOTALL,
)


def _real_user_content_length(text: str) -> int:
    """Return the length of `text` after stripping known metadata wrappers
    and detecting heartbeat-instruction templates. A heartbeat marker
    short-circuits to 0 — those messages are scheduled pings, not human
    judgment, regardless of any human-looking text around them."""
    if any(marker in text for marker in HEARTBEAT_INSTRUCTION_MARKERS):
        return 0
    stripped = _METADATA_BLOCK_RE.sub("", text)
    stripped = _EXTERNAL_UNTRUSTED_RE.sub("", stripped)
    return len(stripped.strip())


COMPILE_PROMPT_SYSTEM = dedent("""\
You are the compiler for a Living Knowledge wiki.

Your job: read raw agent transcripts, memories, and learnings,
then extract ACTIONABLE KNOWLEDGE that helps future agents
deliver high-quality results on the first attempt.

## What to extract

A good wiki entry answers ONE of these for a future agent:
1. WHAT SHOULD I DO? (a rule or decision)
2. WHAT SHOULD I AVOID? (a trap or anti-pattern)
3. WHAT DOES THE USER PREFER? (a preference)
4. WHERE DO I FIND IT? (a reference)

## Output format

Return ONLY valid YAML frontmatter + markdown body. No extra text.

```
---
title: <concise title>
domain: [<domain1>, <domain2>]
tags: [<tag1>, <tag2>, <tag3>]
route: <OMIT unless this is a tool-specific learning — see below>
priority: search
citations: 0  # always 0 on creation — derived live from real cross-agent
             # memory_search traces by dream_cycle/citations.py
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
related: []
source: <source_name>
---

## Rule
<Direct instruction an agent can follow immediately.
Not "we discovered that X" — instead "Do X" or "Never do Y".>

## How it came up
<The surprise, debugging session, or user correction.>

## Apply when
<Search-friendly context. Multiple phrasings.
Ask: "What would an agent query when it needs this?">
```

## Quality bar
"If an agent searches for this topic and gets this entry,
can it act correctly without asking the user?" If no, not actionable enough.

## What NOT to extract
- Raw conversation with no generalizable lesson
- One-time fixes that won't recur
- Info derivable from reading current codebase
- Implementation details that will be stale next week

## When to add `route:`

The `digital-me-recall` plugin's per-tool hook injects wiki entries
deterministically on `before_tool_call`. Add a `route:` field ONLY when
the learning is specific to a tool's behavior at the moment of invocation.

Grammar: `tool=<tool-name>[, params.<field> contains "<value>"[ OR "<value2>"]]`

Examples:
- "Pass `-loglevel error` when running ffmpeg"
  → `route: tool=exec, params.command contains "ffmpeg"`
- "INSERT INTO issues requires a reported_by column"
  → `route: tool=exec, params.command contains "INSERT INTO issues"`

OMIT `route:` for:
- Meta-principles, taste, or user preferences (the taste pipeline handles these)
- General domain knowledge (memory_search covers these per-turn)
- Conceptual rules that apply across many tools
- Anything where the tool dispatch is not the natural trigger

When in doubt, OMIT. A missing route only means the entry is found via
memory_search rather than the deterministic hashmap — no information loss.

## Skill-Wiki boundary
Skills hold executable assets (code, templates) + short manual.
Wiki holds accumulated knowledge (rules, gotchas, decisions).
If content belongs in a SKILL.md, don't duplicate it — reference the skill.

## Multiple entries
If the source contains multiple distinct learnings, return them separated
by a line containing only `---SPLIT---`. Each entry must have its own
complete frontmatter and body.

## Updating existing entries (when a manifest is provided)
If a manifest of existing wiki entries is provided in the user message,
and your extraction matches an existing entry by topic, include
`update_path: <relative-path-from-manifest>` as a frontmatter field
and provide the FULL revised entry body. The route hint will be stripped
before the file is written.

If nothing new should be added to an existing entry, return an empty
response (no frontmatter, no body) — the apply step treats that as a
no-op skip rather than a write.
""")


def _file_hash(path: Path) -> str:
    """SHA256 of file contents."""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def _load_compiled_hashes(config: Config) -> dict:
    """Load the hash cache tracking what's been compiled."""
    cache_file = config.cache_dir / "compiled_hashes.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text())
    return {}


def _save_compiled_hashes(config: Config, hashes: dict) -> None:
    """Save the hash cache."""
    config.cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = config.cache_dir / "compiled_hashes.json"
    cache_file.write_text(json.dumps(hashes, indent=2))


def _slugify(title: str) -> str:
    """Convert a title to a filename slug."""
    slug = title.lower()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)
    slug = re.sub(r'[\s]+', '-', slug.strip())
    slug = re.sub(r'-+', '-', slug)
    return slug[:80]


def _parse_multi_entry_md(path: Path) -> list[dict]:
    """Parse an OpenClaw shared_learnings file with multiple ### entries."""
    entries = []
    content = path.read_text()
    # Split on ### headers
    sections = re.split(r'^### ', content, flags=re.MULTILINE)
    for section in sections[1:]:  # Skip the file-level header
        lines = section.strip().split('\n')
        title = lines[0].strip()
        body = '\n'.join(lines[1:]).strip()
        if title and body:
            entries.append({
                "title": title,
                "body": body,
                "source_file": str(path),
            })
    return entries


def _parse_frontmatter_md(path: Path) -> list[dict]:
    """Parse a Claude Code style memory file with YAML frontmatter."""
    content = path.read_text()
    if not content.startswith('---'):
        return []
    parts = content.split('---', 2)
    if len(parts) < 3:
        return []
    try:
        import yaml
        fm = yaml.safe_load(parts[1])
    except Exception:
        return []
    body = parts[2].strip()
    if not body:
        return []
    return [{
        "title": fm.get("name", fm.get("title", path.stem)),
        "body": body,
        "frontmatter": fm,
        "source_file": str(path),
    }]


def _parse_skill_md(path: Path) -> list[dict]:
    """Parse a SKILL.md file — extract knowledge, not executable instructions."""
    content = path.read_text()
    if not content.strip():
        return []
    # Extract skill name from frontmatter if present
    title = path.parent.name
    if content.startswith('---'):
        parts = content.split('---', 2)
        if len(parts) >= 3:
            try:
                import yaml
                fm = yaml.safe_load(parts[1])
                title = fm.get("name", title)
            except Exception:
                pass
    return [{
        "title": f"Skill: {title}",
        "body": content,
        "source_file": str(path),
        "is_skill": True,
    }]


def _stringify_message_content(value) -> str:
    """Extract human-readable text from common transcript content shapes."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(
                    _stringify_message_content(
                        item.get("text")
                        or item.get("content")
                        or item.get("input_text")
                        or item.get("output_text")
                    )
                )
        return "\n".join(p for p in parts if p)
    if isinstance(value, dict):
        return _stringify_message_content(
            value.get("text")
            or value.get("content")
            or value.get("message")
            or value.get("input_text")
            or value.get("output_text")
        )
    return str(value)


def _transcript_role(record: dict) -> str:
    """Normalize roles across Claude Code, OpenClaw, Codex, and Hermes logs."""
    if isinstance(record.get("message"), dict) and record["message"].get("role"):
        return record["message"]["role"]
    payload = record.get("payload")
    if isinstance(payload, dict):
        if payload.get("role"):
            return payload["role"]
        if isinstance(payload.get("message"), dict) and payload["message"].get("role"):
            return payload["message"]["role"]
    if record.get("role"):
        return record["role"]
    if record.get("type") == "user":
        return "user"
    if record.get("type") == "assistant":
        return "assistant"
    return ""


def _transcript_content(record: dict) -> str:
    if isinstance(record.get("message"), dict):
        text = _stringify_message_content(record["message"].get("content"))
        if text:
            return text
    payload = record.get("payload")
    if isinstance(payload, dict):
        text = _stringify_message_content(payload.get("content"))
        if text:
            return text
        if isinstance(payload.get("message"), dict):
            text = _stringify_message_content(payload["message"].get("content"))
            if text:
                return text
    return _stringify_message_content(record.get("content"))


def _is_real_user_turn(record: dict, text: str) -> bool:
    if _transcript_role(record) != "user":
        return False
    if not text.strip():
        return False
    if record.get("isMeta"):
        return False
    if "<local-command-caveat>" in text:
        return False
    if "<user_action>" in text and "<results>" in text:
        return False
    # Strip metadata wrappers + reject heartbeat templates. A user message
    # whose only content is "Conversation info (untrusted metadata)" JSON
    # blocks, or that contains the heartbeat-instruction markers, is a
    # scheduled ping rather than a human turn.
    if _real_user_content_length(text) <= TASTE_MIN_USER_MSG_CHARS:
        return False
    return True


def _owner_name() -> str:
    """Owner display name used to attribute transcript turns.

    From `$DIGITAL_ME_OWNER_NAME`. Empty (the default) disables owner-marker
    matching, so sources that require the marker are skipped rather than
    mis-attributing someone else's messages as the owner's taste.
    """
    return os.environ.get("DIGITAL_ME_OWNER_NAME", "").strip()


def _has_owner_marker(text: str) -> bool:
    owner = _owner_name()
    if not owner:
        return False
    return (
        f'"sender": "{owner}"' in text
        or f'"name": "{owner}"' in text
        or "Sender (untrusted metadata)" in text and owner in text
    )


def _parse_transcript_records(
    path: Path,
    records: list[dict],
    require_owner_marker: bool = False,
) -> list[dict]:
    turns = []
    user_turns = 0
    assistant_turns = 0
    owner_marked = False
    for record in records:
        if not isinstance(record, dict):
            continue
        role = _transcript_role(record)
        if role not in {"user", "assistant"}:
            continue
        text = _transcript_content(record).strip()
        if not text:
            continue
        if _is_real_user_turn(record, text):
            user_turns += 1
            owner_marked = owner_marked or _has_owner_marker(text)
        elif role == "user":
            continue
        if role == "assistant":
            assistant_turns += 1
        if len(text) > 4000:
            text = text[:4000].rstrip() + "\n[truncated]"
        turns.append(f"{role.upper()}:\n{text}")

    if user_turns <= 3 or not turns:
        return []
    if require_owner_marker and not owner_marked:
        return []

    body = "\n\n---\n\n".join(turns)
    if len(body) > 60000:
        body = body[:60000].rstrip() + "\n\n[transcript truncated]"
    return [{
        "title": f"Transcript: {path.stem}",
        "body": f"user_turns: {user_turns}\nsource_file: {path}\n\n{body}",
        "source_file": str(path),
        "user_turns": user_turns,
        "assistant_turns": assistant_turns,
        "body_chars": len(body),
    }]


def _parse_transcript_jsonl(path: Path, require_owner_marker: bool = False) -> list[dict]:
    records = []
    for line in path.read_text(errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return _parse_transcript_records(path, records, require_owner_marker=require_owner_marker)


def _parse_transcript_json(path: Path, require_owner_marker: bool = False) -> list[dict]:
    try:
        data = json.loads(path.read_text(errors="ignore"))
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict) and isinstance(data.get("messages"), list):
        records = data["messages"]
    elif isinstance(data, list):
        records = data
    else:
        return []
    return _parse_transcript_records(path, records, require_owner_marker=require_owner_marker)


def collect_raw_entries(config: Config, recent_days: Optional[int] = None) -> list[dict]:
    """Walk inbox symlinks and collect all raw entries.

    When `recent_days` is set, files with mtime older than `recent_days * 86400`
    seconds are skipped before parsing. The hash cache still prevents re-work
    on overlapping daily runs; this filter bounds the worst-case iteration cost.
    """
    import time as _time
    mtime_cutoff = None
    if recent_days is not None and recent_days >= 0:
        mtime_cutoff = _time.time() - recent_days * 86400

    all_entries = []
    skipped_by_mtime = 0
    for source in config.sources:
        inbox_link = config.inbox_dir / source.name
        if not inbox_link.exists():
            print(f"  SKIP {source.name} (inbox link missing)")
            continue

        source_path = inbox_link.resolve()
        if source.format in {"multi-entry-md", "frontmatter-md", "skill-md"}:
            candidate_files = sorted(source_path.rglob("*.md"))
        elif source.format == "transcript-jsonl":
            candidate_files = [
                p for p in sorted(source_path.rglob("*.jsonl"))
                if not p.name.endswith(".trajectory.jsonl")
            ]
        elif source.format == "transcript-json":
            candidate_files = sorted(source_path.rglob("*.json"))
        else:
            candidate_files = []

        for md_file in candidate_files:
            # Skip index/meta files
            if md_file.name.startswith('_') or md_file.name == 'MEMORY.md':
                continue
            # Skip README files
            if md_file.name.upper() == 'README.MD':
                continue
            if source.name == "claude-code-transcripts" and "/subagents/" in str(md_file):
                continue
            if mtime_cutoff is not None:
                try:
                    if md_file.stat().st_mtime < mtime_cutoff:
                        skipped_by_mtime += 1
                        continue
                except OSError:
                    continue

            if source.format == "multi-entry-md":
                entries = _parse_multi_entry_md(md_file)
            elif source.format == "frontmatter-md":
                entries = _parse_frontmatter_md(md_file)
            elif source.format == "skill-md":
                if md_file.name == "SKILL.md":
                    entries = _parse_skill_md(md_file)
                else:
                    continue
            elif source.format == "transcript-jsonl":
                entries = _parse_transcript_jsonl(
                    md_file,
                    require_owner_marker=source.name == "openclaw-agent-transcripts",
                )
            elif source.format == "transcript-json":
                entries = _parse_transcript_json(
                    md_file,
                    require_owner_marker=source.name == "hermes-transcripts",
                )
            else:
                continue

            for entry in entries:
                entry["source_name"] = source.name
                entry["source_format"] = source.format
            all_entries.extend(entries)

    if mtime_cutoff is not None:
        print(f"  Skipped {skipped_by_mtime} files older than {recent_days}d (mtime filter)")
    return all_entries


def _read_frontmatter(path: Path) -> Optional[dict]:
    """Parse YAML frontmatter from the first ~2KB of a markdown file."""
    try:
        head = path.read_text(encoding="utf-8")[:3000]
    except OSError:
        return None
    if not head.startswith("---"):
        return None
    parts = head.split("---", 2)
    if len(parts) < 3:
        return None
    try:
        fm = yaml.safe_load(parts[1])
    except Exception:
        return None
    return fm if isinstance(fm, dict) else None


# Workflow-template detector — keeps procedural artifacts out of the wiki.
#
# Compile.py's LLM prompt asks for "actionable knowledge", and workflow
# procedures pattern-match: they have rules, steps, and "do X" instructions.
# But workflow templates are executable artifacts whose canonical home is the
# orchestrator DB (or an external *-template.json file). Narrating them as
# wiki entries duplicates the source, drifts as the template evolves, and
# inflates citation counts when video/production loops hammer memory_search.
#
# Real case (2026-05-12): remotion-production-workflow.md was extracted from a
# codex transcript and accumulated 272 trace hits (247 from one youtube agent
# in a 24h loop). The entry's first line pointed at the external JSON template
# it was narrating — i.e., the wiki entry was already redundant on creation.
#
# These tells fire only on the strongest patterns. False positives go to
# `dream_cycle/logs/skipped-workflows-YYYY-MM-DD.md` for review — adjustable.
_WORKFLOW_TEMPLATE_TELLS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"^\s*-\s*workflow-template\s*$", re.MULTILINE),
        "frontmatter tag 'workflow-template'",
    ),
    (
        re.compile(r"[A-Za-z0-9/_.-]+-template\.json"),
        "references external *-template.json path",
    ),
    (
        re.compile(r"workflow template id is\s*[:`]", re.IGNORECASE),
        "explicit 'workflow template id is' declaration",
    ),
]


def _classify_workflow_template(entry_text: str) -> Optional[str]:
    """Return a short reason string if the entry looks like a workflow
    template that should be rejected from the wiki, or None to allow it
    through to write_wiki_entry."""
    for pattern, reason in _WORKFLOW_TEMPLATE_TELLS:
        if pattern.search(entry_text):
            return reason
    return None


def build_wiki_manifest(config: Config, max_entries: int = 250) -> str:
    """One line per existing wiki entry — what the LLM sees BEFORE extracting.

    Mirrors Claude Code's memoryScan manifest format
    (memdir/memoryScan.ts:84-94) — `[type] path: description`. Pre-injecting
    this prevents the compile LLM from creating duplicates of entries that
    already exist; the LLM is told to set `update_path` when its output
    should overwrite an existing entry instead.

    Description heuristic: prefer the `title` field, fall back to first
    non-header body line. ~80 chars/line × 250 entries = ~20KB at the cap.
    """
    lines: list[tuple[float, str]] = []  # (sort_key=-mtime, line)
    for md in config.wiki_dir.rglob("*.md"):
        if md.name.startswith("_"):
            continue
        try:
            mtime = md.stat().st_mtime
        except OSError:
            continue
        fm = _read_frontmatter(md)
        if not fm:
            continue
        t = fm.get("type", "?")
        title = fm.get("title", "").strip()
        rel = md.relative_to(config.wiki_dir)
        # Trim title aggressively — the manifest's job is matching, not display
        if len(title) > 90:
            title = title[:87] + "..."
        lines.append((-mtime, f"- [{t}] {rel}: {title}"))

    # Newest first; cap at max_entries to bound prompt size
    lines.sort()
    capped = [line for _, line in lines[:max_entries]]
    if len(lines) > max_entries:
        capped.append(f"- _+{len(lines) - max_entries} older entries elided from manifest_")
    return "\n".join(capped)


VALID_DOMAINS = ("infra", "knowledge", "storytelling", "design")


def build_principles_manifest() -> str:
    """One line per existing principle, grouped by domain.

    Per NUX scope-down §A: walks the flat ~/digital-me/tastes/<domain>/*.md tree
    and discriminates `status: promoted` (formerly bundles/) from
    `status: candidate` (formerly _holding/) via frontmatter, not directory.

    The LLM uses this manifest to decide candidate vs. evidence — if a
    fingerprint here semantically matches the principle the LLM would
    propose, it must emit `evidence` with `matched_existing_fingerprint`
    set to the existing fingerprint verbatim.
    """
    if not SKILL_PROPOSALS_DIR.exists():
        return ""
    by_domain: dict[str, list[str]] = {d: [] for d in VALID_DOMAINS}
    for domain_dir in sorted(SKILL_PROPOSALS_DIR.iterdir()):
        if not domain_dir.is_dir() or domain_dir.name not in VALID_DOMAINS:
            continue
        for principle_md in sorted(domain_dir.glob("*.md")):
            fm = _read_frontmatter(principle_md)
            if not fm:
                continue
            fingerprint = (fm.get("principle_fingerprint") or "").strip()
            if not fingerprint:
                continue
            # status: 'promoted' (default for the migrated bundles/) or 'candidate'
            # (default for the migrated _holding/). Treat unknown statuses as
            # candidates so we don't over-claim certainty.
            status = (fm.get("status") or "candidate").strip()
            count = fm.get("evidence_count", 0)
            tag = "leaf" if status == "promoted" else f"holding/{count}"
            slug = principle_md.stem
            by_domain[domain_dir.name].append(
                f"- [{tag}] {domain_dir.name}/{slug} :: {fingerprint}"
            )
    sections = []
    for domain in VALID_DOMAINS:
        sections.append(f"### {domain}")
        if by_domain[domain]:
            sections.extend(by_domain[domain])
        else:
            sections.append("- _(no principles yet)_")
        sections.append("")
    return "\n".join(sections).strip()


# =============================================================================
# Taste-skill reverse-engineering (Sprint 5 item #4)
# =============================================================================
#
# Different shape from wiki extraction: taste skills are OPERATING MANUALS
# (workflow + principles + decision logic + quality bar) that an agent loads
# to do work in the owner's style. We reverse-engineer the underlying mental model
# from a owner-rich conversation, then either UPDATE an existing skill or
# PROPOSE a new one. Updates land in a staging dir for the user to review
# before promoting — never overwrite an active skill from a single transcript.

REVERSE_ENGINEER_SYSTEM = dedent("""\
You are extracting JUDGE-SHAPE rubric components from a transcript so that
future agents can act with the owner's taste AND be scored against it.

A "taste skill" in this system is NOT an operating manual. It is a set of
PRINCIPLES, each backed by evidence from MULTIPLE projects, that can be
loaded as a judge rubric. One transcript contributes at most ONE evidence
record toward a principle — promotion to a full leaf requires evidence
from two or more independent projects.

You receive:
1. A transcript (the owner was substantively involved)
2. A manifest of existing principles in the system, grouped by domain
3. The bodies of the most plausibly-matching existing principles, if any

═══════════════════════════════════════════════════════════════════
DOMAINS — CLOSED SET
═══════════════════════════════════════════════════════════════════

Every extraction MUST be tagged with exactly one of:

  infra        — systems, debugging, architecture, APIs, agents/runtimes
  knowledge    — wiki structure, distillation, agent memory, dream cycle
  storytelling — speeches, decks, content, narrative, post-mortems as story
  design       — UI, animation, visual aesthetic, product feel

Do NOT invent new domains. If the transcript doesn't fit one, outcome is
`neither`.

═══════════════════════════════════════════════════════════════════
THREE OUTCOMES
═══════════════════════════════════════════════════════════════════

A. CANDIDATE — the transcript reveals a NEW principle in a domain.
   Emit principle_fingerprint + one evidence_record. The principle will
   sit in `_holding/` until a second transcript provides independent
   evidence; only then does it graduate to a leaf in `bundles/`.

B. EVIDENCE — the transcript adds a 2nd+ evidence record to a principle
   that already exists (either in `_holding/` or as a promoted leaf).
   You MUST match against the principles manifest before choosing this.
   Set `matched_existing_fingerprint` to the existing fingerprint verbatim.

C. NEITHER — the transcript reveals no new taste signal (default).
   Most conversations land here. Polluting the rubric is much harder
   to undo than skipping a capture.

═══════════════════════════════════════════════════════════════════
WHAT EACH FIELD MEANS
═══════════════════════════════════════════════════════════════════

  principle_fingerprint:
    A one-sentence MENTAL MODEL — the GENERATOR behind the incident,
    NOT the incident's how-to. Hard cap: **≤15 words.** Strip project
    names, framework vocabulary, internal jargon, stack-specific terms.
    The rule must make sense to an engineer who has never seen this
    codebase and may be working in a stack that didn't exist yet.

    TRANSFER TEST (mandatory before emitting candidate/evidence):
      Could a future agent apply this rule to a fictional project the owner
      has never worked on, in a stack you haven't named?
      If NO → you captured a how-to, not a principle. Outcome is NEITHER.

    GO UP ONE LEVEL: if your draft reads like advice ("provide X before
    doing Y", "ensure Z is configured", "use A instead of B"), ask:
    what is the underlying BELIEF that makes this advice obvious to the owner?
    THAT is the principle. Example climb:
      Gotcha:    "italic flares clipped by tight line-height"
      Advice:    "provide sufficient line-height for italics"
      Principle: "Display typography needs room; don't crop signature features."
    Keep climbing until one more step would turn it into empty platitude
    ("write good code"). Stop one rung BEFORE that.

    GOOD (transferable, ≤15 words, generator-level):
      "Fix shared-package bugs upstream, not in local copies."
      "Background callers must provide context that interactive callers get for free."
      "Display typography needs room; don't crop signature features."
      "Evidence over abstraction: two examples beats one polished claim."

    BAD (project-anchored, verbose, surface-bound — outcome should be NEITHER
    or the fingerprint needs to climb a level):
      "Don't patch openclaw-brain MCP gateway in node_modules."
      "Automated background tasks must explicitly provide or mock a valid
       request context when invoking capabilities restricted to interactive
       sessions." ← 19 words, still leaks 'request context' / 'session' jargon.
       Climb to: "Background callers must supply context interactive callers get for free."
      "Provide sufficient line-height and padding for large display italics to
       prevent glyph clipping by the bounding box or CSS masks." ← CSS gotcha.
       Climb to: "Display type needs room; don't crop signature features."

  evidence_record:
    project_id:   short identifier of the project this transcript is about
    date:         today's date (YYYY-MM-DD)
    wiki_paths:   array of relevant wiki entry paths under wiki/. Cite at
                  least one if any wiki entry covers the incident. Empty
                  array allowed but discouraged.
    what_happened:
      2-3 sentence summary of the concrete situation. Names, files,
      error messages OK here — this is the ANCHOR.
    what_triggers_principle:
      One sentence: what surface feature of THIS situation activates
      THIS principle. Connects the anchor to the abstraction.

  fire_signature_hints:
    3-6 short phrases an agent could match against a NEW task to decide
    "should I load this principle?". Surface features, not abstractions.

  rubric_item_candidates:
    2-4 yes/no checklist items a JUDGE could score a produced artifact
    against. Each must be answerable by reading the artifact alone.

  near_miss_observed (nullable):
    If the transcript surfaces a SIMILAR situation where this principle
    does NOT apply, describe it in one sentence with the reason. Often
    null. Counter-examples sharpen the boundary.

═══════════════════════════════════════════════════════════════════
EXTRACTION DISCIPLINE
═══════════════════════════════════════════════════════════════════

  - One transcript = at most ONE outcome. Do not split into multiple
    principles from a single conversation. The right shape is one
    well-anchored evidence record.

  - PREFER outcome=evidence over outcome=candidate when the principles
    manifest contains a fingerprint that semantically matches yours.
    Inventing a near-duplicate sibling is THE failure mode this prompt
    is designed to prevent.

  - DO NOT emit a "leaf" yourself. Promotion is handled OUTSIDE this
    prompt; you emit candidate/evidence and the pipeline graduates on
    ≥2 evidence records.

  - YIELD CALIBRATION: Most taste-eligible transcripts contain NO new
    principle — they contain debugging sessions, work logs, or one-off
    incidents. Healthy yield is 1-3 candidates per 10 taste-eligible
    transcripts. If you find yourself emitting on every transcript,
    the bar is too low — reset to NEITHER and only keep the one with
    the strongest transfer-test pass.

  - THE PROJECT IS EVIDENCE, NOT THE SKILL. If you cannot describe the
    rule without naming the project, the codebase, or the specific
    tool — you have not yet found the principle. The transcript is
    one INSTANCE of a generator; your job is to name the generator.

  - DEFAULT TO C (NEITHER). A skipped capture is recoverable; a polluted
    rubric rots the judge for everyone. Err toward NEITHER when the
    transfer test is shaky.

═══════════════════════════════════════════════════════════════════
OUTPUT — return ONLY this JSON, no markdown fences, no preface
═══════════════════════════════════════════════════════════════════

If outcome is CANDIDATE or EVIDENCE:
{
  "outcome": "candidate" | "evidence",
  "domain": "infra" | "knowledge" | "storytelling" | "design",
  "principle_fingerprint": "<one-sentence rule, surface-stripped>",
  "matched_existing_fingerprint": "<copy of existing fingerprint verbatim if outcome=evidence, else null>",
  "evidence_record": {
    "project_id": "...",
    "date": "<YYYY-MM-DD>",
    "wiki_paths": ["..."],
    "what_happened": "...",
    "what_triggers_principle": "..."
  },
  "fire_signature_hints": ["...", "..."],
  "rubric_item_candidates": ["...", "..."],
  "near_miss_observed": "..." or null,
  "rationale": "<one sentence: why this transcript matters>",
  "confidence": 0.0-1.0
}

If outcome is NEITHER:
{
  "outcome": "neither",
  "rationale": "<one sentence: what the conversation was about and why no taste signal>"
}
""")


def is_taste_eligible(transcript_entry: dict) -> bool:
    """Tighter filter than the wiki-extraction threshold.

    Taste extraction needs back-and-forth substance on BOTH sides plus
    enough total content to reveal a mental model. We also reject
    transcripts from operational-agent + cron source paths
    (TASTE_EXCLUDED_SOURCE_FRAGMENTS) — their high turn counts come
    from automated heartbeat traffic, not owner-authored judgment.
    """
    source = str(transcript_entry.get("source_file") or "")
    for fragment in TASTE_EXCLUDED_SOURCE_FRAGMENTS:
        if fragment in source:
            return False
    return (
        transcript_entry.get("user_turns", 0) > TASTE_MIN_USER_TURNS
        and transcript_entry.get("assistant_turns", 0) > TASTE_MIN_ASSISTANT_TURNS
        and transcript_entry.get("body_chars", 0) > TASTE_MIN_CHARS
    )


def _matched_principles_for(transcript_body: str, top_k: int = 3) -> list[tuple[str, str, Path, dict]]:
    """Find existing principles whose fingerprint or fire_signature surfaces
    in the transcript. Cheap keyword match — the LLM does the final call.

    Returns up to `top_k` matches as (domain, slug, path, frontmatter) tuples.
    """
    # Per NUX scope-down §A: flat tastes/ tree; status:promoted|candidate lives
    # in frontmatter rather than directory. Walk all domain dirs once.
    if not SKILL_PROPOSALS_DIR.exists():
        return []
    body_lower = transcript_body.lower()
    scored: list[tuple[int, str, str, Path, dict]] = []
    for domain_dir in SKILL_PROPOSALS_DIR.iterdir():
        if not domain_dir.is_dir() or domain_dir.name not in VALID_DOMAINS:
            continue
        for principle_md in domain_dir.glob("*.md"):
            fm = _read_frontmatter(principle_md)
            if not fm:
                continue
            fingerprint = (fm.get("principle_fingerprint") or "")
            signature = fm.get("fire_signature") or []
            terms: set[str] = set()
            for w in fingerprint.lower().split():
                if len(w) > 4:
                    terms.add(w.strip(".,;:!?\"'()[]"))
            for sig in signature:
                for w in str(sig).lower().split():
                    if len(w) > 4:
                        terms.add(w.strip(".,;:!?\"'()[]"))
            score = sum(1 for t in terms if t and t in body_lower)
            if score >= 2:
                scored.append((score, domain_dir.name, principle_md.stem, principle_md, fm))
    scored.sort(reverse=True, key=lambda r: r[0])
    return [(d, s, p, fm) for _, d, s, p, fm in scored[:top_k]]


def extract_skill_update(
    engine: Engine,
    transcript_entry: dict,
    principles_manifest: str,
) -> Optional[dict]:
    """Reverse-engineer judge-shape rubric components from a transcript.

    Returns the parsed JSON outcome dict or None on parse/empty errors.
    The shape conforms to REVERSE_ENGINEER_SYSTEM's output contract.
    """
    matches = _matched_principles_for(transcript_entry.get("body", ""))
    user_msg_parts: list[str] = []
    if principles_manifest:
        user_msg_parts.append("## Existing principles manifest\n\n" + principles_manifest)
    if matches:
        match_bodies = []
        for domain, slug, path, _fm in matches:
            try:
                body = path.read_text(encoding="utf-8")[:4000]
            except OSError:
                continue
            match_bodies.append(f"### {domain}/{slug}\n\n{body}")
        if match_bodies:
            user_msg_parts.append(
                "## Most plausibly-matching existing principles\n\n"
                + "\n\n---\n\n".join(match_bodies)
            )
    user_msg_parts.append("## Transcript\n\n" + transcript_entry["body"])
    user_prompt = "\n\n".join(user_msg_parts)

    try:
        raw = engine.llm_call(user_prompt, system=REVERSE_ENGINEER_SYSTEM)
    except Exception as e:
        print(f"      reverse-engineer LLM error: {e}")
        return None

    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"      reverse-engineer JSON parse error: {e}")
        return None
    return data if isinstance(data, dict) else None


def _read_evidence_records(path: Path) -> list[dict]:
    """Parse the Evidence section of a principle file back into a list of
    dicts. Evidence is stored as a JSON array inside a fenced ```json block
    so round-tripping is unambiguous.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    m = re.search(
        r"^## Evidence\b.*?\n```json\s*\n(.*?)\n```",
        text,
        re.MULTILINE | re.DOTALL,
    )
    if not m:
        return []
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def _write_principle_file(
    path: Path,
    frontmatter: dict,
    evidence_records: list[dict],
    latest_rationale: Optional[str] = None,
) -> Path:
    """Write/overwrite a principle file in judge-shape v2 format.

    Frontmatter holds the fields the manifest scans (fingerprint, domain,
    fire_signature, evidence_count, status, rubric_items, near_misses).
    Body has labeled sections so a human reviewer can read it; the Evidence
    section is a JSON array so the pipeline can round-trip it cleanly.
    """
    fm_text = yaml.safe_dump(
        frontmatter, sort_keys=False, default_flow_style=False, allow_unicode=True
    ).strip()
    parts: list[str] = [f"---\n{fm_text}\n---", ""]

    parts.append("## Principle")
    parts.append(frontmatter.get("principle_fingerprint", "").strip() or "_(no fingerprint set)_")
    parts.append("")

    parts.append("## Discriminator")
    parts.append(
        "_Derive from the `what_triggers_principle` field across the "
        "evidence records below — those are the surface features that "
        "activate this principle._"
    )
    parts.append("")

    parts.append("## Evidence")
    status = frontmatter.get("status", "candidate")
    parts.append(
        f"_{len(evidence_records)} record(s) · status: **{status}** "
        f"· promotion threshold: ≥2 independent records._"
    )
    parts.append("")
    parts.append("```json")
    parts.append(json.dumps(evidence_records, indent=2, ensure_ascii=False))
    parts.append("```")
    parts.append("")

    parts.append("## Near-misses")
    near_misses = frontmatter.get("near_misses") or []
    if near_misses:
        for nm in near_misses:
            parts.append(f"- {nm}")
    else:
        parts.append("_None observed yet._")
    parts.append("")

    parts.append("## Rubric items (judge mode)")
    rubric_items = frontmatter.get("rubric_items") or []
    if rubric_items:
        for item in rubric_items:
            parts.append(f"- [ ] {item}")
    else:
        parts.append("_No rubric items yet._")
    parts.append("")

    parts.append("## Fire signature (consult / classifier mode)")
    fire_signature = frontmatter.get("fire_signature") or []
    if fire_signature:
        for sig in fire_signature:
            parts.append(f"- {sig}")
    else:
        parts.append("_No signature hints yet._")
    parts.append("")

    if latest_rationale:
        parts.append("## Latest extraction rationale")
        parts.append(latest_rationale.strip())
        parts.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(parts).rstrip() + "\n", encoding="utf-8")
    return path


def _find_existing_principle(
    fingerprint: str,
) -> Optional[tuple[Path, str, dict]]:
    """Locate an existing principle file by exact fingerprint match.

    Per NUX scope-down §A: walks the flat tastes/ tree once and reads
    `status:` from frontmatter. Returns (path, status, frontmatter) where
    status is 'promoted' or 'candidate' (or None on no match).
    """
    if not fingerprint or not SKILL_PROPOSALS_DIR.exists():
        return None
    target = fingerprint.strip()
    for md in SKILL_PROPOSALS_DIR.rglob("*.md"):
        fm = _read_frontmatter(md)
        if not fm:
            continue
        if (fm.get("principle_fingerprint") or "").strip() == target:
            status = (fm.get("status") or "candidate").strip()
            return md, status, fm
    return None


def apply_skill_outcome(outcome: dict) -> Optional[tuple[Path, str]]:
    """Apply a judge-shape v2 reverse-engineer result.

    Per NUX scope-down §A: tastes live in a flat tree at
    ~/digital-me/tastes/<domain>/<slug>.md. Promotion is now a status flip
    (`candidate` → `promoted`) in frontmatter — no directory move.

    Routes:
      - outcome=neither   → return None (no file mutation)
      - outcome=candidate → write/append to `tastes/<domain>/<slug>.md`
                            with status: candidate. On 2nd evidence
                            record, flip status to `promoted`.
      - outcome=evidence  → find matching principle (via fingerprint), append
                            evidence record. Flip status:promoted if the
                            count crosses 2.

    Returns (path_written, action_tag) where action_tag is one of:
      "candidate-new", "candidate-merged", "evidence-appended", "promoted-to-leaf"
    or None on neither/invalid input.
    """
    kind = outcome.get("outcome")
    if kind == "neither":
        return None
    if kind not in ("candidate", "evidence"):
        return None

    domain = (outcome.get("domain") or "").strip()
    if domain not in VALID_DOMAINS:
        return None

    fingerprint = (outcome.get("principle_fingerprint") or "").strip()
    if not fingerprint:
        return None

    evidence = outcome.get("evidence_record") or {}
    if not isinstance(evidence, dict) or not (evidence.get("what_happened") or "").strip():
        return None

    SKILL_PROPOSALS_DIR.mkdir(parents=True, exist_ok=True)
    domain_dir = SKILL_PROPOSALS_DIR / domain
    domain_dir.mkdir(parents=True, exist_ok=True)

    # Locate existing principle by fingerprint match (preferring the LLM's
    # claimed match for evidence outcomes, but falling back to direct lookup).
    target_path: Optional[Path] = None
    target_status: Optional[str] = None
    target_fm: Optional[dict] = None

    if kind == "evidence":
        claimed = (outcome.get("matched_existing_fingerprint") or "").strip()
        for fp in (claimed, fingerprint):
            if not fp:
                continue
            found = _find_existing_principle(fp)
            if found:
                target_path, target_status, target_fm = found
                break

    # Candidate outcome OR evidence-with-no-match → check if fingerprint
    # already exists (dedup safety) and append instead of duplicating.
    if target_path is None:
        found = _find_existing_principle(fingerprint)
        if found:
            target_path, target_status, target_fm = found

    today_iso = date.today().isoformat()

    if target_path is not None and target_fm is not None:
        # Append to existing file
        evidence_records = _read_evidence_records(target_path)
        evidence_records.append({
            "project_id": evidence.get("project_id", ""),
            "date": evidence.get("date") or today_iso,
            "wiki_paths": evidence.get("wiki_paths") or [],
            "what_happened": evidence.get("what_happened", "").strip(),
            "what_triggers_principle": evidence.get("what_triggers_principle", "").strip(),
        })

        # Merge fire signature hints (dedupe, preserve order)
        existing_sig = list(target_fm.get("fire_signature") or [])
        for hint in outcome.get("fire_signature_hints") or []:
            if hint and hint not in existing_sig:
                existing_sig.append(hint)
        target_fm["fire_signature"] = existing_sig

        # Merge rubric items
        existing_rubric = list(target_fm.get("rubric_items") or [])
        for item in outcome.get("rubric_item_candidates") or []:
            if item and item not in existing_rubric:
                existing_rubric.append(item)
        target_fm["rubric_items"] = existing_rubric

        # Append near-miss
        near_misses = list(target_fm.get("near_misses") or [])
        nm = outcome.get("near_miss_observed")
        if nm and nm not in near_misses:
            near_misses.append(nm)
        target_fm["near_misses"] = near_misses

        target_fm["evidence_count"] = len(evidence_records)
        target_fm["updated"] = today_iso

        # Promotion: candidate → promoted when evidence_count crosses 2.
        # Per §A: same file, frontmatter flip (no directory move).
        if target_fm["evidence_count"] >= 2 and target_status == "candidate":
            target_fm["status"] = "promoted"
            target_path = _write_principle_file(
                target_path, target_fm, evidence_records, outcome.get("rationale")
            )
            return target_path, "promoted-to-leaf"

        target_fm["status"] = "promoted" if target_status == "promoted" else "candidate"
        target_path = _write_principle_file(
            target_path, target_fm, evidence_records, outcome.get("rationale")
        )
        action = "evidence-appended" if kind == "evidence" else "candidate-merged"
        return target_path, action

    # No match → create new candidate in the flat tastes/<domain>/ dir.
    slug_base = _slugify(fingerprint)[:80] or "untitled-principle"
    new_path = domain_dir / f"{slug_base}.md"
    counter = 2
    while new_path.exists():
        new_path = domain_dir / f"{slug_base}-v{counter}.md"
        counter += 1

    # Per NUX scope-down §A: tastes share the wiki frontmatter schema so the
    # dashboard-intake scanner can fold them into the same metrics (counts by
    # domain, application-rate, distribution). Always include: title, domain,
    # status, priority, citations, tags, plus the taste-specific fields.
    fm_title = fingerprint.rstrip(".")
    if len(fm_title) > 80:
        fm_title = fm_title[:77].rstrip() + "..."
    fm = {
        "title": fm_title,
        "domain": domain,
        "principle_fingerprint": fingerprint,
        "status": "candidate",
        "priority": "search",
        "citations": 0,
        "tags": ["taste"],
        "evidence_count": 1,
        "fire_signature": list(outcome.get("fire_signature_hints") or []),
        "rubric_items": list(outcome.get("rubric_item_candidates") or []),
        "near_misses": [outcome.get("near_miss_observed")] if outcome.get("near_miss_observed") else [],
        "parents": [],
        "created": today_iso,
        "updated": today_iso,
    }
    evidence_records = [{
        "project_id": evidence.get("project_id", ""),
        "date": evidence.get("date") or today_iso,
        "wiki_paths": evidence.get("wiki_paths") or [],
        "what_happened": evidence.get("what_happened", "").strip(),
        "what_triggers_principle": evidence.get("what_triggers_principle", "").strip(),
    }]
    written = _write_principle_file(new_path, fm, evidence_records, outcome.get("rationale"))
    return written, "candidate-new"


def build_compile_prompt(
    raw: dict, source_name: str, wiki_manifest: str = "", *, include_manifest: bool = True,
) -> str:
    """Build the user-prompt string for compiling a raw entry into wiki
    entries. Pure (no LLM call) so the agent-driven `stage_compile` path can
    stage the same prompt the inline engine would have sent — keeping
    COMPILE_PROMPT_SYSTEM the single source of truth for extraction rules.

    With `wiki_manifest` populated (Sprint 5 item #1), the LLM is shown the
    existing wiki state and asked to update in place when its output would
    duplicate an existing entry. Mirrors Claude Code's extractMemories
    pattern (extractMemories.ts:395-413).

    `include_manifest=False` (staged-compile mode): omit the manifest body from
    THIS per-candidate prompt and reference the shared top-level `wiki_manifest`
    staging field instead. Avoids duplicating the (large) manifest into every
    one of the N candidate prompts — the 672KB-staging-file bloat that made the
    compiler-agent turn too heavy.
    """
    manifest_section = ""
    if include_manifest and wiki_manifest:
        manifest_section = f"""

## Existing wiki entries (DO NOT DUPLICATE)

Check this list BEFORE writing. If the knowledge you would extract
matches an existing entry by topic, you MUST either:

  (a) update that entry IN PLACE — include `update_path: <relative_path>`
      as a frontmatter field, and provide the FULL updated entry body
      (not a diff). The update_path line will be stripped before the file
      is written.

  (b) skip the extraction — if nothing new is to add to the existing
      entry, return an empty response (just whitespace or ---SPLIT---).

Only create a NEW entry when the content is materially distinct from
every entry below.

Manifest (one line per existing entry, `[type] path: title`):

{wiki_manifest}
"""
    elif not include_manifest:
        manifest_section = """

## Existing wiki entries (DO NOT DUPLICATE)

The full existing-wiki manifest is provided ONCE in the staging file's
top-level `wiki_manifest` field (shared across all candidates). Before
writing, check it: if your extraction would duplicate an existing entry by
topic, either include `update_path: <relative_path>` in frontmatter with the
FULL updated body, or skip it. Only create a NEW entry when materially
distinct from every manifest entry.
"""

    return f"""Compile this raw knowledge into wiki entry format.

Source: {source_name}
Title: {raw['title']}

Content:
{raw['body']}

Today's date: {date.today().isoformat()}
Source name for frontmatter: {source_name}
{manifest_section}
Return ONLY the frontmatter + markdown body. If there are multiple
distinct learnings, separate them with ---SPLIT---."""


def parse_compile_response(response: str) -> list[str]:
    """Parse an LLM/agent compile response into a list of entry texts.

    Splits on ---SPLIT---, strips code fences, and keeps only chunks that
    look like frontmatter (start with '---'). Pure so it can parse both the
    inline engine's output and the compiler agent's staged output."""
    entries: list[str] = []
    chunks = response.split("---SPLIT---")
    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue
        # Strip markdown code fences if LLM wrapped it
        chunk = re.sub(r'^```(?:markdown|yaml)?\s*\n?', '', chunk)
        chunk = re.sub(r'\n?```\s*$', '', chunk)
        chunk = chunk.strip()
        if chunk.startswith('---'):
            entries.append(chunk)
    return entries


def compile_entry(engine: Engine, raw: dict, source_name: str, wiki_manifest: str = "") -> list[str]:
    """LLM-compile a raw entry into one or more wiki entries (inline path).

    Thin wrapper: build the prompt, call the engine, parse the response. The
    staged agent-driven path (stage_compile) instead stages
    `build_compile_prompt(...)` for a spawned compiler agent and parses its
    output in apply_compile — bypassing the inline engine entirely.
    """
    prompt = build_compile_prompt(raw, source_name, wiki_manifest)
    response = engine.llm_call(prompt, system=COMPILE_PROMPT_SYSTEM)
    return parse_compile_response(response)


def _extract_domain_from_entry(entry_text: str) -> str:
    """Extract domain from compiled entry frontmatter for directory placement."""
    match = re.search(r'domain:\s*\[([^\]]+)\]', entry_text)
    if match:
        domains = [d.strip().strip("'\"") for d in match.group(1).split(',')]
        if domains:
            return _slugify(domains[0])
    return "general"


def _extract_title_from_entry(entry_text: str) -> str:
    """Extract title from compiled entry frontmatter."""
    match = re.search(r'title:\s*(.+)', entry_text)
    if match:
        return match.group(1).strip().strip("'\"")
    return "untitled"


def write_wiki_entry(config: Config, entry_text: str) -> Optional[Path]:
    """Write a compiled entry to the wiki directory.

    Honors `update_path:` in the LLM's output — if present and pointing
    to an existing wiki file, OVERWRITES that file. The update_path line
    is stripped from frontmatter before write so the wiki file stays clean.
    Returns the path written, or None if the entry was empty (LLM returned
    nothing because it judged this a no-op against the manifest).
    """
    if not entry_text.strip().startswith("---"):
        # LLM declined to extract — empty/whitespace response under the
        # "skip when manifest covers this" rule.
        return None

    update_path_match = re.search(
        r"^update_path:\s*(.+)$", entry_text, re.MULTILINE,
    )
    if update_path_match:
        rel = update_path_match.group(1).strip().strip("'\"")
        # Strip the update_path line — it's a routing hint, not real frontmatter
        entry_text = re.sub(
            r"^update_path:\s*.+\n", "", entry_text, count=1, flags=re.MULTILINE,
        )
        target = (config.wiki_dir / rel).resolve()
        # Safety: confirm the target is inside wiki_dir (no path traversal)
        try:
            target.relative_to(config.wiki_dir.resolve())
        except ValueError:
            target = None  # fall through to normal write
        if target is not None and target.exists():
            target.write_text(entry_text + "\n")
            return target
        # update_path didn't resolve — fall through to normal write below

    domain = _extract_domain_from_entry(entry_text)
    title = _extract_title_from_entry(entry_text)
    slug = _slugify(title)

    domain_dir = config.wiki_dir / domain
    domain_dir.mkdir(parents=True, exist_ok=True)

    filename = f"{slug}.md"
    filepath = domain_dir / filename

    # Handle name collisions
    counter = 2
    while filepath.exists():
        filepath = domain_dir / f"{slug}-{counter}.md"
        counter += 1

    filepath.write_text(entry_text + "\n")
    return filepath


def write_compiled_entries(
    config: Config, entries: list[str], wiki_manifest: str,
    *, source_name: str = "", source_title: str = "",
) -> dict:
    """Write a batch of compiled entry texts to the wiki, applying the
    workflow-template rejection filter and new/update/noop accounting.

    Shared by the inline compile path (run_compile) and the agent-driven
    apply path (apply_compile) so both classify, write, and count identically.
    Returns a stats dict; the caller owns run-level aggregation + logging.
    """
    stats = {
        "new": 0,
        "updated": 0,
        "noop": 0,
        "skipped_workflow_template": 0,
        "written_files": [],
        "rejections": [],
    }
    for entry_text in entries:
        rejection_reason = _classify_workflow_template(entry_text)
        if rejection_reason is not None:
            stats["skipped_workflow_template"] += 1
            stats["rejections"].append({
                "source": source_name,
                "title": source_title[:120],
                "reason": rejection_reason,
            })
            print(f"    -> [SKIP-WORKFLOW] {source_title[:60]} — {rejection_reason}")
            continue
        path = write_wiki_entry(config, entry_text)
        if path is None:
            # Declined to extract — covered by manifest.
            stats["noop"] += 1
            continue
        stats["written_files"].append(str(path))
        is_update = bool(wiki_manifest) and (
            f"] {path.relative_to(config.wiki_dir)}:" in wiki_manifest
        )
        marker = "UPDATE" if is_update else "NEW"
        print(f"    -> [{marker}] {path.relative_to(config.wiki_root)}")
        if is_update:
            stats["updated"] += 1
        else:
            stats["new"] += 1
    return stats


def run_compile(
    config: Optional[Config] = None,
    dry_run: bool = False,
    max_entries_transcript: Optional[int] = None,
    max_entries_other: Optional[int] = None,
    max_taste_entries: Optional[int] = None,
    recent_days: Optional[int] = None,
    stage_taste_path: Optional[str] = None,
    stage_compile_path: Optional[str] = None,
    max_entries: Optional[int] = None,
) -> dict:
    """Run the full compilation pipeline.

    Per-class wiki-extraction budgets (avoids priority inversion when a busy
    intake source starves another in iteration order):
      `max_entries_transcript` — cap on wiki extractions from transcript
        sources (taste extraction is bounded separately by `max_taste_entries`).
      `max_entries_other` — cap on wiki extractions from non-transcript
        sources (skills, learnings, frontmatter notes).
      `max_entries` — deprecated single-budget knob; applied to BOTH counters
        independently if neither class-specific value is set. Will be removed.

    `max_taste_entries` independently caps taste-extraction LLM calls.
    `recent_days` restricts the inbox walk to files modified within the last
    N days.
    `stage_taste_path` switches taste from inline LLM calls to staged mode:
    eligible transcripts are collected and written to this path as a JSON
    payload (transcripts + principles_manifest) for a downstream COO spawn
    to process. The dream cycle's `apply_taste` step reads the same path
    after COO fills in outcomes.
    """
    if max_entries is not None:
        if max_entries_transcript is None:
            max_entries_transcript = max_entries
        if max_entries_other is None:
            max_entries_other = max_entries
    config = config or load_config()
    engine = get_engine(config)
    hashes = _load_compiled_hashes(config)

    print("Collecting raw entries from inbox/...")
    raw_entries = collect_raw_entries(config, recent_days=recent_days)
    print(f"  Found {len(raw_entries)} raw entries")

    # Build the wiki manifest ONCE per run — every LLM call sees the same
    # snapshot of "what's already in the wiki". Re-running compile in the
    # same dream cycle pass won't double-process because the hash cache
    # skips entries we've already compiled; the manifest is the dedup
    # signal for entries that look similar but weren't seen before.
    print("Building wiki manifest for LLM pre-injection...")
    wiki_manifest = build_wiki_manifest(config)
    manifest_byte_count = len(wiki_manifest.encode("utf-8"))
    print(f"  Manifest: {wiki_manifest.count(chr(10)) + 1} entries, {manifest_byte_count} bytes")

    # Principles manifest — used by the judge-shape v2 reverse-engineer branch.
    # Groups existing principles by domain so the LLM can decide candidate vs.
    # evidence rather than inventing duplicate siblings.
    principles_manifest = build_principles_manifest()
    principles_lines = principles_manifest.count("\n") + 1 if principles_manifest else 0
    print(f"  Principles manifest: {principles_lines} lines across {len(VALID_DOMAINS)} domains")

    new_count = 0
    update_count = 0
    skip_compiled = 0
    skip_noop = 0
    error_count = 0
    skill_candidates_new = 0
    skill_candidates_merged = 0
    skill_evidence_appended = 0
    skill_promotions = 0
    skill_neither = 0
    skipped_limit_transcript = 0
    skipped_limit_other = 0
    skipped_workflow_template = 0
    skipped_taste_limit = 0
    workflow_template_rejections: list[dict] = []
    compiled_transcript = 0
    compiled_other = 0
    taste_called_this_run = 0
    written_files = []
    skill_files: list[str] = []
    # Staged taste mode: collect eligible transcripts for downstream COO
    # batch processing instead of inline LLM calls.
    staged_transcripts: list[dict] = []
    stage_taste = stage_taste_path is not None
    # Deferred hash commits — in staged mode we don't write transcript hashes
    # to the cache until apply_taste confirms each outcome processed. Maps
    # content_key → content_hash for entries that will be committed by apply.
    deferred_hashes: dict[str, str] = {}
    # Staged compile mode: collect the extraction prompt per candidate for a
    # downstream compiler-agent spawn instead of calling the inline engine.
    # Kept in a SEPARATE deferral dict from taste so the two staging files
    # commit their own hashes independently (apply_compile vs apply_taste).
    stage_compile_candidates: list[dict] = []
    stage_compile = stage_compile_path is not None
    compile_deferred_hashes: dict[str, str] = {}

    for i, raw in enumerate(raw_entries):
        # Check if already compiled (by content hash)
        content_key = f"{raw['source_name']}:{raw['title']}"
        content_hash = hashlib.sha256(
            raw['body'].encode()
        ).hexdigest()[:16]

        if hashes.get(content_key) == content_hash:
            skip_compiled += 1
            continue

        # Per-class wiki budgets + independent taste budget. Transcripts and
        # non-transcripts have separate counters so a busy non-transcript day
        # (lots of learnings or skills) can't starve transcript wiki extraction
        # or vice versa. When the transcript wiki cap is hit, transcripts can
        # still reach the taste branch (taste is the only output transcripts
        # exclusively produce).
        is_transcript = raw.get("source_format") in {"transcript-jsonl", "transcript-json"}
        if is_transcript:
            wiki_cap_hit = (
                max_entries_transcript is not None
                and compiled_transcript >= max_entries_transcript
            )
        else:
            wiki_cap_hit = (
                max_entries_other is not None
                and compiled_other >= max_entries_other
            )
        if wiki_cap_hit and not is_transcript:
            skipped_limit_other += 1
            continue

        print(f"  [{i+1}/{len(raw_entries)}] Compiling: {raw['title'][:60]}...")

        if dry_run:
            print(f"    [DRY RUN] Would compile from {raw['source_name']}")
            if not wiki_cap_hit:
                new_count += 1
                if is_transcript:
                    compiled_transcript += 1
                else:
                    compiled_other += 1
            continue

        try:
            if wiki_cap_hit:
                # Only transcripts reach here (non-transcripts continue above).
                # Skip wiki compile for this transcript; taste branch may still
                # run below.
                skipped_limit_transcript += 1
            elif stage_compile:
                # Agent-driven compile: stage the exact extraction prompt for a
                # downstream compiler-agent spawn instead of calling the inline
                # Gemini engine. apply_compile parses the agent's entries and
                # writes them via the same write_compiled_entries path. The
                # hash defers until apply_compile confirms (mirrors staged taste)
                # so a stalled compiler re-stages the candidate next night.
                stage_compile_candidates.append({
                    "content_key": content_key,
                    "source_name": raw['source_name'],
                    "title": raw['title'],
                    # include_manifest=False: the manifest is carried ONCE at the
                    # staging top-level, not duplicated into every candidate prompt.
                    "prompt": build_compile_prompt(
                        raw, raw['source_name'], wiki_manifest, include_manifest=False,
                    ),
                    "entries": None,
                })
                compile_deferred_hashes[content_key] = content_hash
                print("    -> [STAGED-COMPILE] queued for compiler agent")
            else:
                compiled = compile_entry(engine, raw, raw['source_name'], wiki_manifest)
                wstats = write_compiled_entries(
                    config, compiled, wiki_manifest,
                    source_name=raw['source_name'], source_title=raw['title'],
                )
                new_count += wstats["new"]
                update_count += wstats["updated"]
                skip_noop += wstats["noop"]
                skipped_workflow_template += wstats["skipped_workflow_template"]
                written_files.extend(wstats["written_files"])
                workflow_template_rejections.extend(wstats["rejections"])

            # Determine whether this entry's hash will be deferred. In staged
            # modes the hash is committed by the apply step AFTER the agent's
            # output is processed — this prevents the cache from advancing past
            # work that hasn't yet been distilled/extracted, so a failed
            # agent/apply step re-stages it next night instead of losing it.
            will_defer_hash = (
                (stage_compile and not wiki_cap_hit)
                or (
                    stage_taste
                    and is_transcript
                    and is_taste_eligible(raw)
                    and (max_taste_entries is None or taste_called_this_run < max_taste_entries)
                )
            )
            if not will_defer_hash:
                hashes[content_key] = content_hash
            if not wiki_cap_hit:
                if is_transcript:
                    compiled_transcript += 1
                else:
                    compiled_other += 1

            # Judge-shape v2 reverse-engineer — runs as a SECOND LLM call only
            # for taste-eligible transcripts. Each transcript contributes at
            # most ONE evidence record toward a principle; promotion from
            # `_holding/` to `bundles/` happens when ≥2 records triangulate.
            # Independent cap via `max_taste_entries` so notes/skills filling
            # the wiki cap don't starve taste extraction. Runs even when the
            # wiki cap is hit, as long as the taste cap is not.
            if is_transcript and is_taste_eligible(raw):
                if max_taste_entries is not None and taste_called_this_run >= max_taste_entries:
                    skipped_taste_limit += 1
                    print(f"    Taste-eligible but skipped (taste-limit {max_taste_entries} reached)")
                    continue
                # Staged taste mode: collect the transcript for COO batch
                # processing instead of calling the LLM inline. The hash
                # stays in `deferred_hashes` until apply_taste commits it.
                if stage_taste:
                    staged_transcripts.append({
                        "title": raw.get("title", ""),
                        "source_file": raw.get("source_file", ""),
                        "source_name": raw.get("source_name", ""),
                        "content_key": content_key,
                        "user_turns": raw.get("user_turns"),
                        "assistant_turns": raw.get("assistant_turns"),
                        "body_chars": raw.get("body_chars"),
                        "body": raw.get("body", ""),
                    })
                    deferred_hashes[content_key] = content_hash
                    taste_called_this_run += 1
                    print(f"    Taste-eligible (staged for COO; "
                          f"user_turns={raw['user_turns']}, chars={raw['body_chars']})")
                    continue
                taste_called_this_run += 1
                print(f"    Taste-eligible (user_turns={raw['user_turns']}, "
                      f"assistant_turns={raw['assistant_turns']}, chars={raw['body_chars']})")
                outcome = extract_skill_update(engine, raw, principles_manifest)
                if outcome:
                    kind = outcome.get("outcome", "neither")
                    if kind == "neither":
                        skill_neither += 1
                        print(f"      principle outcome: NEITHER ({outcome.get('rationale', '')[:80]})")
                    else:
                        applied = apply_skill_outcome(outcome)
                        if applied:
                            proposal_path, action = applied
                            skill_files.append(str(proposal_path))
                            rel = proposal_path.relative_to(Path.home())
                            if action == "candidate-new":
                                skill_candidates_new += 1
                                print(f"      principle CANDIDATE-NEW: {rel}")
                            elif action == "candidate-merged":
                                skill_candidates_merged += 1
                                print(f"      principle CANDIDATE-MERGED: {rel}")
                            elif action == "evidence-appended":
                                skill_evidence_appended += 1
                                print(f"      principle EVIDENCE-APPENDED: {rel}")
                            elif action == "promoted-to-leaf":
                                skill_promotions += 1
                                print(f"      principle PROMOTED-TO-LEAF: {rel}")
                            # After promotion or new evidence, the manifest is
                            # stale for the rest of this run. Rebuild so later
                            # transcripts see the updated state.
                            principles_manifest = build_principles_manifest()
        except Exception as e:
            print(f"    ERROR: {e}")
            error_count += 1

    if not dry_run:
        _save_compiled_hashes(config, hashes)

    # Staged taste mode: write the staging file with the collected
    # transcripts + principles_manifest for a downstream COO batch.
    if stage_taste and not dry_run:
        staging_path = Path(stage_taste_path)
        staging_path.parent.mkdir(parents=True, exist_ok=True)
        staging_payload = {
            "principles_manifest": principles_manifest,
            "valid_domains": sorted(VALID_DOMAINS),
            "transcripts": staged_transcripts,
            "outcomes": None,  # COO fills in
            # apply_taste commits these to the real hash cache only for
            # transcripts whose outcome was successfully applied (or "neither").
            # Parse/apply errors leave the hash uncommitted so the transcript
            # is eligible for re-staging next night.
            "deferred_hashes": deferred_hashes,
        }
        staging_path.write_text(json.dumps(staging_payload, indent=2), encoding="utf-8")
        print(f"  Staged {len(staged_transcripts)} taste-eligible transcripts → {staging_path}")
        print(f"  Deferred {len(deferred_hashes)} hashes until apply_taste confirms")

    # Staged compile mode: write the compile staging file with one extraction
    # prompt per candidate for a downstream compiler-agent spawn. apply_compile
    # reads this, writes the agent's entries, and commits the deferred hashes.
    if stage_compile and not dry_run:
        compile_staging = Path(stage_compile_path)
        compile_staging.parent.mkdir(parents=True, exist_ok=True)
        compile_payload = {
            "wiki_manifest": wiki_manifest,
            "candidates": stage_compile_candidates,  # each: {content_key, source_name, title, prompt, entries: null}
            # apply_compile commits these only for candidates whose entries
            # were successfully written (or were a manifest-noop). Errors leave
            # the hash uncommitted so the candidate re-stages next night.
            "deferred_hashes": compile_deferred_hashes,
        }
        compile_staging.write_text(json.dumps(compile_payload, indent=2), encoding="utf-8")
        print(f"  Staged {len(stage_compile_candidates)} compile candidates → {compile_staging}")
        print(f"  Deferred {len(compile_deferred_hashes)} hashes until apply_compile confirms")

    # Write a per-day audit log of rejected workflow templates so the
    # detector's behavior is reviewable. Lives next to dream_cycle/logs/
    # alongside the daily run log. Empty days don't write a file.
    if workflow_template_rejections and not dry_run:
        log_dir = Path(__file__).resolve().parent / "logs"
        log_dir.mkdir(exist_ok=True)
        log_path = log_dir / f"skipped-workflows-{date.today().isoformat()}.md"
        lines = [
            f"# Skipped workflow-template extractions — {date.today().isoformat()}",
            "",
            f"Compile detector rejected {len(workflow_template_rejections)} extractions",
            "as workflow templates (not knowledge). See _classify_workflow_template",
            "in dream_cycle/compile.py for the rules.",
            "",
        ]
        for r in workflow_template_rejections:
            lines.append(f"- **{r['title']}** — _{r['reason']}_  (source: `{r['source']}`)")
        log_path.write_text("\n".join(lines) + "\n")

    skipped_limit_total = skipped_limit_transcript + skipped_limit_other
    stats = {
        "total_raw": len(raw_entries),
        "new": new_count,
        "updated": update_count,
        "skipped_already_compiled": skip_compiled,
        "skipped_noop": skip_noop,
        "skipped_workflow_template": skipped_workflow_template,
        "errors": error_count,
        "skipped_limit": skipped_limit_total,
        "skipped_limit_transcript": skipped_limit_transcript,
        "skipped_limit_other": skipped_limit_other,
        "compiled_transcript": compiled_transcript,
        "compiled_other": compiled_other,
        "max_entries_transcript": max_entries_transcript,
        "max_entries_other": max_entries_other,
        "skipped_taste_limit": skipped_taste_limit,
        "taste_called": taste_called_this_run,
        "taste_mode": "staged" if stage_taste else "inline",
        "staged_transcripts": len(staged_transcripts),
        "stage_taste_path": stage_taste_path if stage_taste else None,
        "manifest_bytes": manifest_byte_count,
        "files_written": written_files,
        "skill_candidates_new": skill_candidates_new,
        "skill_candidates_merged": skill_candidates_merged,
        "skill_evidence_appended": skill_evidence_appended,
        "skill_promotions": skill_promotions,
        "skill_neither": skill_neither,
        "skill_files": skill_files,
    }
    print(
        f"\nDone: {new_count} new, {update_count} updated, "
        f"{skip_compiled} previously-compiled, {skip_noop} manifest-noop, "
        f"{skipped_limit_total} skipped-by-limit "
        f"({skipped_limit_transcript} transcript / {skipped_limit_other} other), "
        f"{skipped_workflow_template} skipped-as-workflow-template, "
        f"{error_count} errors"
    )
    if (
        skill_candidates_new
        or skill_candidates_merged
        or skill_evidence_appended
        or skill_promotions
        or skill_neither
    ):
        print(
            f"Principles: {skill_candidates_new} new candidates, "
            f"{skill_candidates_merged} merged into candidates, "
            f"{skill_evidence_appended} evidence appended, "
            f"{skill_promotions} promoted to leaf, "
            f"{skill_neither} neither"
        )
        if skill_files:
            print(f"Principle files touched (review at {SKILL_PROPOSALS_DIR}):")
            for sf in skill_files[:10]:
                print(f"  - {sf}")
    return stats


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    max_entries = None
    max_taste = None
    recent_days = None
    if "--compile-limit" in sys.argv:
        idx = sys.argv.index("--compile-limit")
        try:
            max_entries = max(0, int(sys.argv[idx + 1]))
        except (IndexError, ValueError):
            raise SystemExit("--compile-limit requires a non-negative integer")
    if "--taste-limit" in sys.argv:
        idx = sys.argv.index("--taste-limit")
        try:
            max_taste = max(0, int(sys.argv[idx + 1]))
        except (IndexError, ValueError):
            raise SystemExit("--taste-limit requires a non-negative integer")
    if "--recent-days" in sys.argv:
        idx = sys.argv.index("--recent-days")
        try:
            recent_days = max(0, int(sys.argv[idx + 1]))
        except (IndexError, ValueError):
            raise SystemExit("--recent-days requires a non-negative integer")
    if dry_run:
        print("=== DRY RUN (no files written, no LLM calls) ===\n")
    run_compile(
        dry_run=dry_run,
        max_entries=max_entries,
        max_taste_entries=max_taste,
        recent_days=recent_days,
    )
