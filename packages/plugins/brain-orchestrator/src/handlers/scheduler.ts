/**
 * Scheduler — port of upstream task-orchestrator `src/scheduler.ts`.
 *
 * The scheduler is the periodic tick that:
 *   1. Reconciles stale runs (stalled/ready watchdogs).
 *   2. Finalizes goals whose tasks all reached a terminal state.
 *   3. Refreshes schedule.lastStatus to match the parent goal.
 *   4. Dispatches orphaned ready tasks (callback into the runtime).
 *   5. Scans schedules and instantiates due workflows (callback into the
 *      runtime, which knows how to create a goal from a template).
 *
 * The runtime-specific bits are abstracted behind two interfaces:
 *   - `Dispatcher`: dispatches an individual task (spawn or exec) plus a
 *     liveness-probe hook. The openclaw runtime adapter implements this in
 *     Phase 5 using subagent.spawn + exec. Other runtimes can substitute.
 *   - `WorkflowInstantiator`: given a workflowId + variables, create a goal
 *     and dispatch its initial ready tasks. Same Phase-5 ownership.
 *
 * This keeps the scheduler runtime-agnostic — the brain-orchestrator
 * package depends on neither the openclaw SDK nor any specific dispatcher
 * implementation.
 */

import { computeNextRun } from "../ops/cron.js";
import type { GoalsStore } from "../store/goals.js";
import type { ScheduleRecord, SchedulesStore } from "../store/schedules.js";
import type {
  OrchestratorTaskRecord,
  TasksStore,
  TaskStatus,
} from "../store/tasks.js";
import type { TracesStore } from "../store/traces.js";
import type { WorkflowsStore } from "../store/workflows.js";
import { isTerminalGoalStatus, refreshGoalStatus } from "./resolver-status.js";

// After N consecutive dispatch failures for the same task, the
// orphan-dispatch path terminal-fails the task instead of retrying every tick.
const MAX_FAILED_DISPATCHES_BEFORE_TERMINAL_FAIL = 5;

// Watchdog horizon multiplier for "ready" tasks whose parent goal is old
// enough that dispatch should have completed.
const READY_WATCHDOG_MULTIPLIER = 2;

// A step with retryPolicy="auto_once" earns exactly one fresh re-dispatch when
// its run goes silent past the stall threshold. attemptCount is bumped on every
// dispatch, so the first stall sees attemptCount === 1 and the retry lifts it to
// 2 — a second stall (attemptCount === 2) is terminal. Without this, the
// retryPolicy field is inert: nothing else in the scheduler reads it.
const AUTO_ONCE_MAX_ATTEMPTS = 2;

// Magic-string match for the gateway-scope transient. The openclaw subagent
// proxy throws this when the request scope isn't bound — a benign race
// during nested workflow chains. We mustn't burn the retry budget on it.
const GATEWAY_SCOPE_TRANSIENT_MSG =
  "Plugin runtime subagent methods are only available during a gateway request";

// Retention window for cron-instantiated goals. A per-minute schedule mints
// ~1,440 goals/day (each with tasks + attempts + traces) forever; terminal
// runs older than this are operational exhaust and get swept. Override per
// deployment via `SchedulerDeps.cronGoalRetentionMs`.
export const CRON_GOAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The sweep runs at most this often (the tick itself fires every ~60s).
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h

export type SchedulerRuntime = {
  readonly log: (level: "info" | "warn" | "error", message: string) => void;
};

export type WorkflowInstantiateResult =
  | {
      readonly ok: true;
      readonly goalId: string;
      readonly taskCount: number;
      readonly dispatched: number;
    }
  | { readonly ok: false; readonly error: string };

export type WorkflowInstantiator = (
  workflowId: string,
  variables: Readonly<Record<string, string>>,
) => Promise<WorkflowInstantiateResult>;

export type Dispatcher = {
  dispatchSpawnTask(task: OrchestratorTaskRecord): Promise<boolean>;
  dispatchExecTask(task: OrchestratorTaskRecord): Promise<boolean>;
  probeSessionLiveness(): Promise<readonly OrchestratorTaskRecord[]>;
};

