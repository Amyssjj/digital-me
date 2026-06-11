/**
 * Workflow-template builder handlers — pure business logic for the three
 * ways a workflow template gets into the store:
 *
 *   1. `saveGoalAsWorkflow` — snapshot an existing goal's tasks into a
 *      reusable template. Used by the dashboard's "save as workflow" button.
 *   2. `createWorkflowFromSteps` — typed step records (machine-authored).
 *   3. `importWorkflowFromJson` — JSON definition (file-authored).
 *
 * Result shape is `{ ok: boolean, message?: string, error?: string }` so
 * the MCP envelope can translate to its content[] without re-deriving
 * success/failure from a string parse.
 *
 * Open-source delta from upstream: NO hardcoded `agentId: "main"` default.
 * Workflow authors must specify the dispatch agent. If they omit it,
 * `defaultDispatchAgentId` (an optional caller dep) supplies a fallback;
 * otherwise the build fails validation. This honors the "no predefined
 * agent names" constraint.
 */

import { randomUUID } from "node:crypto";
import type { GoalsStore, Originator } from "../store/goals.js";
import type { TasksStore, TaskDispatch, TaskPriority, UpstreamFailurePolicy } from "../store/tasks.js";
import type {
  WorkflowBranchingPolicy,
  WorkflowStepTemplateRecord,
  WorkflowTemplateRecord,
  WorkflowVariable,
  WorkflowsStore,
} from "../store/workflows.js";
import type { DatabaseSync } from "node:sqlite";

export type WorkflowBuilderDeps = {
  readonly db: DatabaseSync;
  readonly goals: GoalsStore;
  readonly tasks: TasksStore;
  readonly workflows: WorkflowsStore;
  readonly now?: () => number;
  readonly newId?: () => string;
  /**
   * Fallback dispatch agent for steps that omit one. Unset means "fail
   * validation when dispatch is missing" — the open-source default.
   */
  readonly defaultDispatchAgentId?: string;
};

export type BuilderResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: string };

// ── saveGoalAsWorkflow ────────────────────────────────────────────────────

