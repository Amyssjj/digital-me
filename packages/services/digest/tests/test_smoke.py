"""Tests for the post-update/install smoke gate."""

from __future__ import annotations

from digest import daily_digest as dd
from digest import smoke


def test_smoke_passes_on_healthy_package():
    """The shipped package must pass its own smoke gate."""
    assert smoke.run_smoke() == 0
    assert smoke._check_contract() == []


def test_smoke_catches_validator_schema_drift(monkeypatch):
    """If the validator's tones drift from the schema file (the prompt↔validator
    desync class), the gate must flag it."""
    monkeypatch.setattr(dd, "_VALID_TONES", {"totally-bogus-tone"})
    failures = smoke._check_contract()
    assert any("tones" in f for f in failures)


def test_smoke_catches_content_key_regression(monkeypatch):
    """Reproduce the 2026-06-28 outage: a publisher that only sees `text` and
    ignores `content` must be caught by the gate."""
    def _text_only(presentation):
        # Simulate the pre-fix normalizer that dropped `content`-keyed blocks.
        blocks = []
        for raw in presentation.get("blocks") or []:
            if isinstance(raw, dict) and raw.get("type") == "text" and raw.get("text"):
                blocks.append({"type": "text", "text": raw["text"]})
        return {**presentation, "blocks": blocks}

    monkeypatch.setattr(dd, "_normalize_presentation", _text_only)
    failures = smoke._check_contract()
    assert any("content`-keyed" in f or "content-keyed" in f for f in failures)


def test_smoke_catches_broken_floor(monkeypatch):
    """If the fail-open floor stops producing visible text, the digest could
    silently publish nothing — the gate must catch it."""
    monkeypatch.setattr(
        dd, "_minimal_presentation", lambda _date: {"title": "x", "tone": "info", "blocks": []}
    )
    failures = smoke._check_contract()
    assert failures  # empty-blocks floor violates schema (minItems) and/or visibility
