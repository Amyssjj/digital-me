# Architecture

Digital Me OS is a curated stack of openclaw extensions and adapters. It does not contain the brain runtime — openclaw owns that. It contains the things built on top.

## The two cores (in openclaw, not here)

| Core | Owner | Role |
|---|---|---|
| `memory-core` | upstream openclaw | retrieval — `memory_search`, `memory_get` |
| `brain-orchestrator` | this repo (`packages/plugins/brain-orchestrator/`) | operations + learning capture — `tasks`, `goal`, `workflow`, `agent_identify`, `traces_record`, `traces_query`, `learning_capture` |

Together, those two plugins make openclaw a brain. Everything else in this repo orbits them.

## The five package roles

```
packages/
├── plugins/        ← installed INTO openclaw (server-side, extend the brain)
├── runtimes/       ← per-CLI auto-injection + protocol bundles (client-side)
│   ├── openclaw/         (proactive-learning — hooks into openclaw's prompt build)
│   ├── claude-code/      (settings.json hooks + dm_*.sh scripts + skill)
│   ├── codex/            (CODEX.md + config.toml MCP entry + hooks.json lifecycle hooks w/ M1)
│   └── hermes/           (Gemini/Hermes persona + chat protocol)
├── transport/      ← MCP plumbing (CLIs that need stdio↔HTTP bridge)
│   └── brain-mcp-proxy/  (stdio MCP server forwarding to openclaw's gateway HTTP)
├── services/       ← long-running or scheduled processes beside openclaw
│   ├── dashboard/        (HTTP server + UI viewer over brain state)
│   └── dream-cycle/      (Python pipeline — distills learnings into wiki entries)
├── cli/            ← user-invoked installer/orchestrator (`digital-me <command>`)
└── shared/         ← cross-package primitives
    └── contracts/        (env-var registry, config schemas)
```

(Sanitization is enforced by `scripts/sanitize-check.sh` at the repo root — run via `pnpm sanitize:check` — not by a shared package.)

The categories aren't arbitrary — they're determined by **where the package runs and who triggers it**:

| Where it runs | Who triggers it | Category |
|---|---|---|
| Inside openclaw gateway | tool call from an agent | `plugins/` |
| Inside an agent CLI process | the user starting their CLI | `runtimes/` |
| In a CLI process, forwarding to openclaw | the runtime adapter | `transport/` |
| On the host, alongside openclaw | a scheduler, or user starting a service | `services/` |
| On the host, transiently | a user typing `digital-me <command>` | `cli/` |
| Imported by other packages | other packages | `shared/` |

## The closed learning loop

The architecture exists to enable this loop:

```
   Agent (identified by agent_identify)
     │
     │ acts                                ┐
     ▼                                     │  brain-orchestrator
   work tracked (tasks/goal/workflow)      │  (the operations core)
     │ scheduled at time (cron)            │
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
   searchable corpus ── memory-core (upstream openclaw)
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

## What lives where — your config vs the framework

Public packages contain **mechanism only**. User-specific configuration — injection rules, agent IDs, wiki domain registry, schedule times, source paths — lives in your private `digital-me-data` repo, loaded at runtime via the env-var contract in [CONTRACTS.md](CONTRACTS.md).

For example, the openclaw runtime (`packages/runtimes/openclaw/`) ships a **rule engine** that intercepts prompts. The rules — "agent X with keyword Y triggers injection from domain Z" — live in your `config.yaml`. The plugin is generic; your taxonomy is yours.

See [SANITIZATION.md](SANITIZATION.md) for the full list of what's mechanism vs config.

## Relationship to openclaw

Digital Me OS does not modify openclaw. It installs into openclaw via the documented plugin SDK and the MCP protocol. To use Digital Me OS, you install openclaw separately (see [openclaw docs](https://docs.openclaw.ai)), then install this stack's plugins, runtimes, and services.

The `brain-mcp-proxy` (transport) lets any MCP-speaking CLI reach openclaw's HTTP gateway — that's the seam between this repo and the upstream brain.

## Operational telemetry as a brain concern

Goals, metrics, issues, feedback, insights, and cron-run history are all **operational telemetry** about how the system is performing. In the long-term architecture they live behind brain-orchestrator MCP tools (`metric.*`, `issue.*`, `feedback.*`, `insight.*`, `cron.*`, `agent_activity.*`), not in a dashboard-side SQLite store.

Consequence (**target architecture** — not fully realized yet): the dashboard becomes a stateless viewer that calls brain tools and renders responses, with no direct database access. **Today** the dashboard is mid-migration: live brain views (kanban, board) go through the gateway via `brain-mcp-proxy`, while metrics and the activity feed read from a dashboard-owned snapshot store (`~/digital-me/.data/dashboard.db`) populated by a scheduled Python intake ETL. The snapshot store keeps the dashboard usable when the gateway is down; the remaining legacy direct-read paths are being retired as the brain tools land.

See [BRAIN-OPERATIONAL-TELEMETRY-TOOLS.md](BRAIN-OPERATIONAL-TELEMETRY-TOOLS.md) for the full tool specification, and note that this decision reverses the original phase ordering — brain-orchestrator (Phase 3) is built *before* the dashboard finishes (Phase 2), because the dashboard depends on those tools existing.
