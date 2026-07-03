#!/usr/bin/env python3
"""
Daily digest — split into 3 workflow steps:

  Step 1 (this script with --stage):
    Gathers raw data only. No LLM summarization.
    Writes: tldr counts, wiki_entries, taste_entries, agent_raw_prompts
            (mix of pre-summarized deterministic topics and raw user prompts
            for COO to summarize in step 2).

  Step 2 (COO spawn, in workflow):
    Reads the staged raw data. Summarizes each raw prompt into one human
    sentence. Builds the presentation JSON. Writes a polished markdown
    version. Saves both back to the staging file.

  Step 3 (this script with --publish):
    Reads staging.presentation, posts to Discord. Writes staging.markdown
    to memory log if present.

Modes (mutually exclusive):
  default        Single-shot: stage + ad-hoc summarize via gemini-flash +
                 post (legacy; kept for manual one-off runs).
  --stage <path> Step 1 only: write raw-data staging JSON.
  --publish <path>
                 Step 3 only: post a COO-completed presentation.

Other flags:
  --date YYYY-MM-DD  Target date (default: yesterday in PT)
  --dry-run          Don't write or post anything; print payload
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from digest.config import load_paths

ORCH_DB = Path(os.path.expanduser("~/.openclaw/data/task-orchestrator.db"))
# Live orchestrator DB (gateway-owned). The summarize spawn returns the
# built presentation+markdown via tasks.handoff (NOT by writing the staging
# file — that needs an interpreter and trips OpenClaw's exec-approval gate).
# publish reads that handoff envelope back from here. This is the same
# stage -> spawn -> apply-reads-handoff pattern the dream cycle uses.
#
# All machine-specific values resolve through digest.config via the
# arg → env → default contract. NOTHING personal (Discord channel id, user
# paths, memory dir) is baked into this source — see config.py's privacy note.
_PATHS = load_paths()
BRAIN_DB = _PATHS.brain_db
MEMORY_DIR = _PATHS.memory_dir            # Optional[Path]: None → skip secondary log
REPO_DIGEST_DIR = _PATHS.digest_dir
DREAM_CYCLE_LOGS = _PATHS.dream_cycle_logs
WIKI_ROOT = _PATHS.wiki_dir
SKILLS_PROPOSALS = _PATHS.skills_proposals

SUMMARY_CACHE = Path(os.path.expanduser("~/.cache/daily-digest/topic-summaries.json"))

# config.yaml is the single source of truth for which runtimes contribute
# transcripts and where they live. `digital-me setup` auto-populates
# `sources:` from each runtime package's `TRANSCRIPT_SOURCE` manifest, so
# adding a new agent doesn't require editing this script. The defaults below
# are last-resort fallbacks used only when config can't be parsed.
DIGITAL_ME_CONFIG = _PATHS.config_path

_DEFAULT_SOURCE_PATHS: dict[str, str] = {
    "claude-code-jsonl": "~/.claude/projects",
    "codex-jsonl": "~/.codex/sessions",
    "openclaw-agent-jsonl": "~/.openclaw/agents",
    "hermes-session-json": "~/.hermes/sessions",
}
_DEFAULT_GLOBS: dict[str, str] = {
    "hermes-session-json": "session_*.json",
}

# Optional[str]: supplied per-install via $DIGITAL_ME_DIGEST_CHANNEL or
# config.yaml `digest.discord_channel`. Required only for a real --publish.
DISCORD_CHANNEL = _PATHS.discord_channel
# Chat platform delivery rides openclaw's transport (the `--channel` value).
# Defaults to "discord"; a Slack user sets digest.channel_platform=slack (+ a
# slack target) and no digest code changes — see config.resolve_channel_platform.
CHANNEL_PLATFORM = _PATHS.channel_platform
# Optional[str]: resolved from $OPENCLAW_CLI / PATH / ~/.local/bin; None if absent.
OPENCLAW_CLI = _PATHS.openclaw_cli
TZ = ZoneInfo("America/Los_Angeles")

# `tone` values supported by openclaw message send --presentation:
#   success | danger | info | warning  (subset of MessagePresentation tones)
TONE_NORMAL = "success"
TONE_QUIET = "info"  # nothing distilled, low-signal day


def _load_transcript_sources() -> dict[str, dict]:
    """Read `sources:` from digital-me/config.yaml into a dict keyed by
    format. Falls back to baked-in defaults when the config is missing,
    unparseable, or doesn't list a given format — so this script keeps
    working on a fresh setup before `digital-me setup` has been run.
    """
    parsed: list[dict] = []
    if DIGITAL_ME_CONFIG.exists():
        try:
            import yaml  # PyYAML; vendored in the user's Python env

            data = yaml.safe_load(DIGITAL_ME_CONFIG.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                raw = data.get("sources")
                if isinstance(raw, list):
                    parsed = [s for s in raw if isinstance(s, dict)]
        except Exception:
            parsed = []

    home = os.path.expanduser("~")
    sources: dict[str, dict] = {}
    for s in parsed:
        fmt = s.get("format")
        path = s.get("path")
        if not isinstance(fmt, str) or not isinstance(path, str):
            continue
        sources[fmt] = {
            "name": s.get("name", fmt),
            "path": path.replace("$HOME", home).replace("${HOME}", home),
            "format": fmt,
            "glob": s.get("glob"),
        }

    # Fallback for any format missing from config — preserves the
    # legacy behavior so this script keeps producing output even if
    # the user hasn't re-run `digital-me setup` yet.
    for fmt, default_path in _DEFAULT_SOURCE_PATHS.items():
        if fmt in sources:
            continue
        sources[fmt] = {
            "name": fmt,
            "path": os.path.expanduser(default_path),
            "format": fmt,
            "glob": _DEFAULT_GLOBS.get(fmt),
        }
    return sources


# ---------- Dream cycle log parsing ----------

def _parse_dream_cycle_log(date_str: str) -> dict:
    """Parse the markdown log emitted by dream_cycle.run for that date."""
    path = DREAM_CYCLE_LOGS / f"{date_str}.md"
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    result: dict = {"compile": {}, "_path": str(path)}
    current_section = None
    for line in text.splitlines():
        if line.startswith("## "):
            current_section = line[3:].strip()
            result[current_section] = {}
        elif line.startswith("- ") and current_section:
            m = re.match(r"- (\w+): (.*)", line)
            if m:
                k, v = m.group(1), m.group(2).strip()
                # files_written / skill_files come as a Python literal list str
                if v.startswith("[") and v.endswith("]"):
                    try:
                        import ast
                        v = ast.literal_eval(v)
                    except (ValueError, SyntaxError):
                        pass
                else:
                    try:
                        v = int(v)
                    except ValueError:
                        pass
                result[current_section][k] = v
    return result


def _extract_domains(text: str) -> str:
    """Parse `domain:` from frontmatter — supports three shapes:
    inline list `domain: [a, b]`, block list `domain:\\n  - a\\n  - b`,
    or single string `domain: infra` (used by skill-proposal files)."""
    # Try inline list form: `domain: [a, b, c]`
    m = re.search(r"^domain:\s*\[([^\]]*)\]", text, re.MULTILINE)
    if m:
        items = [d.strip().strip("'\"") for d in m.group(1).split(",") if d.strip()]
        return ", ".join(items)
    # Try block-list form
    m = re.search(r"^domain:\s*\n((?:\s*-\s*[\w\-]+\s*\n)+)", text, re.MULTILINE)
    if m:
        items = re.findall(r"-\s*([\w\-]+)", m.group(1))
        return ", ".join(items)
    # Single-string form: `domain: infra`
    m = re.search(r"^domain:\s*([\w\-]+)\s*$", text, re.MULTILINE)
    if m:
        return m.group(1)
    return ""


def _extract_yaml_date(text: str, key: str) -> str:
    """Pull a YYYY-MM-DD value from frontmatter (handles quoted + unquoted forms)."""
    m = re.search(rf"^{key}:\s*['\"]?(\d{{4}}-\d{{2}}-\d{{2}})['\"]?", text, re.MULTILINE)
    return m.group(1) if m else ""


def _confined_read(path: Path) -> Optional[str]:
    """Read a text file, but ONLY if it resolves inside the wiki root.

    The wiki/skill paths passed here come from the dream-cycle activity log
    (`files_written` / `skill_files`) — a semi-trusted local artifact. Confining
    the read to the wiki tree stops a poisoned log from turning the digest into
    an arbitrary-file-read → Discord-exfiltration primitive. Returns None when
    the path resolves outside the tree or is unreadable.
    """
    try:
        resolved = path.expanduser().resolve()
    except (OSError, RuntimeError):
        return None
    if not resolved.is_relative_to(_PATHS.wiki_root):
        print(f"[daily-digest] refusing to read outside wiki root: {path}",
              file=sys.stderr)
        return None
    try:
        return resolved.read_text(encoding="utf-8")
    except OSError:
        return None


def _extract_entry_summary(wiki_path: Path) -> tuple[str, str, str, str]:
    """Return (title, domains, created_date, updated_date) from a wiki entry's frontmatter."""
    text = _confined_read(wiki_path)
    if text is None:
        return (wiki_path.stem, "", "", "")
    title = wiki_path.stem.replace("-", " ")
    m = re.search(r"^title:\s*(.+)$", text, re.MULTILINE)
    if m:
        title = m.group(1).strip().strip("'\"")
    domains = _extract_domains(text)
    created = _extract_yaml_date(text, "created")
    updated = _extract_yaml_date(text, "updated")
    return title, domains, created, updated


