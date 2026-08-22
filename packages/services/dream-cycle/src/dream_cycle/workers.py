"""Which CLI-exec worker runs the workflow's agent steps.

Lives in its own module because both entry points need it and they already
import each other: `install_workflows` imports `materialize_workflow` from
`via_agents`, so `via_agents` cannot import back from `install_workflows`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

import yaml

# Preference order for the CLI-exec worker that runs the agent steps.
#
# claude-code-cli first: runs on a local Claude subscription, has full file
# tools + the openclaw-brain MCP, and is proven end-to-end for these steps.
#
# codex-cli second, deliberately: Codex-CLI on ChatGPT Plus has produced
# multi-day quota blackouts on critical cron paths, and a rate-limited
# dispatcher cannot always report its own failure. Fine as a fallback, never
# the first choice for a nightly.
#
# NOT in this list: the bare in-gateway `claude-code` spawn agent. It has no
# exec tools and no brain MCP, so it can neither read the staging file nor
# call tasks.handoff — it stalls silently until the watchdog fires. It was the
# shipped default until this change, and it is why this module exists.
WORKER_AGENT_PREFERENCE: tuple[str, ...] = ("claude-code-cli", "codex-cli")


def detect_worker_agent_id(
    wiki_root: Path,
    preference: Iterable[str] = WORKER_AGENT_PREFERENCE,
) -> Optional[str]:
    """Return the first configured cli_exec_alias from `preference`, else None.

    Reads `<wiki_root>/config.yaml`. Missing, unreadable, or malformed all mean
    "nothing configured" — the caller decides whether that is fatal.
    """
    try:
        raw = yaml.safe_load((wiki_root / "config.yaml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None
    if not isinstance(raw, dict):
        return None
    aliases = raw.get("cli_exec_aliases")
    if not isinstance(aliases, dict):
        return None
    for candidate in preference:
        if isinstance(aliases.get(candidate), dict):
            return candidate
    return None
