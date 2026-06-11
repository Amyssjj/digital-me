# brain-orchestrator plugin entry — design doc

Status: design (Phase 3 final step, deferred to the next session).

## What this is

The pure business logic for the orchestrator is fully ported and tested
(see `src/handlers/*`). What's left is the **openclaw plugin entry** —
a thin adapter that:

1. Defines openclaw plugin tools (MCP-shaped) and wires their `execute`
   callbacks to the pure handlers under `src/handlers/`.
2. Implements the `Dispatcher` interface (defined in
   `src/handlers/scheduler.ts`) using openclaw's `runtime.subagent.spawn`
   and a child-process exec path.
3. Implements the `WorkflowInstantiator` callback (used by the scheduler
   tick) as a composition of `instantiateWorkflow` + dispatching the
   resulting ready tasks via the Dispatcher.
4. Registers the schedule tick on a `cron` lane (or on the periodic-
   wakeup hook openclaw exposes).

Living under `src/plugin-entry.ts` (or similar). Imports openclaw plugin
SDK via the existing `openclaw-compat/` seam (do NOT pull `openclaw/*`
directly — the compat seam is the only allowed touchpoint).

## Why it lives in this package (not separately)

The plugin entry IS this package's openclaw shape. Splitting it into a
separate `@digital-me/brain-orchestrator-openclaw-plugin` would force
two-package coordination for what's logically one runtime. The plugin
entry compiles only when openclaw's plugin-sdk is available; downstream
embeddings that don't want openclaw can import from `./handlers/*`
without ever loading the entry.

## Tool inventory (the 22 sub-actions of `tasks`)

These wrap the pure handlers. Each entry below is `action → handler`:

| Action | Handler |
|---|---|
| `run_goal` | `createGoalFromPlan` then dispatch ready tasks via Dispatcher |
| `plan_goal` | LLM advisor — out of scope for the orchestrator port; lives in runtime adapter (Phase 5) |
| `run_workflow` | `instantiateWorkflow` then dispatch ready tasks via Dispatcher |
| `board` | `formatBoard({ tasks }, goals.listActive())` |
| `board_json` | JSON serialization of `goals.listAll()` filtered by `since` window |
| `status` | `formatTaskDetail(tasks.get(id) ?? tasks.findByName(id))` |
| `status_json` | JSON wrapping of the same lookup |
| `checkpoint` | `recordCheckpoint(deps, taskId, checkpoint)` |
| `handoff` | `recordHandoff(deps, taskId, output)` |
| `approve` | `approveTask(deps, taskId)` |
| `reject` | `rejectTask(deps, taskId, reason)` |
| `retry` | runtime-adapter concern (Phase 5) — calls resolver-status `claimTask` + Dispatcher |
| `cancel` | `cancelGoal(deps, goalId)` |
| `claim` | `claimTask(deps, taskId)` |
| `complete` | `completeTask(deps, taskId)` |
| `schedule_add` | `addSchedule(deps, input, (id) => !!workflows.get(id))` |
| `schedule_list` | `formatSchedulesList(schedules.listAll())` |
| `schedule_remove` | `removeSchedule(deps, idOrName)` |
| `schedule_enable` | `setScheduleEnabled(deps, idOrName, true)` |
| `schedule_disable` | `setScheduleEnabled(deps, idOrName, false)` |
| `schedule_tick` | `tick(schedulerDeps, defaultStallThresholdMs)` |
| `workflow_import` | `importWorkflowFromJson(workflowBuilderDeps, json)` |
| `workflow_list` | iterate `workflows.listAll()` + format |
| `workflow_delete` | check active schedules first; then `workflows.delete(id)` |

The standalone tools (separate from `tasks`):

- `agent_identify` → `identifyAgent`
- `learning_capture` → `captureLearning`
- `traces_record` → `recordTrace`
- `traces_query` → `queryTraces`

## Dispatcher implementation (Phase 5 territory)

The scheduler's `Dispatcher` interface is:

```ts
type Dispatcher = {
  dispatchSpawnTask(task: OrchestratorTaskRecord): Promise<boolean>;
  dispatchExecTask(task: OrchestratorTaskRecord): Promise<boolean>;
  probeSessionLiveness(): Promise<readonly OrchestratorTaskRecord[]>;
};
```

The openclaw-flavored implementation:

- **spawn**: call `runtime.subagent.spawn({ agentId, prompt, model, thinking })`
  via the openclaw-compat gateway-scope hack; on success, record the
  attempt + runId via `tasks.createAttempt`.
- **exec**: shell out via `execFile` (claude/codex CLI), gate on the
  approval flow.
- **probeSessionLiveness**: list running tasks, ask the subagent runtime
  for status, finalize stalls.

## What NOT to do at plugin entry

- Don't add typebox or zod as a brain-orchestrator dep. Use openclaw's
  re-exported schema helpers via the plugin-sdk seam.
- Don't hardcode agent ids. Pass them via plugin config or fail the
  handler clearly when the workflow author omitted them.
- Don't bake owner-specific defaults (timezones, repo paths, CLI shapes)
  into the entry — those live in the user's config or in `digital-me-cli`
  (Phase 6).
- Don't import from upstream `task-orchestrator/*`. The seam is
  `openclaw/plugin-sdk/*` only.

## Recipe for the next session

1. Create `src/plugin-entry.ts`.
2. Define a `BrainOrchestratorRuntime` type that bundles the deps:
   `{ db, goals, tasks, workflows, schedules, agents, learnings, traces,
   runtime, dispatcher }`.
3. Define the `tasks` tool as a `Type.Object({ action, params })` with a
   switch that routes to the right handler. Return `{ content: [{ type:
   "text", text: handlerResult.message }], isError: !handlerResult.ok }`.
4. Define `agent_identify`, `learning_capture`, `traces_record`,
   `traces_query` as separate tools.
5. Register the scheduler tick under whatever periodic-wake mechanism
   openclaw exposes. The Dispatcher is provided by the user (or by a
   runtime adapter from Phase 5).
6. Add a small smoke test that constructs the plugin, calls one tool
   per action, and verifies the side-effects in a sqlite tempdir.

## Why the split is sound

Every handler in `src/handlers/*` is unit-tested at 100% coverage
without the plugin SDK. The plugin entry is small (just routing +
schema), so its test surface is also small — one smoke test per tool
covers the wiring. This keeps the heavy verification close to the
business logic and the openclaw-specific surface easy to refactor when
the SDK shape changes (the upstream-adaptation constraint).
