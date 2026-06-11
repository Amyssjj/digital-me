# Brain Operational Telemetry Tools

A specification for the MCP tool surface that `brain-orchestrator` will expose to consolidate operational telemetry. Today this data lives in a separate `system_monitor.db` SQLite file that the dashboard reads directly. The end state: brain-orchestrator owns the full operational ledger; the dashboard is a stateless viewer that calls MCP tools.

This document is the **load-bearing contract**. The dashboard is built against these tools (Phase 2 finish); brain-orchestrator implements them (Phase 3); they can be added incrementally with thin SQLite passthroughs before the storage migration completes.

## Design principles

1. **One operational ledger.** Identity, work, traces, learnings, metrics, issues, feedback, insights, cron — all owned by one plugin (`brain-orchestrator`), one tool surface, one SQLite store.
2. **Write side + read side.** Every category has both `record`/`open`/`submit`/`capture` (producers) and `query`/`list`/`summary` (consumers). Producers can be any plugin; consumers are typically the dashboard or another agent.
3. **Agent attribution everywhere.** Every write carries `agent_id` (auto-injected by the proxy if omitted). This is consistent with the existing `traces_record` / `learning_capture` pattern.
4. **Time-series first-class.** Many tools take `since` (epoch ms) and `until` for time-range filtering. Defaults: `since` = 30 days ago, `until` = now.
5. **No special-case "summary" tools where a generic `query` works.** Summaries are derived in the consumer (dashboard transforms) unless aggregation is expensive enough to belong server-side.
6. **Stable JSON schemas at every boundary.** Inputs and outputs are declared. Consumers (dashboard, other tools) can rely on shape without `as` casts.

## Naming conventions

- **Tool name:** `<family>.<action>` — e.g., `metric.record`, `issue.open`, `cron.summary`.
- **Family is singular** (`metric`, not `metrics`) — matches existing `tasks`, `wiki`, `learning_capture` precedent.
- **Action is a verb when it mutates** (`record`, `open`, `submit`, `capture`, `update`), **a noun when it reads** (`query`, `summary`, `list`, `config`).
- **Multi-word actions use snake_case** to match openclaw's tool argument convention (`per_job_summary`, not `perJobSummary`).

## Tool families

The brain-orchestrator gains five new families. Existing families (`tasks`, `traces_*`, `learning_capture`, `agent_identify`) are unchanged.

### `metric.*` — numeric time-series

Replaces dashboard reads of `goal_metrics` and `daily_metric_activity` tables.

| Tool | Purpose |
|---|---|
| `metric.record` | Write a metric value: `{ goal, metric, value, unit, date?, source_agent?, numerator?, denominator?, breakdown? }` |
| `metric.query` | Read time-series: `{ goal?, metric?, since?, until? } → { points: [{date, goal, metric, value, unit, breakdown}, ...] }` |
| `metric.summary` | Latest values + trends per goal: `{ goals: string[] }? → { goals: [{ id, current, previous, trend, sparkline: [{date,value}], health_status, health_score, sub_metrics: {…} }, …] }` |
| `metric.goal_config` | Register a goal's metadata: `{ id, name, icon, color, primary_metric, unit, healthy_threshold, warning_threshold, invert_health? }` |
| `metric.goal_config_list` | Read all registered goal configs |

The dashboard's `getGoals()` becomes `await brain.metric.summary({})`. `getGoalMetrics(id)` becomes `await brain.metric.query({ goal: id })`. The complex `getKnowledgeRows()` aggregations are dashboard-side transforms over `metric.query` output.

### `issue.*` — bugs, improvements, automation opportunities

Replaces dashboard reads of the `issues` table.

| Tool | Purpose |
|---|---|
| `issue.open` | Create issue: `{ type: "bug" \| "improvement" \| "automation_opportunity", goal?, title, description?, category?, severity?, reported_by? }` |
| `issue.update` | Change status: `{ id, status: "open" \| "in_progress" \| "verify" \| "closed" \| "completed", resolution? }` |
| `issue.list` | Filtered list: `{ type?, status?, goal?, since?, until?, limit? } → { issues: [...] }` |
| `issue.summary` | Counts: `{ by_reporter: [{reporter,count}], total, closed, fix_rate }` |
| `issue.timeseries` | Daily counts: `{ since?, until?, by: "reporter" \| "type" \| "goal" } → { points: [{date, dim, opened, closed}, ...] }` |

The "automation opportunities" subset is just `issue.list({ type: "automation_opportunity" })` — no separate tool needed.

