/**
 * Goal/task status resolution — pure subset of upstream task-orchestrator
 * `src/resolver.ts` that doesn't require the plugin SDK / subagent runtime.
 *
 * Two layers:
 *   1. `deriveGoalStatus` (pure rollup): given a goal's tasks, what is the
 *      goal's status?
 *   2. `refreshGoalStatus` (cascade): update the goal row to match the rollup,
 *      then re-evaluate the parent goal if this one transitioned to completed.
 *
 * Task-side transitions (claim/complete/approve/reject/recordCheckpoint/
 * recordHandoff) are also in here as pure functions. They write directly to
 * the tasks store and trigger a goal-status refresh — they do NOT call into
 * any dispatch path. Dispatch lives in the runtime adapter (Phase 5).
 *
 * The dispatch-coupled methods from upstream (`retryTask`, `dispatchTask`,
 * `dispatchExecTask`, `onSubagentEnded`, `probeSessionLiveness`,
 * `dispatchReadyTasks`, `resolveDependents` partial) are out of scope here
 * — they belong with the openclaw runtime adapter.
 */

import type { GoalRecord, GoalStatus, GoalsStore } from "../store/goals.js";
import type {
  AttemptStatus,
  OrchestratorTaskRecord,
  TaskCheckpointRecord,
  TaskOutputRecord,
  TaskStatus,
  TasksStore,
} from "../store/tasks.js";

export type ResolverDeps = {
  readonly goals: GoalsStore;
  readonly tasks: TasksStore;
  readonly now?: () => number;
};

// ── Goal-status derivation ────────────────────────────────────────────────

// A goal in one of these states accepts no further task transitions; callers
// must not revive or re-dispatch its tasks. Single source of truth so the
// watchdog and cancelGoal agree on what "terminal" means.
const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>([
  "completed",
  "cancelled",
  "failed",
  "retired",
]);

/** True when a goal is in a terminal state (no further task work allowed). */
export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return TERMINAL_GOAL_STATUSES.has(status);
}

/**
 * Compute what a goal's status SHOULD be, based on its tasks. Pure: does
 * not mutate the store. Evergreen goals are passed through unchanged
 * (their lifecycle isn't task-rollup-driven).
 */
export function deriveGoalStatus(
  deps: Pick<ResolverDeps, "goals" | "tasks">,
  goalId: string,
): GoalStatus {
  const goal = deps.goals.get(goalId);
  if (goal?.type === "evergreen") {
    return goal.status;
  }
  const tasks = deps.tasks.listForGoal(goalId);
  if (tasks.length === 0) return "pending";

  // A `failed`/`stalled` task is "handled" when at least one task that depends
  // on it is configured to proceed past the failure (onUpstreamFailure
  // `continue` or `skip`). A handled failure does NOT terminally fail the goal
  // — its dependents run the resilient fallback (e.g. the dream-cycle `apply`
  // / digest `publish` inline-engine path) and THEIR outcomes drive the
  // rollup. Without this carve-out a single stalled spawn fails the whole goal
  // the instant the watchdog fires, before the fallback step can run — exactly
  // what silently broke the nightly dream-cycle + daily digest after every
  // gateway perturbation (provider re-route, credential, agent swap). Gated on
  // continue/skip actually being used, so wait-only workflows (the default
  // everywhere else) keep their existing behavior precisely.
  const isTerminalFailure = (t: OrchestratorTaskRecord): boolean =>
    t.status === "failed" || t.status === "stalled";
  const isHandledFailure = (t: OrchestratorTaskRecord): boolean =>
    isTerminalFailure(t) &&
    tasks.some(
      (d) =>
        d.blockedBy.includes(t.id) &&
        (d.onUpstreamFailure === "continue" || d.onUpstreamFailure === "skip"),
    );
  const isResolved = (t: OrchestratorTaskRecord): boolean =>
    t.status === "completed" ||
    t.status === "skipped" ||
    t.status === "acknowledged" ||
    isHandledFailure(t);

  if (tasks.every(isResolved)) {
    // Everything has settled. Fail only if some failure was never handled by a
    // downstream continue/skip step; a handled failure whose fallback ran
    // yields a completed goal.
    return tasks.some((t) => isTerminalFailure(t) && !isHandledFailure(t))
      ? "failed"
      : "completed";
  }

  // An UNHANDLED terminal failure short-circuits to failed — preserving prior
  // behavior for wait-policy chains: a failed step with no continue/skip
  // dependent ends the goal, and treating stalled as "active" would wedge it
  // (and the parent schedule's overlap guard).
  if (tasks.some((t) => isTerminalFailure(t) && !isHandledFailure(t))) {
    return "failed";
  }

  const anyActive = tasks.some(
    (t) =>
      t.status === "running" ||
      t.status === "dispatched" ||
      t.status === "ready" ||
      t.status === "awaiting_approval",
  );
  if (anyActive) return "running";

  return "pending";
}