def _wiki_entries_created_on(date_iso: str) -> list[Path]:
    """Wiki entries whose frontmatter `created` == date_iso — read from the
    TREE itself (the primary source), not from any pipeline's log.

    Why: wiki entries are written by every agent all day long (in-session
    graduation, brain materialization), not only by the overnight dream-cycle
    compiler. Counting `wiki_new` from the dream-cycle log's `files_written`
    was the 2026-07-03 incident: the compiler failed overnight, the log said
    `files_written: []`, and the digest reported "Wiki 0" on a day 29 entries
    landed on disk. The tree cannot lie about what it contains.
    """
    if not date_iso or not WIKI_ROOT.is_dir():
        return []
    out: list[Path] = []
    for md in sorted(WIKI_ROOT.rglob("*.md")):
        if md.name.startswith("_"):
            continue
        try:
            head = md.read_text(encoding="utf-8", errors="ignore")[:4096]
        except OSError:
            continue
        fm = re.match(r"^---\n.*?\n---", head, re.DOTALL)
        if not fm:
            continue
        if _extract_yaml_date(fm.group(0), "created") == date_iso:
            out.append(md)
    return out


def _extract_principle_summary(skill_path: Path) -> tuple[str, str, str, str]:
    """Return (title, domains, created_date, updated_date) from a skill-proposal file."""
    text = _confined_read(skill_path)
    if text is None:
        return (skill_path.stem, "", "", "")
    title = skill_path.stem.replace("-", " ")
    m = re.search(r"^title:\s*(.+)$", text, re.MULTILINE)
    if m:
        title = m.group(1).strip().strip("'\"")
    domains = _extract_domains(text)
    created = _extract_yaml_date(text, "created")
    updated = _extract_yaml_date(text, "updated")
    return title, domains, created, updated


# ---------- Per-agent activity ----------

# Strip date-stamped prefixes added by cron prompts, e.g. "[Wed 2026-05-13 07:00 PDT] Read and follow ..."
_CRON_PREFIX = re.compile(r"^\s*\[[^\]]+\]\s*")
# Recognize workflow-prompt pointers in any of the common paths
_WORKFLOW_PATH = re.compile(r"(?:workflow-prompts|\.clawdbot/prompts(?:/[\w\-]+)?)/([\w\-]+)\.md")
# Messages we should SKIP (boilerplate / wrappers) and look past
_SKIP_PREFIXES = (
    "<environment_context>",
    "<INSTRUCTIONS>",
    "[Inter-session message]",
    "# AGENTS.md",
    "The following is the Codex agent history",
    "sourceSession=",
    "Conversation info (untrusted metadata)",
)
# Special-case tags that ARE meaningful (don't skip, but render cleanly)
_TAG_TOPICS = {
    "<task-orchestrator-board>": "board status check",
}
# Recognize "You are a X worker" / "You are a X agent" — extract role
_ROLE_PATTERN = re.compile(r"^You are an?\s+([^.]+?)(?:\.|$)", re.IGNORECASE)
_TOPIC_FALLBACK_CHARS = 100


def _extract_first_user_prompt(jsonl_path: Path, *, scan_lines: int = 40) -> str:
    """Read first ~N lines of a JSONL session and return the first *meaningful*
    user message — skipping boilerplate wrappers (<environment_context>,
    [Inter-session message]) and looking for the next user turn after them."""
    try:
        with jsonl_path.open("r", encoding="utf-8", errors="ignore") as f:
            for i, line in enumerate(f):
                if i >= scan_lines:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = r.get("message") if isinstance(r.get("message"), dict) else None
                payload = r.get("payload") if isinstance(r.get("payload"), dict) else None
                role = None
                content = None
                # Claude Code: type=user, message.content
                if r.get("type") == "user":
                    role = "user"
                    content = msg.get("content") if msg else None
                # OpenClaw: type=message, message.role=user, message.content
                elif r.get("type") == "message" and msg and msg.get("role") == "user":
                    role = "user"
                    content = msg.get("content")
                # Codex: type=response_item, payload.role=user, payload.content
                elif r.get("type") == "response_item" and payload and payload.get("role") == "user":
                    role = "user"
                    content = payload.get("content")
                if role != "user" or content is None:
                    continue
                text = ""
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list) and content:
                    head = content[0]
                    if isinstance(head, dict):
                        text = head.get("text", "") or head.get("input_text", "") or ""
                    else:
                        text = str(head)
                text = _CRON_PREFIX.sub("", text).strip()
                if not text:
                    continue
                # Skip known wrappers and keep scanning for the real message.
                # Special case: [Inter-session message] wraps a real routed
                # message after the wrapper header — extract that.
                if text.startswith("[Inter-session message]"):
                    parts = text.split("\n\n", 1)
                    if len(parts) == 2 and parts[1].strip():
                        inner = parts[1].strip()
                        if not inner.startswith(_SKIP_PREFIXES):
                            return inner
                    continue
                if text.startswith(_SKIP_PREFIXES):
                    continue
                return text
    except OSError:
        return ""
    return ""


def _topic_from_prompt(text: str) -> str:
    """Compress a raw user prompt to a short topic string."""
    if not text:
        return ""
    # Special-case tag prompts.
    for tag, label in _TAG_TOPICS.items():
        if text.startswith(tag):
            return label
    # Workflow pointer? Use the workflow name.
    m = _WORKFLOW_PATH.search(text)
    if m:
        return f"workflow: {m.group(1)}"
    # Role declaration? Use the role description.
    m = _ROLE_PATTERN.match(text.strip())
    if m:
        role = m.group(1).strip()
        if len(role) <= _TOPIC_FALLBACK_CHARS:
            return f"role: {role}"
    # Drop boilerplate trailers; keep first sentence-ish.
    first_para = text.split("\n", 1)[0]
    if len(first_para) > _TOPIC_FALLBACK_CHARS:
        cut = first_para[:_TOPIC_FALLBACK_CHARS].rsplit(" ", 1)[0]
        return cut + "…"
    return first_para


def _dedup_topics(topics: list[str], max_distinct: int | None = None) -> list[tuple[str, int]]:
    """Collapse repeated cron-prompt topics; returns [(topic, count)] sorted by count.
    Pass max_distinct=None (default) to keep all distinct topics."""
    counts: Counter = Counter()
    for t in topics:
        if not t:
            continue
        counts[t] += 1
    return counts.most_common(max_distinct)


# ---------- LLM summarization for human-readable topics ----------

import hashlib

_DETERMINISTIC_TOPIC = re.compile(r"^(workflow|role): .+$|^board status check$|^/[\w\-:]+$")


def _load_summary_cache() -> dict:
    try:
        return json.loads(SUMMARY_CACHE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _save_summary_cache(cache: dict) -> None:
    try:
        SUMMARY_CACHE.parent.mkdir(parents=True, exist_ok=True)
        SUMMARY_CACHE.write_text(json.dumps(cache, indent=2))
    except OSError:
        pass


_summarize_engine = None
def _get_engine():
    """Lazily build the legacy inline Gemini engine, if available.

    The inline engine is DEPRECATED / fallback-only — the sanctioned LLM path
    is the agent-spawn summarize step. It lives in the optional `dream_cycle`
    package; when that package isn't importable we disable the inline path and
    the digest renders deterministically. No hardcoded source path: `dream_cycle`
    is resolved from the active environment like any other dependency.
    """
    global _summarize_engine, _LLM_DISABLED
    if _summarize_engine is None:
        try:
            from dream_cycle.config import load_config  # type: ignore
            from dream_cycle.engine import get_engine  # type: ignore
            _summarize_engine = get_engine(load_config())
        except Exception as e:
            _LLM_DISABLED = True
            print(f"[daily-digest] inline LLM engine unavailable ({e}); "
                  "rendering deterministically", file=sys.stderr)
            return None
    return _summarize_engine


# --- LLM hang/circuit-breaker guards -----------------------------------------
# OpenClawEngine.llm_call has NO network timeout: if the Gemini endpoint is
# saturated or down, the call blocks forever, the per-prompt fallback never
# fires, and the whole digest render hangs (this is what silently killed the
# digest — same failure class as the COO-spawn stall, different surface).
# We bound every call with a hard wall-clock timeout and trip a circuit breaker
# after a couple of consecutive failures so the run degrades to the regex
# fallback instead of stalling.
_LLM_TIMEOUT_S = int(os.environ.get("DIGEST_LLM_TIMEOUT_S", "8"))
_LLM_MAX_CONSEC_FAILS = int(os.environ.get("DIGEST_LLM_MAX_FAILS", "2"))
_LLM_DISABLED = os.environ.get("DIGEST_NO_LLM") == "1"
_LLM_CONSEC_FAILS = 0


class _LLMTimeout(Exception):
    pass


def _bounded_llm_call(eng, prompt: str, system: str) -> str:
    """Call eng.llm_call with a hard SIGALRM timeout. Raises on timeout/error.

    SIGALRM only arms in the main thread; this CLI is single-threaded so that
    holds. If ever called off-thread, we skip the alarm (best-effort).
    """
    import signal
    import threading

    use_alarm = threading.current_thread() is threading.main_thread()
    if use_alarm:
        def _handler(signum, frame):
            raise _LLMTimeout()
        prev = signal.signal(signal.SIGALRM, _handler)
        signal.alarm(_LLM_TIMEOUT_S)
    try:
        return eng.llm_call(prompt[:2000], system=system).strip()
    finally:
        if use_alarm:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, prev)


