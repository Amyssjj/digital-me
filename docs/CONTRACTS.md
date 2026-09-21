# Environment Variable Contracts

User-specific paths and settings are passed through documented environment variables. The TypeScript registry for the core set lives in `@digital-me/contracts` (`packages/shared/contracts/src/env.ts`); `transport/brain-mcp-proxy` loads through its `loadConfig()`, while other packages (dashboard, CLI, the Python services) read the same variables directly with the defaults documented here. No package hardcodes a user's machine path; no package guesses at where the data lives.

This file documents the contract. Adding a new env var requires updating this document, and the registry in `packages/shared/contracts/src/env.ts` when it's part of the core `loadConfig()` set.

## Required vs optional

A required variable has no default — the package errors at startup if it's not set. An optional variable has a documented fallback.

| Variable | Required | Default | Owner | Consumers |
|---|---|---|---|---|
| `DIGITAL_ME_WIKI_ROOT` | no | `~/digital-me` | data repo | **canonical** — every runtime adapter, hook, `services/dream-cycle`, and `services/dashboard` intake reads this. **Set this one.** |
| `DIGITAL_ME_HOME` | no¹ | — | data repo | `@digital-me/contracts` `loadConfig()` clients (e.g. `transport/brain-mcp-proxy`). Legacy alias for `DIGITAL_ME_WIKI_ROOT`. |
| `DIGITAL_ME_WIKI_DIR` | no | `$DIGITAL_ME_WIKI_ROOT/wiki` (or `$DIGITAL_ME_HOME/wiki`) | data repo | contracts-layer derived value |
| `DREAM_CYCLE_HOME` | no | `$DIGITAL_ME_HOME/dream_cycle` | data repo | `services/dream-cycle` |
| `DREAM_CYCLE_VENV` | no | `$DREAM_CYCLE_HOME/.venv` | data repo | `services/dream-cycle` |
| `OPENCLAW_HOME` | no | `~/.openclaw` | openclaw | `plugins/brain-orchestrator`, `services/dashboard` |
| `OPENCLAW_DATA_DIR` | no | `$OPENCLAW_HOME/data` | openclaw | `plugins/brain-orchestrator`, `services/dashboard` |
| `OPENCLAW_GATEWAY_HOST` | no | `127.0.0.1` | openclaw | `transport/brain-mcp-proxy` |
| `OPENCLAW_GATEWAY_PORT` | no | `18789` | openclaw | `transport/brain-mcp-proxy` |
| `OPENCLAW_GATEWAY_TOKEN` | no | (read from `$OPENCLAW_HOME/openclaw.json`) | openclaw | `transport/brain-mcp-proxy` |
| `DIGITAL_ME_BRAIN_URL` | no | (unset — callers use the openclaw gateway) | brain-host | `transport/brain-mcp-proxy`, `runtimes/claude-code` + `runtimes/codex` hooks, `runtimes/hermes` recall plugin + `m1_backfill.py`, `services/dream-cycle` brain client. The brain-host `/tools/invoke` endpoint (e.g. `http://127.0.0.1:18791/tools/invoke`); when set it takes precedence over every `OPENCLAW_GATEWAY_*` value and **a bearer token must resolve** — from `DIGITAL_ME_BRAIN_TOKEN`, else `DIGITAL_ME_BRAIN_TOKEN_FILE`, else the default token file. A URL with no resolvable token is a configuration error, never a silent fallback to the gateway token. |
| `DIGITAL_ME_BRAIN_TOKEN` | no | — | brain-host | same consumers as `DIGITAL_ME_BRAIN_URL`. Bearer token for brain-host, inline. Prefer `DIGITAL_ME_BRAIN_TOKEN_FILE`: the installers never write this variable (and remove one they wrote earlier), so the secret stays on disk. |
| `DIGITAL_ME_BRAIN_TOKEN_FILE` | no | `$DIGITAL_ME_WIKI_ROOT/.data/brain-host.token` (`~/digital-me/.data/brain-host.token`) | brain-host | same consumers as `DIGITAL_ME_BRAIN_URL`, plus `services/brain-host` itself. File holding the bearer token, read (trimmed) when `DIGITAL_ME_BRAIN_TOKEN` is unset; an empty or unreadable file counts as no token. `digital-me install --runtime brain-host` writes it (mode 600); `install --runtime claude-code | codex | hermes` write this path — not the token — into `~/.claude/settings.json` `env`, the MCP registrations, `~/.codex/config.toml` (`[mcp_servers.openclaw-brain]` env + `[shell_environment_policy.set]` for the hooks) and `~/.hermes/config.yaml`. |
| `BRAIN_PROXY_PATH` | no | `$(which digital-me-brain-mcp-proxy)` | this repo | runtime adapters |
| `ORCHESTRATOR_DB_PATH` | no | `$OPENCLAW_DATA_DIR/orchestrator.db` | brain-orchestrator | **deprecated** — registry entry with no live consumer; the live orchestrator store is `$OPENCLAW_DATA_DIR/brain.db` |
| `OPENCLAW_BRAIN_DB` | no | (alias of `DIGITAL_ME_BRAIN_DB`, lower precedence) | brain-orchestrator | `services/dashboard` intake ETL — legacy name, still honoured |
| `DIGITAL_ME_BRAIN_DB` | no | **rule** (`@digital-me/contracts` `resolveBrainDbPath`): `$DIGITAL_ME_WIKI_ROOT/.data/brain.db` if it exists → legacy `$OPENCLAW_HOME/data/brain.db` if it exists → `$DIGITAL_ME_WIKI_ROOT/.data/brain.db` | brain-host | every brain.db reader applies the same rule: `services/brain-host` (owner), `transport/brain-mcp-proxy` trace writer, `runtimes/openclaw` plugin templates, `services/dashboard` server + intake, `services/dream-cycle` (`brain_learnings.resolve_brain_db_path`, apply, citations), `services/digest` (`digest.config.resolve_brain_db`), the CLI (`doctor`, `migrate`, `brain-db migrate`). Move a legacy database with `digital-me brain-db migrate`. |
| `DIGITAL_ME_ENV_FILE` | no | **rule** (`resolveEnvFilePath`): `$DIGITAL_ME_WIKI_ROOT/.data/.env` if it exists → legacy `$OPENCLAW_HOME/.env` if it exists → `$DIGITAL_ME_WIKI_ROOT/.data/.env` | brain-host | the brain-host service unit loads it (`node --env-file-if-exists`) so `GEMINI_API_KEY` etc. reach the retriever and every worker it dispatches; `digital-me doctor` checks the dream-cycle key there. Never committed (`.data/` is git-ignored by `setup`). |
| `DIGITAL_ME_TASK_ARTIFACTS` | no | `$DIGITAL_ME_WIKI_ROOT/.data/task-artifacts` (legacy `$OPENCLAW_HOME/task-artifacts` while only that exists) | brain-host | `runtimes/openclaw` alias resolver (`defaultArtifactRoot`) — per-task `spec.json` / `handoff.json` dirs for exec workers |
| `DIGITAL_ME_DIGEST_DELIVERY` | no | `webhook` when a webhook URL resolves, else `openclaw` when the openclaw CLI exists, else `webhook` | digest | `services/digest` publisher: `webhook` POSTs to a Discord webhook (no gateway); `openclaw` shells out to `openclaw message send`. Also `config.yaml` `digest.delivery`. |
| `DIGITAL_ME_DIGEST_WEBHOOK_URL` | no | — | digest | inline webhook URL (prefer the file form below — the URL is a secret) |
| `DIGITAL_ME_DIGEST_WEBHOOK_URL_FILE` | no | `config.yaml` `digest.webhook_url_file`, else `$DIGITAL_ME_WIKI_ROOT/.data/digest-webhook.url` | digest | file holding the Discord webhook URL (mode 600, beside `brain-host.token`) |
| `DASHBOARD_PORT` | no | `3458` | dashboard | dashboard Express server (loopback only) |
| `DASHBOARD_DB` | no | `~/digital-me/.data/dashboard.db` | dashboard | dashboard server + Python intake ETL |
| `OPENCLAW_EXTENSIONS_DIR` | no | `$OPENCLAW_HOME/extensions` | openclaw | `cli` (plugin install target) |
| `DIGITAL_ME_TASTES_DIR` | no | `$DIGITAL_ME_WIKI_ROOT/tastes` | data repo | `services/dashboard` intake ETL |
| `DIGITAL_ME_CONFIG_PATH` | no | `$DIGITAL_ME_WIKI_ROOT/config.yaml` | data repo | `services/dream-cycle` |
| `DIGITAL_ME_DRIFT_CHECK_ROOTS` | no | (built-in roots) | data repo | `services/dream-cycle` drift check (colon-separated) |
| `DIGITAL_ME_OWNER_NAME` | no | (empty — owner-marker matching disabled) | data repo | `services/dream-cycle` taste capture: display name that marks transcript turns as owner-authored. Unset → transcript sources that require the marker are skipped rather than mis-attributed. |
| `DASHBOARD_TITLE` | no | `"Operations Dashboard"` | dashboard config | dashboard UI |
| `TEAM_WORKSPACE_ROOT` | no | (none — feature disabled if unset) | dashboard config | dashboard team views |
| `LEARNING_SOURCE_DIR` | no | (none) | dashboard config | dashboard learning ingest |
| `LEARNING_DEST_DIR` | no | (none) | dashboard config | dashboard learning ingest |
| `OPENCLAW_AGENT_ID` | no | `unknown` | runtime adapter | `transport/brain-mcp-proxy` |

