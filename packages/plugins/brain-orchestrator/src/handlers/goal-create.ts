/**
 * Goal-creation handler — port of upstream task-orchestrator
 * `createGoalFromPlan`.
 *
 * Creates a Goal + N Tasks atomically from a plan (a list of TaskPlanItem
 * records). When the workflow has a `branching` policy, also creates the
 * git worktree+branch and stores it on the goal so every task inherits
 * the isolated checkout. Orphan branches are hard-removed on creation
 * failure so re-running with the same sequence number works.
 *
 * This handler does NOT dispatch the resulting ready tasks — the caller
 * (the openclaw plugin entry's Dispatcher) is responsible for triggering
 * dispatch. Keeping dispatch out lets brain-orchestrator stay runtime-
 * agnostic and lets tests verify creation independently from dispatch.
 *
 * Open-source delta from upstream: dropped `isCliExecAlias` and
 * `materializeCliExecDispatch` (owner-specific CLI dispatch shortcuts).
 * Workflow templates must specify dispatch explicitly.
 */

import { randomUUID } from "node:crypto";
import { createWorkflowBranch, removeWorkflowBranch } from "../ops/git.js";
import type {
  GoalRecord,
  GoalStatus,
  GoalsStore,
  Originator,
} from "../store/goals.js";
import type {
  OrchestratorTaskRecord,
  TaskDispatch,
  TaskPriority,
  TasksStore,
  UpstreamFailurePolicy,
} from "../store/tasks.js";
import type { WorkflowBranchingPolicy } from "../store/workflows.js";
import type { DatabaseSync } from "node:sqlite";

export type TaskPlanItem = {
  /** Unique dependency key for this plan item. Other items reference it via
   *  `blockedByNames`. Also used as the task's display name unless
   *  `displayName` is set. */
  readonly name: string;
  /** Optional human-readable name. Falls back to `name` when omitted. */
  readonly displayName?: string;
  readonly task: string;
  readonly blockedByNames?: readonly string[];
  readonly dispatch?: TaskDispatch;
  readonly priority?: TaskPriority;
  readonly retryPolicy?: "manual_only" | "auto_once";
  readonly onUpstreamFailure?: UpstreamFailurePolicy;
  readonly guidance?: readonly string[];
  readonly tags?: readonly string[];
  readonly timeoutMs?: number;
};

/**
 * Caller-supplied alias resolver. Invoked once per task-plan item whose
 * `dispatch.mode === "exec"` and `dispatch.agentId` is set. Returns a
 * replacement dispatch (typically wrapped to invoke a CLI-exec worker
 * with a spec.json) — or undefined if the alias isn't recognized, in
 * which case the original dispatch is stored verbatim.
 *
 * Effectful: implementations are expected to write spec files to disk.
 * Lives in the runtime adapter (e.g. `@digital-me/runtime-openclaw`)
 * so brain-orchestrator stays runtime-agnostic.
 */
export type AliasResolver = (
  agentId: string,
  ctx: {
    readonly taskId: string;
    readonly goalId: string;
    readonly taskName: string;
    readonly task: string;
    readonly cwd?: string;
    readonly originalDispatch: TaskDispatch;
  },
) => TaskDispatch | undefined;

export type CreateGoalFromPlanOptions = {
  readonly parentGoalId?: string;
  readonly sourceWorkflowId?: string;
  readonly sourceWorkflowVersion?: number;
  readonly branching?: WorkflowBranchingPolicy;
  readonly originator?: Originator;
  /** Recorded as the goal's `created_by`. Defaults to "orchestrator".
   *  The scheduler passes "scheduler" so the retention sweep can tell
   *  cron-instantiated runs apart from manual `run_workflow` calls. */
  readonly createdBy?: string;
};

export type CreateGoalFromPlanResult =
  | {
      readonly ok: true;
      readonly goalId: string;
      readonly goalName: string;
      readonly taskCount: number;
      readonly readyTaskIds: readonly string[];
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly errorCode: string;
      readonly error: string;
    };

