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
| `BRAIN_PROXY_PATH` | no | `$(which digital-me-brain-mcp-proxy)` | this repo | runtime adapters |
| `ORCHESTRATOR_DB_PATH` | no | `$OPENCLAW_DATA_DIR/orchestrator.db` | brain-orchestrator | **deprecated** — registry entry with no live consumer; the live orchestrator store is `$OPENCLAW_DATA_DIR/brain.db` |
| `OPENCLAW_BRAIN_DB` | no | `~/.openclaw/data/brain.db` | brain-orchestrator | `services/dashboard` intake ETL |
| `DIGITAL_ME_BRAIN_DB` | no | `~/.openclaw/data/task-orchestrator.db` (legacy) | brain-orchestrator | `services/dream-cycle` brain-learnings reader |
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