_SUMMARIZE_SYSTEM = (
    "You rewrite a user's session prompt as ONE concise sentence describing what "
    "they're working on. Start with a past-tense verb (e.g., 'Reviewed', 'Investigated', "
    "'Refactored', 'Asked', 'Fixed'). Strip code paths, IDs, and quoted blocks. "
    "Maximum 20 words. Reply with ONLY the sentence — no preamble, no quotes."
)


def _clean_prompt_fallback(raw: str) -> str:
    """Readable one-liner from a raw prompt when the LLM summarizer is
    unavailable (e.g. HTTP 429 rate-limit). Pulls the slash-command name out of
    Claude Code <command-*> wrappers, strips XML-ish tags + fenced code, and
    collapses whitespace so the digest never renders raw markup."""
    if not raw:
        return ""
    # Claude Code wraps slash commands: <command-name>/goal</command-name> …
    m = re.search(r"<command-name>\s*(/?[\w\-:]+)\s*</command-name>", raw)
    if m:
        name = m.group(1)
        args = re.search(r"<command-args>\s*(.*?)\s*</command-args>", raw, re.S)
        arg_txt = re.sub(r"\s+", " ", (args.group(1) if args else "")).strip()
        label = f"Invoked {name}"
        if arg_txt:
            label += f" — {arg_txt[:80]}"
        return label[:140]
    txt = re.sub(r"```.*?```", " ", raw, flags=re.S)  # fenced code
    txt = re.sub(r"<[^>]+>", " ", txt)                 # XML-ish tags
    txt = txt.replace("`", "")
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt[:140]


def _summarize_prompt(raw_prompt: str, cache: dict) -> str:
    """Return a one-sentence human description of what the user is doing.

    Skips the LLM call for already-clean deterministic topics (workflow:X,
    role:X, board status check, slash commands) — they're readable as-is.
    Caches everything else by SHA-16 of the prompt text so daily reruns
    don't re-summarize repeated prompts.
    """
    if not raw_prompt:
        return ""
    if _DETERMINISTIC_TOPIC.match(raw_prompt):
        # Convert workflow:X / role:X into a sentence
        if raw_prompt.startswith("workflow: "):
            return f"Ran workflow `{raw_prompt[len('workflow: '):]}`"
        if raw_prompt.startswith("role: "):
            return f"Acted as {raw_prompt[len('role: '):]}"
        if raw_prompt == "board status check":
            return "Checked task-orchestrator board status"
        if raw_prompt.startswith("/"):
            return f"Invoked slash command {raw_prompt}"
    key = hashlib.sha256(raw_prompt.encode("utf-8")).hexdigest()[:16]
    if key in cache:
        return cache[key]
    # Circuit breaker: once the LLM has stalled/errored repeatedly, stop calling
    # it for the rest of the run and summarize deterministically. Bounds the
    # worst case to ~(_LLM_MAX_CONSEC_FAILS * _LLM_TIMEOUT_S) seconds instead of
    # hanging forever or paying the timeout on every single prompt.
    global _LLM_CONSEC_FAILS, _LLM_DISABLED
    if _LLM_DISABLED:
        return _clean_prompt_fallback(raw_prompt)
    try:
        eng = _get_engine()
        if eng is None:
            return _clean_prompt_fallback(raw_prompt)
        out = _bounded_llm_call(eng, raw_prompt, _SUMMARIZE_SYSTEM)
        _LLM_CONSEC_FAILS = 0
        # Strip surrounding quotes if any
        out = out.strip('"').strip("'").strip()
        # Sanity bound
        if not out or len(out) > 300:
            out = _clean_prompt_fallback(raw_prompt)
        cache[key] = out
        return out
    except BaseException as e:  # incl. _LLMTimeout (raised from a signal)
        _LLM_CONSEC_FAILS += 1
        reason = "timed out" if isinstance(e, _LLMTimeout) else repr(e)
        print(f"[daily-digest] summarize {reason} "
              f"({_LLM_CONSEC_FAILS}/{_LLM_MAX_CONSEC_FAILS})", file=sys.stderr)
        if _LLM_CONSEC_FAILS >= _LLM_MAX_CONSEC_FAILS:
            _LLM_DISABLED = True
            print("[daily-digest] LLM summarizer disabled for this run — "
                  "rendering remaining prompts deterministically", file=sys.stderr)
        return _clean_prompt_fallback(raw_prompt)


def _summarize_and_group(raw_prompts: list[str], cache: dict) -> list[tuple[str, int]]:
    """Summarize each prompt and group by summary. Returns [(summary, count)]."""
    summaries = [_summarize_prompt(p, cache) for p in raw_prompts if p]
    counts: Counter = Counter(s for s in summaries if s)
    return counts.most_common()


def _claude_code_raw_prompts(start_ms: int, end_ms: int, root: Path) -> list[str]:
    """Flat list of first-user-prompts across all Claude Code sessions in window."""
    if not root.exists():
        return []
    prompts: list[str] = []
    for project_dir in root.iterdir():
        if not project_dir.is_dir():
            continue
        for jsonl in project_dir.rglob("*.jsonl"):
            try:
                mtime_ms = int(jsonl.stat().st_mtime * 1000)
            except OSError:
                continue
            if start_ms <= mtime_ms < end_ms:
                prompt = _extract_first_user_prompt(jsonl)
                topic = _topic_from_prompt(prompt)  # may collapse to workflow:X / role:X
                # Prefer the cleaned topic if it's deterministic; otherwise pass
                # the raw prompt for LLM summarization.
                prompts.append(topic if _DETERMINISTIC_TOPIC.match(topic or "") else prompt)
    return prompts


def _decode_claude_project_name(encoded: str) -> str:
    """Decode a Claude project dir name: dashes become slashes, the home prefix
    collapses to ~, and a `.../claude/worktrees/<slug>` tail renders as a
    `[worktree:<slug>]` label."""
    name = encoded.replace("-", "/")
    home = str(Path.home())
    if name.startswith(home):
        name = "~" + name[len(home):]
    if name == "~" or name == "~/":
        return "~ (home directory)"
    # Worktrees show as `.../claude/worktrees/<slug>` after the double-slash collapse
    m = re.match(r"(.+?)//claude/worktrees/(.+)", name)
    if m:
        return f"{m.group(1)} [worktree:{m.group(2)}]"
    return name


def _codex_raw_prompts(start_ms: int, end_ms: int, root: Path) -> list[str]:
    """Flat list of first-user-prompts across all Codex sessions in window."""
    if not root.exists():
        return []
    prompts: list[str] = []
    for jsonl in root.rglob("*.jsonl"):
        try:
            mtime_ms = int(jsonl.stat().st_mtime * 1000)
        except OSError:
            continue
        if not (start_ms <= mtime_ms < end_ms):
            continue
        prompt = _extract_first_user_prompt(jsonl)
        topic = _topic_from_prompt(prompt)
        prompts.append(topic if _DETERMINISTIC_TOPIC.match(topic or "") else prompt)
    return prompts


def _openclaw_agents_raw_prompts(
    start_ms: int, end_ms: int, root: Path,
) -> dict[str, list[str]]:
    """Per-agent flat lists of first-user-prompts (or deterministic topics)."""
    if not root.exists():
        return {}
    out: dict[str, list[str]] = {}
    for agent_dir in sorted(root.iterdir()):
        if not agent_dir.is_dir():
            continue
        prompts: list[str] = []
        for f in agent_dir.rglob("*.jsonl"):
            if f.name.endswith(".trajectory.jsonl"):
                continue
            try:
                mtime_ms = int(f.stat().st_mtime * 1000)
            except OSError:
                continue
            if start_ms <= mtime_ms < end_ms:
                prompt = _extract_first_user_prompt(f)
                topic = _topic_from_prompt(prompt)
                prompts.append(topic if _DETERMINISTIC_TOPIC.match(topic or "") else prompt)
        if prompts:
            out[agent_dir.name] = prompts
    return out


