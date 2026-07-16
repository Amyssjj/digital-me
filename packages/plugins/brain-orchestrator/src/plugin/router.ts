/**
 * Action router for the `tasks` MCP tool — port of upstream
 * `buildTasksTool.execute()` switch, minus the openclaw plugin SDK
 * envelope. The plugin entry (Phase 3 final step) wraps this router with
 * the openclaw tool schema + content[] adapter.
 *
 * Keeping the router runtime-agnostic means:
 *   - The router is unit-testable in isolation (no openclaw, no MCP).
 *   - Non-openclaw consumers (dream-cycle worker, custom CLIs) can call
 *     into the same routing logic directly.
 *   - The openclaw plugin entry stays thin — just schema definition and
 *     a one-liner that calls this router.
 *
 * Open-source delta from upstream: NO `plan_goal` LLM-advisor handler.
 * That capability is runtime-specific (depends on the model gateway) and
 * belongs in the runtime adapter (Phase 5).
 */

import {
  addSchedule,
  formatSchedulesList,
  removeSchedule,
  setScheduleEnabled,
  type AddScheduleResult,
  type RemoveScheduleResult,
  type ToggleScheduleResult,
} from "../handlers/schedule-admin.js";
import {
  approveTask,
  cancelGoal,
  claimTask,
  completeTask,
  recordCheckpoint,
  recordHandoff,
  rejectTask,
  type TransitionResult,
} from "../handlers/resolver-status.js";
import { formatBoard, formatTaskDetail } from "../handlers/board.js";
import {
  createGoalFromPlan,
  type CreateGoalFromPlanResult,
  type TaskPlanItem,
} from "../handlers/goal-create.js";
import {
  importWorkflowFromJson,
  type BuilderResult,
} from "../handlers/workflow-builder.js";
import {
  instantiateWorkflow,
  type InstantiateWorkflowResult,
} from "../handlers/workflow-instantiate.js";
import {
  tick,
  type Dispatcher,
  type SchedulerRuntime,
  type TickResult,
} from "../handlers/scheduler.js";
import type { GoalsStore, Originator } from "../store/goals.js";
import type {
  OrchestratorTaskRecord,
  TaskCheckpointRecord,
  TaskOutputRecord,
  TasksStore,
} from "../store/tasks.js";
import type { WorkflowsStore } from "../store/workflows.js";
import type { SchedulesStore } from "../store/schedules.js";
import type { DatabaseSync } from "node:sqlite";

export type RouterDeps = {
  readonly db: DatabaseSync;
  readonly goals: GoalsStore;
  readonly tasks: TasksStore;
  readonly workflows: WorkflowsStore;
  readonly schedules: SchedulesStore;
  readonly runtime: SchedulerRuntime;
  readonly dispatcher: Dispatcher;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Default ms threshold for the stall watchdog on `schedule_tick`. */
  readonly defaultStallThresholdMs?: number;
  /** Caller's originator (e.g. the user who fired the MCP call). Passed
   *  through to goal creation paths. */
  readonly originator?: Originator;
};

export type RouterResult = {
  readonly ok: boolean;
  readonly text: string;
  /** Structured payload for `format=json` callers (board, status, etc). */
  readonly json?: unknown;
};

export const TASKS_ACTIONS = [
  "run_goal",
  "run_workflow",
  "board",
  "status",
  "checkpoint",
  "handoff",
  "approve",
  "reject",
  "cancel",
  "claim",
  "complete",
  "schedule_add",
  "schedule_list",
  "schedule_remove",
  "schedule_enable",
  "schedule_disable",
  "schedule_tick",
  "workflow_import",
  "workflow_list",
  "workflow_delete",
] as const;

export type TasksAction = (typeof TASKS_ACTIONS)[number];

// ── Entry point ────────────────────────────────────────────────────────────