export type GoalCreateDeps = {
  readonly db: DatabaseSync;
  readonly goals: GoalsStore;
  readonly tasks: TasksStore;
  readonly now?: () => number;
  readonly newId?: () => string;
  /**
   * Optional alias resolver. When set, exec-mode plans with `agentId`
   * pass through it before being stored as tasks.
   */
  readonly aliasResolver?: AliasResolver;
};

/**
 * Plan a workflow branch (spawn-mode constraint check + sequence number +
 * createWorkflowBranch call). Returns the branch name + worktree path on
 * success, or a structured error on validation/git failure.
 *
 * Used as a sub-step of `createGoalFromPlan` — exported here so callers
 * can compose alternative goal-creation flows (e.g. the dashboard).
 */
export async function planWorkflowBranch(
  deps: Pick<GoalCreateDeps, "goals">,
  policy: WorkflowBranchingPolicy,
  taskPlans: readonly TaskPlanItem[],
  sourceWorkflowId: string | undefined,
): Promise<
  | { readonly ok: true; readonly branchName: string; readonly worktreePath: string }
  | { readonly ok: false; readonly errorCode: string; readonly error: string }
> {
  // Spawn-mode tasks can't honor a worktree as their cwd today, so they'd
  // commit to trunk and bypass branch isolation. Refuse rather than silently
  // break.
  const spawnTasks = taskPlans.filter((p) => p.dispatch?.mode === "spawn");
  if (spawnTasks.length > 0) {
    const taskNames = spawnTasks.map((p) => p.name).join(", ");
    return {
      ok: false,
      errorCode: "spawn_in_branched_workflow",
      error:
        `Branching is enabled but plan contains spawn-mode tasks (${taskNames}). ` +
        `Spawn workers cannot honor the workflow worktree as their cwd. ` +
        `Convert those tasks to exec mode, or remove branching from the workflow template.`,
    };
  }
  try {
    const prefix = policy.namePrefix ?? "wf";
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const idForName = sourceWorkflowId ?? "ad-hoc";
    const seqPrefix = `${prefix}/${idForName}-${ymd}-`;
    const seq = deps.goals.countByBranchPrefix(seqPrefix) + 1;
    const result = createWorkflowBranch({
      policy,
      templateId: idForName,
      seq,
      date: ymd,
    });
    return {
      ok: true,
      branchName: result.branchName,
      worktreePath: result.worktreePath,
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: "branching_failed",
      error: `Workflow branching failed — ${(err as Error).message}.`,
    };
  }
}

/**
 * Create a goal + its tasks atomically from a plan. Returns the goal id
 * and the ids of tasks that became ready (zero blockers); the caller
 * dispatches those via its Dispatcher.
 */