def _extract_first_user_prompt_from_hermes_session(json_path: Path) -> str:
    """Read a Hermes `session_*.json` file and return its first meaningful
    user message. Hermes stores the whole session as one JSON object with
    a `messages: [{role, content}]` list — unlike the JSONL-per-turn shape
    Claude Code / Codex / OpenClaw use."""
    try:
        with json_path.open("r", encoding="utf-8", errors="ignore") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return ""
    if not isinstance(data, dict):
        return ""
    messages = data.get("messages")
    if not isinstance(messages, list):
        return ""
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content")
        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list) and content:
            head = content[0]
            if isinstance(head, dict):
                text = head.get("text") or head.get("input_text") or ""
            else:
                text = str(head)
        text = _CRON_PREFIX.sub("", text).strip()
        if not text or text.startswith(_SKIP_PREFIXES):
            continue
        if text.startswith("[Inter-session message]"):
            parts = text.split("\n\n", 1)
            if len(parts) == 2 and parts[1].strip():
                inner = parts[1].strip()
                if not inner.startswith(_SKIP_PREFIXES):
                    return inner
            continue
        return text
    return ""


def _hermes_raw_prompts(
    start_ms: int, end_ms: int, root: Path, glob: str | None,
) -> list[str]:
    """Flat list of first-user-prompts across all Hermes sessions in window."""
    if not root.exists():
        return []
    pattern = glob or "session_*.json"
    prompts: list[str] = []
    for f in root.glob(pattern):
        try:
            mtime_ms = int(f.stat().st_mtime * 1000)
        except OSError:
            continue
        if not (start_ms <= mtime_ms < end_ms):
            continue
        prompt = _extract_first_user_prompt_from_hermes_session(f)
        if not prompt:
            continue
        topic = _topic_from_prompt(prompt)
        prompts.append(topic if _DETERMINISTIC_TOPIC.match(topic or "") else prompt)
    return prompts


def _coo_goals(start_ms: int, end_ms: int) -> list[tuple[str, int]]:
    """Goals worked on by COO (orchestrator-tracked) yesterday — secondary signal
    for the COO line; supplements session-count with goal names."""
    db = sqlite3.connect(f"file:{ORCH_DB}?mode=ro", uri=True)
    rows = db.execute(
        """
        SELECT g.name AS goal_name, COUNT(*) AS n
          FROM tasks t
          JOIN goals g ON g.id = t.goal_id
         WHERE t.status = 'completed'
           AND t.completed_at BETWEEN ? AND ?
           AND json_extract(t.dispatch, '$.agentId') = 'coo'
         GROUP BY g.name
         ORDER BY n DESC
        """,
        (start_ms, end_ms),
    ).fetchall()
    db.close()
    return rows


def _count_active_agents(cc_projects, codex_sessions, openclaw_agents) -> int:
    """Active agent count: distinct OpenClaw agents + Claude Code (if any) + Codex (if any)."""
    n = len(openclaw_agents)
    if cc_projects:
        n += 1
    if codex_sessions:
        n += 1
    return n


# ---------- Render ----------

def render_full(date_str: str) -> tuple[str, dict]:
    """Render the full markdown digest + a structured dict for components.

    The dream cycle that captures `date_str`'s activity runs in the early
    morning of the *following* day. So a digest for 2026-05-14 reads the
    dream cycle log dated 2026-05-15 (which fired at 2:47 AM with data
    covering everything up to that moment).
    """
    target = datetime.date.fromisoformat(date_str)
    dream_cycle_date = (target + datetime.timedelta(days=1)).isoformat()
    log = _parse_dream_cycle_log(dream_cycle_date)
    # Fallback: if the morning-after log isn't available yet, read the
    # same-day log so we don't go fully empty.
    if not log:
        log = _parse_dream_cycle_log(date_str)
    compile_stats = log.get("compile", {})

    files_written = compile_stats.get("files_written") or []
    if not isinstance(files_written, list):
        files_written = []
    # Per-file truth (executive view). `wiki_new` counts entries that LANDED
    # on the digest's day — frontmatter `created` == date_str, read from the
    # wiki TREE itself (see _wiki_entries_created_on: log-only counting was
    # the 2026-07-03 "Wiki 0 on a 29-entry day" incident). Dream-cycle
    # entries materialized at ~02:47 the morning after carry created ==
    # target+1 and count in the NEXT digest — a 1-day skew, never a loss.
    #
    # `wiki_updated` stays log-classified: the tree alone has no churn-safe
    # update signal here (nightly consolidation rewrites `updated:` on every
    # file it touches — counting frontmatter would report hundreds of
    # phantom updates; the dashboard intake solves this with a body-hash
    # store the digest doesn't have).
    wiki_created_paths = _wiki_entries_created_on(date_str)
    wiki_new = len(wiki_created_paths)
    seen_paths: set = set(str(p) for p in wiki_created_paths)
    unique_wiki_paths = [p for p in files_written if not (p in seen_paths or seen_paths.add(p))]
    wiki_updated = 0
    wiki_updated_paths: list = []
    for raw_path in unique_wiki_paths:
        _, _, created, updated = _extract_entry_summary(Path(raw_path))
        if created in (date_str, dream_cycle_date):
            continue  # creations are counted from the tree, on landing day
        if updated == dream_cycle_date:
            wiki_updated += 1
            wiki_updated_paths.append(raw_path)

    skill_new = compile_stats.get("skill_candidates_new", 0) or 0
    skill_merged = compile_stats.get("skill_candidates_merged", 0) or 0
    skill_evidence = compile_stats.get("skill_evidence_appended", 0) or 0
    skill_promoted = compile_stats.get("skill_promotions", 0) or 0
    taste_total = skill_new + skill_merged + skill_evidence + skill_promoted
    skill_files = compile_stats.get("skill_files") or []
    if not isinstance(skill_files, list):
        skill_files = []
    # Staged taste mode: compile defers skill writes to apply_taste.
    apply_taste_files = log.get("apply_taste", {}).get("skill_files") or []
    if isinstance(apply_taste_files, list):
        skill_files = list(skill_files) + apply_taste_files
    if taste_total == 0:
        taste_total = len(set(skill_files))

    # PT calendar-day window
    target = datetime.date.fromisoformat(date_str)
    start_dt = datetime.datetime.combine(target, datetime.time.min, TZ)
    end_dt = start_dt + datetime.timedelta(days=1)
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms = int(end_dt.timestamp() * 1000)

    # Collect raw prompts per agent, summarize, then group. Source
    # paths come from digital-me/config.yaml (auto-populated by
    # `digital-me setup` from each runtime's TRANSCRIPT_SOURCE manifest);
    # falls back to baked-in defaults if the config is missing.
    sources = _load_transcript_sources()
    cache = _load_summary_cache()
    cc_raw = _claude_code_raw_prompts(
        start_ms, end_ms, Path(sources["claude-code-jsonl"]["path"]),
    )
    codex_raw = _codex_raw_prompts(
        start_ms, end_ms, Path(sources["codex-jsonl"]["path"]),
    )
    openclaw_raw = _openclaw_agents_raw_prompts(
        start_ms, end_ms, Path(sources["openclaw-agent-jsonl"]["path"]),
    )
    hermes_raw = _hermes_raw_prompts(
        start_ms,
        end_ms,
        Path(sources["hermes-session-json"]["path"]),
        sources["hermes-session-json"].get("glob"),
    )
    cc_topics = _summarize_and_group(cc_raw, cache)
    codex_topics = _summarize_and_group(codex_raw, cache)
    hermes_topics = _summarize_and_group(hermes_raw, cache)
    openclaw_topics = {
        agent: _summarize_and_group(prompts, cache)
        for agent, prompts in openclaw_raw.items()
    }
    _save_summary_cache(cache)
    coo_goals = _coo_goals(start_ms, end_ms)
    active_agents = (
        (1 if cc_topics else 0)
        + (1 if codex_topics else 0)
        + (1 if hermes_topics else 0)
        + len(openclaw_topics)
    )

    # ----- Render markdown -----
    lines: list[str] = [f"# Daily Digest — {date_str}", ""]
    lines.append("## TL;DR")
    lines.append("")
    lines.append("| Active agents | Wiki created | Wiki updated | Taste distilled |")
    lines.append("|---|---|---|---|")
    taste_breakdown = (
        f"**{taste_total}** "
        f"(new: {skill_new}, merged: {skill_merged}, "
        f"evidence: {skill_evidence}, promoted: {skill_promoted})"
    )
    lines.append(
        f"| **{active_agents}** | **{wiki_new}** | **{wiki_updated}** | {taste_breakdown} |"
    )
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Deep Dive")
    lines.append("")
    def _entry_label(created: str, updated: str) -> str:
        """Determine 'created' vs 'updated' relative to the dream cycle run date."""
        if created and created == dream_cycle_date:
            return "🟢 created"
        if updated and updated == dream_cycle_date and created and created < dream_cycle_date:
            return "🔵 updated"
        # Fallback: if neither matches, show 'touched' (rare; usually a file
        # that was overwritten without bumping `updated:`).
        return "⚪ touched"

    lines.append("### Wiki (edited yesterday — created + updated)")
    # Created entries come from the TREE (frontmatter created == the digest's
    # day, any producer); updated entries from the dream-cycle log
    # classification — same sources as the TL;DR counts above.
    wiki_listing = [(p, "🟢 created") for p in wiki_created_paths] + [
        (Path(p), "🔵 updated") for p in wiki_updated_paths
    ]
    if wiki_listing:
        for i, (p, label) in enumerate(wiki_listing, 1):
            title, domains, _created, _updated = _extract_entry_summary(p)
            domain_tag = f" — _{domains}_" if domains else ""
            lines.append(f"{i}. [{label}] **{title}**{domain_tag}")
    else:
        lines.append("_(no wiki entries written yesterday)_")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("### Taste distilled")
    if skill_files:
        seen = set()
        unique_paths = [p for p in skill_files if not (p in seen or seen.add(p))]
        for i, raw_path in enumerate(unique_paths, 1):
            p = Path(raw_path)
            title, domains, created, updated = _extract_principle_summary(p)
            label = _entry_label(created, updated)
            domain_tag = f" — _{domains}_" if domains else ""
            lines.append(f"{i}. [{label}] **{title}**{domain_tag}")
    else:
        lines.append("_(no taste principles distilled yesterday)_")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Projects that Agents working")
    lines.append("")

    def _render_agent(label: str, topics: list[tuple[str, int]]) -> None:
        """One bullet per topic. No paths, no cwd, no project labels."""
        if not topics:
            lines.append(f"- **{label}:** _no activity_")
            return
        lines.append(f"- **{label}:**")
        for topic, n in topics:
            suffix = f" (×{n})" if n > 1 else ""
            lines.append(f"    - {topic}{suffix}")

    _render_agent("Claude Code CLI", cc_topics)

    by_count = sorted(
        openclaw_topics.items(), key=lambda x: -sum(n for _, n in x[1])
    )
    for agent_name, topics in by_count:
        _render_agent(f"OpenClaw - {agent_name}", topics)

    _render_agent("Hermes Agent", hermes_topics)
    _render_agent("Codex CLI", codex_topics)

    full_md = "\n".join(lines)

    structured = {
        "date": date_str,
        "dream_cycle_date": dream_cycle_date,
        "active_agents": active_agents,
        "wiki_new": wiki_new,
        "wiki_updated": wiki_updated,
        "taste_total": taste_total,
        "skill_new": skill_new,
        "skill_merged": skill_merged,
        "skill_evidence": skill_evidence,
        "skill_promoted": skill_promoted,
        "files_written": files_written,
        "skill_files": skill_files,
        "cc_topics": cc_topics,
        "codex_topics": codex_topics,
        "hermes_topics": hermes_topics,
        "openclaw_topics": openclaw_topics,
        "coo_goals": coo_goals,
    }
    return full_md, structured


