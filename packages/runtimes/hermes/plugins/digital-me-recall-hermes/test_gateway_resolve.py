"""Unit tests for the Hermes recall plugin's brain-endpoint resolution and
score gate — the pieces that decide whether recall reaches digital-me
brain-host (DIGITAL_ME_BRAIN_URL with the token from DIGITAL_ME_BRAIN_TOKEN,
DIGITAL_ME_BRAIN_TOKEN_FILE or the default token file) or the openclaw
gateway, and whether brain-host's RRF-fused `score` survives MIN_SCORE.

Run standalone (the plugin dir name has a hyphen so it isn't an importable
package; load it by path):

    python3 packages/runtimes/hermes/plugins/digital-me-recall-hermes/test_gateway_resolve.py

or under pytest:

    python3 -m pytest packages/runtimes/hermes/plugins/digital-me-recall-hermes/test_gateway_resolve.py

Every test takes no fixtures so the standalone `__main__` runner and pytest
run the same functions.
"""

import contextlib
import importlib.util
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

_spec = importlib.util.spec_from_file_location(
    "dmrh_resolve_under_test", Path(__file__).with_name("__init__.py")
)
dmrh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dmrh)

_ENV_KEYS = (
    "DIGITAL_ME_BRAIN_URL",
    "DIGITAL_ME_BRAIN_TOKEN",
    "DIGITAL_ME_BRAIN_TOKEN_FILE",
    "DIGITAL_ME_WIKI_ROOT",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_HOST",
    "OPENCLAW_GATEWAY_PORT",
    "DIGITAL_ME_OPENCLAW_CONFIG",
)

# A brain-host-shaped memory_search hit: absolute data-repo path, RRF-fused
# `score` (<= ~0.05), cosine `vectorScore`, plus relPath/citation. The root
# is a deliberately fake absolute prefix — the sanitize gate forbids real
# home paths in source, and _normalize_hit_path only keys on "/wiki/".
FAKE_DATA_ROOT = "/srv/brain-host-e2e/digital-me"
BRAIN_HOST_HIT_PATH = f"{FAKE_DATA_ROOT}/wiki/infrastructure/hermes-runtime-onsessionend-hook-limitations.md"
BRAIN_HOST_TASTE_PATH = f"{FAKE_DATA_ROOT}/tastes/design/no-italics.md"


@contextlib.contextmanager
def _env(**overrides: Optional[str]) -> Iterator[Path]:
    """Clear every endpoint-related variable, apply `overrides`, restore after.
    Also resets the plugin's cached token + one-shot error flag so each test
    resolves from scratch, and pins DIGITAL_ME_WIKI_ROOT to a scratch dir
    (yielded) so the default brain-host token file under a real ~/digital-me
    can never leak into a "no token" assertion."""
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    with tempfile.TemporaryDirectory() as scratch:
        os.environ["DIGITAL_ME_WIKI_ROOT"] = scratch
        for k, v in overrides.items():
            if v is not None:
                os.environ[k] = v
        dmrh._GATEWAY_TOKEN = None
        dmrh._BRAIN_TOKEN_MISSING_LOGGED = False
        try:
            yield Path(scratch)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            dmrh._GATEWAY_TOKEN = None
            dmrh._BRAIN_TOKEN_MISSING_LOGGED = False


def _reset_session(session_id: str) -> None:
    dmrh._session_cleanup(session_id)