### `feedback.*` — user/agent feedback notes

Replaces dashboard reads of the `feedback` table.

| Tool | Purpose |
|---|---|
| `feedback.submit` | Capture: `{ type, agent, description, severity?, source, related_goal? }` |
| `feedback.list` | Recent feedback: `{ since?, limit? } → { feedback: [{ id, date, type, agent, description, severity, source, related_goal, resolved }, ...] }` |
| `feedback.resolve` | Mark resolved: `{ id, resolved: boolean, resolution? }` |

### `insight.*` — discovered insights surfaced to the user

Replaces dashboard reads of the `insights` table.

| Tool | Purpose |
|---|---|
| `insight.capture` | Record: `{ type, observation, why_it_matters?, question_for_jing?, proposed_action?, related_goal? }` |
| `insight.list` | Surfaced + discussed: `{ status_filter?, since?, limit? } → { insights: [...] }` |
| `insight.update_status` | Mark surfaced/discussed/resolved/archived: `{ id, status }` |

### `cron.*` (read side) — scheduled-run history

Existing `tasks` tool already covers cron *scheduling* (`schedule_add`, `schedule_remove`, etc.). This family covers the **read side** — what happened when each scheduled run fired.

Replaces dashboard reads of `cron_runs` table.

| Tool | Purpose |
|---|---|
| `cron.history` | Raw runs: `{ cron_name?, since?, until?, limit? } → { runs: [{ date, cron_name, scheduled_time, run_time, status, duration_ms, error }, ...] }` |
| `cron.summary` | Per-day aggregate: `{ since?, until? } → { points: [{date, total_scheduled, success_count, failed_count, skipped_count, missed_count, success_rate}, ...] }` |
| `cron.per_job_summary` | Per-day per-job aggregate: `{ since?, until? } → { points: [{date, cron_name, ...counts, success_rate}, ...] }` |

The dashboard's `getCronRunsPerJob` hybrid (joining brain's workflow_list for name→id relabel) becomes natural: brain-orchestrator already owns workflow templates, so it can return the canonical id directly.

### `agent_activity.*` — daily per-agent rollups

Replaces dashboard reads of `daily_agent_activity` table.

| Tool | Purpose |
|---|---|
| `agent_activity.record` | Write daily rollup: `{ agent_id, date, status, sessions_count, prompt_byte_breakdown: {agents_md, memory_md, soul_md, user_md, tools_md, heartbeat_md, total} }` |
| `agent_activity.query` | Read time series: `{ since?, until?, agent_id? } → { activity: [...] }` |

## What does NOT become new brain tools

Some dashboard endpoints don't need new tools because **existing brain tools already cover them**:

| Dashboard endpoint | Existing brain tool that serves it |
|---|---|
| `/api/kanban` | `tasks` (action: board) — already migrated |
| `/api/traces` + `/api/traces/:id` | `traces_query` — already migrated |
| `/api/workflows` + `/api/workflows-v2` | `tasks` (action: workflow_list) — already migrated |
| `/api/workflow-status` | `tasks` (action: workflow_list, status filter) |
| `/api/system-status` | drift-status uses `brain-orchestrator` for cron meta + filesystem checks; no new tool needed |
| `/api/dashboard` (legacy v1: agents + work items + cron) | composes `agent_activity.query` + `cron.history` + a memory-file walk that stays in dashboard |
| `/api/layer-health` | `metric.summary` filtered to the four operating-model goals |

This catalog cuts the "new tool" surface to **17 tools across 5 families** instead of "everything db.ts does."

## Implementation strategy: thin passthrough first

Brain-orchestrator's initial implementation of each new tool is a thin **passthrough** over `system_monitor.db`:

1. Plugin accepts a config field `legacy_metrics_db` (path).
2. Tool handlers connect to that DB read-only and run the same SQL the dashboard's `db.ts` runs today.
3. Result is shaped to the tool's declared output schema.
4. Schema-validated at the boundary so callers get the typed contract from day one.

Later (separately, no consumer touches required):

1. Brain-orchestrator gains its own tables (`metric_points`, `issues`, `feedback`, etc.) in `orchestrator.db`.
2. Tool handlers switch from reading `system_monitor.db` to reading own store.
3. One-time migration script copies historical rows.
4. `system_monitor.db` retires.

Dashboard sees identical responses throughout. This is exactly the pattern used by memory-core (filesystem-backed wiki accessed through MCP tools).

## What the dashboard becomes after migration