def render_components(s: dict) -> dict:
    tone = TONE_QUIET if s["taste_total"] == 0 else TONE_NORMAL
    blocks: list[dict] = []

    # TL;DR — aligned table inside a code fence (Discord doesn't render md tables)
    tldr_table = (
        "```\n"
        "Agents  Wiki+   Wiki~   Taste\n"
        f"{s['active_agents']:<7} {s['wiki_new']:<7} {s['wiki_updated']:<7} {s['taste_total']}\n"
        "```"
    )
    if s["taste_total"]:
        tldr_table += (
            f"\nTaste breakdown: new {s['skill_new']} · merged {s['skill_merged']} · "
            f"evidence {s['skill_evidence']} · promoted {s['skill_promoted']}"
        )
    blocks.append({"type": "text", "text": f"**TL;DR**\n{tldr_table}"})

    dc_date = s.get("dream_cycle_date", "")

    def _entry_label(created: str, updated: str) -> str:
        if created and created == dc_date:
            return "🟢 created"
        if updated and updated == dc_date and created and created < dc_date:
            return "🔵 updated"
        return "⚪ touched"

    # Wiki summary — title + domain + created/updated label
    if s["files_written"]:
        blocks.append({"type": "divider"})
        blocks.append({"type": "text", "text": "**Wiki edited (created + updated)**"})
        seen: set = set()
        unique_paths = [p for p in s["files_written"] if not (p in seen or seen.add(p))]
        wiki_lines = []
        for i, raw_path in enumerate(unique_paths, 1):
            p = Path(raw_path)
            title, domains, created, updated = _extract_entry_summary(p)
            label = _entry_label(created, updated)
            domain_str = f" — _{domains}_" if domains else ""
            wiki_lines.append(f"{i}. [{label}] **{title}**{domain_str}")
        blocks.append({"type": "text", "text": "\n".join(wiki_lines)})

    # Taste summary — title + domain + created/updated label
    blocks.append({"type": "divider"})
    if s["skill_files"]:
        blocks.append({"type": "text", "text": "**Taste distilled**"})
        seen = set()
        unique_paths = [p for p in s["skill_files"] if not (p in seen or seen.add(p))]
        taste_lines = []
        for i, raw_path in enumerate(unique_paths, 1):
            p = Path(raw_path)
            title, domains, created, updated = _extract_principle_summary(p)
            label = _entry_label(created, updated)
            domain_str = f" — _{domains}_" if domains else ""
            taste_lines.append(f"{i}. [{label}] **{title}**{domain_str}")
        blocks.append({"type": "text", "text": "\n".join(taste_lines)})
    else:
        blocks.append({"type": "text", "text": "**Taste distilled** — _none yesterday_"})

    # What each agent worked on — one topic per line, no paths
    blocks.append({"type": "divider"})
    blocks.append({"type": "text", "text": "**What each agent worked on**"})

    def _agent_block(label: str, topics: list[tuple[str, int]]) -> str:
        if not topics:
            return f"**{label}** — _no activity_"
        bullets = "\n".join(
            f"  • {topic}" + (f" (×{n})" if n > 1 else "")
            for topic, n in topics
        )
        return f"**{label}**\n{bullets}"

    agent_blocks = [_agent_block("Claude Code CLI", s["cc_topics"])]
    by_count = sorted(
        s["openclaw_topics"].items(), key=lambda x: -sum(n for _, n in x[1])
    )
    for agent_name, topics in by_count:
        agent_blocks.append(_agent_block(f"OpenClaw — {agent_name}", topics))
    if not s["openclaw_topics"]:
        agent_blocks.append("**OpenClaw agents** — _no activity_")
    agent_blocks.append(_agent_block("Hermes Agent", s.get("hermes_topics", [])))
    agent_blocks.append(_agent_block("Codex CLI", s["codex_topics"]))

    # Each agent block as its own text block so the divider visual stays tight
    for block in agent_blocks:
        blocks.append({"type": "text", "text": block})

    return {
        "title": f"📋 Daily Digest — {s['date']}",
        "tone": tone,
        "blocks": blocks,
    }


