"""Read/write the compile + taste staging files handed to the CLI worker agents.

The stage step writes a batch that a headless worker (`claude -p` / codex via
`cli_exec_aliases`) must read IN FULL. The worker can only do that with its
file-Read tool:

- Claude Code's working-directory guard blocks shell reads (`cat`) outside the
  worker's cwd no matter what `Bash(cat <path>)` allow rule is granted, and
  even an allowed `cat` of a few-hundred-KB file is persisted to disk with only
  a ~2 KB preview reaching the model.
- The Read tool returns at most ~25k tokens per call and pages by LINE
  (offset/limit), so a single line over that budget is unreadable at every
  offset.

So the long free-text fields are written as JSON arrays of short pieces — one
piece per line under indent=2 — and `ensure_ascii=False` keeps non-ASCII text
from inflating ~6x as `\\uXXXX` escapes. `load_staging` joins the pieces back,
so every Python consumer keeps seeing plain strings.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# Longest piece a text field is cut into. Well under the Read tool's per-call
# token budget even for CJK-heavy text, so any page of a few dozen lines fits.
MAX_PIECE_CHARS = 2000

# Free-text fields stored as piece arrays: top-level keys, and per-item keys of
# the top-level lists. Anything else round-trips untouched.
_TOP_LEVEL_TEXT = ("principles_manifest", "wiki_manifest")
_ITEM_TEXT = {"transcripts": ("body",), "candidates": ("prompt",)}


def split_text(text: str, max_chars: int = MAX_PIECE_CHARS) -> list[str]:
    """Cut `text` into consecutive pieces of at most `max_chars`, breaking at
    line ends where possible. `"".join(split_text(t)) == t` always."""
    pieces: list[str] = []
    buf = ""
    for line in text.splitlines(keepends=True):
        if len(buf) + len(line) <= max_chars:
            buf += line
            continue
        if buf:
            pieces.append(buf)
        while len(line) > max_chars:
            pieces.append(line[:max_chars])
            line = line[max_chars:]
        buf = line
    if buf:
        pieces.append(buf)
    return pieces


def join_text(value: Any) -> str:
    """Inverse of `split_text`. A plain string (a file staged before the piece
    format) passes through; anything else reads as empty."""
    if isinstance(value, list):
        return "".join(p for p in value if isinstance(p, str))
    if isinstance(value, str):
        return value
    return ""


def _map_text_fields(payload: Any, fn) -> Any:
    if not isinstance(payload, dict):
        return payload  # malformed file: let the caller fail as before
    out = dict(payload)
    for key in _TOP_LEVEL_TEXT:
        if key in out:
            out[key] = fn(out[key])
    for list_key, fields in _ITEM_TEXT.items():
        items = out.get(list_key)
        if not isinstance(items, list):
            continue
        mapped = []
        for item in items:
            if isinstance(item, dict):
                item = dict(item)
                for f in fields:
                    if f in item:
                        item[f] = fn(item[f])
            mapped.append(item)
        out[list_key] = mapped
    return out


def _split_value(value: Any) -> Any:
    return split_text(value) if isinstance(value, str) else value


def dump_staging(path: Path, payload: dict) -> None:
    """Write `payload` to `path` in the Read-pageable piece format."""
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = _map_text_fields(payload, _split_value)
    path.write_text(json.dumps(encoded, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_staging(path: Path) -> dict:
    """Read a staging file, joining piece arrays back into plain strings."""
    return _map_text_fields(json.loads(path.read_text(encoding="utf-8")), join_text)