export async function dispatchAction(
  deps: RouterDeps,
  action: string,
  params: Readonly<Record<string, unknown>>,
): Promise<RouterResult> {
  const json = params.format === "json";
  switch (action) {
    case "run_goal":
      return await handleRunGoal(deps, params);
    case "run_workflow":
      return await handleRunWorkflow(deps, params);
    case "board":
      return json ? handleBoardJson(deps, params) : handleBoardMarkdown(deps);
    case "status":
      return json ? handleStatusJson(deps, params) : handleStatusMarkdown(deps, params);
    case "checkpoint":
      return handleCheckpoint(deps, params);
    case "handoff":
      return handleHandoff(deps, params);
    case "approve":
      return fromTransition(approveTask(deps, asString(params.taskId)));
    case "reject":
      return fromTransition(
        rejectTask(deps, asString(params.taskId), asOptString(params.reason)),
      );
    case "cancel":
      return fromTransition(cancelGoal(deps, asString(params.goalId)));
    case "claim":
      return fromTransition(claimTask(deps, asString(params.taskId)));
    case "complete":
      return fromTransition(completeTask(deps, asString(params.taskId)));
    case "schedule_add":
      return handleScheduleAdd(deps, params);
    case "schedule_list":
      return json ? handleScheduleListJson(deps) : handleScheduleListMarkdown(deps);
    case "schedule_remove":
      return fromRemoveSchedule(
        removeSchedule(deps, asString(params.scheduleId)),
      );
    case "schedule_enable":
      return fromToggleSchedule(
        setScheduleEnabled(deps, asString(params.scheduleId), true),
      );
    case "schedule_disable":
      return fromToggleSchedule(
        setScheduleEnabled(deps, asString(params.scheduleId), false),
      );
    case "schedule_tick":
      return await handleScheduleTick(deps);
    case "workflow_import":
      return fromBuilder(
        importWorkflowFromJson(
          { ...deps, defaultDispatchAgentId: undefined },
          asString(params.workflowJson),
        ),
      );
    case "workflow_list":
      return json ? handleWorkflowListJson(deps) : handleWorkflowListMarkdown(deps);
    case "workflow_delete":
      return handleWorkflowDelete(deps, params);
    default:
      return { ok: false, text: `Unknown action: ${action}` };
  }
}

// ── Action handlers ───────────────────────────────────────────────────────

async function handleRunGoal(
  deps: RouterDeps,
  params: Readonly<Record<string, unknown>>,
): Promise<RouterResult> {
  const description = asOptString(params.description);
  if (!description) {
    return { ok: false, text: "Missing description for run_goal." };
  }
  const rawTasks = params.tasks;
  if (!rawTasks) {
    return {
      ok: false,
      text: "Missing tasks parameter. Provide a JSON array of task plan items.",
    };
  }
  let taskPlans: TaskPlanItem[];
  try {
    taskPlans =
      typeof rawTasks === "string"
        ? (JSON.parse(rawTasks) as TaskPlanItem[])
        : (rawTasks as TaskPlanItem[]);
  } catch {
    return { ok: false, text: "Invalid JSON in tasks parameter." };
  }
  const result = await createGoalFromPlan(
    deps,
    description,
    taskPlans,
    {
      parentGoalId: asOptString(params.parentGoalId),
      originator: deps.originator,
    },
  );
  if (!result.ok) {
    return { ok: false, text: result.error };
  }
  // Dispatch ready tasks. We don't fail the whole call if dispatching
  // throws — the goal is still created and the scheduler will pick up
  // the ready tasks on the next tick.
  let dispatched = 0;
  for (const taskId of result.readyTaskIds) {
    const task = deps.tasks.get(taskId);
    if (!task) continue;
    if (task.dispatch.mode !== "spawn" && task.dispatch.mode !== "exec") {
      continue;
    }
    try {
      const ok =
        task.dispatch.mode === "exec"
          ? await deps.dispatcher.dispatchExecTask(task)
          : await deps.dispatcher.dispatchSpawnTask(task);
      if (ok) dispatched++;
    } catch {
      // Best-effort — let the scheduler pick this up.
    }
  }
  return {
    ok: true,
    text: `Goal "${result.goalName}" created with ${result.taskCount} tasks. ${dispatched} dispatched.`,
    json: { goalId: result.goalId, taskCount: result.taskCount, dispatched },
  };
}

