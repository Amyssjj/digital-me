"""Every agent step's prompt must be readable by the codex-cli fallback.

An agentId step runs on claude-code-cli, which falls back to codex-cli when the
Claude login lapses. Codex has no Read tool, so a prompt that allows only Read
leaves it unable to open its staging file: the summarize step handed off
`partial` on 2026-11-08 and 2026-11-09 and no digest was built. Each agent
prompt must give Codex a read-only shell read of its own staging file.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import digest

WORKFLOW = Path(digest.__file__).parent / "workflows" / "digest.json"
STAGING_VAR = re.compile(r"\{\{\w*staging_path\}\}")
SHELL_READ = re.compile(r"`sed -n '1,\d+p' (\{\{\w+\}\})`")


def _agent_steps() -> list[dict]:
    steps = json.loads(WORKFLOW.read_text(encoding="utf-8"))["steps"]
    return [s for s in steps if s.get("dispatch", {}).get("agentId")]


def test_summarize_is_the_agent_step() -> None:
    assert [s["stepKey"] for s in _agent_steps()] == ["summarize"]


def test_agent_prompts_give_codex_a_shell_read_of_their_staging_file() -> None:
    for step in _agent_steps():
        key, prompt = step["stepKey"], step["promptTemplate"]
        assert "Read/file tool" in prompt, key
        assert "If you have no Read tool (you are the Codex fallback)" in prompt, key
        read = SHELL_READ.search(prompt)
        assert read, key
        assert read.group(1) == STAGING_VAR.search(prompt).group(0), key
        assert "omitted or truncated" in prompt, key
        assert "run nothing else" in prompt, key
