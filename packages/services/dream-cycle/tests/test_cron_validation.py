"""validate_cron_expression must accept standard 5-field cron syntax,
reject everything outside it, and fail load_config when config.yaml
ships a garbage schedule string.
"""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent

import pytest

from dream_cycle.config import load_config, validate_cron_expression


VALID = [
    "0 3 * * *",
    "*/15 * * * *",
    "0 0 1 * *",
    "30 14 * * 1-5",
    "0,15,30,45 * * * *",
    "0 9-17/2 * * 1-5",
    "0 0 * * 0",
    "0 0 * * 7",  # 7 and 0 both = Sunday in standard cron
    "59 23 31 12 6",
    "*/1 */1 */1 */1 */1",
    "5,10-15,20-30/2 * * * *",
]


@pytest.mark.parametrize("expr", VALID)
def test_accepts_valid_expressions(expr: str) -> None:
    # No assertion needed — validator returns None on success, raises on fail.
    validate_cron_expression(expr)


INVALID = [
    ("", "empty"),
    ("   ", "empty"),
    ("0 3 * *", "5 fields"),
    ("0 3 * * * *", "5 fields"),
    ("60 0 * * *", "out of range"),
    ("0 24 * * *", "out of range"),
    ("0 0 32 * *", "out of range"),
    ("0 0 0 * *", "out of range"),    # DOM is 1-31
    ("0 0 * 13 *", "out of range"),
    ("0 0 * * 8", "out of range"),
    ("5-1 * * * *", "range start"),    # reversed
    ("*/0 * * * *", "> 0"),
    ("abc * * * *", "numeric only"),
    ("0 0 * * mon", "numeric only"),   # named weekday rejected
    ("0,, * * * *", "empty token"),
    ("0 0 - * *", "invalid range"),
]


@pytest.mark.parametrize("expr,fragment", INVALID)
def test_rejects_invalid_expressions(expr: str, fragment: str) -> None:
    with pytest.raises(ValueError, match=fragment):
        validate_cron_expression(expr)


def test_load_config_rejects_bad_schedule(tmp_path: Path) -> None:
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(dedent("""\
        engine: standalone
        standalone:
          api_key_env: GEMINI_API_KEY
        sources: []
        dream_cycle:
          schedule: "every nite at 3"
    """))
    with pytest.raises(ValueError, match="invalid dream_cycle.schedule"):
        load_config(path=cfg_path, wiki_root=tmp_path)


def test_load_config_accepts_omitted_schedule(fixture_wiki: Path) -> None:
    """The default `0 3 * * *` is itself valid; omitted schedule shouldn't error."""
    cfg = load_config(wiki_root=fixture_wiki)
    assert cfg.dream_cycle.schedule == "0 3 * * *"
