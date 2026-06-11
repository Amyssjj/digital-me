"""Unit tests for the Hermes recall plugin's `_parse_ack` — the M1
application-rate ack parser.

Run standalone (the plugin dir name has a hyphen so it isn't an importable
package; load it by path):

    python3 packages/runtimes/hermes/plugins/digital-me-recall-hermes/test_parse_ack.py

or under pytest:

    python3 -m pytest packages/runtimes/hermes/plugins/digital-me-recall-hermes/test_parse_ack.py
"""

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "dmrh_under_test", Path(__file__).with_name("__init__.py")
)
dmrh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dmrh)

SURFACED = [
    {
        "path": "infrastructure/m1-universal-event-protocol.md",
        "title": "M1 Universal Event Protocol",
    },
    {"path": "youtube/thumbnail-rules.md", "title": "Thumbnail Rules"},
]


def test_explicit_path_when_reply_names_surfaced_slug():
    sig, acted = dmrh._parse_ack(
        "[Digital Me] applying m1-universal-event-protocol — paired surfaced↔ack.",
        SURFACED,
    )
    assert sig == "explicit_path"
    assert [e["path"] for e in acted] == [
        "infrastructure/m1-universal-event-protocol.md"
    ]


def test_title_match_when_reply_names_title_only():
    sig, acted = dmrh._parse_ack(
        "[Digital Me] applying the Thumbnail Rules entry.", SURFACED
    )
    assert sig == "title_match"
    assert [e["path"] for e in acted] == ["youtube/thumbnail-rules.md"]


def test_no_applicable_on_explicit_decline():
    sig, acted = dmrh._parse_ack(
        "[Digital Me] no applicable wiki entries. Proceeding.", SURFACED
    )
    assert sig == "no_applicable"
    assert acted == []


def test_prefix_fallback_to_top1_when_nothing_matchable():
    sig, acted = dmrh._parse_ack(
        "[Digital Me] applying the relevant guidance below.", SURFACED
    )
    assert sig == "title_match"
    assert [e["path"] for e in acted] == [
        "infrastructure/m1-universal-event-protocol.md"
    ]


def test_no_ack_without_prefix_or_citation():
    sig, acted = dmrh._parse_ack("Sure, here is a plain answer.", SURFACED)
    assert sig == "no_acknowledgement"
    assert acted == []


def test_no_ack_when_nothing_surfaced():
    sig, _ = dmrh._parse_ack("[Digital Me] applying x", [])
    assert sig == "no_acknowledgement"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