async function handleRunWorkflow(
  deps: RouterDeps,
  params: Readonly<Record<string, unknown>>,
): Promise<RouterResult> {
  const templateId = asOptString(params.templateId);
  if (!templateId) {
    return { ok: false, text: "Missing templateId for run_workflow." };
  }
  const rawVars = params.variables;
  let variables: Record<string, string> = {};
  if (rawVars) {
    if (typeof rawVars === "string") {
      try {
        variables = JSON.parse(rawVars) as Record<string, string>;
      } catch {
        return { ok: false, text: "Invalid JSON in variables parameter." };
      }
    } else if (typeof rawVars === "object") {
      variables = rawVars as Record<string, string>;
    }
  }
  const result = await instantiateWorkflow(deps, {
    templateId,
    variables,
    force: params.force === true,
    originator: deps.originator,
  });
  if (!result.ok) {
    return { ok: false, text: result.error };
  }
  let dispatched = 0;
  for (const taskId of result.readyTaskIds) {
    const task = deps.tasks.get(taskId);
    if (!task) continue;
    if (task.dispatch.mode !== "spawn" && task.dispatch.mode !== "exec") {
      continue;
    }
    try {
      const ok =
        task.dispatch.mode === "exec"
          ? await deps.dispatcher.dispatchExecTask(task)
          : await deps.dispatcher.dispatchSpawnTask(task);
      if (ok) dispatched++;
    } catch {
      // Scheduler will pick up.
    }
  }
  return {
    ok: true,
    text: `Goal "${result.goalName}" created from workflow "${templateId}". ${result.taskCount} tasks, ${dispatched} dispatched.`,
    json: { goalId: result.goalId, taskCount: result.taskCount, dispatched },
  };
}

function handleBoardMarkdown(deps: RouterDeps): RouterResult {
  const goals = deps.goals.listActive();
  return {
    ok: true,
    text: formatBoard({ tasks: deps.tasks, now: deps.now }, goals),
  };
}

function handleBoardJson(
  deps: RouterDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const now = (deps.now ?? Date.now)();
  const sinceMs =
    typeof params.since === "number"
      ? params.since
      : now - 7 * 24 * 60 * 60 * 1000;
  const filtered = deps.goals.listAll().filter((g) => {
    if (g.type === "evergreen") return false;
    if (g.status === "completed") {
      return (g.completedAt ?? g.updatedAt) >= sinceMs;
    }
    // failed and cancelled are terminal too — without the window, every
    // failed goal ever accumulates into the payload forever (1k+ goals in
    // the 2026-07 oversize incident that crashed MCP clients).
    if (g.status === "cancelled" || g.status === "failed") {
      return g.updatedAt >= sinceMs;
    }
    return true;
  });
  // Optional bound for MCP-agent callers: most recently updated N goals.
  // The dashboard omits it and keeps the full window.
  const limit =
    typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0
      ? params.limit
      : undefined;
  const bounded =
    limit !== undefined && filtered.length > limit
      ? [...filtered].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
      : filtered;
  const payload = bounded.map((g) => ({
    ...g,
    tasks: deps.tasks.listForGoal(g.id),
  }));
  return {
    ok: true,
    text: JSON.stringify({ goals: payload }),
    json: { goals: payload },
  };
}

function handleStatusMarkdown(
  deps: RouterDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const taskId = asOptString(params.taskId);
  if (!taskId) {
    return { ok: false, text: "Missing taskId for status action." };
  }
  const task = lookupTask(deps, taskId);
  if (!task) {
    return { ok: false, text: `Task "${taskId}" not found.` };
  }
  return { ok: true, text: formatTaskDetail(task) };
}

function handleStatusJson(
  deps: RouterDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const taskId = asOptString(params.taskId);
  if (!taskId) {
    return {
      ok: false,
      text: JSON.stringify({ task: null, error: "Missing taskId for status action." }),
      json: { task: null, error: "Missing taskId for status action." },
    };
  }
  const task = lookupTask(deps, taskId);
  if (!task) {
    return {
      ok: false,
      text: JSON.stringify({ task: null, error: `Task "${taskId}" not found.` }),
      json: { task: null, error: `Task "${taskId}" not found.` },
    };
  }
  return { ok: true, text: JSON.stringify({ task }), json: { task } };
}

function handleCheckpoint(
  deps: RouterDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const taskId = asOptString(params.taskId);
  if (!taskId) {
    return { ok: false, text: "Missing taskId for checkpoint action." };
  }
  const phase = asOptString(params.phase);
  const summary = asOptString(params.summary);
  if (!phase || !summary) {
    return {
      ok: false,
      text: "checkpoint requires both phase and summary.",
    };
  }
  const task = lookupTask(deps, taskId);
  if (!task) {
    return { ok: false, text: `Task "${taskId}" not found.` };
  }
  const now = (deps.now ?? Date.now)();
  const checkpoint: TaskCheckpointRecord = {
    checkpointAt: now,
    phase,
    summary,
    artifactPaths: parseArtifactPaths(params.artifactPaths),
    progressPercent:
      typeof params.progressPercent === "number"
        ? params.progressPercent
        : undefined,
    blocker: asOptString(params.blocker),
    recommendedNextStep: asOptString(params.recommendedNextStep),
  };
  const ok = recordCheckpoint(deps, task.id, checkpoint);
  if (!ok) {
    return {
      ok: false,
      text: `Cannot checkpoint task "${task.name}" — not in a checkpoint-accepting status (${task.status}).`,
    };
  }
  return { ok: true, text: `Checkpoint recorded for "${task.name}".` };
}