export type SchedulerDeps = {
  readonly goals: GoalsStore;
  readonly schedules: SchedulesStore;
  readonly tasks: TasksStore;
  readonly workflows: WorkflowsStore;
  readonly runtime: SchedulerRuntime;
  readonly dispatcher: Dispatcher;
  readonly instantiateWorkflow: WorkflowInstantiator;
  readonly now?: () => number;
  /** Optional traces store — when present, the retention sweep also removes
   *  traces rows tied to swept goals. */
  readonly traces?: Pick<TracesStore, "deleteByGoal">;
  /** Override for the cron-goal retention window.
   *  Defaults to `CRON_GOAL_RETENTION_MS` (7 days). */
  readonly cronGoalRetentionMs?: number;
};

export type ScanResult = {
  readonly scanned: number;
  readonly instantiated: number;
  readonly skipped: number;
  readonly errors: number;
};

export type TickResult = ScanResult & {
  readonly reconciled: number;
  readonly dependenciesReconciled: number;
  readonly probed: number;
  readonly goalsFinalized: number;
  readonly statusRefreshed: number;
  readonly orphansDispatched: number;
  /** Cron goals removed by the hourly retention sweep (0 on throttled ticks). */
  readonly retentionSweptGoals: number;
};

// ── Main scan + processSchedule ───────────────────────────────────────────

export async function scanSchedules(
  deps: SchedulerDeps,
  nowMs?: number,
): Promise<ScanResult> {
  const now = nowMs ?? (deps.now ?? Date.now)();
  const due = deps.schedules.findDue(now);
  let instantiated = 0;
  let skipped = 0;
  let errors = 0;

  for (const schedule of due) {
    try {
      const outcome = await processSchedule(deps, schedule, now);
      if (outcome === "instantiated") instantiated++;
      else if (outcome === "skipped") skipped++;
      else errors++;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      deps.runtime.log(
        "error",
        `scheduler: failed to process schedule "${schedule.name}": ${msg}`,
      );
      // Advance next_run_at even on error so we don't tight-retry the same row.
      advanceSchedule(deps, schedule, now);
    }
  }

  const result: ScanResult = {
    scanned: due.length,
    instantiated,
    skipped,
    errors,
  };
  if (result.scanned > 0) {
    deps.runtime.log(
      "info",
      `scheduler: scanned ${result.scanned} due, instantiated ${result.instantiated}, skipped ${result.skipped}, errors ${result.errors}`,
    );
  }
  return result;
}

async function processSchedule(
  deps: SchedulerDeps,
  schedule: ScheduleRecord,
  nowMs: number,
): Promise<"instantiated" | "skipped" | "error"> {
  const workflow = deps.workflows.get(schedule.workflowId);
  if (!workflow) {
    deps.runtime.log(
      "error",
      `scheduler: workflow "${schedule.workflowId}" not found for schedule "${schedule.name}", disabling`,
    );
    deps.schedules.update({ ...schedule, enabled: false, updatedAt: nowMs });
    return "error";
  }

  // Validate the cron expression FIRST — before any advanceSchedule call. A
  // malformed expr must disable the schedule cleanly here; otherwise it throws
  // out of advanceSchedule on the overlap-skip path, escapes scanSchedules'
  // catch (which itself calls advanceSchedule), and rejects the whole tick —
  // stalling every schedule.
  let newNextRunAt: number;
  try {
    newNextRunAt = computeNextRun(schedule.cronExpr, schedule.timezone, nowMs);
  } catch (err) {
    // computeNextRun only throws Error; the cast is safe.
    const msg = (err as Error).message;
    deps.runtime.log(
      "error",
      `scheduler: bad cron for "${schedule.name}": ${msg}, disabling`,
    );
    deps.schedules.update({ ...schedule, enabled: false, updatedAt: nowMs });
    return "error";
  }

  // Workflow-level concurrency cap: refuse to fire when the number of active
  // goals already running this workflow exceeds maxOverlap. maxOverlap=0 is the
  // strict mutex (skip if ANY in flight); a positive N caps concurrent runs at
  // N (skip once inFlight > N). Catches concurrent dispatchers, not just this
  // schedule's own previous run.
  const inFlight = deps.goals.findActiveByWorkflow(schedule.workflowId);
  if (inFlight.length > schedule.maxOverlap) {
    const blocker = inFlight[0]!;
    deps.runtime.log(
      "info",
      `scheduler: skipping "${schedule.name}" — workflow "${schedule.workflowId}" at concurrency cap (maxOverlap=${schedule.maxOverlap}, ${inFlight.length} active; e.g. goal ${blocker.id} ${blocker.status})`,
    );
    advanceSchedule(deps, schedule, nowMs);
    return "skipped";
  }

  // Atomic claim — if another scanner already advanced this row, we lost.
  const claimed = deps.schedules.claim(
    schedule.id,
    schedule.nextRunAt,
    newNextRunAt,
    nowMs,
  );
  if (!claimed) {
    deps.runtime.log(
      "info",
      `scheduler: skipping "${schedule.name}" — already claimed by concurrent tick`,
    );
    return "skipped";
  }

  const result = await deps.instantiateWorkflow(
    schedule.workflowId,
    schedule.variables,
  );

  // claim() already wrote next_run_at + last_run_at; carry the post-result
  // status fields with another update.
  if (!result.ok) {
    deps.schedules.update({
      ...schedule,
      nextRunAt: newNextRunAt,
      lastRunAt: nowMs,
      lastStatus: "failed",
      updatedAt: nowMs,
    });
    deps.runtime.log(
      "error",
      `scheduler: failed to instantiate "${schedule.name}": ${result.error}`,
    );
    return "error";
  }

  deps.schedules.update({
    ...schedule,
    nextRunAt: newNextRunAt,
    lastRunAt: nowMs,
    lastGoalId: result.goalId,
    lastStatus: "running",
    updatedAt: nowMs,
  });
  deps.runtime.log(
    "info",
    `scheduler: instantiated "${schedule.name}" → goal ${result.goalId} (${result.taskCount} tasks, ${result.dispatched} dispatched)`,
  );
  return "instantiated";
}

