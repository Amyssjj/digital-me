"""OpenClawEngine key/model resolution across $GEMINI_API_KEY and both
openclaw.json layouts.

openclaw >= 2026.7.1 moved the memorySearch block from
``agents.defaults.memorySearch`` to the root ``memory.search`` namespace, and
the nightly workers now run under the brain-host service, which exports
``$GEMINI_API_KEY``. The engine must honour env > namespaced > legacy and
must not need openclaw.json at all when the env var is set.

Only ``__init__`` is exercised -- no network calls are made.
"""

from __future__ import annotations

import json
from pathlib import Path
from textwrap import dedent
from typing import Optional

import pytest

from dream_cycle.config import load_config
from dream_cycle.engine import (
    OpenClawEngine,
    _load_openclaw_config,
    _memory_search_block,
    get_engine,
)

ENV_KEY = "env-key-from-brain-host"
NAMESPACED_KEY = "namespaced-key-from-openclaw-json"
LEGACY_KEY = "legacy-key-from-openclaw-json"
DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001"


def _write_config(path: Path, cfg: dict) -> Path:
    path.write_text(json.dumps(cfg), encoding="utf-8")
    return path


def _namespaced(
    api_key: Optional[str] = NAMESPACED_KEY, model: Optional[str] = None
) -> dict:
    """openclaw >= 2026.7.1 layout: root ``memory.search`` block."""
    search: dict = {}
    if api_key is not None:
        search["remote"] = {"apiKey": api_key}
    if model is not None:
        search["model"] = model
    return {"memory": {"search": search}}


def _legacy(
    api_key: Optional[str] = LEGACY_KEY, model: Optional[str] = None
) -> dict:
    """Pre-2026.7.1 layout: ``agents.defaults.memorySearch`` block."""
    memory_search: dict = {}
    if api_key is not None:
        memory_search["remote"] = {"apiKey": api_key}
    if model is not None:
        memory_search["model"] = model
    return {"agents": {"defaults": {"memorySearch": memory_search}}}


