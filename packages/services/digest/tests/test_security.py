"""Path-handling safety: log-derived reads stay inside the wiki tree, and the
staging `date` can't carry a traversal value into titles/filenames."""

import json

from digest import config
from digest import daily_digest as dd


def test_confined_read_blocks_paths_outside_wiki_root(monkeypatch, tmp_path):
    """`files_written`/`skill_files` come from a semi-trusted local log; a path
    outside the wiki root must NOT be read (no arbitrary-file-read → Discord)."""
    wiki_root = tmp_path / "digital-me"
    (wiki_root / "wiki").mkdir(parents=True)
    inside = wiki_root / "wiki" / "entry.md"
    inside.write_text("title: Inside", encoding="utf-8")
    outside = tmp_path / "secret.txt"
    outside.write_text("SECRET", encoding="utf-8")

    monkeypatch.setattr(dd, "_PATHS", config.load_paths(wiki_root=wiki_root))

    assert dd._confined_read(inside) == "title: Inside"
    assert dd._confined_read(outside) is None
    # `..` traversal from inside the tree is also refused.
    assert dd._confined_read(wiki_root / "wiki" / ".." / ".." / "secret.txt") is None


def test_extract_entry_summary_refuses_outside_path(monkeypatch, tmp_path):
    wiki_root = tmp_path / "digital-me"
    (wiki_root / "wiki").mkdir(parents=True)
    outside = tmp_path / "id_rsa"
    outside.write_text("PRIVATE KEY", encoding="utf-8")
    monkeypatch.setattr(dd, "_PATHS", config.load_paths(wiki_root=wiki_root))

    title, domains, created, updated = dd._extract_entry_summary(outside)
    # Falls back to the stem only — never reads/leaks the file contents.
    assert "PRIVATE KEY" not in (title + domains + created + updated)
    assert title == "id_rsa"


def test_read_staging_rejects_non_iso_date(tmp_path):
    p = tmp_path / "staging.json"
    p.write_text(json.dumps({"date": "../../../etc/cron.d/evil", "presentation": None}))
    assert dd.read_staging(p)["date"] is None


def test_read_staging_keeps_valid_iso_date(tmp_path):
    p = tmp_path / "staging.json"
    p.write_text(json.dumps({"date": "2026-06-28", "presentation": None}))
    assert dd.read_staging(p)["date"] == "2026-06-28"