```typescript
// packages/services/dashboard/src/server/routes.ts
// Total: ~200 lines for all 25 routes. No SQLite. No leakage points.

app.get("/api/goals", async (_req, res) => {
  const summary = await brain.metric.summary({});
  res.json(toGoalsResponse(summary));   // pure transform, 100% testable
});

app.get("/api/cron-runs/summary", async (req, res) => {
  const days = parseIntOr(req.query.days, 30);
  const out = await brain.cron.summary({ since: daysAgo(days) });
  res.json(toCronSummary(out));
});

app.get("/api/issues/summary", async (_req, res) => {
  res.json(await brain.issue.summary({}));
});

// ... 22 more routes of the same shape
```

`db.ts` does not exist. The two external-SSD path leakage points in the legacy file evaporate along with the file. Tests are mock-the-brain-client; coverage is mechanical.

## Sequencing implications

This decision **reverses the original phase order**. The new sequence:

| Order | Phase | Why this order |
|---|---|---|
| 1 | Phase 0 (scaffold) ✅ | foundations |
| 2 | Phase 1 (brain-mcp-proxy) ✅ | unlocks all client testing |
| 3 | Phase 3 (brain-orchestrator extraction + add new tool families) | dashboard depends on these tools existing |
| 4 | Phase 2 finish (dashboard as brain-only consumer) | builds on Phase 3's tool surface |
| 5 | Phase 4 (dream-cycle) | independent |
| 6 | Phase 5 (runtime adapters) | independent |
| 7 | Phase 6 (CLI) | wires everything up |
| 8 | Phase 7 (private data repo) | content move |
| 9 | Phase 8.5 (dogfood validation) | full-stack parity |
| 10 | Phase 8 (publish) | ship |

Phases 2 and 3 effectively swap. The dashboard becomes the *first consumer* of the new brain tools and validates them in a real workload.

## Open questions to resolve before implementation

1. **Goal config: code-side or data-side?** The 6 `GOAL_CONFIGS` in current `db.ts` are hardcoded TS constants (knowledge / validation / operation / evaluation / team_health / personal_learning, plus thresholds). Two reasonable homes:
   - (a) Brain-orchestrator's plugin config (user-defined; `metric.goal_config` writes them).
   - (b) digital-me-data's `config.yaml` (loaded at startup; goal definitions are user taxonomy).
   - **Recommend (b)** — goals are part of the user's operating model, not the brain's. Config-driven, ships an empty example, users customize. This matches the "no agent IDs / domains baked in" sanitization rule.

2. **Sub-metric breakdowns: keep JSON blob or normalize?** Current schema stores `breakdown` as a JSON string in `goal_metrics.breakdown`. For brain-orchestrator's own storage, we could normalize into a `metric_breakdowns` table or keep the JSON blob.
   - **Recommend: keep JSON blob.** Breakdown shape varies per metric and is opaque to the query layer. Normalizing buys nothing.

3. **Reporter / source name labels.** `db.ts` has hardcoded `REPORTER_LABELS` and `AGENT_LABELS` maps that translate raw IDs to display names (`jing_modal` → "Owner", `cto` → "CTO", etc.). These are pure presentation.
   - **Recommend:** brain tools return raw IDs only. Dashboard owns the label mapping, and that mapping is config-driven (loaded from `digital-me-data/config.yaml`). Sanitization win: no personal labels in public code.

4. **Backward-compatibility of `system_monitor.db` reads during transition.** The current dashboard runs on system_monitor.db. The new dashboard hits brain tools that passthrough to system_monitor.db. Both keep running until cutover.
   - **Recommend:** No DB-level dual-write needed. Same store, two readers (old dashboard direct, new dashboard via brain). When brain-orchestrator's own storage takes over, only brain-orchestrator writes; system_monitor.db retires.

## Net summary

| Before this decision | After |
|---|---|
| db.ts (1998 LOC) gets extracted with sanitization | db.ts gets **deleted entirely** |
| Two SQLite stores (orchestrator.db + system_monitor.db) | One canonical operational store (brain-orchestrator's) |
| Dashboard tightly coupled to local SQLite paths | Dashboard talks only HTTP MCP — deployable anywhere |
| `goal_metrics`, `issues`, `feedback`, `insights`, `cron_runs` are orphaned tables | They live behind brain MCP tools, registered & versioned |
| Custom plugin metrics: not visible in dashboard | Custom plugin metrics: auto-visible via `metric.record` |
| Phase 2 estimate: 2000+ lines of test code | Phase 2 estimate: a few hundred lines of transform tests |
| Phase order: 2 → 3 | Phase order: 3 (extended) → 2 |
