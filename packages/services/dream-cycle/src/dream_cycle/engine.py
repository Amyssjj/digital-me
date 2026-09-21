"""LLM/embedding abstraction layer.

engine: openclaw  -> Gemini; key from $GEMINI_API_KEY, else ~/.openclaw/openclaw.json
                     (memory.search.remote.apiKey for openclaw >= 2026.7.1, then the
                     legacy agents.defaults.memorySearch.remote.apiKey)
engine: standalone -> direct API calls using api_key_env
"""

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from .config import Config, StandaloneConfig


def _urlopen_json(req, timeout: int, *, max_retries: int = 5) -> dict:
    """POST + parse JSON with exponential backoff on transient throttling.

    Gemini preview models (and other providers) return HTTP 429 / 503 under the
    dream cycle's burst of per-transcript calls. Without backoff every
    transcript errors on the first 429 and the night distills nothing — the
    2026-05-29 "no taste" incident. Honors Retry-After when the server sends it.
    """
    delay = 2.0
    for attempt in range(max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < max_retries:
                ra = e.headers.get("Retry-After") if e.headers else None
                wait = float(ra) if (ra and ra.isdigit()) else delay
                time.sleep(min(wait, 60.0))
                delay = min(delay * 2, 60.0)
                continue
            raise


class Engine(ABC):
    """Abstract engine for LLM and embedding calls."""

    @abstractmethod
    def llm_call(self, prompt: str, system: str = "") -> str:
        """Single-turn LLM call. Returns response text."""
        ...

    @abstractmethod
    def embed(self, text: str) -> list[float]:
        """Embed a text string. Returns float vector."""
        ...

    @abstractmethod
    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed multiple texts. Returns list of float vectors."""
        ...


# openclaw.json paths that hold the memorySearch block, in precedence order.
# openclaw >= 2026.7.1 moved it to the root "memory.search" namespace; older
# releases nested it under "agents.defaults.memorySearch".
_MEMORY_SEARCH_PATHS: tuple[tuple[str, ...], ...] = (
    ("memory", "search"),
    ("agents", "defaults", "memorySearch"),
)


def _load_openclaw_config(path: str) -> dict:
    """Parse openclaw.json at ``path``; return ``{}`` when missing or unparseable.

    Never raises: the OpenClaw engine has to work on a machine without
    OpenClaw at all (the key can arrive via ``$GEMINI_API_KEY``), so a bad or
    absent config only matters if no key turns up anywhere -- and that is
    ``OpenClawEngine.__init__``'s call, not this loader's.
    """
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        # OSError: missing / unreadable / a directory. ValueError covers
        # json.JSONDecodeError and UnicodeDecodeError.
        return {}
    return cfg if isinstance(cfg, dict) else {}


def _dig(node: object, *keys: str) -> object:
    """Walk nested dicts; ``None`` as soon as a key is absent or a level isn't a dict."""
    for key in keys:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _clean_str(value: object) -> str:
    """Stripped string, or ``""`` for anything that is not a non-blank string."""
    return value.strip() if isinstance(value, str) else ""


def _memory_search_block(cfg: dict) -> dict:
    """Resolve the memorySearch settings from a parsed openclaw.json.

    Returns a normalised ``{"api_key": str, "model": str, "provider": str}``
    (``""`` when unset). Each field is taken from the namespaced ``memory.search`` block
    when it is set there, else from the legacy ``agents.defaults.memorySearch``
    block -- the new layout wins field by field, not block by block, so a
    half-migrated config still yields whatever key it has.
    """
    blocks = [_dig(cfg, *path) for path in _MEMORY_SEARCH_PATHS]
    blocks = [b for b in blocks if isinstance(b, dict)]

    def first(*keys: str) -> str:
        for block in blocks:
            value = _clean_str(_dig(block, *keys))
            if value:
                return value
        return ""

    return {
        "api_key": first("remote", "apiKey"),
        "model": first("model"),
        "provider": first("provider"),
    }


class OpenClawEngine(Engine):
    """Gemini engine that borrows OpenClaw's Gemini key and embedding model instead of duplicating them.

    API key precedence (first non-blank wins):

    1. ``$GEMINI_API_KEY`` (``API_KEY_ENV``) -- what the digital-me brain-host
       service exports for the nightly workers. This also lets the engine run
       on a machine with no OpenClaw install at all.
    2. ``memory.search.remote.apiKey`` in ``OPENCLAW_CONFIG`` -- the root
       ``memory`` namespace that openclaw >= 2026.7.1 moved the block to.
    3. ``agents.defaults.memorySearch.remote.apiKey`` -- the legacy layout.

    Embedding model: ``memory.search.model``, else
    ``agents.defaults.memorySearch.model``, else ``DEFAULT_EMBEDDING_MODEL`` --
    but only when the configured ``provider`` is ``gemini`` (or unset). This
    engine calls the Gemini endpoint only, so a model name configured for
    another embedding provider (e.g. ``openai`` + ``text-embedding-3-small``)
    is ignored in favour of the default.

    A missing or unparseable ``OPENCLAW_CONFIG`` is not an error by itself;
    ``ValueError`` is raised only when no key is found in any of the three
    sources.
    """

    API_KEY_ENV = "GEMINI_API_KEY"
    OPENCLAW_CONFIG = os.path.expanduser("~/.openclaw/openclaw.json")
    DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001"

    def __init__(self, llm_model: str = "gemini-3-flash-preview"):
        self.llm_model = llm_model
        settings = _memory_search_block(_load_openclaw_config(self.OPENCLAW_CONFIG))
        gemini_configured = settings["provider"] in ("", "gemini")
        self.embedding_model = (
            settings["model"] if gemini_configured else ""
        ) or self.DEFAULT_EMBEDDING_MODEL
        self.api_key = (
            _clean_str(os.environ.get(self.API_KEY_ENV)) or settings["api_key"]
        )
        if not self.api_key:
            raise ValueError(
                f"No Gemini API key found. Set ${self.API_KEY_ENV}, or put it in "
                f"{self.OPENCLAW_CONFIG} at memory.search.remote.apiKey "
                "(openclaw >= 2026.7.1) or agents.defaults.memorySearch.remote.apiKey "
                "(legacy layout)."
            )

    def llm_call(self, prompt: str, system: str = "") -> str:
        import urllib.request
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/"
            f"models/{self.llm_model}:generateContent?key={self.api_key}"
        )
        if system:
            text = f"[System]\n{system}\n\n[User]\n{prompt}"
        else:
            text = prompt

        payload = json.dumps({
            "contents": [{"parts": [{"text": text}]}],
            # 8192: batched-JSON callers (backfill_types: 10 entries × ~200 toks
            # each + structure) overran 4096 on noisier batches.
            "generationConfig": {"maxOutputTokens": 8192},
        }).encode()
        req = urllib.request.Request(
            url, data=payload,
            headers={"Content-Type": "application/json"},
        )
        result = _urlopen_json(req, timeout=120)
        return result["candidates"][0]["content"]["parts"][0]["text"]

    def embed(self, text: str) -> list[float]:
        return self.embed_batch([text])[0]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        import urllib.request
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/"
            f"models/{self.embedding_model}:batchEmbedContents?key={self.api_key}"
        )
        requests_list = [
            {"model": f"models/{self.embedding_model}", "content": {"parts": [{"text": t}]}}
            for t in texts
        ]
        payload = json.dumps({"requests": requests_list}).encode()
        req = urllib.request.Request(
            url, data=payload,
            headers={"Content-Type": "application/json"},
        )
        result = _urlopen_json(req, timeout=120)
        return [e["values"] for e in result["embeddings"]]