def post_discord(presentation: dict, fallback_text: str, *, dry_run: bool) -> None:
    # --message is CLI-required but renders ABOVE the presentation card on
    # Discord, so passing the title duplicates it visually. Use a zero-width
    # space so the field is non-empty but invisible in the rendered message.
    fallback_message = "​"
    presentation = _normalize_presentation(presentation)
    if not any(
        _block_text(b).strip()
        for b in presentation.get("blocks") or []
        if isinstance(b, dict) and b.get("type") == "text"
    ):
        # Fail open: never post a blank card. main() normally guarantees a
        # visible floor; this is the final belt-and-suspenders guard.
        title = presentation.get("title") or "Daily Digest"
        presentation = {
            **presentation,
            "blocks": [{"type": "text", "text": f"_{title}: nothing to report._"}],
        }
    batches = list(_presentation_batches(presentation))
    if dry_run:
        print("[dry-run] presentation payload batches:")
        print(json.dumps(batches, indent=2))
        return
    if not OPENCLAW_CLI:
        raise SystemExit(
            "[daily-digest] openclaw CLI not found — set $OPENCLAW_CLI or "
            "install openclaw on PATH"
        )
    if not DISCORD_CHANNEL:
        raise SystemExit(
            "[daily-digest] no Discord channel configured — set "
            "$DIGITAL_ME_DIGEST_CHANNEL or config.yaml digest.discord_channel"
        )
    for index, batch in enumerate(batches, start=1):
        cmd = [
            OPENCLAW_CLI, "message", "send",
            "--channel", CHANNEL_PLATFORM,
            "--target", DISCORD_CHANNEL,
            "--presentation", json.dumps(batch),
            "--message", fallback_message,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            # FAIL LOUDLY — orchestrator should see the task as failed so the
            # silent-Discord-post bug from 2026-05-15 can't recur.
            raise SystemExit(
                f"[daily-digest] Discord post failed (batch {index}/{len(batches)}, exit {result.returncode}):\n"
                f"stderr: {result.stderr.strip()}\n"
                f"stdout: {result.stdout.strip()}"
            )
    print(
        f"[daily-digest] Posted to {CHANNEL_PLATFORM} "
        f"({len(presentation.get('blocks', []))} blocks in {len(batches)} messages)"
    )


def _block_text(block: dict) -> str:
    """Return visible text from native, Slack-style, or handoff-style blocks."""
    text = block.get("text")
    if text is None:
        text = block.get("content")
    if isinstance(text, dict):
        return str(text.get("text") or text.get("content") or "")
    if text is None and isinstance(block.get("fields"), list):
        fields = []
        for field in block["fields"]:
            if isinstance(field, dict):
                fields.append(str(field.get("text") or field.get("content") or ""))
            elif field is not None:
                fields.append(str(field))
        return "\n".join(fields)
    return str(text or "")


_READABLE_TEXT_CHARS = 1800
_PIMR_HEADINGS = ("problem", "problems", "insight", "insights", "method", "result", "results")


def _prepare_digest_text(text: str) -> str:
    """Normalize rough Markdown before it becomes Discord component text."""
    if not text:
        return ""
    # The summarize handoff has previously returned literal backslash-n text;
    # render it as real line breaks when it is clearly being used as Markdown.
    if "\\n" in text and text.count("\\n") >= max(2, text.count("\n")):
        text = text.replace("\\n", "\n")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _looks_like_digest_heading(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if re.match(r"^#{1,4}\s+\S", stripped):
        return True
    if re.match(r"^\*\*[^*]{1,80}\*\*:?$", stripped):
        return True
    return bool(re.match(r"^(?:" + "|".join(_PIMR_HEADINGS) + r")\b\s*:", stripped, re.I))


def _normalize_digest_line(line: str) -> str:
    stripped = line.strip()
    if re.match(r"^[-*]\s+", stripped):
        return "• " + stripped[2:].strip()
    return line.rstrip()


def _append_divider(blocks: list[dict]) -> None:
    if blocks and blocks[-1].get("type") != "divider":
        blocks.append({"type": "divider"})


def _split_readable_text(text: str, *, max_chars: int = _READABLE_TEXT_CHARS) -> list[dict]:
    """Break one large Markdown blob into scan-friendly Discord text blocks."""
    text = _prepare_digest_text(text)
    if not text:
        return []

    blocks: list[dict] = []
    current: list[str] = []

    def flush() -> None:
        nonlocal current
        body = "\n".join(line for line in current).strip()
        current = []
        if not body:
            return
        if len(body) <= max_chars:
            blocks.append({"type": "text", "text": body})
            return
        chunk: list[str] = []
        chunk_len = 0
        for raw_line in body.splitlines():
            line = raw_line.rstrip()
            line_len = len(line) + (1 if chunk else 0)
            if chunk and chunk_len + line_len > max_chars:
                blocks.append({"type": "text", "text": "\n".join(chunk).strip()})
                chunk = []
                chunk_len = 0
            if len(line) > max_chars:
                words = line.split()
                for word in words:
                    extra = len(word) + (1 if chunk else 0)
                    if chunk and chunk_len + extra > max_chars:
                        blocks.append({"type": "text", "text": "\n".join(chunk).strip()})
                        chunk = []
                        chunk_len = 0
                    if len(word) > max_chars:
                        for start in range(0, len(word), max_chars):
                            blocks.append({"type": "text", "text": word[start:start + max_chars]})
                        continue
                    if chunk:
                        chunk[-1] = chunk[-1] + " " + word
                    else:
                        chunk.append(word)
                    chunk_len += extra
                continue
            chunk.append(line)
            chunk_len += line_len
        if chunk:
            blocks.append({"type": "text", "text": "\n".join(chunk).strip()})

    for line in text.splitlines():
        stripped = line.strip()
        if stripped in {"---", "***", "___"}:
            flush()
            _append_divider(blocks)
            continue
        if _looks_like_digest_heading(stripped) and current:
            flush()
            _append_divider(blocks)
        current.append(_normalize_digest_line(line))
    flush()

    while blocks and blocks[0].get("type") == "divider":
        blocks.pop(0)
    while blocks and blocks[-1].get("type") == "divider":
        blocks.pop()
    return blocks


def _normalize_presentation(presentation: dict) -> dict:
    """Accept native blocks, Slack-style variants, and rough Markdown blobs.

    The summarize worker sometimes returns Slack-ish `section`/`header`/`divider`
    blocks or one giant text block. The Discord publisher expects readable
    `text`/`divider` components; normalization prevents blank or wall-of-text
    digest posts while still preserving the worker's content.
    """
    normalized: list[dict] = []
    for raw in presentation.get("blocks") or []:
        if not isinstance(raw, dict):
            continue
        kind = raw.get("type")
        if kind in {"divider", "separator"}:
            _append_divider(normalized)
            continue
        if kind == "header":
            text = _prepare_digest_text(_block_text(raw))
            if text:
                normalized.extend(_split_readable_text(f"**{text.strip('* ')}**"))
            continue
        text = _block_text(raw)
        if text.strip():
            normalized.extend(_split_readable_text(text))
    while normalized and normalized[-1].get("type") == "divider":
        normalized.pop()
    return {**presentation, "blocks": normalized}


# ── Presentation contract (presentation.schema.json) ────────────────────────
# The summarize step (an LLM agent, swapped on every runtime update) and this
# publisher are two sides of one seam. The rules below are the written,
# versioned contract both sides agree on — they mirror presentation.schema.json,
# which is ALSO injected into the summarize prompt so the producer is TOLD the
# contract instead of guessing. Validating here turns producer drift (e.g.
# `content` vs `text`, the 2026-06-28 outage) into a loud, LOCATED error rather
# than a silently empty 7am digest — and the publish path then fails OPEN to a
# deterministic floor instead of refusing to publish.
_VALID_TONES = {"success", "danger", "info", "warning"}
_VALID_BLOCK_TYPES = {"text", "header", "divider"}


def validate_presentation(presentation: dict) -> list[str]:
    """Return a list of contract violations ([] = valid). Pure; never raises.

    Mirrors presentation.schema.json. A text/header block must carry non-empty
    visible text — accepted under the canonical `text` key OR the tolerated
    `content`/`fields` variants `_block_text` absorbs (tolerant reader).
    """
    if not isinstance(presentation, dict):
        return ["presentation is not an object"]
    errors: list[str] = []
    title = presentation.get("title")
    if not isinstance(title, str) or not title.strip():
        errors.append("title: missing or empty")
    tone = presentation.get("tone")
    if tone not in _VALID_TONES:
        errors.append(f"tone: {tone!r} not in {sorted(_VALID_TONES)}")
    blocks = presentation.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        errors.append("blocks: missing or empty")
        return errors
    has_visible = False
    for i, block in enumerate(blocks):
        if not isinstance(block, dict):
            errors.append(f"blocks[{i}]: not an object")
            continue
        btype = block.get("type")
        if btype not in _VALID_BLOCK_TYPES:
            errors.append(
                f"blocks[{i}].type: {btype!r} not in {sorted(_VALID_BLOCK_TYPES)}"
            )
            continue
        if btype in ("text", "header"):
            if _block_text(block).strip():
                has_visible = True
            else:
                errors.append(f"blocks[{i}] ({btype}): empty text")
    if not has_visible:
        errors.append("no visible text blocks")
    return errors


def _minimal_presentation(date_iso: str) -> dict:
    """The fail-open floor: a guaranteed-valid 'nothing to report' card.

    Last resort. If the staging file, the agent handoff, AND the regex render
    all yield nothing visible (e.g. a totally empty data day), the digest still
    delivers a valid card + a warning rather than dropping silently."""
    return {
        "title": f"Daily Digest — {date_iso}",
        "tone": "info",
        "blocks": [
            {"type": "text", "text": f"_No activity recorded for {date_iso}._"},
        ],
    }


def _presentation_batches(presentation: dict) -> list[dict]:
    """Split one presentation into Discord-safe component container batches."""
    title = presentation.get("title")
    tone = presentation.get("tone")
    # Discord Components V2 containers reject oversized child lists. The CLI
    # adds a hidden fallback text child, so cap authored children below the
    # Discord container ceiling.
    max_children = 7
    # Discord also rejects containers whose combined text is too large even
    # when every individual text component is valid. Keep each message under a
    # conservative text budget so a long Wiki/Taste section does not poison the
    # whole publish step.
    max_text_chars = 2800
    blocks = _split_oversized_text_blocks(
        list(presentation.get("blocks") or []),
        max_text_chars=max_text_chars,
    )
    batches: list[dict] = []
    offset = 0
    while offset < len(blocks) or not batches:
        include_title = bool(title) and not batches
        capacity = max_children - (1 if include_title else 0)
        chunk: list[dict] = []
        text_chars = len(title or "") if include_title else 0
        while offset < len(blocks) and len(chunk) < capacity:
            block = blocks[offset]
            block_chars = len(str(block.get("text") or ""))
            if chunk and text_chars + block_chars > max_text_chars:
                break
            chunk.append(block)
            text_chars += block_chars
            offset += 1
        while chunk and chunk[0].get("type") == "divider":
            chunk = chunk[1:]
        if not chunk and batches:
            continue
        batch: dict = {"blocks": chunk}
        if include_title:
            batch["title"] = title
        if tone:
            batch["tone"] = tone
        batches.append(batch)
    return batches


def _split_oversized_text_blocks(blocks: list[dict], *, max_text_chars: int) -> list[dict]:
    """Split long text components on line boundaries before Discord submit."""
    split_blocks: list[dict] = []
    for block in blocks:
        if block.get("type") != "text":
            split_blocks.append(block)
            continue
        text = str(block.get("text") or "")
        if len(text) <= max_text_chars:
            split_blocks.append(block)
            continue
        lines = text.splitlines()
        current: list[str] = []
        current_len = 0
        for line in lines:
            line_len = len(line) + (1 if current else 0)
            if current and current_len + line_len > max_text_chars:
                split_blocks.append({**block, "text": "\n".join(current)})
                current = []
                current_len = 0
            if len(line) > max_text_chars:
                for start in range(0, len(line), max_text_chars):
                    split_blocks.append({**block, "text": line[start:start + max_text_chars]})
                continue
            current.append(line)
            current_len += line_len
        if current:
            split_blocks.append({**block, "text": "\n".join(current)})
    return split_blocks


def write_raw_staging(path: Path, target_iso: str, dream_cycle_iso: str) -> None:
    """Gather raw data for COO to summarize in step 2.

    Output JSON shape (everything below is data; presentation/markdown are
    left null for COO to fill):
      {
        "date": "<target_iso>",                # yesterday in PT
        "dream_cycle_date": "<target+1>",      # the log file we read from
        "tldr": {
          "active_agents": int,
          "wiki_new": int, "wiki_updated": int,
          "taste_total": int,
          "skill_new": int, "skill_merged": int,
          "skill_evidence": int, "skill_promoted": int, "skill_neither": int
        },
        "wiki_entries": [
          {"title": str, "domains": str, "status": "created"|"updated"|"touched"}
        ],
        "taste_entries": [
          {"title": str, "domains": str, "status": "...", "fingerprint": str}
        ],
        "agent_raw_prompts": {
          "Claude Code CLI": [str, ...],   # mix of pre-summarized + raw prompts
          "OpenClaw - <name>": [str, ...],
          "Codex CLI": [str, ...]
        },
        "presentation": null,    # COO fills in (title, tone, blocks)
        "markdown": null         # COO writes a polished markdown version
      }
    """
    log = _parse_dream_cycle_log(dream_cycle_iso) or _parse_dream_cycle_log(target_iso)
    compile_stats = log.get("compile", {})

    files_written = compile_stats.get("files_written") or []
    if not isinstance(files_written, list):
        files_written = []

    def _classify(created: str, updated: str) -> str:
        if created and created == dream_cycle_iso:
            return "created"
        if updated and updated == dream_cycle_iso and created and created < dream_cycle_iso:
            return "updated"
        return "touched"

    # `wiki_new` counts entries that LANDED on the digest's day — frontmatter
    # `created` == target_iso, read from the wiki TREE itself (any producer:
    # in-session agents, brain materialization, dream cycle). Counting only
    # the dream-cycle log's files_written was the 2026-07-03 incident: the
    # compiler failed overnight, files_written came back [], and the digest
    # said "Wiki 0" on a day 29 entries landed. `wiki_updated` stays
    # log-classified — the tree has no churn-safe update signal (nightly
    # consolidation rewrites `updated:` frontmatter on files it merely
    # touches). Dream-cycle entries materialized at ~02:47 on target+1 count
    # in the NEXT digest (1-day skew, never a loss).
    wiki_entries = []
    wiki_created_paths = _wiki_entries_created_on(target_iso)
    wiki_new = len(wiki_created_paths)
    for p in wiki_created_paths:
        title, domains, _created, _updated = _extract_entry_summary(p)
        wiki_entries.append({"title": title, "domains": domains, "status": "created"})
    seen_paths: set = set(str(p) for p in wiki_created_paths)
    unique_wiki_paths = [p for p in files_written if not (p in seen_paths or seen_paths.add(p))]
    wiki_updated = 0
    for raw_path in unique_wiki_paths:
        title, domains, created, updated = _extract_entry_summary(Path(raw_path))
        if created in (target_iso, dream_cycle_iso):
            continue  # creations are counted from the tree, on landing day
        status = _classify(created, updated)
        if status == "updated":
            wiki_updated += 1
        wiki_entries.append({"title": title, "domains": domains, "status": status})

    skill_files = compile_stats.get("skill_files") or []
    if not isinstance(skill_files, list):
        skill_files = []
    # Staged taste mode: compile defers skill writes to apply_taste.
    apply_taste_files = log.get("apply_taste", {}).get("skill_files") or []
    if isinstance(apply_taste_files, list):
        skill_files = list(skill_files) + apply_taste_files
    seen_paths = set()
    unique_skill_paths = [p for p in skill_files if not (p in seen_paths or seen_paths.add(p))]
    taste_entries = []
    for raw_path in unique_skill_paths:
        title, domains, created, updated = _extract_principle_summary(Path(raw_path))
        # _extract_principle_summary returns fingerprint as 4th tuple slot
        # historically; we need it. Re-pull via direct file read for robustness.
        fingerprint = _read_fingerprint(Path(raw_path))
        taste_entries.append({
            "title": title,
            "domains": domains,
            "status": _classify(created, updated),
            "fingerprint": fingerprint,
        })

    taste_total = (
        (compile_stats.get("skill_candidates_new") or 0)
        + (compile_stats.get("skill_candidates_merged") or 0)
        + (compile_stats.get("skill_evidence_appended") or 0)
        + (compile_stats.get("skill_promotions") or 0)
    )
    if taste_total == 0:
        taste_total = len(unique_skill_paths)

    # PT calendar-day window for session walks
    target = datetime.date.fromisoformat(target_iso)
    start_dt = datetime.datetime.combine(target, datetime.time.min, TZ)
    end_dt = start_dt + datetime.timedelta(days=1)
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms = int(end_dt.timestamp() * 1000)

    sources = _load_transcript_sources()
    cc_raw = _claude_code_raw_prompts(
        start_ms, end_ms, Path(sources["claude-code-jsonl"]["path"]),
    )
    codex_raw = _codex_raw_prompts(
        start_ms, end_ms, Path(sources["codex-jsonl"]["path"]),
    )
    openclaw_raw = _openclaw_agents_raw_prompts(
        start_ms, end_ms, Path(sources["openclaw-agent-jsonl"]["path"]),
    )
    hermes_raw = _hermes_raw_prompts(
        start_ms,
        end_ms,
        Path(sources["hermes-session-json"]["path"]),
        sources["hermes-session-json"].get("glob"),
    )

    agent_raw_prompts: dict[str, list[str]] = {}
    if cc_raw:
        agent_raw_prompts["Claude Code CLI"] = cc_raw
    for agent_name, prompts in sorted(openclaw_raw.items(), key=lambda x: -len(x[1])):
        agent_raw_prompts[f"OpenClaw - {agent_name}"] = prompts
    if hermes_raw:
        agent_raw_prompts["Hermes Agent"] = hermes_raw
    if codex_raw:
        agent_raw_prompts["Codex CLI"] = codex_raw

    active_agents = (
        (1 if cc_raw else 0)
        + (1 if codex_raw else 0)
        + (1 if hermes_raw else 0)
        + len(openclaw_raw)
    )

    payload = {
        "date": target_iso,
        "dream_cycle_date": dream_cycle_iso,
        "tldr": {
            "active_agents": active_agents,
            "wiki_new": wiki_new,
            "wiki_updated": wiki_updated,
            "taste_total": taste_total,
            "skill_new": compile_stats.get("skill_candidates_new", 0) or 0,
            "skill_merged": compile_stats.get("skill_candidates_merged", 0) or 0,
            "skill_evidence": compile_stats.get("skill_evidence_appended", 0) or 0,
            "skill_promoted": compile_stats.get("skill_promotions", 0) or 0,
            "skill_neither": compile_stats.get("skill_neither", 0) or 0,
        },
        "wiki_entries": wiki_entries,
        "taste_entries": taste_entries,
        "agent_raw_prompts": agent_raw_prompts,
        "presentation": None,
        "markdown": None,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _read_fingerprint(skill_path: Path) -> str:
    try:
        text = skill_path.read_text(encoding="utf-8")
    except OSError:
        return ""
    m = re.search(r"^principle_fingerprint:\s*(.+(?:\n  .+)*)", text, re.MULTILINE)
    if m:
        return re.sub(r"\s+", " ", m.group(1)).strip().strip("'\"")
    m = re.search(r"^fingerprint:\s*(.+)$", text, re.MULTILINE)
    if m:
        return m.group(1).strip().strip("'\"")
    return ""


_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def read_staging(path: Path) -> dict:
    staged = json.loads(path.read_text(encoding="utf-8"))
    # The staging file is produced by an upstream step / LLM handoff. `date`
    # flows into titles and (potentially) filenames, so reject anything that
    # isn't a bare YYYY-MM-DD here — the publish path then falls back to the
    # CLI/now-derived target date instead of trusting an injected value.
    if isinstance(staged, dict):
        d = staged.get("date")
        if not (isinstance(d, str) and _ISO_DATE.match(d)):
            staged["date"] = None
    return staged


def _extract_handoff_payload(envelope: str) -> dict | None:
    """Unwrap a tasks.handoff envelope and return the COO's
    {"presentation": {...}, "markdown": "..."} payload, or None.

    The COO is instructed to put the built presentation+markdown JSON in the
    handoff `summary` (optionally fenced as ```json). The envelope itself is
    {"deliverableState","summary","artifactPaths","recommendedNextStep"}.
    Handles: payload directly, payload inside `summary`, fenced or bare JSON.
    """
    if not envelope:
        return None
    candidates: list[str] = []
    try:
        obj = json.loads(envelope)
        if isinstance(obj, dict):
            if "presentation" in obj or "markdown" in obj:
                return obj
            summ = obj.get("summary")
            if isinstance(summ, str):
                candidates.append(summ)
    except (json.JSONDecodeError, TypeError):
        pass
    candidates.append(envelope)
    for cand in candidates:
        m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", cand, re.S)
        text = m.group(1) if m else cand
        try:
            d = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(d, dict) and (d.get("presentation") or d.get("markdown")):
            return d
    return None


def load_coo_handoff() -> tuple[dict | None, str | None]:
    """Read the most-recent digest goal's COO summarize handoff from brain.db.

    Scoped to the LATEST digest goal so a stalled run (empty output) falls
    through to the deterministic fallback instead of resurrecting stale
    content from an older successful day. Read-only; never raises.
    """
    if not BRAIN_DB.exists():
        return None, None
    try:
        con = sqlite3.connect(f"file:{BRAIN_DB}?mode=ro", uri=True)
        try:
            row = con.execute(
                "SELECT t.latest_output FROM tasks t "
                "JOIN goals g ON g.id = t.goal_id "
                "WHERE g.name LIKE '%digest%' AND t.name LIKE '%summar%' "
                "ORDER BY g.created_at DESC LIMIT 1"
            ).fetchone()
        finally:
            con.close()
    except sqlite3.Error as e:
        print(f"[daily-digest] brain.db read failed: {e}", file=sys.stderr)
        return None, None
    if not row or not row[0]:
        return None, None
    payload = _extract_handoff_payload(row[0])
    if not payload:
        return None, None
    pres = payload.get("presentation")
    md = payload.get("markdown")
    if isinstance(pres, dict) and pres.get("blocks"):
        return pres, (md if isinstance(md, str) else None)
    return None, (md if isinstance(md, str) else None)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Daily activity digest")
    parser.add_argument("--date", type=str, default=None,
                        help="Target date YYYY-MM-DD (default: yesterday in PT)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--stage", type=str, default=None,
                        help="Compute and write presentation JSON to this path. "
                             "No Discord post. Memory log still written.")
    parser.add_argument("--publish", type=str, default=None,
                        help="Read presentation JSON from this path and post to "
                             "Discord. No re-computation.")
    args = parser.parse_args(argv)

    if args.stage and args.publish:
        raise SystemExit("--stage and --publish are mutually exclusive")

    # Determine target date once.
    if args.date:
        target = datetime.date.fromisoformat(args.date)
    else:
        now_pt = datetime.datetime.now(TZ)
        target = (now_pt - datetime.timedelta(days=1)).date()
    target_iso = target.isoformat()
    dream_cycle_iso = (target + datetime.timedelta(days=1)).isoformat()

    # PUBLISH mode: read COO-completed staging, post to Discord, write memory log.
    if args.publish:
        staging_path = Path(args.publish)
        if not staging_path.exists():
            raise SystemExit(f"--publish staging file not found: {staging_path}")
        staged = read_staging(staging_path)
        date_iso = staged.get("date") or target_iso
        markdown = staged.get("markdown") or ""
        global _LLM_DISABLED

        # Seam contract: each candidate source must satisfy the presentation
        # contract (presentation.schema.json) before we accept it. A violation
        # is logged with its exact path and we fall through to the next source.
        # Source priority (the publisher FAILS OPEN — it always delivers a
        # valid digest; only an infra failure makes the step fail):
        #   1. staging-file presentation (back-compat: a producer that writes it)
        #   2. agent summarize handoff in brain.db (the sanctioned path)
        #   3. deterministic regex render from staged data (no inline LLM)
        #   4. minimal 'nothing to report' card (guaranteed-valid floor)
        def _accept(candidate: dict, source: str) -> Optional[dict]:
            errs = validate_presentation(candidate or {})
            if errs:
                if candidate:  # only noise-log a source that actually had data
                    print(
                        f"[daily-digest] {source}: contract violation "
                        f"({len(errs)}): {'; '.join(errs[:5])}",
                        file=sys.stderr,
                    )
                return None
            print(f"[daily-digest] using {source}")
            return candidate

        presentation = _accept(staged.get("presentation") or {}, "staging-file presentation")

        if presentation is None:
            hp, hmd = load_coo_handoff()
            if hp:
                presentation = _accept(hp, "agent summarize handoff (brain.db)")
                if presentation is not None and hmd and not markdown:
                    markdown = hmd

        if presentation is None:
            # Deterministic floor — the agent summarize is best-effort polish,
            # never a hard dependency. Force the regex summarizer (no inline
            # Gemini) so the fallback never reintroduces the deprecated SPOF.
            _LLM_DISABLED = True
            print(
                "[daily-digest] no valid agent handoff — rendering "
                "deterministically from staged data (regex, no LLM)",
                file=sys.stderr,
            )
            full_md, structured = render_full(date_iso)
            presentation = _accept(render_components(structured), "deterministic regex render")
            if not markdown:
                markdown = full_md

        if presentation is None:
            # Last resort: a guaranteed-valid card. Never drop the digest.
            print(
                "[daily-digest] all sources empty — publishing minimal "
                "'nothing to report' card (fail-open floor)",
                file=sys.stderr,
            )
            presentation = _minimal_presentation(date_iso)

        fallback = (presentation.get("title") or "Daily Digest")[:1900]
        if args.dry_run:
            presentation = _normalize_presentation(presentation)
            print("[publish dry-run] presentation:")
            print(json.dumps(presentation, indent=2))
            return 0
        # Write the markdown to the wiki digests dir (always) + the optional
        # secondary memory log (only when DIGITAL_ME_DIGEST_MEMORY_DIR is set —
        # no personal default ships in source).
        if markdown:
            REPO_DIGEST_DIR.mkdir(parents=True, exist_ok=True)
            fname = f"{target_iso}-daily-digest.md"
            (REPO_DIGEST_DIR / fname).write_text(markdown, encoding="utf-8")
            written = [str(REPO_DIGEST_DIR)]
            if MEMORY_DIR is not None:
                MEMORY_DIR.mkdir(parents=True, exist_ok=True)
                (MEMORY_DIR / fname).write_text(markdown, encoding="utf-8")
                written.append(str(MEMORY_DIR))
            print(f"[daily-digest] Wrote {fname} to {', '.join(written)}")
        post_discord(presentation, fallback, dry_run=False)
        return 0

    # STAGE mode: gather raw data only, no LLM summary, no Discord post.
    if args.stage:
        staging_path = Path(args.stage)
        if args.dry_run:
            print(f"[stage dry-run] would write raw staging to {staging_path}")
            return 0
        write_raw_staging(staging_path, target_iso, dream_cycle_iso)
        print(f"[daily-digest] Staged raw data to {staging_path}")
        return 0

    # DEFAULT (legacy single-shot): compute, summarize via gemini-flash, post.
    full_md, structured = render_full(target_iso)
    presentation = render_components(structured)
    if args.dry_run:
        print("=== Full markdown ===")
        print(full_md)
        print()
        print("=== Presentation payload ===")
        print(json.dumps(presentation, indent=2)[:3000])
        return 0
    REPO_DIGEST_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{target_iso}-daily-digest.md"
    (REPO_DIGEST_DIR / fname).write_text(full_md, encoding="utf-8")
    written = [str(REPO_DIGEST_DIR)]
    if MEMORY_DIR is not None:
        MEMORY_DIR.mkdir(parents=True, exist_ok=True)
        (MEMORY_DIR / fname).write_text(full_md, encoding="utf-8")
        written.append(str(MEMORY_DIR))
    print(f"[daily-digest] Wrote {fname} to {', '.join(written)}")
    post_discord(presentation, full_md, dry_run=False)
    return 0


def main_cli() -> None:
    """Zero-arg console-script entry point (see pyproject [project.scripts])."""
    raise SystemExit(main(sys.argv[1:]))


if __name__ == "__main__":
    main_cli()