export function saveGoalAsWorkflow(
  deps: WorkflowBuilderDeps,
  workflowId: string,
  goalId: string,
): BuilderResult {
  const goal = deps.goals.get(goalId);
  if (!goal) {
    return { ok: false, error: `Goal "${goalId}" not found.` };
  }
  const tasks = deps.tasks.listForGoal(goalId);
  if (tasks.length === 0) {
    return { ok: false, error: "Goal has no tasks to save." };
  }
  const existing = deps.workflows.get(workflowId);
  if (existing) {
    return {
      ok: false,
      error: `Workflow "${workflowId}" already exists. Delete it first or choose a different ID.`,
    };
  }

  const now = (deps.now ?? Date.now)();
  const newId = deps.newId ?? randomUUID;
  const template: WorkflowTemplateRecord = {
    id: workflowId,
    name: goal.name,
    description: goal.description,
    variables: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
    tags: [],
  };

  const taskIdToKey = new Map<string, string>();
  for (const task of tasks) {
    const key = task.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    taskIdToKey.set(task.id, key || `step-${task.id.slice(0, 8)}`);
  }

  // Validate every blockedBy id resolves to a sibling task. Previously the
  // map+filter inside the transaction silently dropped unknown references
  // (e.g. orphan ids from a cleanup race), turning a sequenced snapshot into
  // a parallel one with no signal — same shape as the bug
  // validateStepDependencies guards against for createWorkflowFromSteps.
  for (const task of tasks) {
    for (const blockerId of task.blockedBy) {
      if (!taskIdToKey.has(blockerId)) {
        return {
          ok: false,
          error: `Task "${task.name}" references unknown blockedBy id "${blockerId}" which is not in the goal's task list.`,
        };
      }
    }
  }

  try {
    runInTransaction(deps.db, () => {
      deps.workflows.create(template);
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]!;
        const stepKey = taskIdToKey.get(task.id)!;
        const blockedByKeys = task.blockedBy
          .map((id) => taskIdToKey.get(id))
          .filter((key): key is string => key !== undefined);
        const step: WorkflowStepTemplateRecord = {
          id: newId(),
          workflowId,
          stepKey,
          name: task.name,
          promptTemplate: task.task,
          blockedByKeys,
          dispatch: task.dispatch,
          priority: task.priority,
          retryPolicy: task.retryPolicy,
          onUpstreamFailure: task.onUpstreamFailure,
          sortOrder: i,
          guidance: task.guidance,
          timeoutMs: task.timeoutMs,
        };
        deps.workflows.createStep(step);
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to save workflow "${workflowId}": ${msg}` };
  }

  return {
    ok: true,
    message: `Workflow "${workflowId}" saved with ${tasks.length} steps from goal "${goal.name}".`,
  };
}

// ── createWorkflowFromSteps ───────────────────────────────────────────────

export type StepInput = {
  readonly stepKey: string;
  readonly name: string;
  readonly promptTemplate: string;
  readonly blockedByKeys: readonly string[];
  readonly dispatch?: TaskDispatch;
  readonly priority?: TaskPriority;
  readonly retryPolicy?: "manual_only" | "auto_once";
  readonly onUpstreamFailure?: UpstreamFailurePolicy;
  readonly sortOrder?: number;
  readonly guidance?: readonly string[];
  readonly timeoutMs?: number;
};

export function createWorkflowFromSteps(
  deps: WorkflowBuilderDeps,
  workflowId: string,
  name: string,
  description: string,
  variables: readonly WorkflowVariable[],
  steps: readonly StepInput[],
  branching?: WorkflowBranchingPolicy,
  notifyTarget?: Originator,
): BuilderResult {
  const existing = deps.workflows.get(workflowId);
  if (existing) {
    return { ok: false, error: `Workflow "${workflowId}" already exists.` };
  }
  if (steps.length === 0) {
    return { ok: false, error: "Workflow must have at least one step." };
  }
  const validation = validateStepDependencies(steps);
  if (!validation.ok) return validation;

  const normalized: WorkflowStepTemplateRecord[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const dispatch = resolveDispatch(s.dispatch, deps.defaultDispatchAgentId);
    if (!dispatch.ok) {
      return {
        ok: false,
        error: `Step "${s.stepKey}": ${dispatch.error}`,
      };
    }
    normalized.push({
      id: (deps.newId ?? randomUUID)(),
      workflowId,
      stepKey: s.stepKey,
      name: s.name,
      promptTemplate: s.promptTemplate,
      blockedByKeys: s.blockedByKeys,
      dispatch: dispatch.value,
      priority: s.priority ?? "normal",
      retryPolicy: s.retryPolicy,
      onUpstreamFailure: s.onUpstreamFailure ?? "wait",
      sortOrder: s.sortOrder ?? i,
      guidance: s.guidance,
      timeoutMs: s.timeoutMs,
    });
  }

  const now = (deps.now ?? Date.now)();
  const template: WorkflowTemplateRecord = {
    id: workflowId,
    name,
    description,
    variables,
    createdAt: now,
    updatedAt: now,
    version: 1,
    tags: [],
    branching,
    notifyTarget,
  };

  try {
    runInTransaction(deps.db, () => {
      deps.workflows.create(template);
      for (const step of normalized) deps.workflows.createStep(step);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to create workflow "${workflowId}": ${msg}`,
    };
  }

  return {
    ok: true,
    message: `Workflow "${workflowId}" created with ${steps.length} steps.`,
  };
}

// ── importWorkflowFromJson ────────────────────────────────────────────────

type RawJson = {
  id?: string;
  name?: string;
  description?: string;
  version?: number;
  variables?: WorkflowVariable[];
  tags?: string[];
  branching?: WorkflowBranchingPolicy;
  notifyTarget?: unknown;
  steps?: ReadonlyArray<{
    stepKey?: string;
    name?: string;
    promptTemplate?: string;
    blockedByKeys?: string[];
    dispatch?: TaskDispatch | string;
    priority?: TaskPriority;
    retryPolicy?: string;
    onUpstreamFailure?: UpstreamFailurePolicy;
    sortOrder?: number;
    guidance?: string[];
    timeoutMs?: number;
  }>;
};

