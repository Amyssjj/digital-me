# Architecture

Digital Me OS is one brain and a set of spokes. The brain — **brain-host** — is a small always-on service in this repo that serves retrieval, operations and scheduling on a single HTTP wire. Every agent CLI you run is a spoke: a thin runtime adapter that wires that CLI's prompt lifecycle to the brain's tools. Nothing outside this repo is required to run it.

## The two cores (both in this repo)

| Core | Package | Role |
|---|---|---|
| retriever | `packages/services/brain-host/src/retriever/` | retrieval — `memory_search`, `memory_get`, `wiki`. Hybrid FTS5 + embedding search over `wiki/` and `tastes/`; the entry is the retrieval unit, one hit per entry, incremental re-index |
| `brain-orchestrator` | `packages/plugins/brain-orchestrator/` | operations + learning capture — `tasks` (goals / tasks / workflows / schedules), `agent_identify`, `traces_record`, `traces_query`, `learning_capture`, `m1_event_record`, `m1_score`, plus the scheduler tick and the exec dispatcher |

`brain-host` mounts both on `POST /tools/invoke` (bearer token, `{tool, agentId, args}` → `{ok, result}`), opens and migrates `brain.db`, and runs the tick. Everything else in this repo orbits that process.

### Vocabulary

| Name | What it is | Where you see it |
|---|---|---|
| **digital-me-brain** | The brain, as agents and people see it | The MCP server every runtime registers (tools surface as `mcp__digital-me-brain__tasks`; Codex spells it `mcp__digital_me_brain__tasks`), the openclaw plugin id |
| **brain-host** | The always-on process that serves the digital-me-brain | The `@digital-me/brain-host` package, its launchd/systemd service, `DIGITAL_ME_BRAIN_*` env, `digital-me service brain-host` |
| **brain-mcp-proxy** | The stdio↔HTTP transport a CLI spawns to reach brain-host | The command behind each MCP registration |

`openclaw-brain` is the MCP server's name from when openclaw was the hub. It survives only as a legacy alias (`LEGACY_BRAIN_MCP_SERVER_NAMES` in `@digital-me/contracts`): `install` removes a registration under it, hooks still recognise its tool names in older transcripts, and saved `cli_exec_aliases` that reference it are rewritten at dispatch time.

## The package roles

```
packages/
├── plugins/        ← the operations core (runtime-agnostic tool descriptors + stores)
│   └── brain-orchestrator/
├── services/       ← long-running or scheduled processes on your machine
│   ├── brain-host/       (THE HUB — retriever + brain-orchestrator on /tools/invoke; owns brain.db + the tick)
│   ├── dashboard/        (HTTP server + UI viewer over brain state)
│   ├── dream-cycle/      (Python pipeline — distills learnings into wiki entries, nightly)
│   └── digest/           (Python — the morning activity digest; Discord webhook or openclaw transport)
├── runtimes/       ← per-CLI auto-injection + protocol bundles (the spokes, client-side)
│   ├── claude-code/      (settings.json hooks + dm_*.sh scripts + skill + MCP registration)
│   ├── codex/            (CODEX.md + config.toml MCP entry + hooks.json lifecycle hooks w/ M1)
│   ├── hermes/           (SOUL.md protocol + recall plugin + MCP stanza)
│   └── openclaw/         (optional: plugin overlay so openclaw agents share the brain; also the
│                          cli-exec alias resolver + dispatcher brain-host reuses)
├── transport/      ← MCP plumbing
│   └── brain-mcp-proxy/  (stdio MCP server forwarding to brain-host's HTTP wire)
├── cli/            ← user-invoked installer/orchestrator (`digital-me <command>`)
└── shared/         ← cross-package primitives
    └── contracts/        (env-var registry, the brain-path rule, config schemas)
```

(Sanitization is enforced by `scripts/sanitize-check.sh` at the repo root — run via `pnpm sanitize:check` — not by a shared package.)

The categories aren't arbitrary — they're determined by **where the package runs and who triggers it**:

| Where it runs | Who triggers it | Category |
|---|---|---|
| Inside brain-host (or the openclaw gateway plugin) | a tool call from an agent | `plugins/` |
| Inside an agent CLI process | the user starting their CLI | `runtimes/` |
| In a CLI process, forwarding to brain-host | the runtime adapter | `transport/` |
| On the host, always-on or scheduled | launchd/systemd, the scheduler tick, or the user | `services/` |
| On the host, transiently | a user typing `digital-me <command>` | `cli/` |
| Imported by other packages | other packages | `shared/` |

## The closed learning loop

