"""Tests for generate_overviews' wiki-only scope.

Regression: collect_entries indexes BOTH trees (wiki/ and tastes/), but
generate_overviews wrote every domain's _OVERVIEW.md under wiki/<domain>/.
A taste-only domain (tastes/storytelling/ with no wiki/storytelling/ dir)
made the write raise ENOENT, which killed the whole crosslink step —
observed nightly from 2026-07-09 through 2026-07-11.

After the fix, overviews are a wiki-only surface: tastes-tree entries are
excluded (the tastes tree stays flat — leaves + status flips only), and a
wiki domain whose directory is missing is skipped instead of crashing.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from dream_cycle.crosslink import generate_overviews


def _entry(path: Path, domain: str, tree: str, title: str) -> dict:
    return {
        "title": title,
        "_path": path,
        "_rel_path": Path(domain) / path.name,
        "_domain": domain,
        "_tree": tree,
        "_body": "Body sentence.",
    }


def test_taste_only_domain_does_not_crash_or_write(tmp_path):
    wiki = tmp_path / "wiki"
    (wiki / "infra").mkdir(parents=True)
    tastes = tmp_path / "tastes"
    (tastes / "storytelling").mkdir(parents=True)

    wiki_md = wiki / "infra" / "a.md"
    wiki_md.write_text("body")
    taste_md = tastes / "storytelling" / "b.md"
    taste_md.write_text("body")

    config = SimpleNamespace(wiki_dir=wiki, wiki_root=tmp_path)
    entries = [
        _entry(wiki_md, "infra", "wiki", "Wiki entry"),
        _entry(taste_md, "storytelling", "tastes", "Taste leaf"),
    ]

    count = generate_overviews(config, entries)

    assert count == 1
    assert (wiki / "infra" / "_OVERVIEW.md").exists()
    # The tastes tree stays flat: no machine files, and no phantom wiki dir.
    assert not (tastes / "storytelling" / "_OVERVIEW.md").exists()
    assert not (wiki / "storytelling").exists()


def test_missing_wiki_domain_dir_is_skipped(tmp_path):
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    ghost_md = wiki / "ghost" / "a.md"  # dir intentionally not created

    config = SimpleNamespace(wiki_dir=wiki, wiki_root=tmp_path)
    entries = [_entry(ghost_md, "ghost", "wiki", "Ghost entry")]

    assert generate_overviews(config, entries) == 0


def test_taste_leaves_do_not_pollute_shared_domain_overview(tmp_path):
    """A domain present in BOTH trees lists only its wiki entries —
    taste leaves' path.name relative links would dangle from wiki/<domain>/."""
    wiki = tmp_path / "wiki"
    (wiki / "design").mkdir(parents=True)
    tastes = tmp_path / "tastes"
    (tastes / "design").mkdir(parents=True)

    wiki_md = wiki / "design" / "tokens.md"
    wiki_md.write_text("body")
    taste_md = tastes / "design" / "leaf.md"
    taste_md.write_text("body")

    config = SimpleNamespace(wiki_dir=wiki, wiki_root=tmp_path)
    entries = [
        _entry(wiki_md, "design", "wiki", "Tokens"),
        _entry(taste_md, "design", "tastes", "Leaf"),
    ]

    generate_overviews(config, entries)
    overview = (wiki / "design" / "_OVERVIEW.md").read_text()
    assert "tokens.md" in overview
    assert "leaf.md" not in overview
