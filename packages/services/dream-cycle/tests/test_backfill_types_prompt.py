"""Tests for backfill_types._build_batch_prompt frontmatter coercion.

Regression: YAML parses unquoted numeric scalars by type, so an entry with
`tags: [pull-request-review, 422, self-review]` yields an int in the tags
list. `", ".join(...)` then raised `TypeError: sequence item 1: expected
str instance, int found`, failing the whole 5-entry batch — not just the
offending entry. The prompt builder now coerces every tag/domain to str.
"""

from __future__ import annotations

import yaml

from dream_cycle.backfill_types import _build_batch_prompt, _fm_list
from dream_cycle.consolidate import normalize_domain_name


def _entry(**overrides) -> dict:
    base = {
        "_rel_path": "github-actions/sample.md",
        "_domain": "github-actions",
        "_body": "## Rule\nDo the thing.",
        "title": "Sample",
        "domain": ["github-actions"],
        "tags": ["a", "b"],
    }
    base.update(overrides)
    return base


def test_int_tag_from_yaml_does_not_raise():
    # Mirror the real on-disk shape: unquoted 422 parses as int.
    fm = yaml.safe_load(
        "tags: [pull-request-review, 422, self-review, gh-api, automation, verdict]\n"
    )
    assert 422 in fm["tags"]  # sanity: YAML really gives us an int

    prompt = _build_batch_prompt([_entry(tags=fm["tags"])])

    assert "TAGS: pull-request-review, 422, self-review, gh-api, automation, verdict" in prompt


def test_int_domain_does_not_raise():
    prompt = _build_batch_prompt([_entry(domain=["infra", 2026])])
    assert "DOMAINS: infra, 2026" in prompt


def test_one_bad_entry_does_not_poison_batch():
    entries = [
        _entry(_rel_path="a.md", tags=["x"]),
        _entry(_rel_path="b.md", tags=["y", 422]),
        _entry(_rel_path="c.md", tags=[3.5, None, "z"]),
    ]
    prompt = _build_batch_prompt(entries)
    assert "PATH: a.md" in prompt and "PATH: b.md" in prompt and "PATH: c.md" in prompt
    assert "TAGS: y, 422" in prompt
    assert "TAGS: 3.5, z" in prompt  # None dropped, float stringified


def test_scalar_tags_and_domain_are_not_split_into_characters():
    # `tags: foo` (bare scalar) parses as str; joining a str iterates chars.
    prompt = _build_batch_prompt([_entry(tags="foo", domain="bar")])
    assert "TAGS: foo" in prompt
    assert "DOMAINS: bar" in prompt


def test_missing_domain_falls_back_to_directory_domain():
    prompt = _build_batch_prompt([_entry(domain=None, _domain="misc")])
    assert "DOMAINS: misc" in prompt
    # Empty list also falls back (matches the pre-fix `or [...]` semantics).
    prompt = _build_batch_prompt([_entry(domain=[], _domain="misc")])
    assert "DOMAINS: misc" in prompt


def test_fm_list_helper_shapes():
    assert _fm_list(None) == []
    assert _fm_list("solo") == ["solo"]
    assert _fm_list(422) == ["422"]
    assert _fm_list(["a", 1, None, 2.0]) == ["a", "1", "2.0"]


def test_consolidate_normalize_domain_accepts_int_via_str():
    # consolidate.py's domain pass now wraps each item in str() before
    # normalize_domain_name; the function itself still expects a str.
    assert normalize_domain_name(str(2026)) == "2026"