/**
 * Apply the derived status to the goal row. If the rollup transitioned this
 * goal to "completed" and it has a parent, recursively re-evaluate the
 * parent so chain-completion propagates upward.
 *
 * Returns the post-refresh status.
 */
export function refreshGoalStatus(
  deps: ResolverDeps,
  goalId: string,
): GoalStatus {
  const goal = deps.goals.get(goalId);
  if (goal?.type === "evergreen") {
    return goal.status;
  }
  const derived = deriveGoalStatus(deps, goalId);
  if (!goal) return derived;
  if (goal.status !== derived) {
    const completedAt =
      derived === "completed" ? (deps.now ?? Date.now)() : undefined;
    deps.goals.updateStatus(goalId, derived, completedAt);
    if (derived === "completed" && goal.parentGoalId) {
      refreshParentGoalStatus(deps, goal.parentGoalId);
    }
  }
  return derived;
}

function refreshParentGoalStatus(deps: ResolverDeps, parentGoalId: string): void {
  const parent = deps.goals.get(parentGoalId);
  if (!parent) return;
  if (parent.status === "completed" || parent.status === "cancelled") return;
  if (parent.type === "evergreen") return;

  const children = deps.goals.listChildren(parentGoalId);
  const allChildrenDone = children.every(
    (c) => c.status === "completed" || c.status === "cancelled",
  );
  if (!allChildrenDone) return;

  if (deriveGoalStatus(deps, parentGoalId) === "completed") {
    deps.goals.updateStatus(
      parentGoalId,
      "completed",
      (deps.now ?? Date.now)(),
    );
    if (parent.parentGoalId) {
      refreshParentGoalStatus(deps, parent.parentGoalId);
    }
  }
}

// ── Task transitions ──────────────────────────────────────────────────────

export type TransitionResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: string };

/**
 * Claim a ready/pending task. Used for manual or inline workflows where the
 * caller intends to do the work itself (no subagent dispatch).
 */
export function claimTask(
  deps: ResolverDeps,
  taskId: string,
): TransitionResult {
  const task = deps.tasks.get(taskId);
  if (!task) return { ok: false, error: "Task not found." };
  if (task.status !== "ready" && task.status !== "pending") {
    return { ok: false, error: `Cannot claim task in status "${task.status}".` };
  }
  if (task.status === "pending" && task.blockedBy.length > 0) {
    return {
      ok: false,
      error: `Task "${task.name}" is still blocked by: ${task.blockedBy.join(", ")}`,
    };
  }
  const now = (deps.now ?? Date.now)();
  deps.tasks.update({ ...task, status: "running", startedAt: now });
  refreshGoalStatus(deps, task.goalId);
  return { ok: true, message: `Task "${task.name}" claimed and running.` };
}

/**
 * Mark a task complete. Used for manual/inline tasks that don't carry a
 * subagent lifecycle.
 */
