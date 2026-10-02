"""~/.codex/CODEX.md managed-section refresh (dream_cycle.integrations.codex).

The installer owns the protocol text at the top of the managed section; the
nightly refresh owns only the Active Policies block after it.
"""

from pathlib import Path

import pytest

from dream_cycle.integrations import codex

FENCE = "=" * 60
INDEX = f"""# Index

{FENCE}
## ACTIVE POLICIES (MANDATORY)

### Policy {{n}}
{FENCE}
body
{FENCE}

## Domains
"""

INSTALLER_PROTOCOL = """## Digital Me Protocol

Installer-written protocol.

### [Digital Me] — M1 application_rate protocol

Begin your reply with `[Digital Me]`."""


@pytest.fixture
def paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    codex_md = tmp_path / ".codex" / "CODEX.md"
    index = tmp_path / "_INDEX.md"
    index.write_text(INDEX.replace("{n}", "1"), encoding="utf-8")
    monkeypatch.setattr(codex, "CODEX_INSTRUCTIONS_PATH", codex_md)
    monkeypatch.setattr(codex, "DM_INDEX_PATH", index)
    return codex_md, index


def _installed(protocol: str, policies: str) -> str:
    return (
        "# Codex Instructions\n\nuser text\n\n"
        f"{codex.BEGIN_MARKER}\n\n{protocol}\n\n{policies}\n{codex.END_MARKER}\n"
    )


def test_keeps_the_installer_protocol_and_refreshes_only_the_policies(paths):
    codex_md, index = paths
    old_policies = f"{FENCE}\n## ACTIVE POLICIES (MANDATORY)\n\n### Stale policy\n{FENCE}\nx\n{FENCE}"
    codex_md.parent.mkdir(parents=True)
    codex_md.write_text(_installed(INSTALLER_PROTOCOL, old_policies), encoding="utf-8")

    result = codex.update_codex_instructions()

    out = codex_md.read_text(encoding="utf-8")
    assert result["status"] == "updated"
    assert "Installer-written protocol." in out
    assert "[Digital Me] — M1 application_rate protocol" in out
    assert "### Policy 1" in out and "Stale policy" not in out
    assert out.startswith("# Codex Instructions\n\nuser text\n\n")
    assert out.count(codex.BEGIN_MARKER) == 1 and out.count(codex.END_MARKER) == 1
    # idempotent
    assert codex.update_codex_instructions()["status"] == "unchanged"
    # a new policy set is picked up, protocol still kept
    index.write_text(INDEX.replace("{n}", "2"), encoding="utf-8")
    codex.update_codex_instructions()
    out2 = codex_md.read_text(encoding="utf-8")
    assert "### Policy 2" in out2 and "Installer-written protocol." in out2


def test_falls_back_to_protocol_reminder_which_carries_the_m1_rule(paths):
    codex_md, _ = paths
    result = codex.update_codex_instructions()
    out = codex_md.read_text(encoding="utf-8")
    assert result["status"] == "created"
    assert "## Digital Me Protocol" in out
    assert "[Digital Me] — M1 application_rate protocol" in out
    assert "### Policy 1" in out


def test_existing_protocol_needs_a_managed_section_and_a_fence():
    b, e = codex.BEGIN_MARKER, codex.END_MARKER
    assert codex._existing_protocol("no markers") == ""
    assert codex._existing_protocol(f"{b}\nprotocol only, no fence\n{e}") == ""
    assert codex._existing_protocol(f"{b}\n\nP\n\n{FENCE}\npolicies\n{e}") == "P"


def test_unreadable_codex_md_falls_back(paths, monkeypatch: pytest.MonkeyPatch):
    codex_md, _ = paths
    codex_md.parent.mkdir(parents=True)
    codex_md.write_text(_installed(INSTALLER_PROTOCOL, FENCE), encoding="utf-8")
    real_read = Path.read_text

    def flaky(self: Path, *args, **kwargs):
        if self == codex_md:
            raise OSError("unreadable")
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", flaky)
    section = codex.build_managed_section(codex._existing_protocol(""))
    assert "## Digital Me Protocol" in section
    with pytest.raises(OSError):
        codex.update_codex_instructions()