class StandaloneEngine(Engine):
    """Direct API calls for users without OpenClaw."""

    def __init__(self, config: StandaloneConfig):
        self.config = config
        self.api_key = os.environ.get(config.api_key_env, "")
        if not self.api_key:
            raise ValueError(
                f"Set {config.api_key_env} env var for standalone engine"
            )

    def llm_call(self, prompt: str, system: str = "") -> str:
        provider = self.config.llm_provider
        if provider == "gemini":
            return self._gemini_llm(prompt, system)
        elif provider == "openai":
            return self._openai_llm(prompt, system)
        elif provider == "anthropic":
            return self._anthropic_llm(prompt, system)
        else:
            raise ValueError(f"Unsupported LLM provider: {provider}")

    def embed(self, text: str) -> list[float]:
        return self.embed_batch([text])[0]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        provider = self.config.embedding_provider
        if provider == "gemini":
            return self._gemini_embed(texts)
        elif provider == "openai":
            return self._openai_embed(texts)
        else:
            raise ValueError(f"Unsupported embedding provider: {provider}")

    def _gemini_llm(self, prompt: str, system: str) -> str:
        import urllib.request
        model = self.config.llm_model
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/"
            f"models/{model}:generateContent?key={self.api_key}"
        )
        parts = []
        if system:
            parts.append({"text": f"[System]\n{system}\n\n[User]\n{prompt}"})
        else:
            parts.append({"text": prompt})

        payload = json.dumps({
            "contents": [{"parts": parts}],
            "generationConfig": {"maxOutputTokens": 4096},
        }).encode()
        req = urllib.request.Request(
            url, data=payload,
            headers={"Content-Type": "application/json"},
        )
        result = _urlopen_json(req, timeout=120)
        return result["candidates"][0]["content"]["parts"][0]["text"]

    def _gemini_embed(self, texts: list[str]) -> list[list[float]]:
        import urllib.request
        model = self.config.embedding_model
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/"
            f"models/{model}:batchEmbedContents?key={self.api_key}"
        )
        requests_list = [
            {"model": f"models/{model}", "content": {"parts": [{"text": t}]}}
            for t in texts
        ]
        payload = json.dumps({"requests": requests_list}).encode()
        req = urllib.request.Request(
            url, data=payload,
            headers={"Content-Type": "application/json"},
        )
        result = _urlopen_json(req, timeout=60)
        return [e["values"] for e in result["embeddings"]]

    def _openai_llm(self, prompt: str, system: str) -> str:
        import urllib.request
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload = json.dumps({
            "model": self.config.llm_model,
            "messages": messages,
            "max_tokens": 4096,
        }).encode()
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
        )
        result = _urlopen_json(req, timeout=120)
        return result["choices"][0]["message"]["content"]

    def _openai_embed(self, texts: list[str]) -> list[list[float]]:
        import urllib.request
        payload = json.dumps({
            "model": self.config.embedding_model,
            "input": texts,
        }).encode()
        req = urllib.request.Request(
            "https://api.openai.com/v1/embeddings",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
        )
        result = _urlopen_json(req, timeout=60)
        return [d["embedding"] for d in result["data"]]

    def _anthropic_llm(self, prompt: str, system: str) -> str:
        import urllib.request
        payload = {
            "model": self.config.llm_model,
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            payload["system"] = system

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
            },
        )
        result = _urlopen_json(req, timeout=120)
        return result["content"][0]["text"]


def get_engine(config: Config) -> Engine:
    """Factory: return the right engine based on config."""
    if config.engine == "openclaw":
        return OpenClawEngine(llm_model=config.standalone.llm_model)
    elif config.engine == "standalone":
        return StandaloneEngine(config.standalone)
    else:
        raise ValueError(f"Unknown engine: {config.engine}")