export function importWorkflowFromJson(
  deps: WorkflowBuilderDeps,
  json: string,
): BuilderResult {
  let data: RawJson;
  try {
    data = JSON.parse(json) as RawJson;
  } catch {
    return { ok: false, error: "Invalid JSON." };
  }
  if (!data.id || !data.name || !data.steps) {
    return {
      ok: false,
      error: "Invalid workflow format: missing id, name, or steps.",
    };
  }
  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    return {
      ok: false,
      error: "Invalid workflow format: steps must be a non-empty array.",
    };
  }

  const normalized: StepInput[] = data.steps.map((s, i) => {
    let dispatch: TaskDispatch | undefined;
    if (s.dispatch && typeof s.dispatch === "object") {
      dispatch = s.dispatch;
    }
    return {
      stepKey: s.stepKey || `step-${i + 1}`,
      name: s.name || `Step ${i + 1}`,
      promptTemplate: s.promptTemplate || "",
      blockedByKeys: s.blockedByKeys ?? [],
      dispatch,
      priority: s.priority,
      retryPolicy: s.retryPolicy as "manual_only" | "auto_once" | undefined,
      onUpstreamFailure: s.onUpstreamFailure,
      sortOrder: s.sortOrder ?? i,
      guidance: s.guidance,
      timeoutMs: s.timeoutMs,
    };
  });

  let notifyTarget: Originator | undefined;
  if (data.notifyTarget !== undefined) {
    const validated = validateNotifyTarget(data.notifyTarget);
    if (!validated.ok) return { ok: false, error: validated.error };
    notifyTarget = validated.value;
  }

  return createWorkflowFromSteps(
    deps,
    data.id,
    data.name,
    data.description ?? "",
    data.variables ?? [],
    normalized,
    data.branching,
    notifyTarget,
  );
}

// ── Internals ─────────────────────────────────────────────────────────────

function runInTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

type ResolveResult =
  | { readonly ok: true; readonly value: TaskDispatch }
  | { readonly ok: false; readonly error: string };

function validateStepDependencies(
  steps: readonly StepInput[],
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const stepKeys = new Set<string>();
  for (const step of steps) {
    if (!step.stepKey.trim()) {
      return { ok: false, error: "Workflow stepKey must be non-empty." };
    }
    if (stepKeys.has(step.stepKey)) {
      return {
        ok: false,
        error: `Duplicate workflow stepKey "${step.stepKey}".`,
      };
    }
    stepKeys.add(step.stepKey);
  }

  for (const step of steps) {
    for (const blocker of step.blockedByKeys) {
      if (!stepKeys.has(blocker)) {
        return {
          ok: false,
          error: `Step "${step.stepKey}" references unknown blockedByKey "${blocker}".`,
        };
      }
    }
  }

  return { ok: true };
}

function resolveDispatch(
  dispatch: TaskDispatch | undefined,
  defaultAgentId: string | undefined,
): ResolveResult {
  if (dispatch && dispatch.mode) {
    if (dispatch.mode === "spawn" && !dispatch.agentId) {
      if (!defaultAgentId) {
        return {
          ok: false,
          error:
            "dispatch.mode=spawn requires agentId, and no defaultDispatchAgentId was configured.",
        };
      }
      return { ok: true, value: { ...dispatch, agentId: defaultAgentId } };
    }
    return { ok: true, value: dispatch };
  }
  if (!defaultAgentId) {
    return {
      ok: false,
      error:
        "dispatch is required, and no defaultDispatchAgentId was configured. " +
        "Specify dispatch on every step or supply defaultDispatchAgentId.",
    };
  }
  return {
    ok: true,
    value: { mode: "spawn", agentId: defaultAgentId },
  };
}

type ValidatedNotifyTarget =
  | { readonly ok: true; readonly value: Originator }
  | { readonly ok: false; readonly error: string };

function validateNotifyTarget(raw: unknown): ValidatedNotifyTarget {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      error:
        "Invalid notifyTarget: must be { channel: string, accountId: string, to?: string, threadId?: string }.",
    };
  }
  const nt = raw as Record<string, unknown>;
  if (
    typeof nt.channel !== "string" ||
    !nt.channel.trim() ||
    typeof nt.accountId !== "string" ||
    !nt.accountId.trim()
  ) {
    return {
      ok: false,
      error:
        "Invalid notifyTarget: must be { channel: string, accountId: string, to?: string, threadId?: string }.",
    };
  }
  const result: Originator = {
    channel: nt.channel.trim(),
    accountId: nt.accountId.trim(),
    ...(typeof nt.to === "string" && nt.to.trim() ? { to: nt.to.trim() } : {}),
    ...(typeof nt.threadId === "string" && nt.threadId.trim()
      ? { threadId: nt.threadId.trim() }
      : {}),
  };
  return { ok: true, value: result };
}
