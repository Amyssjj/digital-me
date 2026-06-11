"""Load and validate the dream-cycle config.yaml.

The wiki root is no longer derived from the source-file location — dream-cycle
ships as a standalone Python package that can point at any wiki. Resolution
order:

1. Explicit `wiki_root=` arg to `load_config()` (or `--wiki-root` on the CLI).
2. `$DIGITAL_ME_WIKI_ROOT` env var.
3. `~/digital-me/` (legacy default for users coming from the original layout).

The config file location follows the same priority, then falls back to
`<wiki_root>/config.yaml`.
"""

import os
import yaml
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional


DEFAULT_WIKI_ROOT = Path.home() / "digital-me"


def resolve_wiki_root(wiki_root: Optional[Path] = None) -> Path:
    """Resolve the active wiki root using arg → env → default."""
    if wiki_root is not None:
        return Path(wiki_root).expanduser().resolve()
    env = os.environ.get("DIGITAL_ME_WIKI_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    return DEFAULT_WIKI_ROOT


def resolve_config_path(
    config_path: Optional[Path] = None,
    wiki_root: Optional[Path] = None,
) -> Path:
    """Resolve the active config.yaml path using arg → env → <wiki_root>/config.yaml."""
    if config_path is not None:
        return Path(config_path).expanduser().resolve()
    env = os.environ.get("DIGITAL_ME_CONFIG_PATH")
    if env:
        return Path(env).expanduser().resolve()
    return resolve_wiki_root(wiki_root) / "config.yaml"


@dataclass
class Source:
    name: str
    path: Path
    format: str  # multi-entry-md | frontmatter-md | skill-md | transcript-jsonl | transcript-json


@dataclass
class StandaloneConfig:
    llm_provider: str = "gemini"
    llm_model: str = "gemini-3-flash-preview"
    embedding_provider: str = "gemini"
    embedding_model: str = "gemini-embedding-001"
    api_key_env: str = "GEMINI_API_KEY"


@dataclass
class DreamCycleConfig:
    schedule: str = "0 3 * * *"
    staleness_threshold_days: int = 30
    auto_archive: bool = False
    # Roots the drift-check step is allowed to read code from when verifying
    # entry citations. Path strings undergo env-var + ~ expansion at load
    # time. None → "compute defaults at runtime from wiki_root + $HOME".
    drift_check_repo_roots: Optional[list[Path]] = None


@dataclass
class Config:
    engine: str  # "openclaw" | "standalone"
    standalone: StandaloneConfig
    sources: list[Source]
    dream_cycle: DreamCycleConfig
    wiki_root: Path = field(default_factory=lambda: DEFAULT_WIKI_ROOT)

    @property
    def wiki_dir(self) -> Path:
        return self.wiki_root / "wiki"

    @property
    def inbox_dir(self) -> Path:
        return self.wiki_root / "inbox"

    @property
    def cache_dir(self) -> Path:
        return self.wiki_root / ".cache"

    @property
    def archive_dir(self) -> Path:
        return self.wiki_root / "archive"

    @property
    def logs_dir(self) -> Path:
        return self.wiki_root / "dream_cycle" / "logs"


def _expand(p: str) -> Path:
    """Expand ~ and env vars in a path string."""
    return Path(os.path.expandvars(os.path.expanduser(p)))


# ── Cron-string validation ────────────────────────────────────────────────
#
# Standard 5-field cron format: MIN HOUR DOM MON DOW. We validate the
# structure + each field's range so a typo in config.yaml fails at load
# time, not at midnight when the schedule fires. We do NOT compute
# next-fire times — the downstream scheduler (launchd / systemd / cron /
# openclaw) owns that, and we'd just be duplicating its parser.
#
# Numeric tokens only — named months (jan-dec) and weekdays (mon-sun)
# are not supported. If a user wants those, the underlying scheduler
# will still accept the string verbatim, but our validator will reject.
# That's intentional: keep the contract narrow so we know exactly what
# round-trips through every downstream scheduler.

_CRON_FIELDS = [
    ("minute", 0, 59),
    ("hour", 0, 23),
    ("day_of_month", 1, 31),
    ("month", 1, 12),
    # day-of-week: both 0 and 7 mean Sunday in standard cron, so accept both.
    ("day_of_week", 0, 7),
]


def _validate_cron_token(token: str, field_name: str, lo: int, hi: int) -> None:
    # Pull out an optional step suffix first: TOKEN/N or */N or N-M/N.
    if "/" in token:
        base, _, step_str = token.partition("/")
        if not step_str.isdigit():
            raise ValueError(
                f"invalid step '/{step_str}' in {field_name} field '{token}'"
            )
        step = int(step_str)
        if step <= 0:
            raise ValueError(
                f"step must be > 0 in {field_name} field '{token}'"
            )
    else:
        base = token

    if base == "*":
        return
    if "-" in base:
        start_s, _, end_s = base.partition("-")
        if not (start_s.isdigit() and end_s.isdigit()):
            raise ValueError(
                f"invalid range '{base}' in {field_name} field"
            )
        start, end = int(start_s), int(end_s)
        if start > end:
            raise ValueError(
                f"range start {start} > end {end} in {field_name} field"
            )
        if not (lo <= start <= hi and lo <= end <= hi):
            raise ValueError(
                f"range {start}-{end} out of [{lo},{hi}] in {field_name} field"
            )
        return
    if not base.isdigit():
        raise ValueError(
            f"invalid token '{token}' in {field_name} field (numeric only)"
        )
    n = int(base)
    if not (lo <= n <= hi):
        raise ValueError(
            f"value {n} out of range [{lo},{hi}] in {field_name} field"
        )


def validate_cron_expression(expr: str) -> None:
    """Validate a 5-field cron expression. Raises ValueError on garbage.

    Accepted syntax per field: `*`, `N`, `N-M`, `N,M,...`, with an optional
    `/STEP` suffix on any of those. Named months/weekdays are NOT
    supported — numbers only.

    Returns None on success. Does not return a parsed structure; this is
    a validate-only contract.
    """
    if not expr or not expr.strip():
        raise ValueError("cron expression is empty")
    fields = expr.strip().split()
    if len(fields) != len(_CRON_FIELDS):
        raise ValueError(
            f"cron expression must have {len(_CRON_FIELDS)} fields "
            f"(got {len(fields)}): '{expr}'"
        )
    for raw_field, (name, lo, hi) in zip(fields, _CRON_FIELDS):
        if not raw_field:
            raise ValueError(f"empty {name} field in cron expression '{expr}'")
        for token in raw_field.split(","):
            if not token:
                raise ValueError(
                    f"empty token in {name} field of cron expression '{expr}'"
                )
            _validate_cron_token(token, name, lo, hi)


def load_config(
    path: Optional[Path] = None,
    wiki_root: Optional[Path] = None,
) -> Config:
    """Load and validate config.yaml.

    Args:
        path: Explicit config file path; overrides env + default lookup.
        wiki_root: Explicit wiki root; overrides env + default lookup. Used
            both to locate ``<wiki_root>/config.yaml`` (when ``path`` is
            omitted) and to populate ``Config.wiki_root``.
    """
    active_wiki_root = resolve_wiki_root(wiki_root)
    active_path = resolve_config_path(path, wiki_root=active_wiki_root)
    if not active_path.exists():
        raise FileNotFoundError(f"Config not found: {active_path}")

    with open(active_path) as f:
        raw = yaml.safe_load(f) or {}

    engine = raw.get("engine", "standalone")

    # Parse standalone config
    sc = raw.get("standalone", {})
    standalone = StandaloneConfig(
        llm_provider=sc.get("llm_provider", "gemini"),
        llm_model=sc.get("llm_model", "gemini-2.0-flash"),
        embedding_provider=sc.get("embedding_provider", "gemini"),
        embedding_model=sc.get("embedding_model", "gemini-embedding-001"),
        api_key_env=sc.get("api_key_env", "GEMINI_API_KEY"),
    )

    # Parse sources
    sources = []
    for s in raw.get("sources", []):
        sources.append(Source(
            name=s["name"],
            path=_expand(s["path"]),
            format=s["format"],
        ))

    # Parse dream cycle
    dc = raw.get("dream_cycle", {})
    drift_roots_raw = dc.get("drift_check_repo_roots")
    drift_roots: Optional[list[Path]] = (
        [_expand(p) for p in drift_roots_raw]
        if isinstance(drift_roots_raw, list)
        else None
    )
    schedule = dc.get("schedule", "0 3 * * *")
    try:
        validate_cron_expression(schedule)
    except ValueError as e:
        raise ValueError(
            f"invalid dream_cycle.schedule in {active_path}: {e}"
        ) from e
    dream_cycle = DreamCycleConfig(
        schedule=schedule,
        staleness_threshold_days=dc.get("staleness_threshold_days", 30),
        auto_archive=dc.get("auto_archive", False),
        drift_check_repo_roots=drift_roots,
    )

    return Config(
        engine=engine,
        standalone=standalone,
        sources=sources,
        dream_cycle=dream_cycle,
        wiki_root=active_wiki_root,
    )


def setup_inbox(config: Config) -> None:
    """Create inbox symlinks from configured sources."""
    inbox = config.inbox_dir
    inbox.mkdir(parents=True, exist_ok=True)

    for source in config.sources:
        link = inbox / source.name
        if link.exists() or link.is_symlink():
            link.unlink()
        if source.path.exists():
            link.symlink_to(source.path)
            print(f"  {source.name} -> {source.path}")
        else:
            print(f"  {source.name} SKIPPED (path not found: {source.path})")


if __name__ == "__main__":
    import sys
    cfg = load_config()
    if "--setup" in sys.argv:
        print("Setting up inbox symlinks:")
        setup_inbox(cfg)
    else:
        print(f"Wiki root: {cfg.wiki_root}")
        print(f"Engine: {cfg.engine}")
        print(f"Sources: {[s.name for s in cfg.sources]}")
        print(f"Wiki: {cfg.wiki_dir}")
        print(f"Dream Cycle: {cfg.dream_cycle.schedule}")