export async function createGoalFromPlan(
  deps: GoalCreateDeps,
  description: string,
  taskPlans: readonly TaskPlanItem[],
  options: CreateGoalFromPlanOptions = {},
): Promise<CreateGoalFromPlanResult> {
  const now = (deps.now ?? Date.now)();
  const newId = deps.newId ?? randomUUID;
  const goalId = newId();
  const goalName = description.slice(0, 80);

  let branchName: string | undefined;
  let worktreePath: string | undefined;
  if (options.branching) {
    const planned = await planWorkflowBranch(
      deps,
      options.branching,
      taskPlans,
      options.sourceWorkflowId,
    );
    if (!planned.ok) {
      return { ok: false, errorCode: planned.errorCode, error: planned.error };
    }
    branchName = planned.branchName;
    worktreePath = planned.worktreePath;
  }

  const goal: GoalRecord = {
    id: goalId,
    name: goalName,
    description,
    status: "pending" as GoalStatus,
    type: "project",
    taskIds: [],
    createdAt: now,
    updatedAt: now,
    createdBy: options.createdBy ?? "orchestrator",
    parentGoalId: options.parentGoalId,
    sourceWorkflowId: options.sourceWorkflowId,
    sourceWorkflowVersion: options.sourceWorkflowVersion,
    originator: options.originator,
    branchName,
    worktreePath,
    branchingPolicy: options.branching,
  };

  // Map plan names → task ids for dependency resolution.
  const nameToId = new Map<string, string>();
  for (const plan of taskPlans) {
    if (!plan.name.trim()) {
      return {
        ok: false,
        errorCode: "invalid_plan_name",
        error: "Task plan name must be non-empty.",
      };
    }
    if (nameToId.has(plan.name)) {
      return {
        ok: false,
        errorCode: "duplicate_plan_name",
        error: `Duplicate task plan name "${plan.name}".`,
      };
    }
    nameToId.set(plan.name, newId());
  }

  // Validate every blockedByName resolves to a sibling plan. Previously the
  // map+filter below silently dropped unknown references, turning a sequenced
  // goal into a parallel one with no signal — same shape as the bug
  // workflow-builder's validateStepDependencies guards against.
  for (const plan of taskPlans) {
    for (const blockerName of plan.blockedByNames ?? []) {
      if (!nameToId.has(blockerName)) {
        return {
          ok: false,
          errorCode: "unknown_blocked_by_name",
          error: `Task "${plan.name}" references unknown blockedByName "${blockerName}".`,
        };
      }
    }
  }

  // Pre-build task records BEFORE the transaction so we can keep the txn
  // tight (no allocations inside).
  const taskRecords: OrchestratorTaskRecord[] = [];
  const readyTaskIds: string[] = [];
  for (const plan of taskPlans) {
    const taskId = nameToId.get(plan.name)!;
    const blockedBy = (plan.blockedByNames ?? [])
      .map((name) => nameToId.get(name))
      .filter((id): id is string => id !== undefined);
    // Plans arriving from MCP callers can omit dispatch — default to manual
    // so the orchestrator still surfaces the task on the board.
    let dispatch: TaskDispatch = plan.dispatch ?? { mode: "manual" };
    // Alias resolution: if this is an exec dispatch with an agentId and
    // the caller supplied an aliasResolver, give it a chance to rewrite
    // the dispatch (e.g. wrap the command in a CLI-exec worker).
    if (
      dispatch.mode === "exec" &&
      dispatch.agentId &&
      deps.aliasResolver
    ) {
      const resolved = deps.aliasResolver(dispatch.agentId, {
        taskId,
        goalId,
        taskName: plan.name,
        task: plan.task,
        cwd: dispatch.cwd ?? worktreePath,
        originalDispatch: dispatch,
      });
      if (resolved) dispatch = resolved;
    }
    const status: OrchestratorTaskRecord["status"] =
      blockedBy.length === 0 ? "ready" : "pending";
    const task: OrchestratorTaskRecord = {
      id: taskId,
      goalId,
      name: plan.displayName ?? plan.name,
      task: plan.task,
      blockedBy,
      dispatch,
      status,
      attemptCount: 0,
      attempts: [],
      priority: plan.priority ?? "normal",
      retryPolicy: plan.retryPolicy,
      onUpstreamFailure: plan.onUpstreamFailure ?? "wait",
      guidance: plan.guidance,
      timeoutMs: plan.timeoutMs,
      tags: plan.tags,
      originator: options.originator,
      readyAt: status === "ready" ? now : undefined,
    };
    taskRecords.push(task);
    if (status === "ready") readyTaskIds.push(taskId);
  }

  try {
    deps.db.exec("BEGIN");
    try {
      deps.goals.create(goal);
      for (const t of taskRecords) deps.tasks.create(t);
      deps.db.exec("COMMIT");
    } catch (err) {
      deps.db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    // If branching ran above, the worktree+branch exist on disk but no goal
    // row references them — hard-remove so the seq can be reused on retry.
    // removeWorkflowBranch is best-effort (swallows its own errors).
    if (branchName && worktreePath && options.branching) {
      removeWorkflowBranch(
        options.branching.repoPath,
        branchName,
        worktreePath,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorCode: "goal_create_failed",
      error: `Failed to create goal "${goalName}": ${message}`,
    };
  }

  // Mark the goal "running" — tasks are queued; the caller will dispatch
  // the ready ones via its Dispatcher.
  deps.goals.updateStatus(goalId, "running");

  return {
    ok: true,
    goalId,
    goalName,
    taskCount: taskRecords.length,
    readyTaskIds,
    message: `Goal "${goalName}" created with ${taskRecords.length} tasks. ${readyTaskIds.length} ready for dispatch.`,
  };
}
