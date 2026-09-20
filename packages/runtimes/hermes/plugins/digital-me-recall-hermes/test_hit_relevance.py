"""Unit tests for the Hermes recall plugin's `_hit_relevance` — the
backend-neutral 0..1 relevance the MIN_SCORE gate reads.

Regression: brain-host's `score` used to be the reciprocal-rank-fusion sum
(~0.05 max), so gating on `score` alone dropped every brain-host hit. The
plugin now prefers `vectorScore` (cosine, 0..1) and falls back to `score`
for gateway-shaped hits that carry only `score`.

Run standalone (the plugin dir name has a hyphen so it isn't an importable
package; load it by path):

    python3 packages/runtimes/hermes/plugins/digital-me-recall-hermes/test_hit_relevance.py

or under pytest:

    python3 -m pytest packages/runtimes/hermes/plugins/digital-me-recall-hermes/test_hit_relevance.py
"""

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "dmrh_relevance_under_test", Path(__file__).with_name("__init__.py")
)
dmrh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dmrh)


def test_prefers_vector_score_over_fused_score():
    # brain-host shape (pre-fix): `score` is the RRF sum, `vectorScore` the cosine.
    hit = {"path": "wiki/x.md", "score": 0.042, "vectorScore": 0.78, "textScore": 1}
    assert dmrh._hit_relevance(hit) == 0.78
    assert dmrh._hit_relevance(hit) >= dmrh.MIN_SCORE


def test_falls_back_to_score_for_gateway_shaped_hits():
    hit = {"path": "../digital-me/wiki/x.md", "score": 0.47}
    assert dmrh._hit_relevance(hit) == 0.47


def test_missing_or_null_scores_count_as_zero():
    assert dmrh._hit_relevance({"path": "wiki/x.md"}) == 0.0
    assert dmrh._hit_relevance({"path": "wiki/x.md", "score": None}) == 0.0
    assert dmrh._hit_relevance({"vectorScore": None, "score": None}) == 0.0


def test_non_numeric_scores_count_as_zero():
    assert dmrh._hit_relevance({"score": "high"}) == 0.0
    assert dmrh._hit_relevance({"vectorScore": {"nested": 1}}) == 0.0


def test_gate_keeps_brain_host_hit_and_drops_weak_one():
    strong = {"path": "wiki/a.md", "score": 0.04, "vectorScore": 0.8}
    weak = {"path": "wiki/b.md", "score": 0.03, "vectorScore": 0.2}
    kept = [h for h in (strong, weak) if dmrh._hit_relevance(h) >= dmrh.MIN_SCORE]
    assert kept == [strong]


def test_format_injection_renders_vector_score_percent():
    text = dmrh._format_injection([{"path": "wiki/a.md", "score": 0.04, "vectorScore": 0.8, "snippet": "s"}])
    assert "(score=80/100)" in text


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
