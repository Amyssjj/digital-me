# @digital-me/dream-cycle

LLM-powered knowledge distillation loop for the Digital Me Living Knowledge Wiki.

Status: **alpha** — ported from the maintainer's prior personal setup; all
migration phases landed.

## What it does

The dream cycle is a nightly pipeline that turns raw inputs (chat
transcripts, scratch notes, brain learnings) into curated, cross-linked
wiki entries:

```
brain_learnings  →  compile  →  index  →  citations  →  crosslink
                                                ↓
                  consolidate  ←  drift_check  ←  lint
```

Each step uses either an LLM (via the OpenClaw gateway or directly against
Gemini / OpenAI / Anthropic) or deterministic file operations.

## Install

Requires Python ≥ 3.11. Only runtime dep: `pyyaml`.

**Use a venv.** Homebrew Python (and most modern Linux distros) ship as
"externally-managed" per PEP 668 and reject system-wide `pip install`.
The venv recipe works on every supported platform:

```bash
python3 -m venv ~/.venvs/dream-cycle
~/.venvs/dream-cycle/bin/pip install -e "<digital-me-os-repo>/packages/services/dream-cycle[dev]"
export PATH="$HOME/.venvs/dream-cycle/bin:$PATH"
```

Verify:

```bash
digital-me doctor          # the dream-cycle: * rows should all be OK
digital-me-dream-cycle --help
```

The `pip install -e` registers a `digital-me-dream-cycle` console
script + makes `dream_cycle` importable. The `@digital-me/cli` runner
also exposes it as `digital-me dream-cycle [args]` — see
[packages/cli/README.md](../../cli/README.md).

If you really want to skip the venv (e.g. on a Linux CI runner without
PEP 668), the bare `pip install -e packages/services/dream-cycle[dev]`
still works there — `digital-me doctor` will tell you which install
shape your Python actually supports.

## Configuration

Dream-cycle reads `config.yaml` from your wiki root. Resolution order:

| Setting | Priority |
|---|---|
| Config file path | `--config-path` → `$DIGITAL_ME_CONFIG_PATH` → `<wiki_root>/config.yaml` |
| Wiki root | `--wiki-root` → `$DIGITAL_ME_WIKI_ROOT` → `~/digital-me/` |
| Brain DB (optional input) | `$DIGITAL_ME_BRAIN_DB` → `~/.openclaw/data/task-orchestrator.db` (graceful skip if missing) |
| Drift-check repo roots | `$DIGITAL_ME_DRIFT_CHECK_ROOTS` (`:`-separated) → `dream_cycle.drift_check_repo_roots` in config → `[wiki_root, $HOME]` |

Minimal `config.yaml`:

```yaml
engine: standalone      # or "openclaw"
standalone:
  llm_provider: gemini
  llm_model: gemini-2.0-flash
  embedding_provider: gemini
  embedding_model: gemini-embedding-001
  api_key_env: GEMINI_API_KEY
sources: []
dream_cycle:
  schedule: "0 3 * * *"
  staleness_threshold_days: 30
  auto_archive: false
  # Optional: roots the drift-check step will scan for cited code.
  # Defaults to [wiki_root, $HOME] when omitted.
  drift_check_repo_roots:
    - ~/openclaw
    - ~/.claude
```

## Run

```bash
# Full cycle (via the digital-me wrapper)
digital-me dream-cycle

# …or directly via the console script
digital-me-dream-cycle

# Skip the expensive LLM compile step
digital-me dream-cycle --no-compile

# Only process inbox files touched in the last day
digital-me dream-cycle --recent-days 1

# Use a different wiki root
digital-me dream-cycle --wiki-root /tmp/test-wiki

# All flags
digital-me dream-cycle --help
```

## Scheduling

Pick whichever your system already uses:

- **launchd (macOS):** write a `.plist` to `~/Library/LaunchAgents/`
  that runs `digital-me-dream-cycle` at the time in
  `dream_cycle.schedule`.
- **systemd (Linux):** a `.service` + `.timer` pair pointing at the same
  console script.
- **cron:** `0 3 * * * /path/to/digital-me-dream-cycle`.
- **openclaw scheduler:** load `src/dream_cycle/workflow.json` as a
  workflow template and let openclaw run it.

`dream_cycle.schedule` is validated at config load (standard 5-field
cron, numeric only — named months/weekdays not supported). A bad
expression fails fast with a clear error. The downstream scheduler
(launchd / systemd / cron / openclaw) is what actually fires the
schedule — dream-cycle just holds the string as the single source of
truth so all your scheduling artifacts can be derived from it.

## Tests

```bash
# From inside this package after `pip install -e .[dev]`:
pytest

# Or from anywhere with the venv on PATH:
pytest packages/services/dream-cycle/tests/
```

19 cases cover: every module imports clean, wiki-root + config-path
resolution honors arg → env → default, brain_learnings gracefully skips
when the DB is missing, and a full smoke pipeline runs against a tmp
fixture wiki with no LLM calls.

## Layout

```
src/dream_cycle/
  run.py                  entrypoint / orchestrator
  config.py               YAML loader, dataclasses, env resolvers
  engine.py               LLM/embedding abstraction (openclaw + standalone)
  compile.py              transcript → wiki extraction (LLM)
  consolidate.py          deduplicate / merge entries (LLM)
  drift_check.py          LLM citation-drift audit (configurable code roots)
  index.py                _INDEX.md / _STATS.md
  crosslink.py            _GRAPH.md cross-link generation
  citations.py            citation tracking from traces
  lint.py                 frontmatter / structure checks
  bundles.py              skill-bundle packaging
  brain_learnings.py      materialize learnings from brain MCP
  apply_taste.py          taste-skill application
  distill.py              distillation helpers
  backfill_types.py       backfill missing frontmatter type tags
  health_detector.py      per-entry health signals
  integrations/codex.py   write _INDEX.md → ~/.codex/CODEX.md
  workflow.json           openclaw workflow definition (one template, runs each step)
```
