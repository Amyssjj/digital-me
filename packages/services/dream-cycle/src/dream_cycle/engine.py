"""LLM/embedding abstraction layer.

engine: openclaw  -> calls OpenClaw gateway APIs
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


class OpenClawEngine(Engine):
    """Use OpenClaw's config for LLM and embeddings.

    Reads the Gemini API key and model from ~/.openclaw/openclaw.json
    and calls Gemini directly. This inherits provider config from OpenClaw
    without duplicating keys in our own config.
    """

    OPENCLAW_CONFIG = os.path.expanduser("~/.openclaw/openclaw.json")

    def __init__(self, llm_model: str = "gemini-3-flash-preview"):
        self.llm_model = llm_model
        with open(self.OPENCLAW_CONFIG) as f:
            cfg = json.load(f)
        memory_search = cfg.get("agents", {}).get("defaults", {}).get("memorySearch", {})
        self.api_key = memory_search.get("remote", {}).get("apiKey", "")
        self.embedding_model = memory_search.get("model", "gemini-embedding-001")
        if not self.api_key:
            raise ValueError(
                f"No Gemini API key found in {self.OPENCLAW_CONFIG} "
                "at agents.defaults.memorySearch.remote.apiKey"
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