function advanceSchedule(
  deps: SchedulerDeps,
  schedule: ScheduleRecord,
  nowMs: number,
): void {
  // Total by construction — never throws. processSchedule validates cronExpr
  // before the happy-path callers reach here, but scanSchedules' catch block
  // also calls advanceSchedule, so a malformed expr must not escape and reject
  // the whole tick. On parse failure, disable the schedule instead.
  let nextRunAt: number;
  try {
    nextRunAt = computeNextRun(schedule.cronExpr, schedule.timezone, nowMs);
  } catch (err) {
    deps.runtime.log(
      "error",
      `scheduler: advanceSchedule cron parse failed for "${schedule.name}": ${
        (err as Error).message
      }, disabling`,
    );
    deps.schedules.update({ ...schedule, enabled: false, updatedAt: nowMs });
    return;
  }
  deps.schedules.update({ ...schedule, nextRunAt, updatedAt: nowMs });
}

// ── Goal/schedule reconciliation ──────────────────────────────────────────

export function finalizeTerminalGoals(deps: SchedulerDeps): number {
  const goals = deps.goals.listActive();
  let finalized = 0;
  for (const goal of goals) {
    const before = goal.status;
    const after = refreshGoalStatus(deps, goal.id);
    // deriveGoalStatus never returns "cancelled" (that status only comes from
    // explicit cancelGoal calls), so we don't check it here.
    if (before !== after && (after === "completed" || after === "failed")) {
      finalized++;
      deps.runtime.log(
        "info",
        `scheduler: finalized stale goal ${goal.id} (${before} → ${after})`,
      );
    }
  }
  return finalized;
}

export function refreshScheduleStatuses(deps: SchedulerDeps): number {
  const schedules = deps.schedules.listAll();
  const now = (deps.now ?? Date.now)();
  let updated = 0;
  for (const schedule of schedules) {
    if (!schedule.lastGoalId || !schedule.lastStatus) continue;
    if (
      schedule.lastStatus !== "running" &&
      schedule.lastStatus !== "pending"
    ) {
      continue;
    }
    const goal = deps.goals.get(schedule.lastGoalId);
    if (!goal) continue;
    if (goal.status !== schedule.lastStatus) {
      deps.schedules.update({
        ...schedule,
        lastStatus: goal.status,
        updatedAt: now,
      });
      updated++;
    }
  }
  return updated;
}