def _brain_host_payload(hits: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The /tools/invoke envelope brain-host returns for memory_search."""
    inner = {
        "results": hits,
        "provider": "gemini",
        "model": "gemini-embedding-001",
        "count": len(hits),
        "query": "q",
        "citations": "auto",
    }
    return {
        "ok": True,
        "result": {
            "content": [{"type": "text", "text": json.dumps(inner)}],
            "details": {},
        },
    }


def _brain_host_hit(
    path: str = BRAIN_HOST_HIT_PATH,
    *,
    score: float = 0.042,
    vector_score: Optional[float] = 0.78,
    rel_path: str = "wiki/infrastructure/hermes-runtime-onsessionend-hook-limitations.md",
) -> Dict[str, Any]:
    hit: Dict[str, Any] = {
        "path": path,
        "relPath": rel_path,
        "title": "Hermes Runtime on_session_end Hook Limitations",
        "corpus": "wiki",
        "startLine": 29,
        "endLine": 33,
        "score": score,
        "textScore": 0.333333,
        "snippet": "Rule: on_session_end only fires at real session boundaries.",
        "source": "memory",
        "citation": f"{rel_path}#L29-L33",
    }
    if vector_score is not None:
        hit["vectorScore"] = vector_score
    return hit


# ── (a) brain-host env wins ────────────────────────────────────────────────


def test_brain_host_url_and_token_win():
    with _env(
        DIGITAL_ME_BRAIN_URL="http://brain.test:18791/tools/invoke",
        DIGITAL_ME_BRAIN_TOKEN="brain-secret",
        OPENCLAW_GATEWAY_URL="http://gw.test:18789/tools/invoke",
        OPENCLAW_GATEWAY_TOKEN="gw-secret",
        OPENCLAW_GATEWAY_HOST="gw-host",
        OPENCLAW_GATEWAY_PORT="1",
    ):
        assert dmrh._resolve_gateway_url() == "http://brain.test:18791/tools/invoke"
        assert dmrh._load_gateway_token() == "brain-secret"
        assert dmrh._get_token() == "brain-secret"


def test_brain_host_url_without_token_never_falls_back():
    # A gateway token (env or file) authenticates a different server; using
    # it against brain-host would be a silent 401. Recall must stay off.
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "openclaw.json"
        cfg.write_text(json.dumps({"gateway": {"auth": {"token": "file-secret"}}}))
        with _env(
            DIGITAL_ME_BRAIN_URL="http://brain.test:18791/tools/invoke",
            OPENCLAW_GATEWAY_TOKEN="gw-secret",
            DIGITAL_ME_OPENCLAW_CONFIG=str(cfg),
        ) as wiki_root:
            # No env token and no default token file under the scratch wiki root.
            assert dmrh._brain_token_file() == wiki_root / ".data" / "brain-host.token"
            assert not dmrh._brain_token_file().exists()
            assert dmrh._resolve_gateway_url() == "http://brain.test:18791/tools/invoke"
            assert dmrh._load_gateway_token() is None
            assert dmrh._get_token() is None
            # The misconfiguration is logged once, not on every turn.
            assert dmrh._BRAIN_TOKEN_MISSING_LOGGED is True
            assert dmrh._load_gateway_token() is None
            # And _invoke_gateway refuses to call without a token.
            assert dmrh._invoke_gateway("memory_search", {"query": "x"}) is None


def test_brain_host_error_log_names_both_token_vars():
    import logging

    class _Capture(logging.Handler):
        def __init__(self) -> None:
            super().__init__()
            self.messages: List[str] = []

        def emit(self, record: logging.LogRecord) -> None:
            self.messages.append(record.getMessage())

    handler = _Capture()
    dmrh.logger.addHandler(handler)
    try:
        with _env(DIGITAL_ME_BRAIN_URL="http://brain.test:18791/tools/invoke") as wiki_root:
            assert dmrh._load_gateway_token() is None
            assert len(handler.messages) == 1, handler.messages
            msg = handler.messages[0]
            assert "DIGITAL_ME_BRAIN_TOKEN," in msg and "DIGITAL_ME_BRAIN_TOKEN_FILE" in msg, msg
            assert str(wiki_root / ".data" / "brain-host.token") in msg, msg
    finally:
        dmrh.logger.removeHandler(handler)


def test_brain_host_token_from_default_file():
    with _env(DIGITAL_ME_BRAIN_URL="http://brain.test:18791/tools/invoke", OPENCLAW_GATEWAY_TOKEN="gw-secret") as wiki_root:
        token_file = wiki_root / ".data" / "brain-host.token"
        token_file.parent.mkdir(parents=True)
        token_file.write_text("  file-brain-secret\n")
        assert dmrh._load_gateway_token() == "file-brain-secret"   # trimmed
        assert dmrh._get_token() == "file-brain-secret"
        assert dmrh._BRAIN_TOKEN_MISSING_LOGGED is False


def test_brain_host_token_from_explicit_file_beats_default():
    with _env(DIGITAL_ME_BRAIN_URL="http://brain.test:18791/tools/invoke") as wiki_root:
        default_file = wiki_root / ".data" / "brain-host.token"
        default_file.parent.mkdir(parents=True)
        default_file.write_text("default-secret\n")
        explicit = wiki_root / "custom.token"
        explicit.write_text("explicit-secret\n")
        os.environ["DIGITAL_ME_BRAIN_TOKEN_FILE"] = str(explicit)
        assert dmrh._brain_token_file() == explicit
        assert dmrh._load_gateway_token() == "explicit-secret"
        # An empty DIGITAL_ME_BRAIN_TOKEN_FILE counts as unset → default file.
        os.environ["DIGITAL_ME_BRAIN_TOKEN_FILE"] = ""
        assert dmrh._load_gateway_token() == "default-secret"


def test_brain_host_env_token_beats_file():
    with _env(DIGITAL_ME_BRAIN_URL="http://brain.test:18791/tools/invoke", DIGITAL_ME_BRAIN_TOKEN="env-secret") as wiki_root:
        explicit = wiki_root / "custom.token"
        explicit.write_text("explicit-secret\n")
        os.environ["DIGITAL_ME_BRAIN_TOKEN_FILE"] = str(explicit)
        assert dmrh._load_gateway_token() == "env-secret"


def test_brain_host_empty_or_unreadable_token_file_is_no_token():
    with _env(DIGITAL_ME_BRAIN_URL="http://brain.test:18791/tools/invoke", OPENCLAW_GATEWAY_TOKEN="gw-secret") as wiki_root:
        blank = wiki_root / "blank.token"
        blank.write_text("   \n\n")
        os.environ["DIGITAL_ME_BRAIN_TOKEN_FILE"] = str(blank)
        assert dmrh._load_gateway_token() is None
        assert dmrh._BRAIN_TOKEN_MISSING_LOGGED is True
        # A directory is unreadable as a file → also "no token".
        dmrh._BRAIN_TOKEN_MISSING_LOGGED = False
        os.environ["DIGITAL_ME_BRAIN_TOKEN_FILE"] = str(wiki_root)
        assert dmrh._load_gateway_token() is None
        assert dmrh._read_brain_token_file(wiki_root) is None
        assert dmrh._read_brain_token_file(wiki_root / "missing.token") is None


def test_empty_brain_url_counts_as_unset():
    with _env(DIGITAL_ME_BRAIN_URL="", DIGITAL_ME_BRAIN_TOKEN="", OPENCLAW_GATEWAY_TOKEN="gw-secret"):
        assert dmrh._resolve_gateway_url() == dmrh.DEFAULT_GATEWAY_URL
        assert dmrh._load_gateway_token() == "gw-secret"


# ── (b) OPENCLAW_GATEWAY_URL / TOKEN ───────────────────────────────────────


def test_openclaw_gateway_url_and_token_env():
    with _env(
        OPENCLAW_GATEWAY_URL="http://gw.test:18789/tools/invoke",
        OPENCLAW_GATEWAY_TOKEN="gw-secret",
        OPENCLAW_GATEWAY_HOST="ignored-when-url-set",
    ):
        assert dmrh._resolve_gateway_url() == "http://gw.test:18789/tools/invoke"
        assert dmrh._load_gateway_token() == "gw-secret"


# ── (c) OPENCLAW_GATEWAY_HOST / PORT composition ───────────────────────────


def test_openclaw_gateway_host_port_composed():
    with _env(OPENCLAW_GATEWAY_HOST="10.0.0.9", OPENCLAW_GATEWAY_PORT="28789"):
        assert dmrh._resolve_gateway_url() == "http://10.0.0.9:28789/tools/invoke"
    with _env(OPENCLAW_GATEWAY_HOST="10.0.0.9"):
        assert dmrh._resolve_gateway_url() == "http://10.0.0.9:18789/tools/invoke"
    with _env(OPENCLAW_GATEWAY_PORT="28789"):
        assert dmrh._resolve_gateway_url() == "http://localhost:28789/tools/invoke"


# ── (d) nothing set → default URL + token from the openclaw config file ────


def test_nothing_set_uses_default_url_and_config_file_token():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "openclaw.json"
        cfg.write_text(json.dumps({"gateway": {"auth": {"token": "file-secret"}}}))
        with _env(DIGITAL_ME_OPENCLAW_CONFIG=str(cfg)):
            assert dmrh._resolve_gateway_url() == dmrh.DEFAULT_GATEWAY_URL
            assert dmrh.DEFAULT_GATEWAY_URL == "http://localhost:18789/tools/invoke"
            assert dmrh._load_gateway_token() == "file-secret"


def test_unreadable_config_file_yields_no_token():
    with tempfile.TemporaryDirectory() as tmp:
        bad = Path(tmp) / "openclaw.json"
        bad.write_text("{not json")
        # Point the explicit override at the bad file; the default candidates
        # (~/.openclaw/..., ~/.clawdbot/...) may exist on a developer machine,
        # so only assert that the bad file itself is skipped rather than that
        # the overall result is None.
        with _env(DIGITAL_ME_OPENCLAW_CONFIG=str(bad)):
            tok = dmrh._load_gateway_token()
            assert tok != "{not json"


# ── (e) score gate uses the cosine-scale number ────────────────────────────


def test_hit_score_prefers_vector_score_when_present():
    assert dmrh._hit_score({"score": 0.042, "vectorScore": 0.78}) == 0.78
    assert dmrh._hit_score({"score": 0.56}) == 0.56
    # Gateway shape: fused score below vectorScore → max never tightens the gate.
    assert dmrh._hit_score({"score": 0.49, "vectorScore": 0.70}) == 0.70
    # Defensive: missing / non-numeric values gate to 0, never raise.
    assert dmrh._hit_score({}) == 0.0
    assert dmrh._hit_score({"score": None, "vectorScore": "0.9"}) == 0.0
    assert dmrh._hit_score({"score": 0.3, "vectorScore": None}) == 0.3


def test_min_score_is_cosine_scale():
    assert dmrh.MIN_SCORE == 0.4
    assert dmrh._hit_score(_brain_host_hit()) >= dmrh.MIN_SCORE
    assert dmrh._hit_score(_brain_host_hit(vector_score=0.2)) < dmrh.MIN_SCORE


# ── path normalisation for brain-host absolute paths ──────────────────────


def test_normalize_hit_path_handles_brain_host_absolute_paths():
    assert dmrh._normalize_hit_path(BRAIN_HOST_HIT_PATH) == (
        "infrastructure/hermes-runtime-onsessionend-hook-limitations.md"
    )
    assert dmrh._normalize_hit_path(BRAIN_HOST_TASTE_PATH) == "tastes/design/no-italics.md"
    # Gateway relative encoding still normalises the same way.
    assert dmrh._normalize_hit_path("../../../x/digital-me/wiki/youtube/thumbs.md") == "youtube/thumbs.md"
    assert dmrh._normalize_hit_path("memory/agent/notes.md") == "memory/agent/notes.md"
    assert dmrh._normalize_hit_path("/etc/passwd") is None
    assert dmrh._normalize_hit_path("") is None


def test_read_wiki_body_resolves_tastes_beside_wiki():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "wiki" / "infra").mkdir(parents=True)
        (root / "tastes" / "design").mkdir(parents=True)
        (root / "wiki" / "infra" / "a.md").write_text("---\ntitle: A\n---\n\n## Rule\nwiki body\n")
        (root / "tastes" / "design" / "b.md").write_text("---\ntitle: B\n---\n\n## Principle\ntaste body\n")
        saved = dmrh.WIKI_ROOT
        dmrh.WIKI_ROOT = root / "wiki"
        try:
            assert dmrh._read_wiki_body("infra/a.md") == "## Rule\nwiki body"
            assert dmrh._read_wiki_body("tastes/design/b.md") == "## Principle\ntaste body"
            assert dmrh._read_wiki_body("memory/x.md") is None
            assert dmrh._read_wiki_body("infra/missing.md") is None
        finally:
            dmrh.WIKI_ROOT = saved


# ── (f) pre_llm_call end-to-end with a brain-host-shaped payload ───────────


@contextlib.contextmanager
def _patched_brain(payload: Optional[Dict[str, Any]]) -> Iterator[Dict[str, List[Any]]]:
    """Monkeypatch the plugin's network + M1 emit seams. Yields a recorder of
    every gateway call and every M1 event so tests can assert the wire."""
    calls: Dict[str, List[Any]] = {"invoke": [], "m1": []}
    saved_invoke = dmrh._invoke_gateway
    saved_emit = dmrh._emit_m1_event

    def fake_invoke(tool: str, args: Dict[str, Any], timeout: float = 4.0):
        calls["invoke"].append((tool, args))
        return payload if tool == "memory_search" else {"ok": True, "result": {"content": []}}

    def fake_emit(**kwargs: Any) -> None:
        calls["m1"].append(kwargs)

    dmrh._invoke_gateway = fake_invoke
    dmrh._emit_m1_event = fake_emit
    try:
        yield calls
    finally:
        dmrh._invoke_gateway = saved_invoke
        dmrh._emit_m1_event = saved_emit


def test_pre_llm_call_injects_brain_host_hit_and_normalises_path():
    sid = "test-brain-host-inject"
    _reset_session(sid)
    payload = _brain_host_payload([
        _brain_host_hit(),
        _brain_host_hit(BRAIN_HOST_TASTE_PATH, score=0.041, vector_score=0.71, rel_path="tastes/design/no-italics.md"),
    ])
    try:
        with _patched_brain(payload) as calls:
            out = dmrh._on_pre_llm_call(
                session_id=sid,
                user_message="why does hermes on_session_end not fire for the discord bot?",
                platform="discord",
            )
        assert out is not None and "context" in out, out
        text = out["context"]
        assert BRAIN_HOST_HIT_PATH in text
        assert "(score=78/100)" in text, text          # vectorScore, not the RRF 0.042
        assert "[Digital Me]" in text
        # The search went out with the caller's query and the canonical args.
        tools = [t for t, _ in calls["invoke"]]
        assert "memory_search" in tools, tools
        ms_args = next(a for t, a in calls["invoke"] if t == "memory_search")
        assert ms_args["limit"] == dmrh.SEARCH_LIMIT and ms_args["corpus"] == "all"
        # M1 knowledge_surfaced carries the wiki-relative path + cosine score,
        # and the taste leaf keeps its tastes/ prefix for the classifier.
        surfaced = [e for e in calls["m1"] if e["event_type"] == "knowledge_surfaced"]
        assert len(surfaced) == 1, calls["m1"]
        entries = surfaced[0]["entries"]
        assert entries[0]["path"] == "infrastructure/hermes-runtime-onsessionend-hook-limitations.md"
        assert entries[0]["score"] == 0.78
        assert entries[1]["path"] == "tastes/design/no-italics.md"
        assert dmrh._SESSION_LAST_SURFACED[sid] == entries
        # session_start fired exactly once, before the surfaced event.
        assert [e["event_type"] for e in calls["m1"]] == ["session_start", "knowledge_surfaced"]
        assert dmrh._SESSION_HOOK_INJECTIONS[sid] == 1
    finally:
        _reset_session(sid)


def test_pre_llm_call_drops_brain_host_hit_below_cosine_gate():
    sid = "test-brain-host-gate"
    _reset_session(sid)
    payload = _brain_host_payload([_brain_host_hit(vector_score=0.2)])
    try:
        with _patched_brain(payload) as calls:
            out = dmrh._on_pre_llm_call(
                session_id=sid,
                user_message="why does hermes on_session_end not fire for the discord bot?",
            )
        assert out is None
        assert [e["event_type"] for e in calls["m1"]] == ["session_start"]
        assert dmrh._SESSION_HOOK_INJECTIONS[sid] == 0
    finally:
        _reset_session(sid)


def test_pre_llm_call_rrf_only_score_would_have_been_dropped():
    # Regression pin: without vectorScore, brain-host's fused score alone
    # fails the gate — documents WHY _hit_score exists.
    sid = "test-brain-host-rrf-only"
    _reset_session(sid)
    payload = _brain_host_payload([_brain_host_hit(vector_score=None)])
    try:
        with _patched_brain(payload):
            assert dmrh._on_pre_llm_call(session_id=sid, user_message="a question long enough to search") is None
    finally:
        _reset_session(sid)


def test_pre_llm_call_dedups_within_session():
    sid = "test-brain-host-dedup"
    _reset_session(sid)
    payload = _brain_host_payload([_brain_host_hit()])
    try:
        with _patched_brain(payload):
            first = dmrh._on_pre_llm_call(session_id=sid, user_message="first turn asks about hermes hooks")
            second = dmrh._on_pre_llm_call(session_id=sid, user_message="second turn asks about hermes hooks")
        assert first is not None
        assert second is None
    finally:
        _reset_session(sid)


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