export function completeTask(
  deps: ResolverDeps,
  taskId: string,
): TransitionResult {
  const task = deps.tasks.get(taskId);
  if (!task) return { ok: false, error: "Task not found." };
  if (task.status !== "running" && task.status !== "ready") {
    return { ok: false, error: `Cannot complete task in status "${task.status}".` };
  }
  const now = (deps.now ?? Date.now)();
  deps.tasks.update({ ...task, status: "completed", completedAt: now });
  // Unblock dependents immediately. Without this a task B blocked by A stays
  // `pending` until the next schedule tick (the only other caller of
  // resolveDependents), stalling manually-completed chains.
  resolveDependents(deps, taskId);
  refreshGoalStatus(deps, task.goalId);
  return { ok: true, message: `Task "${task.name}" completed.` };
}

/**
 * Approve a task awaiting human review.
 */
export function approveTask(
  deps: ResolverDeps,
  taskId: string,
): TransitionResult {
  const task = deps.tasks.get(taskId);
  if (!task) return { ok: false, error: "Task not found." };
  if (task.status !== "awaiting_approval") {
    return {
      ok: false,
      error: `Task is not awaiting approval (status: ${task.status}).`,
    };
  }
  const now = (deps.now ?? Date.now)();
  deps.tasks.update({ ...task, status: "completed", completedAt: now });
  resolveDependents(deps, taskId);
  refreshGoalStatus(deps, task.goalId);
  return { ok: true, message: `Task "${task.name}" approved and completed.` };
}

/**
 * Reject a task awaiting human review. Goal-status rollup will treat this
 * as a terminal failure if no other tasks are still active.
 */
export function rejectTask(
  deps: ResolverDeps,
  taskId: string,
  reason?: string,
): TransitionResult {
  const task = deps.tasks.get(taskId);
  if (!task) return { ok: false, error: "Task not found." };
  if (task.status !== "awaiting_approval") {
    return {
      ok: false,
      error: `Task is not awaiting approval (status: ${task.status}).`,
    };
  }
  deps.tasks.update({
    ...task,
    status: "failed",
    failureReason: reason ?? "rejected on approval",
  });
  refreshGoalStatus(deps, task.goalId);
  return { ok: true, message: `Task "${task.name}" rejected.` };
}

// ── Checkpoint + handoff ──────────────────────────────────────────────────

/**
 * Record a checkpoint and auto-transition a ready/dispatched task to
 * running. Returns true on success, false when the task isn't found or
 * isn't in a state that accepts checkpoints.
 */
export function recordCheckpoint(
  deps: ResolverDeps,
  taskId: string,
  checkpoint: TaskCheckpointRecord,
): boolean {
  const task = deps.tasks.get(taskId);
  if (!task) return false;
  const allowed: ReadonlySet<TaskStatus> = new Set([
    "running",
    "dispatched",
    "ready",
  ]);
  if (!allowed.has(task.status)) return false;

  const now = (deps.now ?? Date.now)();
  const next: OrchestratorTaskRecord = {
    ...task,
    latestCheckpoint: checkpoint,
    status:
      task.status === "dispatched" || task.status === "ready"
        ? "running"
        : task.status,
    startedAt:
      (task.status === "dispatched" || task.status === "ready") && !task.startedAt
        ? now
        : task.startedAt,
  };
  deps.tasks.update(next);
  refreshGoalStatus(deps, task.goalId);
  return true;
}

/**
 * Record a handoff (worker-reported output). When `output.deliverableState`
 * is `"complete"`, finalize the task: status=completed, end the active
 * attempt, refresh the goal. Otherwise just save the partial output.
 */
export function recordHandoff(
  deps: ResolverDeps,
  taskId: string,
  output: TaskOutputRecord,
): boolean {
  const task = deps.tasks.get(taskId);
  if (!task) return false;
  const allowed: ReadonlySet<TaskStatus> = new Set([
    "running",
    "dispatched",
    "ready",
  ]);
  if (!allowed.has(task.status)) return false;

  const now = (deps.now ?? Date.now)();
  const isComplete = output.deliverableState === "complete";

  if (isComplete) {
    const next: OrchestratorTaskRecord = {
      ...task,
      status: "completed",
      completedAt: now,
      activeRunId: undefined,
      activeSessionKey: undefined,
      startedAt:
        (task.status === "dispatched" || task.status === "ready") &&
        !task.startedAt
          ? now
          : task.startedAt,
      latestOutput: output,
    };
    deps.tasks.update(next);
    finalizeRunningAttempt(deps, task, now, output.summary);
    resolveDependents(deps, task.id);
    refreshGoalStatus(deps, task.goalId);
    return true;
  }

  // Partial handoff — record the output, advance status from ready/dispatched
  // to running, but don't finalize.
  const next: OrchestratorTaskRecord = {
    ...task,
    latestOutput: output,
    status:
      task.status === "dispatched" || task.status === "ready"
        ? "running"
        : task.status,
    startedAt:
      (task.status === "dispatched" || task.status === "ready") && !task.startedAt
        ? now
        : task.startedAt,
  };
  deps.tasks.update(next);
  return true;
}