export function reconcileCompletedDependencies(deps: SchedulerDeps): number {
  const pendingTasks = deps.tasks.findByStatus("pending");
  const now = (deps.now ?? Date.now)();
  let updated = 0;

  const isSatisfied = (s?: TaskStatus): boolean =>
    s === "completed" || s === "skipped" || s === "acknowledged";
  const isTerminalFailure = (s?: TaskStatus): boolean =>
    s === "failed" || s === "stalled";

  for (const task of pendingTasks) {
    if (task.blockedBy.length === 0) continue;

    const policy = task.onUpstreamFailure;

    // `skip` policy: if ANY upstream terminally failed, skip this task. Its own
    // dependents then unblock normally (skipped is a satisfied state), so the
    // skip cascades down the chain on subsequent ticks.
    if (
      policy === "skip" &&
      task.blockedBy.some((id) => isTerminalFailure(deps.tasks.get(id)?.status))
    ) {
      deps.tasks.update({ ...task, status: "skipped" });
      refreshGoalStatus(deps, task.goalId);
      updated++;
      deps.runtime.log(
        "info",
        `scheduler: skipped "${task.name}" — upstream failed and onUpstreamFailure=skip`,
      );
      continue;
    }

    // A blocker stops blocking when it's satisfied (completed/skipped/
    // acknowledged) OR it terminally failed under a `continue` policy — the
    // task is meant to run anyway (e.g. an inline-engine fallback step that
    // recovers a stalled spawn). `wait` (the default) keeps a failed blocker in
    // place, so the task stays pending and the goal rolls up failed.
    const remainingBlockers = task.blockedBy.filter((id) => {
      const s = deps.tasks.get(id)?.status;
      if (isSatisfied(s)) return false;
      if (policy === "continue" && isTerminalFailure(s)) return false;
      return true;
    });

    if (remainingBlockers.length === task.blockedBy.length) continue;

    const next: OrchestratorTaskRecord = {
      ...task,
      blockedBy: remainingBlockers,
      ...(remainingBlockers.length === 0
        ? { status: "ready" as const, readyAt: task.readyAt ?? now }
        : {}),
    };
    deps.tasks.update(next);
    refreshGoalStatus(deps, task.goalId);
    updated++;
    deps.runtime.log(
      "info",
      `scheduler: reconciled blockers for "${task.name}" (${task.blockedBy.length} → ${remainingBlockers.length})`,
    );
  }

  return updated;
}

// ── Stall watchdog ────────────────────────────────────────────────────────

export function reconcileStaleRuns(
  deps: SchedulerDeps,
  defaultStallThresholdMs: number,
): number {
  const nowMs = (deps.now ?? Date.now)();
  let reconciled = 0;

  for (const status of ["running", "dispatched"] as const) {
    const tasks = deps.tasks.findByStatus(status);
    for (const task of tasks) {
      const threshold = task.timeoutMs ?? defaultStallThresholdMs;
      const lastActivity =
        task.latestCheckpoint?.checkpointAt ?? task.startedAt ?? 0;
      if (nowMs - lastActivity <= threshold) continue;

      const silentMin = Math.round((nowMs - lastActivity) / 60_000);

      // auto_once: hand a silent run one fresh re-dispatch before declaring it
      // stalled. Three guards keep the retry from corrupting state:
      //  - attemptCount < MAX bounds it to a single retry (every dispatch bumps
      //    the count, so the first stall sees attemptCount === 1).
      //  - the parent goal must still be active — otherwise the same tick's
      //    dispatchOrphanedReadyTasks (which does not filter by goal status)
      //    would launch fresh work for an already failed/cancelled workflow.
      //  - the abandoned attempt is closed (stalled) before the reset, so a
      //    later completion finalizes the retry's attempt rather than this one
      //    (finalizeRunningAttempt picks the first running attempt by order).
      // The reset clears the activity clock (startedAt + latestCheckpoint) and
      // run identity so dispatchOrphanedReadyTasks re-runs it with a full
      // timeout window. Clearing startedAt is load-bearing: the dispatcher sets
      // `startedAt ?? now`, so a stale clock would survive and re-stall the
      // retry on the next tick instead of giving it its own window.
      const goal = deps.goals.get(task.goalId);
      const goalActive = goal !== undefined && !isTerminalGoalStatus(goal.status);
      if (
        task.retryPolicy === "auto_once" &&
        task.attemptCount < AUTO_ONCE_MAX_ATTEMPTS &&
        goalActive
      ) {
        const abandoned = task.attempts.find((a) => a.status === "running");
        if (abandoned) {
          deps.tasks.updateAttempt(abandoned.attemptId, {
            status: "stalled",
            endedAt: nowMs,
          });
        }
        deps.tasks.update({
          ...task,
          status: "ready",
          activeRunId: undefined,
          activeSessionKey: undefined,
          startedAt: undefined,
          latestCheckpoint: undefined,
          readyAt: nowMs,
          failureReason: undefined,
        });
        refreshGoalStatus(deps, task.goalId);
        reconciled++;
        deps.runtime.log(
          "warn",
          `scheduler: re-dispatching stalled auto_once task "${task.name}" (silent ${silentMin}min, retry ${task.attemptCount}/${AUTO_ONCE_MAX_ATTEMPTS - 1})`,
        );
        continue;
      }

      deps.tasks.update({
        ...task,
        status: "stalled",
        failureReason: `watchdog: exceeded ${Math.round(threshold / 1000)}s timeout (silent ${silentMin}min)`,
      });
      refreshGoalStatus(deps, task.goalId);
      reconciled++;
      deps.runtime.log(
        "warn",
        `scheduler: reconciled stale task "${task.name}" (silent ${silentMin}min, threshold ${Math.round(threshold / 60_000)}min)`,
      );
    }
  }

  // "ready" tasks that never reached dispatch — measured against readyAt
  // (when the task transitioned to ready), not goal.createdAt.
  const readyTasks = deps.tasks.findByStatus("ready");
  for (const task of readyTasks) {
    const threshold =
      (task.timeoutMs ?? defaultStallThresholdMs) * READY_WATCHDOG_MULTIPLIER;
    const goal = deps.goals.get(task.goalId);
    if (!goal) continue;
    const readyAt = task.readyAt ?? goal.createdAt;
    const ageMs = nowMs - readyAt;
    if (ageMs > threshold) {
      deps.tasks.update({
        ...task,
        status: "stalled",
        failureReason: `watchdog: ready task never dispatched (ready age ${Math.round(ageMs / 60_000)}min, threshold ${Math.round(threshold / 60_000)}min)`,
      });
      refreshGoalStatus(deps, task.goalId);
      reconciled++;
      deps.runtime.log(
        "warn",
        `scheduler: reconciled stuck-ready task "${task.name}" (ready age ${Math.round(ageMs / 60_000)}min)`,
      );
    }
  }

  return reconciled;
}