¹ `DIGITAL_ME_HOME` is an **optional legacy alias** for `DIGITAL_ME_WIKI_ROOT`.
When unset it derives from `DIGITAL_ME_WIKI_ROOT` (which defaults to
`~/digital-me`), so both resolve to the same root. Export
`DIGITAL_ME_WIKI_ROOT` — that's the name the wiki/runtime/dream-cycle/dashboard
code actually reads; `DIGITAL_ME_HOME` is retained only so existing
`loadConfig()` clients (e.g. `transport/brain-mcp-proxy`) keep working.

## Resolution order

1. Environment variable (highest precedence)
2. Value in `$DIGITAL_ME_WIKI_ROOT/config.yaml` (per-key override)
3. Default declared in the contract

This means a user can override anything either via env vars (for one-off testing) or via their `config.yaml` (for persistent local configuration).

## Adding a new variable

1. Add to the `EnvSpec` map in `packages/shared/contracts/src/env.ts`.
2. Add a row to the table above.
3. Update `packages/shared/contracts/src/schemas.ts` if it's also a `config.yaml` field.
4. Note which package(s) consume it.
5. The sanitize-check gate will catch any hardcoded value left in the consumer.

## Why this design

Three properties:

- **No personal data in code** — every consumer that needs a path or identity reads it via `loadConfig()`. The sanitize-check enforces this mechanically.
- **One source of truth** — adding a new path is one edit (`env.ts`) plus one row here. No package-by-package configuration files to keep in sync.
- **Predictable failures** — missing required vars throw at startup with a clear message ("set `OPENCLAW_HOME`"), not at runtime with a confusing path error. (Wiki paths default to `~/digital-me`, so a fresh user gets a working golden path without exporting anything.)
