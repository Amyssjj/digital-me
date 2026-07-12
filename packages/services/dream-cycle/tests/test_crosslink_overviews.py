"""Tests for generate_overviews' tree-consistent scope.

History: collect_entries indexes BOTH trees (wiki/ and tastes/), but
generate_overviews originally wrote every domain's _OVERVIEW.md under
wiki/<domain>/ — a taste-only domain (tastes/storytelling/ with no
wiki/storytelling/ dir) made the write raise ENOENT, killing the whole
crosslink step nightly 2026-07-09..11. The first fix scoped overviews to
the wiki; on 2026-07-12 the owner ratified tree-CONSISTENT overviews
instead: each tree's domain dir gets an overview built from its OWN
entries.

Invariants:
- overviews land in the entry's own tree (wiki/<d>/ and tastes/<d>/);
- links never cross trees (path.name links stay within their directory);
- a domain directory that doesn't exist is skipped, never created;
- `_`-prefixed files are invisible to all consumers, so tastes overviews
  don't pollute the leaf stream (lifecycle stays flat + status-flip).
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


def _config(tmp_path: Path) -> SimpleNamespace:
    return SimpleNamespace(wiki_dir=tmp_path / "wiki", wiki_root=tmp_path)


def test_overviews_written_in_both_trees(tmp_path):
    wiki = tmp_path / "wiki"
    (wiki / "infra").mkdir(parents=True)
    tastes = tmp_path / "tastes"
    (tastes / "storytelling").mkdir(parents=True)

    wiki_md = wiki / "infra" / "a.md"
    wiki_md.write_text("body")
    taste_md = tastes / "storytelling" / "b.md"
    taste_md.write_text("body")

    entries = [
        _entry(wiki_md, "infra", "wiki", "Wiki entry"),
        _entry(taste_md, "storytelling", "tastes", "Taste leaf"),
    ]

    count = generate_overviews(_config(tmp_path), entries)

    assert count == 2
    assert (wiki / "infra" / "_OVERVIEW.md").exists()
    assert (tastes / "storytelling" / "_OVERVIEW.md").exists()
    # No phantom cross-tree dir gets created.
    assert not (wiki / "storytelling").exists()
    taste_overview = (tastes / "storytelling" / "_OVERVIEW.md").read_text()
    assert "Taste leaf" in taste_overview and "b.md" in taste_overview


def test_missing_domain_dir_is_skipped_in_either_tree(tmp_path):
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    ghost_wiki = wiki / "ghost" / "a.md"          # dir intentionally missing
    ghost_taste = tmp_path / "tastes" / "gone" / "b.md"  # dir intentionally missing

    entries = [
        _entry(ghost_wiki, "ghost", "wiki", "Ghost entry"),
        _entry(ghost_taste, "gone", "tastes", "Gone leaf"),
    ]

    assert generate_overviews(_config(tmp_path), entries) == 0
    assert not (wiki / "ghost").exists()
    assert not (tmp_path / "tastes" / "gone").exists()


def test_shared_domain_overviews_do_not_cross_trees(tmp_path):
    """wiki/design and tastes/design each list only their own entries —
    a cross-tree path.name link would dangle from the other directory."""
    wiki = tmp_path / "wiki"
    (wiki / "design").mkdir(parents=True)
    tastes = tmp_path / "tastes"
    (tastes / "design").mkdir(parents=True)

    wiki_md = wiki / "design" / "tokens.md"
    wiki_md.write_text("body")
    taste_md = tastes / "design" / "leaf.md"
    taste_md.write_text("body")

    entries = [
        _entry(wiki_md, "design", "wiki", "Tokens"),
        _entry(taste_md, "design", "tastes", "Leaf"),
    ]

    assert generate_overviews(_config(tmp_path), entries) == 2
    wiki_overview = (wiki / "design" / "_OVERVIEW.md").read_text()
    taste_overview = (tastes / "design" / "_OVERVIEW.md").read_text()
    assert "tokens.md" in wiki_overview and "leaf.md" not in wiki_overview
    assert "leaf.md" in taste_overview and "tokens.md" not in taste_overview
