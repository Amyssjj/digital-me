"""Tests for the taste-eligibility filter improvements in compile.py.

Covers two production-grade filter additions:

  1. Source-path exclusion (TASTE_EXCLUDED_SOURCE_FRAGMENTS): transcripts
     under coo/cron paths shouldn't be staged even when they pass numerical
     thresholds — empirically they yield 0 candidates and consume the
     taste-limit budget.

  2. User-message-density floor (TASTE_MIN_USER_MSG_CHARS + heartbeat
     instruction detection): "user turns" that are bare metadata blocks
     or scheduled HEARTBEAT.md instructions shouldn't inflate user_turns.
"""

from __future__ import annotations

from dream_cycle.compile import (
    TASTE_EXCLUDED_SOURCE_FRAGMENTS,
    TASTE_MIN_USER_MSG_CHARS,
    _is_real_user_turn,
    _real_user_content_length,
    is_taste_eligible,
)


# ── _real_user_content_length ─────────────────────────────────────────────


def test_real_user_content_length_strips_conversation_info_block() -> None:
    text = """Conversation info (untrusted metadata):
```json
{
  "sender": "Owner",
  "timestamp": "2026-05-19"
}
```

This is the actual user message that should be counted."""
    # The JSON wrapper gets stripped; only the trailing prose counts.
    assert (
        _real_user_content_length(text)
        == len("This is the actual user message that should be counted.")
    )


def test_real_user_content_length_strips_sender_metadata_block() -> None:
    text = """Sender (untrusted metadata):
```json
{"label": "Owner", "id": "..."}
```"""
    # Pure metadata → 0 real content
    assert _real_user_content_length(text) == 0


def test_real_user_content_length_strips_external_untrusted_block() -> None:
    text = (
        "<<<EXTERNAL_UNTRUSTED_CONTENT id=\"abc\">>>\n"
        "channel topic: noise\n"
        "<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"abc\">>>\n"
        "real Owner-authored content here"
    )
    assert _real_user_content_length(text) == len("real Owner-authored content here")


def test_real_user_content_length_zero_on_heartbeat_marker() -> None:
    """Heartbeat instructions short-circuit to 0 regardless of surrounding
    text — they're scheduled pings, not human turns."""
    text = """Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.
Do not infer or repeat old tasks from prior chats.
If nothing needs attention, reply HEARTBEAT_OK.

Current time: Wednesday, May 13th, 2026 - 11:05 AM"""
    assert _real_user_content_length(text) == 0


def test_real_user_content_length_keeps_genuine_text() -> None:
    text = "Hey, can you help me design the new compile filter? Specifically the heartbeat exclusion."
    assert _real_user_content_length(text) == len(text)


# ── _is_real_user_turn ────────────────────────────────────────────────────


def test_is_real_user_turn_accepts_genuine_message() -> None:
    record = {"role": "user"}
    text = "Can you investigate yesterday's dream-cycle taste output?"
    assert _is_real_user_turn(record, text) is True


def test_is_real_user_turn_rejects_heartbeat_instruction() -> None:
    record = {"role": "user"}
    text = "Read HEARTBEAT.md if it exists. If nothing needs attention, reply HEARTBEAT_OK."
    assert _is_real_user_turn(record, text) is False


def test_is_real_user_turn_rejects_metadata_only_message() -> None:
    record = {"role": "user"}
    text = (
        "Conversation info (untrusted metadata):\n"
        "```json\n"
        '{"sender": "Owner"}\n'
        "```"
    )
    assert _is_real_user_turn(record, text) is False


def test_is_real_user_turn_rejects_short_post_strip(monkeypatch) -> None:
    """A message that's only 3 chars after stripping metadata fails the floor."""
    record = {"role": "user"}
    text = "Conversation info (untrusted metadata):\n```json\n{}\n```\nok"
    # Post-strip length is len("ok") == 2, which is <= TASTE_MIN_USER_MSG_CHARS (5).
    assert _is_real_user_turn(record, text) is False


def test_is_real_user_turn_still_rejects_existing_markers() -> None:
    record = {"role": "user"}
    assert _is_real_user_turn(record, "<local-command-caveat>foo</local-command-caveat>") is False
    record_meta = {"role": "user", "isMeta": True}
    assert _is_real_user_turn(record_meta, "real text here") is False


# ── is_taste_eligible: source-path exclusion ──────────────────────────────


def _passing_numeric_entry(**overrides):
    """Entry that meets all numerical thresholds — for testing the source-path
    short-circuit."""
    base = {
        "user_turns": 20,
        "assistant_turns": 10,
        "body_chars": 10_000,
        "source_file": "/home/test/digital-me/inbox/transcripts/abc.jsonl",
    }
    base.update(overrides)
    return base


def test_is_taste_eligible_accepts_passing_entry() -> None:
    assert is_taste_eligible(_passing_numeric_entry()) is True


def test_is_taste_eligible_rejects_coo_session_path() -> None:
    entry = _passing_numeric_entry(
        source_file="/home/test/.openclaw/agents/coo/sessions/foo.jsonl"
    )
    assert is_taste_eligible(entry) is False


def test_is_taste_eligible_rejects_podcast_agent_path() -> None:
    entry = _passing_numeric_entry(
        source_file="/home/test/.openclaw/agents/podcast/sessions/bar.jsonl"
    )
    assert is_taste_eligible(entry) is False


def test_is_taste_eligible_rejects_cron_output_path() -> None:
    entry = _passing_numeric_entry(
        source_file="/home/test/.hermes/cron/output/abc/2026-05-19_03-00.md"
    )
    assert is_taste_eligible(entry) is False


def test_is_taste_eligible_rejects_below_user_turns_threshold() -> None:
    entry = _passing_numeric_entry(user_turns=5)
    assert is_taste_eligible(entry) is False


def test_taste_excluded_source_fragments_covers_coo_and_cron() -> None:
    """Sanity-check that the constant tuple covers the two source families
    documented in the rationale comment — guards against accidental
    deletion."""
    fragments_str = " ".join(TASTE_EXCLUDED_SOURCE_FRAGMENTS)
    assert "coo" in fragments_str
    assert "cron" in fragments_str


def test_taste_min_user_msg_chars_is_positive() -> None:
    """If someone sets this to 0 (or negative) the filter degrades to
    accepting every empty message — guard the constant."""
    assert TASTE_MIN_USER_MSG_CHARS > 0