// ── Orphan dispatch ───────────────────────────────────────────────────────

export async function dispatchOrphanedReadyTasks(
  deps: SchedulerDeps,
): Promise<number> {
  const readyTasks = deps.tasks.findByStatus("ready");
  let dispatched = 0;
  for (const task of readyTasks) {
    if (task.dispatch.mode !== "spawn" && task.dispatch.mode !== "exec") {
      continue;
    }
    if (task.activeRunId) continue;
    // The store column `failed_dispatch_count INTEGER NOT NULL DEFAULT 0`
    // guarantees a number on read — type assertion is safe.
    const priorFailedCount = task.failedDispatchCount as number;
    try {
      const ok =
        task.dispatch.mode === "exec"
          ? await deps.dispatcher.dispatchExecTask(task)
          : await deps.dispatcher.dispatchSpawnTask(task);
      if (ok) {
        dispatched++;
        // Reset the failure counter on a successful dispatch.
        if (priorFailedCount > 0) {
          deps.tasks.update({ ...task, failedDispatchCount: 0 });
        }
        deps.runtime.log(
          "info",
          `scheduler: dispatched orphaned ready task "${task.name}" (${task.dispatch.mode})`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Transient gateway-scope-unbound error: don't burn the retry budget.
      if (msg.includes(GATEWAY_SCOPE_TRANSIENT_MSG)) {
        deps.runtime.log(
          "info",
          `scheduler: deferring orphaned-dispatch for "${task.name}" (gateway-scope unbound at tick; will retry on next agent wake)`,
        );
        continue;
      }
      const nextCount = priorFailedCount + 1;
      if (nextCount >= MAX_FAILED_DISPATCHES_BEFORE_TERMINAL_FAIL) {
        deps.tasks.update({
          ...task,
          failedDispatchCount: nextCount,
          status: "failed",
          failureReason: `dispatch retries exhausted (${nextCount} attempts): ${msg}`,
        });
        refreshGoalStatus(deps, task.goalId);
        deps.runtime.log(
          "error",
          `scheduler: task "${task.name}" terminal-failed after ${nextCount} dispatch attempts: ${msg}`,
        );
      } else {
        deps.tasks.update({ ...task, failedDispatchCount: nextCount });
        deps.runtime.log(
          "warn",
          `scheduler: failed to dispatch orphaned task "${task.name}" (attempt ${nextCount}/${MAX_FAILED_DISPATCHES_BEFORE_TERMINAL_FAIL}): ${msg}`,
        );
      }
    }
  }
  return dispatched;
}

// ── Cron-goal retention sweep ─────────────────────────────────────────────

export type RetentionSweepResult = {
  readonly goalsDeleted: number;
  readonly tasksDeleted: number;
  readonly tracesDeleted: number;
};

/**
 * Delete terminal (completed/failed) goals of SCHEDULED workflows whose
 * completion is older than the retention window, along with their tasks,
 * attempts, and (when a traces store is provided) traces. There are no FK
 * cascades in the schema — children are removed explicitly, leaf-first.
 *
 * Ratified policy (2026-07-10): any terminal goal of a workflow currently in
 * the schedules table, older than the retention window, is operational
 * exhaust — regardless of who instantiated it. That includes manual
 * `run_workflow` replays of a scheduled template, and legacy rows from before
 * `created_by` origin-stamping existed, which the previous
 * `created_by = 'scheduler'` guard left immortal. The remaining guards:
 * schedules-table membership, terminal status, and `type = 'project'` —
 * one-off goals of non-scheduled workflows and evergreen concerns are never
 * touched. The per-workflow id lookup runs against idx_goals_workflow, so the
 * sweep is an indexed no-op when nothing expired.
 */
export function sweepCronGoalRetention(
  deps: SchedulerDeps,
): RetentionSweepResult {
  const now = (deps.now ?? Date.now)();
  const retentionMs = deps.cronGoalRetentionMs ?? CRON_GOAL_RETENTION_MS;
  const cutoff = now - retentionMs;

  const cronWorkflowIds = new Set(
    deps.schedules.listAll().map((s) => s.workflowId),
  );

  let goalsDeleted = 0;
  let tasksDeleted = 0;
  let tracesDeleted = 0;
  for (const workflowId of cronWorkflowIds) {
    const goalIds = deps.goals.findTerminalIdsByWorkflowBefore(
      workflowId,
      cutoff,
    );
    for (const goalId of goalIds) {
      // Collect task ids BEFORE deleting the tasks: traces may carry a
      // task_id with no goal_id, and goal-only deletion would orphan them.
      const taskIds = deps.tasks.listForGoal(goalId).map((t) => t.id);
      tracesDeleted += deps.traces?.deleteByGoal(goalId, taskIds) ?? 0;
      tasksDeleted += deps.tasks.deleteByGoal(goalId);
      deps.goals.delete(goalId);
      goalsDeleted++;
    }
  }

  if (goalsDeleted > 0) {
    deps.runtime.log(
      "info",
      `scheduler: retention sweep deleted ${goalsDeleted} cron goals (${tasksDeleted} tasks, ${tracesDeleted} traces) older than ${Math.round(retentionMs / 86_400_000)}d`,
    );
  }
  return { goalsDeleted, tasksDeleted, tracesDeleted };
}

// Module-level last-sweep clock so the hourly throttle survives across tick
// invocations (the brain plugin rebuilds the deps object every tick). Same
// module-state-plus-test-reset pattern as the migration registry.
let lastRetentionSweepAt = 0;

/** Test-only helper: reset the retention sweep throttle. */
export function resetRetentionSweepForTests(): void {
  lastRetentionSweepAt = 0;
}

// ── Full tick ─────────────────────────────────────────────────────────────

export async function tick(
  deps: SchedulerDeps,
  stallThresholdMs: number,
): Promise<TickResult> {
  const reconciled = reconcileStaleRuns(deps, stallThresholdMs);
  const probed = (await deps.dispatcher.probeSessionLiveness()).length;
  const dependenciesReconciled = reconcileCompletedDependencies(deps);
  const goalsFinalized = finalizeTerminalGoals(deps);
  const statusRefreshed = refreshScheduleStatuses(deps);
  const orphansDispatched = await dispatchOrphanedReadyTasks(deps);
  const scan = await scanSchedules(deps);

  // Retention sweep — throttled to at most once per hour.
  const now = (deps.now ?? Date.now)();
  let retentionSweptGoals = 0;
  if (now - lastRetentionSweepAt >= RETENTION_SWEEP_INTERVAL_MS) {
    lastRetentionSweepAt = now;
    retentionSweptGoals = sweepCronGoalRetention(deps).goalsDeleted;
  }

  return {
    ...scan,
    reconciled,
    dependenciesReconciled,
    probed,
    goalsFinalized,
    statusRefreshed,
    orphansDispatched,
    retentionSweptGoals,
  };
}
