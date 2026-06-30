"""Path + destination resolution for the daily digest.

The digest ships as a standalone package that can point at any wiki and post
to any Discord channel — nothing personal is baked into the source. Every
machine-specific value resolves through the same arg → env → default contract
the dream-cycle package uses (see DIGITAL_ME_WIKI_ROOT / DIGITAL_ME_BRAIN_DB).

Resolution order for each value:
  1. explicit constructor arg (tests / callers)
  2. environment variable
  3. a safe, non-personal default (or None when there is no safe default)

Privacy contract: NO Discord channel id, NO `~/.claude/projects/-Users-<name>`
memory path, and NO absolute user paths live in this repo. The channel id and
the optional memory-log directory have NO default — they are supplied per
install via env or config.yaml, so the OSS source carries zero personal data.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


DEFAULT_WIKI_ROOT = Path.home() / "digital-me"


def _env_path(name: str) -> Optional[Path]:
    val = os.environ.get(name)
    return Path(os.path.expandvars(os.path.expanduser(val))) if val else None


def resolve_wiki_root(wiki_root: Optional[Path] = None) -> Path:
    """arg → $DIGITAL_ME_WIKI_ROOT → ~/digital-me."""
    if wiki_root is not None:
        return Path(wiki_root).expanduser().resolve()
    env = _env_path("DIGITAL_ME_WIKI_ROOT")
    if env is not None:
        return env.resolve()
    return DEFAULT_WIKI_ROOT


def resolve_brain_db(brain_db: Optional[Path] = None) -> Path:
    """arg → $DIGITAL_ME_BRAIN_DB → ~/.openclaw/data/brain.db."""
    if brain_db is not None:
        return Path(brain_db).expanduser().resolve()
    env = _env_path("DIGITAL_ME_BRAIN_DB")
    if env is not None:
        return env.resolve()
    return Path.home() / ".openclaw" / "data" / "brain.db"


def resolve_openclaw_cli(openclaw_cli: Optional[str] = None) -> Optional[str]:
    """arg → $OPENCLAW_CLI → `openclaw` on PATH → ~/.local/bin/openclaw.

    Returns None when no openclaw binary can be located — the publisher
    surfaces that as a clear error instead of shelling out to a hardcoded
    user path that won't exist on another machine.
    """
    if openclaw_cli:
        return openclaw_cli
    env = os.environ.get("OPENCLAW_CLI")
    if env:
        return env
    found = shutil.which("openclaw")
    if found:
        return found
    fallback = Path.home() / ".local" / "bin" / "openclaw"
    return str(fallback) if fallback.exists() else None


def resolve_discord_channel(channel: Optional[str] = None) -> Optional[str]:
    """arg → $DIGITAL_ME_DIGEST_CHANNEL → config.yaml `digest.discord_channel`.

    NO default. A real `--publish` to Discord requires this to be set per
    install; `--dry-run` works without it. Keeping it out of source means the
    OSS repo never carries a personal channel id.
    """
    if channel:
        return channel
    env = os.environ.get("DIGITAL_ME_DIGEST_CHANNEL")
    if env:
        return env
    return _channel_from_config()


def resolve_memory_dir(memory_dir: Optional[Path] = None) -> Optional[Path]:
    """arg → $DIGITAL_ME_DIGEST_MEMORY_DIR → None (skip the secondary log).

    The original code hardcoded a personal Claude-memory path
    (`~/.claude/projects/-Users-<name>/memory`). That is a per-user location
    with no safe default, so it is opt-in via env only; when unset the digest
    simply skips the secondary memory-log copy (the wiki `digests/` copy is
    always written).
    """
    if memory_dir is not None:
        return Path(memory_dir).expanduser().resolve()
    env = _env_path("DIGITAL_ME_DIGEST_MEMORY_DIR")
    return env.resolve() if env is not None else None


def _channel_from_config() -> Optional[str]:
    """Read `digest.discord_channel` from config.yaml if present. Best-effort:
    never raises, returns None on any problem (missing file, no pyyaml, etc.)."""
    cfg_env = _env_path("DIGITAL_ME_CONFIG_PATH")
    cfg_path = cfg_env if cfg_env is not None else resolve_wiki_root() / "config.yaml"
    if not cfg_path.exists():
        return None
    try:
        import yaml  # local import: only needed when a config file exists
        raw = yaml.safe_load(cfg_path.read_text()) or {}
        digest = raw.get("digest") or {}
        chan = digest.get("discord_channel")
        return str(chan) if chan else None
    except Exception:
        return None


@dataclass(frozen=True)
class DigestPaths:
    """Resolved, machine-specific values. Build once at import via
    ``load_paths()`` and expose as module constants in daily_digest."""
    wiki_root: Path
    brain_db: Path
    discord_channel: Optional[str]
    openclaw_cli: Optional[str]
    memory_dir: Optional[Path]

    @property
    def wiki_dir(self) -> Path:
        return self.wiki_root / "wiki"

    @property
    def digest_dir(self) -> Path:
        return self.wiki_root / "digests"

    @property
    def dream_cycle_logs(self) -> Path:
        return self.wiki_root / "dream_cycle" / "logs"

    @property
    def skills_proposals(self) -> Path:
        return self.wiki_root / "skills-proposals"

    @property
    def config_path(self) -> Path:
        env = _env_path("DIGITAL_ME_CONFIG_PATH")
        return env if env is not None else self.wiki_root / "config.yaml"


def load_paths(
    *,
    wiki_root: Optional[Path] = None,
    brain_db: Optional[Path] = None,
    discord_channel: Optional[str] = None,
    openclaw_cli: Optional[str] = None,
    memory_dir: Optional[Path] = None,
) -> DigestPaths:
    """Resolve all machine-specific values via the arg → env → default chain."""
    return DigestPaths(
        wiki_root=resolve_wiki_root(wiki_root),
        brain_db=resolve_brain_db(brain_db),
        discord_channel=resolve_discord_channel(discord_channel),
        openclaw_cli=resolve_openclaw_cli(openclaw_cli),
        memory_dir=resolve_memory_dir(memory_dir),
    )