@pytest.fixture
def config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point OPENCLAW_CONFIG at a tmp file (not yet written) with the env key unset."""
    path = tmp_path / "openclaw.json"
    monkeypatch.setattr(OpenClawEngine, "OPENCLAW_CONFIG", str(path))
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    return path


# ── 1. env var ──────────────────────────────────────────────────────────


def test_env_key_wins_with_no_config_file(
    config_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", ENV_KEY)
    assert not config_path.exists()
    engine = OpenClawEngine()
    assert engine.api_key == ENV_KEY
    assert engine.embedding_model == DEFAULT_EMBEDDING_MODEL


def test_env_key_wins_over_config_with_different_key(
    config_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_config(config_path, {**_namespaced(NAMESPACED_KEY), **_legacy(LEGACY_KEY)})
    monkeypatch.setenv("GEMINI_API_KEY", ENV_KEY)
    assert OpenClawEngine().api_key == ENV_KEY


def test_env_key_is_stripped(
    config_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", f"  {ENV_KEY}\n")
    assert OpenClawEngine().api_key == ENV_KEY


def test_blank_env_key_counts_as_unset(
    config_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_config(config_path, _namespaced(NAMESPACED_KEY))
    monkeypatch.setenv("GEMINI_API_KEY", "   ")
    assert OpenClawEngine().api_key == NAMESPACED_KEY


def test_env_var_name_is_a_class_attribute() -> None:
    assert OpenClawEngine.API_KEY_ENV == "GEMINI_API_KEY"


# ── 2 + 3. openclaw.json layouts ────────────────────────────────────────


def test_namespaced_layout_read_when_env_unset(config_path: Path) -> None:
    _write_config(config_path, _namespaced(NAMESPACED_KEY))
    assert OpenClawEngine().api_key == NAMESPACED_KEY


def test_legacy_layout_read_when_env_unset_and_namespaced_absent(
    config_path: Path,
) -> None:
    _write_config(config_path, _legacy(LEGACY_KEY))
    assert OpenClawEngine().api_key == LEGACY_KEY


def test_namespaced_beats_legacy_when_both_present(config_path: Path) -> None:
    _write_config(config_path, {**_namespaced(NAMESPACED_KEY), **_legacy(LEGACY_KEY)})
    assert OpenClawEngine().api_key == NAMESPACED_KEY


def test_legacy_key_fills_in_when_namespaced_block_lacks_one(
    config_path: Path,
) -> None:
    """Half-migrated config: namespaced block exists but carries no key."""
    cfg = {**_namespaced(api_key=None, model="ns-embed"), **_legacy(LEGACY_KEY)}
    _write_config(config_path, cfg)
    engine = OpenClawEngine()
    assert engine.api_key == LEGACY_KEY
    assert engine.embedding_model == "ns-embed"


def test_blank_config_key_counts_as_unset(config_path: Path) -> None:
    cfg = {**_namespaced(api_key="   "), **_legacy(LEGACY_KEY)}
    _write_config(config_path, cfg)
    assert OpenClawEngine().api_key == LEGACY_KEY


# ── broken / absent config ──────────────────────────────────────────────


def test_unparseable_config_with_env_key_works(
    config_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path.write_text("{ this is not json", encoding="utf-8")
    monkeypatch.setenv("GEMINI_API_KEY", ENV_KEY)
    assert OpenClawEngine().api_key == ENV_KEY


def test_config_without_any_key_plus_env_key_works(
    config_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_config(config_path, _namespaced(api_key=None, model="ns-embed"))
    monkeypatch.setenv("GEMINI_API_KEY", ENV_KEY)
    engine = OpenClawEngine()
    assert engine.api_key == ENV_KEY
    assert engine.embedding_model == "ns-embed"


def test_missing_everywhere_raises_naming_all_three_sources(
    config_path: Path,
) -> None:
    _write_config(config_path, {"agents": {"defaults": {}}, "memory": {}})
    with pytest.raises(ValueError) as excinfo:
        OpenClawEngine()
    msg = str(excinfo.value)
    assert "GEMINI_API_KEY" in msg
    assert "memory.search.remote.apiKey" in msg
    assert "agents.defaults.memorySearch.remote.apiKey" in msg
    assert str(config_path) in msg


def test_missing_config_and_env_raises_value_error_not_oserror(
    config_path: Path,
) -> None:
    assert not config_path.exists()
    with pytest.raises(ValueError, match="GEMINI_API_KEY"):
        OpenClawEngine()


def test_unparseable_config_and_no_env_raises_value_error(
    config_path: Path,
) -> None:
    config_path.write_text("{ nope", encoding="utf-8")
    with pytest.raises(ValueError, match="memory.search.remote.apiKey"):
        OpenClawEngine()


# ── embedding model ─────────────────────────────────────────────────────


def test_embedding_model_from_namespaced_layout(config_path: Path) -> None:
    _write_config(config_path, _namespaced(NAMESPACED_KEY, model="ns-embed"))
    assert OpenClawEngine().embedding_model == "ns-embed"


def test_embedding_model_from_legacy_layout(config_path: Path) -> None:
    _write_config(config_path, _legacy(LEGACY_KEY, model="legacy-embed"))
    assert OpenClawEngine().embedding_model == "legacy-embed"


def test_embedding_model_namespaced_beats_legacy(config_path: Path) -> None:
    cfg = {
        **_namespaced(NAMESPACED_KEY, model="ns-embed"),
        **_legacy(LEGACY_KEY, model="legacy-embed"),
    }
    _write_config(config_path, cfg)
    assert OpenClawEngine().embedding_model == "ns-embed"


def test_embedding_model_legacy_fills_in_when_namespaced_lacks_one(
    config_path: Path,
) -> None:
    cfg = {**_namespaced(NAMESPACED_KEY), **_legacy(LEGACY_KEY, model="legacy-embed")}
    _write_config(config_path, cfg)
    assert OpenClawEngine().embedding_model == "legacy-embed"


def test_embedding_model_defaults_when_unset(config_path: Path) -> None:
    _write_config(config_path, _namespaced(NAMESPACED_KEY))
    assert OpenClawEngine().embedding_model == DEFAULT_EMBEDDING_MODEL
    assert OpenClawEngine.DEFAULT_EMBEDDING_MODEL == DEFAULT_EMBEDDING_MODEL


def test_embedding_model_from_config_when_provider_is_gemini(config_path: Path) -> None:
    cfg = _namespaced(NAMESPACED_KEY, model="ns-embed")
    cfg["memory"]["search"]["provider"] = "gemini"
    _write_config(config_path, cfg)
    assert OpenClawEngine().embedding_model == "ns-embed"


def test_embedding_model_ignores_config_model_for_non_gemini_provider(
    config_path: Path,
) -> None:
    # This engine only calls the Gemini endpoint: a model configured for another
    # embedding provider must not be sent there.
    cfg = _namespaced(NAMESPACED_KEY, model="text-embedding-3-small")
    cfg["memory"]["search"]["provider"] = "openai"
    _write_config(config_path, cfg)
    engine = OpenClawEngine()
    assert engine.embedding_model == DEFAULT_EMBEDDING_MODEL
    assert engine.api_key == NAMESPACED_KEY  # the key precedence is unaffected


def test_provider_is_resolved_namespaced_first_then_legacy() -> None:
    cfg = {**_namespaced(NAMESPACED_KEY), **_legacy(LEGACY_KEY)}
    cfg["agents"]["defaults"]["memorySearch"]["provider"] = "openai"
    assert _memory_search_block(cfg)["provider"] == "openai"
    cfg["memory"]["search"]["provider"] = "gemini"
    assert _memory_search_block(cfg)["provider"] == "gemini"


def test_llm_model_constructor_arg_is_kept(
    config_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", ENV_KEY)
    assert OpenClawEngine(llm_model="gemini-custom").llm_model == "gemini-custom"
    assert OpenClawEngine().llm_model == "gemini-3-flash-preview"


# ── helpers ─────────────────────────────────────────────────────────────


def test_load_openclaw_config_missing_returns_empty(tmp_path: Path) -> None:
    assert _load_openclaw_config(str(tmp_path / "nope.json")) == {}


def test_load_openclaw_config_unparseable_returns_empty(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("not json at all", encoding="utf-8")
    assert _load_openclaw_config(str(bad)) == {}


def test_load_openclaw_config_non_object_returns_empty(tmp_path: Path) -> None:
    lst = tmp_path / "list.json"
    lst.write_text("[1, 2, 3]", encoding="utf-8")
    assert _load_openclaw_config(str(lst)) == {}


def test_load_openclaw_config_directory_returns_empty(tmp_path: Path) -> None:
    assert _load_openclaw_config(str(tmp_path)) == {}


def test_load_openclaw_config_parses_object(tmp_path: Path) -> None:
    ok = _write_config(tmp_path / "ok.json", {"memory": {"search": {"model": "m"}}})
    assert _load_openclaw_config(str(ok)) == {"memory": {"search": {"model": "m"}}}


def test_memory_search_block_shape_on_empty_config() -> None:
    assert _memory_search_block({}) == {"api_key": "", "model": "", "provider": ""}


def test_memory_search_block_ignores_non_dict_levels() -> None:
    cfg = {"memory": "oops", "agents": {"defaults": {"memorySearch": ["nope"]}}}
    assert _memory_search_block(cfg) == {"api_key": "", "model": "", "provider": ""}


def test_memory_search_block_ignores_non_string_values() -> None:
    cfg = {"memory": {"search": {"remote": {"apiKey": 12345}, "model": None, "provider": 7}}}
    assert _memory_search_block(cfg) == {"api_key": "", "model": "", "provider": ""}


def test_memory_search_block_prefers_namespaced_field_by_field() -> None:
    cfg = {
        **_namespaced(api_key=None, model="ns-embed"),
        **_legacy(LEGACY_KEY, model="legacy-embed"),
    }
    assert _memory_search_block(cfg) == {"api_key": LEGACY_KEY, "model": "ns-embed", "provider": ""}


# ── factory ─────────────────────────────────────────────────────────────


def test_get_engine_openclaw_uses_env_key_without_openclaw_json(
    config_path: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", ENV_KEY)
    # load_config resolves $DIGITAL_ME_CONFIG_PATH before <wiki_root>/config.yaml;
    # a developer shell exporting it would otherwise load a real config here.
    monkeypatch.delenv("DIGITAL_ME_CONFIG_PATH", raising=False)
    monkeypatch.delenv("DIGITAL_ME_WIKI_ROOT", raising=False)
    wiki_root = tmp_path / "wiki-root"
    (wiki_root / "wiki").mkdir(parents=True)
    (wiki_root / "config.yaml").write_text(
        dedent("""\
            engine: openclaw
            standalone:
              llm_model: gemini-from-yaml
            sources: []
            dream_cycle:
              schedule: "0 3 * * *"
              staleness_threshold_days: 30
              auto_archive: false
        """),
        encoding="utf-8",
    )
    engine = get_engine(load_config(wiki_root=wiki_root))
    assert isinstance(engine, OpenClawEngine)
    assert engine.api_key == ENV_KEY
    assert engine.llm_model == "gemini-from-yaml"
    assert not config_path.exists()