function finalizeRunningAttempt(
  deps: ResolverDeps,
  task: OrchestratorTaskRecord,
  endedAt: number,
  outputSummary: string,
): void {
  const running = task.attempts.find((a) => a.status === "running");
  if (!running) return;
  const completed: AttemptStatus = "completed";
  deps.tasks.updateAttempt(running.attemptId, {
    endedAt,
    status: completed,
    outputSummary,
  });
}

// ── Cascade: unblock dependent tasks ──────────────────────────────────────

/**
 * When a task completes, find the tasks blocked by it; if removing this
 * blocker leaves them with zero blockers, transition them from "pending"
 * to "ready" (and stamp `readyAt`).
 *
 * Returns the list of tasks that newly became ready.
 *
 * Note: this only handles the pending→ready transition. Dispatching those
 * ready tasks lives in the runtime adapter.
 */
export function resolveDependents(
  deps: ResolverDeps,
  completedTaskId: string,
): readonly OrchestratorTaskRecord[] {
  const dependents = deps.tasks.findBlockedBy(completedTaskId);
  const now = (deps.now ?? Date.now)();
  const newlyReady: OrchestratorTaskRecord[] = [];
  for (const dep of dependents) {
    if (dep.status !== "pending") continue;
    const remainingBlockers = dep.blockedBy.filter(
      (id) => id !== completedTaskId,
    );
    if (remainingBlockers.length === 0) {
      const next: OrchestratorTaskRecord = {
        ...dep,
        blockedBy: [],
        status: "ready",
        readyAt: dep.readyAt ?? now,
      };
      deps.tasks.update(next);
      newlyReady.push(next);
    } else {
      deps.tasks.update({ ...dep, blockedBy: remainingBlockers });
    }
  }
  return newlyReady;
}

// ── Goal-level cancellation ───────────────────────────────────────────────

/**
 * Cancel a goal: mark it cancelled, then mark all non-terminal tasks as
 * skipped. Returns the number of tasks that were affected. No-op when the
 * goal is already in a terminal state.
 */
export function cancelGoal(
  deps: ResolverDeps,
  goalId: string,
): TransitionResult & { readonly cancelledTaskCount?: number } {
  const goal = deps.goals.get(goalId);
  if (!goal) return { ok: false, error: `Goal "${goalId}" not found.` };
  if (isTerminalGoalStatus(goal.status)) {
    return {
      ok: false,
      error: `Goal "${goal.name}" is already ${goal.status}.`,
    };
  }

  const now = (deps.now ?? Date.now)();
  deps.goals.updateStatus(goalId, "cancelled" as GoalStatus, now);

  const tasks = deps.tasks.listForGoal(goalId);
  const terminalTaskStatuses: ReadonlySet<TaskStatus> = new Set([
    "completed",
    "failed",
    "skipped",
    "stalled",
    "acknowledged",
  ]);
  let cancelled = 0;
  for (const t of tasks) {
    if (terminalTaskStatuses.has(t.status)) continue;
    deps.tasks.update({ ...t, status: "skipped" });
    cancelled++;
  }
  return {
    ok: true,
    message: `Goal "${goal.name}" cancelled (${cancelled} tasks skipped).`,
    cancelledTaskCount: cancelled,
  };
}

// Re-export for convenience.
export type { GoalRecord, GoalStatus };
