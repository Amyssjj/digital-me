"""The summarize->publish seam contract.

These tests pin the exact failure class that took the digest down on
2026-06-28: a producer emitting `{"type":"text","content":...}` while the
publisher only recognized `text`. The contract must (a) accept that variant via
the tolerant reader and normalize it, and (b) reject a genuinely empty
presentation so the publish path fails open to a deterministic floor.
"""

from digest import daily_digest as dd


def _good():
    return {
        "title": "Daily Digest — 2026-06-28",
        "tone": "success",
        "blocks": [
            {"type": "text", "text": "Agents 4  Wiki+ 1"},
            {"type": "divider"},
            {"type": "header", "text": "Wiki"},
            {"type": "text", "text": "1. created **Foo** — _infra_"},
        ],
    }


def test_valid_presentation_passes():
    assert dd.validate_presentation(_good()) == []


def test_content_key_block_is_accepted_and_normalized():
    """Regression for the 2026-06-28 outage: a block keyed `content` instead of
    `text` must be treated as visible (tolerant reader) and normalized to a
    `text`-keyed block the Discord publisher renders."""
    pres = {
        "title": "Daily Digest — 2026-06-28",
        "tone": "info",
        "blocks": [{"type": "text", "content": "Executive summary text"}],
    }
    # Tolerant reader sees it → contract is satisfied, NOT a silent empty.
    assert dd.validate_presentation(pres) == []
    # Normalization rewrites it into a visible `text` block.
    norm = dd._normalize_presentation(pres)
    visible = [dd._block_text(b) for b in norm["blocks"] if b.get("type") == "text"]
    assert any("Executive summary text" in v for v in visible)


def test_empty_blocks_flagged():
    pres = {"title": "t", "tone": "info", "blocks": []}
    errs = dd.validate_presentation(pres)
    assert any("blocks" in e for e in errs)


def test_only_dividers_has_no_visible_text():
    pres = {"title": "t", "tone": "info", "blocks": [{"type": "divider"}]}
    assert "no visible text blocks" in dd.validate_presentation(pres)


def test_empty_text_block_flagged():
    pres = {"title": "t", "tone": "info", "blocks": [{"type": "text", "text": "   "}]}
    errs = dd.validate_presentation(pres)
    assert any("empty text" in e for e in errs)
    assert "no visible text blocks" in errs


def test_bad_tone_flagged():
    pres = _good()
    pres["tone"] = "celebratory"
    assert any(e.startswith("tone:") for e in dd.validate_presentation(pres))


def test_bad_block_type_flagged():
    pres = _good()
    pres["blocks"].append({"type": "section", "text": "x"})
    assert any(".type:" in e for e in dd.validate_presentation(pres))


def test_missing_title_flagged():
    pres = _good()
    pres["title"] = ""
    assert any(e.startswith("title:") for e in dd.validate_presentation(pres))


def test_non_dict_is_invalid():
    assert dd.validate_presentation(None) == ["presentation is not an object"]
    assert dd.validate_presentation([]) == ["presentation is not an object"]


def test_minimal_presentation_is_valid():
    """The fail-open floor must always satisfy its own contract."""
    assert dd.validate_presentation(dd._minimal_presentation("2026-06-28")) == []


def test_validator_agrees_with_schema_file():
    """presentation.schema.json is the canonical contract — the in-code
    validator's enums MUST match it, so the shipped schema file is load-bearing
    (drift fails this test) rather than decorative."""
    import json
    from pathlib import Path

    schema = json.loads(
        (Path(dd.__file__).parent / "presentation.schema.json").read_text()
    )
    schema_tones = set(schema["properties"]["tone"]["enum"])
    schema_block_types = set(
        schema["properties"]["blocks"]["items"]["properties"]["type"]["enum"]
    )
    assert dd._VALID_TONES == schema_tones
    assert dd._VALID_BLOCK_TYPES == schema_block_types