function handleHandoff(
  deps: RouterDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const taskId = asOptString(params.taskId);
  if (!taskId) {
    return { ok: false, text: "Missing taskId for handoff action." };
  }
  const summary = asOptString(params.summary);
  const deliverableState = asOptString(params.deliverableState);
  if (!summary || !deliverableState) {
    return {
      ok: false,
      text: "handoff requires both summary and deliverableState (complete | partial).",
    };
  }
  if (deliverableState !== "complete" && deliverableState !== "partial") {
    return {
      ok: false,
      text: `Invalid deliverableState "${deliverableState}". Must be "complete" or "partial".`,
    };
  }
  const task = lookupTask(deps, taskId);
  if (!task) {
    return { ok: false, text: `Task "${taskId}" not found.` };
  }
  const output: TaskOutputRecord = {
    deliverableState: deliverableState as "complete" | "partial",
    summary,
    artifactPaths: parseArtifactPaths(params.artifactPaths),
    recommendedNextStep: asOptString(params.recommendedNextStep),
  };
  const ok = recordHandoff(deps, task.id, output);
  if (!ok) {
    return {
      ok: false,
      text: `Cannot handoff task "${task.name}" — not in a handoff-accepting status (${task.status}).`,
    };
  }
  return { ok: true, text: `Handoff recorded for "${task.name}".` };
}

function handleScheduleAdd(
  deps: RouterDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const workflowId = asOptString(params.templateId);
  if (!workflowId) {
    return { ok: false, text: "Missing templateId for schedule_add." };
  }
  const cronExpr = asOptString(params.cronExpr);
  if (!cronExpr) {
    return { ok: false, text: "Missing cronExpr for schedule_add." };
  }
  const rawVars = params.variables;
  let variables: Record<string, string> = {};
  if (rawVars) {
    if (typeof rawVars === "string") {
      try {
        variables = JSON.parse(rawVars) as Record<string, string>;
      } catch {
        return { ok: false, text: "Invalid JSON in variables parameter." };
      }
    } else if (typeof rawVars === "object") {
      variables = rawVars as Record<string, string>;
    }
  }
  return fromAddSchedule(
    addSchedule(
      deps,
      {
        workflowId,
        name: asOptString(params.scheduleName),
        cronExpr,
        timezone: asOptString(params.timezone),
        variables,
      },
      (id) => !!deps.workflows.get(id),
    ),
  );
}

function handleScheduleListMarkdown(deps: RouterDeps): RouterResult {
  return { ok: true, text: formatSchedulesList(deps.schedules.listAll()) };
}

function handleScheduleListJson(deps: RouterDeps): RouterResult {
  const schedules = deps.schedules.listAll();
  return {
    ok: true,
    text: JSON.stringify({ schedules }),
    json: { schedules },
  };
}

async function handleScheduleTick(deps: RouterDeps): Promise<RouterResult> {
  const result: TickResult = await tick(
    {
      goals: deps.goals,
      schedules: deps.schedules,
      tasks: deps.tasks,
      workflows: deps.workflows,
      runtime: deps.runtime,
      dispatcher: deps.dispatcher,
      instantiateWorkflow: async (workflowId, vars) => {
        const r = await instantiateWorkflow(deps, {
          templateId: workflowId,
          variables: vars,
          origin: "schedule",
        });
        if (!r.ok) return { ok: false, error: r.error };
        let dispatched = 0;
        for (const taskId of r.readyTaskIds) {
          const task = deps.tasks.get(taskId);
          if (!task) continue;
          if (task.dispatch.mode !== "spawn" && task.dispatch.mode !== "exec") {
            continue;
          }
          try {
            const ok =
              task.dispatch.mode === "exec"
                ? await deps.dispatcher.dispatchExecTask(task)
                : await deps.dispatcher.dispatchSpawnTask(task);
            if (ok) dispatched++;
          } catch {
            // Scheduler will pick up.
          }
        }
        return {
          ok: true,
          goalId: r.goalId,
          taskCount: r.taskCount,
          dispatched,
        };
      },
      now: deps.now,
    },
    deps.defaultStallThresholdMs ?? 3_600_000,
  );
  const parts = ["Tick complete."];
  if (result.reconciled > 0) {
    parts.push(`Reconciled ${result.reconciled} stale tasks.`);
  }
  if (result.dependenciesReconciled > 0) {
    parts.push(
      `Reconciled ${result.dependenciesReconciled} completed dependency blockers.`,
    );
  }
  if (result.statusRefreshed > 0) {
    parts.push(`Refreshed ${result.statusRefreshed} schedule statuses.`);
  }
  if (result.scanned > 0) {
    parts.push(
      `Scanned ${result.scanned} due schedules: ${result.instantiated} instantiated, ${result.skipped} skipped, ${result.errors} errors.`,
    );
  } else {
    parts.push("No schedules due.");
  }
  return {
    ok: true,
    text: parts.join(" "),
    json: result,
  };
}

