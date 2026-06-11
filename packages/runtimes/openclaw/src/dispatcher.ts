/**
 * openclaw Dispatcher — implements `brain-orchestrator`'s `Dispatcher`
 * interface using openclaw's `runtime.subagent.run` (for spawn tasks) and
 * `runtime.execRun` (for exec tasks). This is the seam that lets the
 * scheduler tick actually fire work via openclaw.
 *
 * The Dispatcher is intentionally minimal: it dispatches the task, records
 * an attempt in the tasks store, and refreshes the goal status. Resource-
 * isolation (touched-files overlap), prompt templating, and post-spawn
 * lifecycle hooks (subagent_ended) are upstream-specific complexities
 * deferred to a later pass — the scheduler's stall watchdog already
 * handles tasks that get stuck.
 *
 * Open-source defaults:
 *   - No hardcoded agentId for spawn tasks — the task's dispatch must
 *     supply one (`createWorkflowFromSteps` already enforces this).
 *   - No hardcoded session-key format — the dispatcher uses a stable
 *     `orch-<taskId>` shape that the openclaw runtime can override via a
 *     caller-supplied `sessionKeyFor(task)` callback.
 */

import { randomUUID } from "node:crypto";
import { refreshGoalStatus, resolveDependents } from "@digital-me/brain-orchestrator";
import type {
  Dispatcher,
  GoalsStore,
  OrchestratorTaskRecord,
  TasksStore,
} from "@digital-me/brain-orchestrator";
import type {
  ExecRunArgs,
  ExecRunResult,
  OpenClawRuntime,
} from "@digital-me/brain-orchestrator";

export type OpenClawDispatcherDeps = {
  readonly goals: GoalsStore;
  readonly tasks: TasksStore;
  readonly runtime: OpenClawRuntime;
  readonly now?: () => number;
  readonly newId?: () => string;
  /**
   * Build the openclaw session key for a spawn task. Defaults to
   * `orch-<task.id>`. Override when the host wants per-attempt session
   * keys (e.g. `orch-<task.id>-attempt-<n>`) to avoid clobbering an
   * earlier attempt's chat history.
   */
  readonly sessionKeyFor?: (task: OrchestratorTaskRecord) => string;
};

export function createOpenClawDispatcher(
  deps: OpenClawDispatcherDeps,
): Dispatcher {
  return {
    async dispatchSpawnTask(task) {
      return await dispatchSpawn(deps, task);
    },
    async dispatchExecTask(task) {
      return await dispatchExec(deps, task);
    },
    async probeSessionLiveness() {
      // Minimum-viable: rely on the scheduler's stall watchdog rather
      // than actively probing subagent sessions. The watchdog already
      // marks tasks "stalled" when no checkpoint arrives within the
      // task's timeoutMs, so silent-session detection still works.
      return [];
    },
  };
}

async function dispatchSpawn(
  deps: OpenClawDispatcherDeps,
  task: OrchestratorTaskRecord,
): Promise<boolean> {
  if (task.status !== "ready") return false;
  if (task.activeRunId) return false;
  if (task.dispatch.mode !== "spawn") return false;

  const sessionKey = (deps.sessionKeyFor ?? defaultSessionKey)(task);
  const newId = deps.newId ?? randomUUID;
  const now = (deps.now ?? Date.now)();

  let runResult: { runId: string };
  try {
    runResult = await deps.runtime.subagent.run({
      sessionKey,
      message: task.task,
      deliver: false,
      model: task.dispatch.model,
      idempotencyKey: `orch-${task.id}-${task.attemptCount + 1}`,
      ...(task.originator?.channel && { channel: task.originator.channel }),
      ...(task.originator?.accountId && { accountId: task.originator.accountId }),
      ...(task.originator?.threadId && { threadId: task.originator.threadId }),
      ...(task.dispatch.agentId ? { agentId: task.dispatch.agentId } : {}),
    });
  } catch (err) {
    deps.runtime.log(
      "error",
      `dispatcher: spawn for "${task.name}" failed: ${(err as Error).message}`,
    );
    throw err;
  }

  const attemptId = newId();
  deps.tasks.createAttempt({
    attemptId,
    taskId: task.id,
    attemptNumber: task.attemptCount + 1,
    runId: runResult.runId,
    sessionKey,
    status: "running",
    startedAt: now,
  });
  deps.tasks.update({
    ...task,
    activeRunId: runResult.runId,
    activeSessionKey: sessionKey,
    status: "running",
    startedAt: task.startedAt ?? now,
    attemptCount: task.attemptCount + 1,
    attempts: [
      ...task.attempts,
      {
        attemptId,
        attemptNumber: task.attemptCount + 1,
        runId: runResult.runId,
        sessionKey,
        status: "running",
        startedAt: now,
      },
    ],
  });
  refreshGoalStatus({ goals: deps.goals, tasks: deps.tasks, now: deps.now }, task.goalId);
  deps.runtime.log("info", `dispatcher: spawned "${task.name}" (runId=${runResult.runId})`);
  return true;
}

