"""Config resolution + the privacy contract.

The privacy test is a hard gate: this package ships in the public OSS repo, so
NO personal data (a real username, an absolute /Users path, a hardcoded Discord
channel snowflake) may appear in source. The patterns are matched generically
so this test file itself carries no secret.
"""

import re
from pathlib import Path

import pytest

from digest import config


SRC_DIR = Path(__file__).resolve().parent.parent / "src" / "digest"


def _source_files():
    return sorted(SRC_DIR.rglob("*.py")) + sorted(SRC_DIR.rglob("*.json"))


# ── Privacy: no personal data in shipped source ─────────────────────────────

# (pattern, human-readable reason). Matched case-insensitively against source.
_FORBIDDEN = [
    (r"/Users/[A-Za-z0-9]", "absolute macOS user path"),
    (r"/home/[A-Za-z0-9]", "absolute Linux user home path"),
    (r"-Users-[A-Za-z0-9]", "dash-encoded user path (Claude project dir)"),
    (r"channel:\d{10,}", "hardcoded Discord channel snowflake"),
    (r"\bjingshi\b", "owner username"),
]


@pytest.mark.parametrize("path", _source_files(), ids=lambda p: p.name)
def test_no_personal_data_in_source(path):
    text = path.read_text(encoding="utf-8")
    for pattern, reason in _FORBIDDEN:
        m = re.search(pattern, text, re.IGNORECASE)
        assert m is None, f"{path.name}: leaked {reason}: {m.group(0)!r}"


def test_discord_channel_is_not_a_literal():
    """The channel must come from env/config, never a source default."""
    src = (SRC_DIR / "daily_digest.py").read_text(encoding="utf-8")
    # DISCORD_CHANNEL must be assigned from resolved config, not a string literal.
    assert re.search(r'DISCORD_CHANNEL\s*=\s*["\']', src) is None


# ── Config resolution: arg → env → default ──────────────────────────────────

def test_wiki_root_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(tmp_path))
    assert config.resolve_wiki_root() == tmp_path.resolve()


def test_wiki_root_arg_wins(tmp_path):
    assert config.resolve_wiki_root(tmp_path) == tmp_path.resolve()


def test_brain_db_env_override(monkeypatch, tmp_path):
    db = tmp_path / "brain.db"
    monkeypatch.setenv("DIGITAL_ME_BRAIN_DB", str(db))
    assert config.resolve_brain_db() == db.resolve()


def test_discord_channel_no_default(monkeypatch, tmp_path):
    """No env, no config.yaml → None (never a baked-in channel)."""
    monkeypatch.delenv("DIGITAL_ME_DIGEST_CHANNEL", raising=False)
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(tmp_path))  # empty wiki, no config
    monkeypatch.delenv("DIGITAL_ME_CONFIG_PATH", raising=False)
    assert config.resolve_discord_channel() is None


def test_discord_channel_from_env(monkeypatch):
    monkeypatch.setenv("DIGITAL_ME_DIGEST_CHANNEL", "channel:test-123")
    assert config.resolve_discord_channel() == "channel:test-123"


def test_discord_channel_from_config(monkeypatch, tmp_path):
    pytest.importorskip("yaml")
    (tmp_path / "config.yaml").write_text(
        "digest:\n  discord_channel: channel:from-config\n", encoding="utf-8"
    )
    monkeypatch.delenv("DIGITAL_ME_DIGEST_CHANNEL", raising=False)
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(tmp_path))
    monkeypatch.delenv("DIGITAL_ME_CONFIG_PATH", raising=False)
    assert config.resolve_discord_channel() == "channel:from-config"


def test_openclaw_cli_env_override(monkeypatch):
    monkeypatch.setenv("OPENCLAW_CLI", "/custom/openclaw")
    assert config.resolve_openclaw_cli() == "/custom/openclaw"


def test_channel_platform_defaults_discord(monkeypatch, tmp_path):
    monkeypatch.delenv("DIGITAL_ME_DIGEST_PLATFORM", raising=False)
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(tmp_path))  # no config.yaml
    monkeypatch.delenv("DIGITAL_ME_CONFIG_PATH", raising=False)
    assert config.resolve_channel_platform() == "discord"


def test_channel_platform_env_override(monkeypatch):
    monkeypatch.setenv("DIGITAL_ME_DIGEST_PLATFORM", "slack")
    assert config.resolve_channel_platform() == "slack"


def test_channel_platform_from_config(monkeypatch, tmp_path):
    pytest.importorskip("yaml")
    (tmp_path / "config.yaml").write_text(
        "digest:\n  channel_platform: slack\n", encoding="utf-8"
    )
    monkeypatch.delenv("DIGITAL_ME_DIGEST_PLATFORM", raising=False)
    monkeypatch.setenv("DIGITAL_ME_WIKI_ROOT", str(tmp_path))
    monkeypatch.delenv("DIGITAL_ME_CONFIG_PATH", raising=False)
    assert config.resolve_channel_platform() == "slack"


def test_memory_dir_defaults_none(monkeypatch):
    monkeypatch.delenv("DIGITAL_ME_DIGEST_MEMORY_DIR", raising=False)
    assert config.resolve_memory_dir() is None


def test_paths_derive_from_wiki_root(tmp_path):
    p = config.load_paths(wiki_root=tmp_path)
    assert p.wiki_dir == tmp_path.resolve() / "wiki"
    assert p.digest_dir == tmp_path.resolve() / "digests"
    assert p.skills_proposals == tmp_path.resolve() / "skills-proposals"