function handleWorkflowListMarkdown(deps: RouterDeps): RouterResult {
  const workflows = deps.workflows.listAll();
  if (workflows.length === 0) {
    return { ok: true, text: "No workflow templates." };
  }
  const lines = workflows.map((w) => {
    const steps = deps.workflows.listSteps(w.id);
    const varNames =
      w.variables.length > 0
        ? ` [${w.variables.map((v) => `{{${v.name}}}`).join(", ")}]`
        : "";
    const guidedSteps = steps.filter(
      (s) => s.guidance && s.guidance.length > 0,
    ).length;
    const guidanceNote =
      guidedSteps > 0 ? `, ${guidedSteps} with guidance` : "";
    return `- **${w.id}** — ${w.name} (v${w.version}, ${steps.length} steps${guidanceNote})${varNames}`;
  });
  return {
    ok: true,
    text: ["## Workflow Templates", "", ...lines].join("\n"),
  };
}

function handleWorkflowListJson(deps: RouterDeps): RouterResult {
  const templates = deps.workflows.listAll().map((w) => ({
    ...w,
    steps: deps.workflows.listSteps(w.id),
  }));
  return {
    ok: true,
    text: JSON.stringify({ templates }),
    json: { templates },
  };
}

function handleWorkflowDelete(
  deps: RouterDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const templateId = asOptString(params.templateId);
  if (!templateId) {
    return { ok: false, text: "Missing templateId for workflow_delete." };
  }
  // Block if any enabled schedule references this workflow.
  const blockingSchedule = deps.schedules
    .listAll()
    .find((s) => s.workflowId === templateId && s.enabled);
  if (blockingSchedule) {
    return {
      ok: false,
      text:
        `Cannot delete: workflow "${templateId}" is referenced by active schedule ` +
        `"${blockingSchedule.name}". Disable or remove the schedule first.`,
    };
  }
  const deleted = deps.workflows.delete(templateId);
  return deleted
    ? { ok: true, text: `Workflow "${templateId}" deleted.` }
    : { ok: false, text: `Workflow "${templateId}" not found.` };
}

// ── Result envelope adapters ──────────────────────────────────────────────

function fromTransition(r: TransitionResult): RouterResult {
  return r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error };
}

function fromBuilder(r: BuilderResult): RouterResult {
  return r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error };
}

function fromAddSchedule(r: AddScheduleResult): RouterResult {
  return r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error };
}

function fromRemoveSchedule(r: RemoveScheduleResult): RouterResult {
  return r.ok
    ? { ok: true, text: `Schedule "${r.removed}" removed.` }
    : { ok: false, text: r.error };
}

function fromToggleSchedule(r: ToggleScheduleResult): RouterResult {
  return r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asOptString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseArtifactPaths(v: unknown): readonly string[] | undefined {
  // Array shape — native MCP callers pass a decoded JSON array. Previously
  // dropped (only the comma-string branch existed), silently losing artifact
  // paths on checkpoint/handoff.
  if (Array.isArray(v)) {
    const out = v.map((x) => String(x).trim()).filter((s) => s.length > 0);
    return out.length > 0 ? out : undefined;
  }
  // Comma-string shape — OpenClaw passes a single delimited string.
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function lookupTask(
  deps: Pick<RouterDeps, "tasks">,
  idOrName: string,
): OrchestratorTaskRecord | undefined {
  return deps.tasks.get(idOrName) ?? deps.tasks.findByName(idOrName);
}

// Re-export so callers don't need to dig into nested types for typing.
export type {
  CreateGoalFromPlanResult,
  InstantiateWorkflowResult,
};