async function dispatchExec(
  deps: OpenClawDispatcherDeps,
  task: OrchestratorTaskRecord,
): Promise<boolean> {
  if (task.status !== "ready") return false;
  if (task.activeRunId) return false;
  if (task.dispatch.mode !== "exec") return false;
  if (!deps.runtime.execRun) {
    deps.runtime.log(
      "error",
      `dispatcher: execRun unavailable, cannot dispatch "${task.name}"`,
    );
    return false;
  }
  const dispatch = task.dispatch;
  const newId = deps.newId ?? randomUUID;
  const now = (deps.now ?? Date.now)();
  const attemptId = newId();

  // Record the attempt BEFORE shelling out so a hang/abort doesn't leave
  // the task without an attempt row (the watchdog reads attempts for
  // diagnostic context).
  deps.tasks.createAttempt({
    attemptId,
    taskId: task.id,
    attemptNumber: task.attemptCount + 1,
    runId: attemptId, // exec uses its own attempt id as the "run id"
    sessionKey: undefined,
    status: "running",
    startedAt: now,
  });
  deps.tasks.update({
    ...task,
    activeRunId: attemptId,
    status: "running",
    startedAt: task.startedAt ?? now,
    attemptCount: task.attemptCount + 1,
    attempts: [
      ...task.attempts,
      {
        attemptId,
        attemptNumber: task.attemptCount + 1,
        runId: attemptId,
        status: "running",
        startedAt: now,
      },
    ],
  });
  refreshGoalStatus({ goals: deps.goals, tasks: deps.tasks, now: deps.now }, task.goalId);

  const execArgs: ExecRunArgs = {
    command: dispatch.command,
    cwd: dispatch.cwd,
    env: dispatch.env,
    timeoutMs: dispatch.timeoutMs,
  };
  const execRun = deps.runtime.execRun;

  // Fire-and-forget. The attempt is already recorded as running, so resolve the
  // dispatch immediately rather than blocking the scheduler tick on the child's
  // full lifetime — alias-resolved exec tasks set timeoutMs up to ~65min, and
  // the scheduler awaits each dispatch serially, so one long exec would
  // otherwise stall all subsequent ready-task dispatch + schedule scanning for
  // the tick. Finalize from a detached promise; errors are caught INSIDE it (a
  // synchronous throw here would surface as an unhandled rejection). Mirrors
  // dispatchSpawn's fire-and-forget contract; the stall watchdog still handles
  // hangs.
  void Promise.resolve()
    .then(() => execRun(execArgs))
    .then((result) => finalizeExecResult(deps, task, attemptId, result))
    .catch((err) => {
      deps.runtime.log(
        "error",
        `dispatcher: exec for "${task.name}" threw: ${(err as Error).message}`,
      );
      finalizeExecFailure(deps, task, attemptId, (err as Error).message);
    });
  return true;
}

function finalizeExecResult(
  deps: OpenClawDispatcherDeps,
  task: OrchestratorTaskRecord,
  attemptId: string,
  result: ExecRunResult,
): void {
  const now = (deps.now ?? Date.now)();
  if (result.success) {
    deps.tasks.updateAttempt(attemptId, {
      status: "completed",
      endedAt: now,
      outputSummary: truncate(result.stdout, 4000),
    });
    deps.tasks.update({
      ...deps.tasks.get(task.id)!,
      status: "completed",
      completedAt: now,
      activeRunId: undefined,
    });
    resolveDependents({ goals: deps.goals, tasks: deps.tasks, now: deps.now }, task.id);
    refreshGoalStatus({ goals: deps.goals, tasks: deps.tasks, now: deps.now }, task.goalId);
    deps.runtime.log("info", `dispatcher: exec "${task.name}" succeeded`);
  } else {
    finalizeExecFailure(
      deps,
      task,
      attemptId,
      result.error ?? `exit code ${result.exitCode ?? "?"}; stderr: ${truncate(result.stderr, 500)}`,
      result.timedOut ? "timeout" : "failed",
      // Preserve stdout on failure too — the success path captures it
      // into outputSummary; on failure we used to discard stdout entirely,
      // leaving operators a "exit code 1; stderr: " black box (e.g. the
      // dream-cycle compile step's silent crashes). Same 4000-char cap.
      truncate(result.stdout, 4000),
    );
  }
}

function finalizeExecFailure(
  deps: OpenClawDispatcherDeps,
  task: OrchestratorTaskRecord,
  attemptId: string,
  failureReason: string,
  attemptStatus: "failed" | "timeout" = "failed",
  outputSummary?: string,
): void {
  const now = (deps.now ?? Date.now)();
  deps.tasks.updateAttempt(attemptId, {
    status: attemptStatus,
    endedAt: now,
    failureReason,
    // Optional — only the exec dispatcher's failure path passes stdout
    // through; other call sites (timeout, watchdog) leave this undefined
    // since they don't have child-process output to capture.
    ...(outputSummary !== undefined ? { outputSummary } : {}),
  });
  const t = deps.tasks.get(task.id);
  if (!t) return;
  deps.tasks.update({
    ...t,
    status: "failed",
    failureReason,
    activeRunId: undefined,
  });
  refreshGoalStatus({ goals: deps.goals, tasks: deps.tasks, now: deps.now }, task.goalId);
  deps.runtime.log("error", `dispatcher: exec "${task.name}" failed: ${failureReason}`);
}

function defaultSessionKey(task: OrchestratorTaskRecord): string {
  return `orch-${task.id}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}