The architecture exists to enable this loop:

```
   Agent (identified by agent_identify)
     │
     │ acts                                ┐
     ▼                                     │  brain-orchestrator
   work tracked (tasks/goal/workflow)      │  (the operations core,
     │ scheduled at time (cron)            │   mounted in brain-host)
     ▼                                     │
   outcome observed (traces_record)        │
     │ noteworthy?                         │
     ▼                                     │
   learning captured (learning_capture)    ┘
     │
     │ distilled
     ▼
   wiki entry  ─────  dream-cycle (services/dream-cycle)
     │ indexed
     ▼
   searchable corpus ── retriever (services/brain-host)
     │ retrieved & injected
     ▼
   runtime adapter (runtimes/<cli>/) prepends context to next prompt
     │
     ▼
   Agent (richer context, better decision)
     │
     └─────── back to top ───────┘
```

Each arrow crosses a package boundary. Cut any node, the loop stops.

## Where the brain's files live

One rule, applied by every reader in every language (`@digital-me/contracts` `resolveBrainDbPath` / `resolveEnvFilePath`, with Python twins in dream-cycle, digest and the dashboard intake):

| File | Canonical home | Legacy home (honoured while it is the only one that exists) |
|---|---|---|
| `brain.db` — goals, tasks, traces, learnings | `~/digital-me/.data/brain.db` | `~/.openclaw/data/brain.db` |
| provider keys (`GEMINI_API_KEY`, …) | `~/digital-me/.data/.env` — brain-host loads it and every worker it dispatches inherits it | `~/.openclaw/.env` |
| bearer token | `~/digital-me/.data/brain-host.token` | — |
| retrieval index | `~/digital-me/.data/retrieval.db` | — |
| exec task artifacts | `~/digital-me/.data/task-artifacts/` | `~/.openclaw/task-artifacts/` |

`.data/` is git-ignored by `setup`; `digital-me brain-db migrate` moves a legacy database. See [CONTRACTS.md](CONTRACTS.md) for the env-var overrides.

## What lives where — your config vs the framework

Public packages contain **mechanism only**. User-specific configuration — injection rules, agent IDs, wiki domain registry, schedule times, source paths — lives in your `~/digital-me` directory (ideally a private git repo), loaded at runtime via the env-var contract in [CONTRACTS.md](CONTRACTS.md).

For example, the openclaw runtime (`packages/runtimes/openclaw/`) ships a **rule engine** that intercepts prompts. The rules — "agent X with keyword Y triggers injection from domain Z" — live in your `config.yaml`. The plugin is generic; your taxonomy is yours.

See [SANITIZATION.md](SANITIZATION.md) for the full list of what's mechanism vs config.

## Relationship to openclaw

openclaw is one of the four supported runtimes, not a dependency. Where it is installed, `digital-me install --runtime openclaw` adds an **additive plugin overlay** (`digital-me-brain` + `digital-me-recall`) to `~/.openclaw/extensions/` through the documented plugin SDK — no fork, no rebase — so openclaw agents get the same tools and the same prompt-time recall. The plugin opens the same `brain.db` and defers the scheduler tick to brain-host whenever brain-host is installed (exactly one process ticks a brain). Installs that predate brain-host keep working: a legacy openclaw gateway is still accepted as the brain endpoint for the adapters, and the file rule above keeps reading the old locations until you migrate.

## Operational telemetry as a brain concern

Goals, metrics, issues, feedback, insights, and cron-run history are all **operational telemetry** about how the system is performing. In the long-term architecture they live behind brain-orchestrator MCP tools (`metric.*`, `issue.*`, `feedback.*`, `insight.*`, `cron.*`, `agent_activity.*`), not in a dashboard-side SQLite store.

Consequence (**target architecture** — not fully realized yet): the dashboard becomes a stateless viewer that calls brain tools and renders responses, with no direct database access. **Today** the dashboard is mid-migration: live brain views (kanban, board, search) go through brain-host via `brain-mcp-proxy`, while metrics and the activity feed read from a dashboard-owned snapshot store (`~/digital-me/.data/dashboard.db`) populated by a scheduled Python intake ETL. The snapshot store keeps the dashboard usable when brain-host is down; the remaining legacy direct-read paths are being retired as the brain tools land.

See [BRAIN-OPERATIONAL-TELEMETRY-TOOLS.md](BRAIN-OPERATIONAL-TELEMETRY-TOOLS.md) for the full tool specification, and note that this decision reverses the original phase ordering — brain-orchestrator (Phase 3) is built *before* the dashboard finishes (Phase 2), because the dashboard depends on those tools existing.
