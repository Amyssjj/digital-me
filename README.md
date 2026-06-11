<div align="center">

# Digital Me

### The intelligence every agent runs on.

[![CI](https://github.com/Amyssjj/digital-me/actions/workflows/ci.yml/badge.svg)](https://github.com/Amyssjj/digital-me/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 22.5](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen.svg)](#prerequisites)
[![Runs on openclaw](https://img.shields.io/badge/runs%20on-openclaw-CC2936.svg)](https://github.com/openclaw/openclaw)

**Agents change. Your intelligence compounds.**

[Getting Started](#install) · [Architecture](docs/ARCHITECTURE.md) · [Contracts](docs/CONTRACTS.md) · [Releasing](docs/RELEASING.md) · [openclaw](https://github.com/openclaw/openclaw)

</div>

---

**Digital Me** carries your intelligence — knowledge, taste, decisions — to every agent you run. Use Claude Code for deep work, Codex across repos, Hermes or openclaw always-on: each one remembers what the others learned, applies your taste, and reports into the same goals. Switch agents without becoming the memory, translator, and context courier between them.

New install? Start here: [Getting started](#install)

Preferred setup: run `pnpm dm setup` from a clone. It detects your installed CLIs, scaffolds your data directory, wires every runtime, and ends with a doctor pass. Works on macOS and Linux.

> **Status:** pre-release WIP. The packages are functional with ~1,400 unit tests (core stores and handlers at 100% coverage), but nothing is published to npm yet — install from source (see below).

## What you get

When fully installed, every agent runtime shares:

- **memory_search** — retrieve from a personal knowledge wiki
- **learning_capture** — agents submit observations back as reusable knowledge
- **traces** — every agent action recorded and queryable
- **workflows** — reliable recurring tasks with cron scheduling
- **goals** — long-running objectives with task hierarchies
- **dashboard** — a viewer over your accumulated state
- **dream-cycle** — nightly distillation pipeline that turns raw learnings into clean wiki entries

## Install

### Prerequisites

- **Node.js ≥ 22.5** and **pnpm** — the CLI checks and tells you if your Node is too old.
- **[openclaw](https://github.com/openclaw/openclaw)** — mandatory, see below.
- **Python ≥ 3.11** — optional; only needed for the dream-cycle distillation pipeline (skip with `setup --minimal`).

### Prerequisite — openclaw (mandatory)

Install [openclaw](https://github.com/openclaw/openclaw) **first** and verify `openclaw --version` works. Digital Me is a plugin + CLI-adapter set that rides on top of the openclaw gateway daemon — without it, the brain MCP tools and every runtime adapter have nothing to connect to. `setup` and `install` **hard-stop** with install guidance if openclaw isn't detected (override with `--skip-openclaw-check` for advanced/CI use).

### One-shot install

```bash
git clone https://github.com/Amyssjj/digital-me.git ~/digital-me-os
cd ~/digital-me-os && pnpm install && pnpm build

# Detect installed CLIs, scaffold ~/digital-me/, install hooks/skills/configs,
# link the `digital-me` command onto PATH, run doctor. (`pnpm dm` = the CLI.)
pnpm dm setup

# Or pin a custom wiki location:
pnpm dm setup --wiki-root ~/notes/brain

# Node-only? Skip the heavy optional services (dream-cycle Python venv +
# dashboard build) — add either later with `digital-me install --runtime <id>`:
pnpm dm setup --minimal

# Then:
export DIGITAL_ME_WIKI_ROOT=~/digital-me
# config.yaml is auto-created with `sources` pre-filled from your detected CLIs.
# Default engine=openclaw reads your LLM key from ~/.openclaw/openclaw.json,
# so there's usually nothing left to edit. Review ~/digital-me/config.yaml.
```

What `setup` does:

1. **Detects** `~/.claude/`, `~/.codex/`, `~/.hermes/` to figure out which runtimes you have.
2. **Scaffolds** the wiki root: `~/digital-me/{wiki,inbox,.cache}` + a pristine `config.example.yaml` and a live `config.yaml` (created only if absent, never clobbered).
3. **Installs each detected runtime**:
   - `~/.claude/hooks/*` + `~/.claude/skills/digital-me/` + merged settings.json
   - `~/.codex/CODEX.md` + openclaw-brain MCP entry in `~/.codex/config.toml` + `~/.codex/hooks/*` wired via `~/.codex/hooks.json` (UserPromptSubmit / Stop / PreToolUse, with M1 application_rate tracking)
   - `~/.hermes/SOUL.md` with the digital-me protocol section
4. **Populates `cli_exec_aliases`** in the starter config so workflows can dispatch tasks via `claude` / `codex` out of the box.
5. **Runs `doctor`** to confirm everything resolved.

Re-running is idempotent — installers merge into existing settings without clobbering your other hooks.

> **The `digital-me` command on your PATH:** `setup` runs `pnpm link --global`
> for you, so after the one-shot install the bare `digital-me …` commands below
> work directly. Before that link exists, use `pnpm dm <command>` from the repo
> (or `node packages/cli/dist/bin/digital-me.js <command>` the long way).

### First-run scenarios

Pick the row that matches you:

| You have… | Run | What you get |
|---|---|---|
| openclaw + Claude Code / Codex / Hermes | `pnpm dm setup` | Full install: adapters + brain plugin + dashboard + dream-cycle, `digital-me` on PATH, green doctor |
| openclaw, but node-only (no Python / no dashboard) | `pnpm dm setup --minimal` | Wiki + agent-runtime wiring + brain plugin only; add the rest later with `digital-me install --runtime dream-cycle\|dashboard` |
| **not** openclaw yet | *(install openclaw first)* | `setup` hard-stops and points you at the openclaw install — it's the mandatory foundation |
| Homebrew / Debian / recent Ubuntu Python | *(see [dream-cycle](#running-the-dream-cycle-distillation-pipeline))* | These enforce PEP 668; install dream-cycle into a venv (recipe below). `digital-me doctor` prints the exact recipe for your Python. |

Everything is idempotent — re-run `setup` anytime; it merges and skips what already exists.

### Manual control

```bash
digital-me init                       # scaffold wiki dir only
digital-me install --runtime codex    # install one runtime
digital-me doctor                     # diagnose without changes
```

### Installing the brain into openclaw

The brain itself (the `tasks`, `agent_identify`, `learning_capture`, `traces_record`, `traces_query`, `m1_event_record`, and `m1_score` tools) lives in `@digital-me/brain-orchestrator`. See [packages/runtimes/openclaw/README.md](packages/runtimes/openclaw/README.md) for the manifest + wiring snippet that registers them with openclaw.

### Running the dream-cycle distillation pipeline

The nightly knowledge-distillation loop lives in [packages/services/dream-cycle/](packages/services/dream-cycle/) as a Python sibling package. Install it into a venv (required on Homebrew / Debian / recent Ubuntu — they enforce PEP 668):

```bash
python3 -m venv ~/.venvs/dream-cycle
~/.venvs/dream-cycle/bin/pip install -e "packages/services/dream-cycle[dev]"
export PATH="$HOME/.venvs/dream-cycle/bin:$PATH"
```

Then run it via the wrapper or directly:

```bash
digital-me dream-cycle                 # full pipeline, picks up $DIGITAL_ME_WIKI_ROOT
digital-me dream-cycle --no-compile    # skip the LLM compile step (cheap rerun)
digital-me dream-cycle --help          # all flags
```

`digital-me doctor` adds three checks (`python3 >= 3.11`, `dream_cycle` importable, LLM-auth env var set per `config.yaml`). If `dream_cycle` isn't installed, the doctor prints the exact venv recipe for your Python — including whether it's externally-managed. **The nightly distillation is scheduled for you** at install time (workflow + schedule `dream-cycle-nightly`, `0 3 * * *`, registered with the openclaw orchestrator) — no manual cron needed; adjust or disable it via the dashboard or `tasks.schedule_*`.

## CLI exec aliases — dispatching to your CLIs

When the brain wants to run a step via a CLI (claude, codex), it looks up an *alias* in your config:

```yaml
cli_exec_aliases:
  claude-code-cli:
    binary: claude
    args: ["-p", "--allowedTools", "Bash,Read,Write", "{{prompt}}"]
    env: { OPENCLAW_AGENT_ID: claude-code }
    timeoutMs: 1800000
```

Then a workflow step like:

```json
{ "stepKey": "deploy", "dispatch": { "mode": "exec", "agentId": "claude-code-cli" } }
```

…gets materialized at task-creation time by [`@digital-me/runtime-openclaw`](packages/runtimes/openclaw)'s alias resolver, which wraps it in a `cli-exec-worker.mjs` invocation that handles prompt rendering, handoff capture, and verify gating. `digital-me setup` auto-populates `cli_exec_aliases` for whichever CLIs it detects — third-party CLIs are added by hand.

## Architecture at a glance

Five package roles, each with one clear job:

```
packages/
├── plugins/        ← installed INTO openclaw (universal brain tools)
├── runtimes/       ← per-CLI auto-injection + protocol bundles
│   ├── openclaw/
│   ├── claude-code/
│   ├── codex/
│   └── hermes/
├── transport/      ← MCP plumbing (stdio↔HTTP shim for non-openclaw CLIs)
├── services/       ← long-running or scheduled processes beside openclaw
│   ├── dashboard/
│   └── dream-cycle/
├── cli/            ← installer/orchestrator (`digital-me <command>`)
└── shared/         ← contracts (env vars), schemas, lint rules
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full mental model.

## How it relates to openclaw

- **openclaw** owns the brain runtime (gateway daemon, memory-core, active-memory).
- **this repo** owns everything built on top: one extension plugin (brain-orchestrator), per-runtime protocol adapters, transport, services, CLI.
- **digital-me-data** (separate private repo per user) holds your wiki content and config.

This repo contains **no personal data**. All user-specific configuration lives in your local `digital-me-data` repo and is loaded at runtime via the env-var contract documented in [docs/CONTRACTS.md](docs/CONTRACTS.md).

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm sanitize:check  # forbidden-pattern scan; must pass before any commit
```

## License

MIT — see [LICENSE](LICENSE).
