import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  createGoalsStore,
  GOALS_MIGRATIONS,
  type GoalRecord,
} from "../store/goals.js";
import {
  createSchedulesStore,
  SCHEDULES_MIGRATIONS,
  type ScheduleRecord,
} from "../store/schedules.js";
import {
  createTasksStore,
  TASKS_MIGRATIONS,
  type OrchestratorTaskRecord,
} from "../store/tasks.js";
import {
  createWorkflowsStore,
  WORKFLOWS_MIGRATIONS,
  type WorkflowTemplateRecord,
} from "../store/workflows.js";
import {
  createTracesStore,
  TRACES_MIGRATIONS,
} from "../store/traces.js";
import type { Migration } from "../store/migrations.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "../store/migrations.js";
import {
  CRON_GOAL_RETENTION_MS,
  dispatchOrphanedReadyTasks,
  finalizeTerminalGoals,
  reconcileCompletedDependencies,
  reconcileStaleRuns,
  refreshScheduleStatuses,
  resetRetentionSweepForTests,
  RETENTION_SWEEP_INTERVAL_MS,
  scanSchedules,
  sweepCronGoalRetention,
  tick,
  type Dispatcher,
  type SchedulerDeps,
  type SchedulerRuntime,
  type WorkflowInstantiator,
} from "./scheduler.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of [
    ...GOALS_MIGRATIONS,
    ...TASKS_MIGRATIONS,
    ...WORKFLOWS_MIGRATIONS,
    ...SCHEDULES_MIGRATIONS,
    ...TRACES_MIGRATIONS,
  ] as Migration[]) {
    registerMigration(m);
  }
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

type LogEntry = { level: "info" | "warn" | "error"; message: string };

function makeRuntime(): { runtime: SchedulerRuntime; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  return {
    runtime: {
      log(level, message) {
        logs.push({ level, message });
      },
    },
    logs,
  };
}

function makeDispatcher(
  overrides: Partial<Dispatcher> = {},
): {
  dispatcher: Dispatcher;
  spawnCalls: OrchestratorTaskRecord[];
  execCalls: OrchestratorTaskRecord[];
} {
  const spawnCalls: OrchestratorTaskRecord[] = [];
  const execCalls: OrchestratorTaskRecord[] = [];
  const dispatcher: Dispatcher = {
    async dispatchSpawnTask(t) {
      spawnCalls.push(t);
      return true;
    },
    async dispatchExecTask(t) {
      execCalls.push(t);
      return true;
    },
    async probeSessionLiveness() {
      return [];
    },
    ...overrides,
  };
  return { dispatcher, spawnCalls, execCalls };
}

function makeDeps(opts: {
  instantiateWorkflow?: WorkflowInstantiator;
  dispatcher?: Dispatcher;
  now?: number;
  runtime?: SchedulerRuntime;
  traces?: SchedulerDeps["traces"];
  cronGoalRetentionMs?: number;
}): { deps: SchedulerDeps; logs: LogEntry[] } {
  const r = opts.runtime ? { runtime: opts.runtime, logs: [] as LogEntry[] } : makeRuntime();
  const goals = createGoalsStore({ db });
  const schedules = createSchedulesStore({ db });
  const tasks = createTasksStore({ db });
  const workflows = createWorkflowsStore({ db });
  const dispatcher = opts.dispatcher ?? makeDispatcher().dispatcher;
  const instantiateWorkflow: WorkflowInstantiator =
    opts.instantiateWorkflow ??
    (async () => ({ ok: true, goalId: "g-new", taskCount: 1, dispatched: 1 }));
  const deps: SchedulerDeps = {
    goals,
    schedules,
    tasks,
    workflows,
    runtime: r.runtime,
    dispatcher,
    instantiateWorkflow,
    now: opts.now !== undefined ? () => opts.now! : undefined,
    traces: opts.traces,
    cronGoalRetentionMs: opts.cronGoalRetentionMs,
  };
  return { deps, logs: r.logs };
}

function seedWorkflow(deps: SchedulerDeps, id: string = "wf-1"): void {
  const wf: WorkflowTemplateRecord = {
    id,
    name: id,
    description: "",
    variables: [],
    createdAt: 0,
    updatedAt: 0,
    version: 1,
  };
  deps.workflows.create(wf);
}

function seedSchedule(
  deps: SchedulerDeps,
  overrides: Partial<ScheduleRecord> = {},
): ScheduleRecord {
  const s: ScheduleRecord = {
    id: "sched-1",
    workflowId: "wf-1",
    name: "nightly",
    cronExpr: "0 0 * * *",
    timezone: "UTC",
    variables: {},
    enabled: true,
    nextRunAt: 0,
    maxOverlap: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
  deps.schedules.create(s);
  return s;
}

function seedGoal(
  deps: SchedulerDeps,
  overrides: Partial<GoalRecord> = {},
): GoalRecord {
  const g: GoalRecord = {
    id: "g-1",
    name: "G",
    description: "",
    status: "running",
    type: "project",
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "t",
    ...overrides,
  };
  deps.goals.create(g);
  return g;
}

function seedTask(
  deps: SchedulerDeps,
  overrides: Partial<OrchestratorTaskRecord> = {},
): OrchestratorTaskRecord {
  const t: OrchestratorTaskRecord = {
    id: "t-1",
    goalId: "g-1",
    name: "T",
    task: "x",
    blockedBy: [],
    dispatch: { mode: "spawn", agentId: "agent-x" },
    status: "ready",
    attemptCount: 0,
    attempts: [],
    priority: "normal",
    onUpstreamFailure: "wait",
    ...overrides,
  };
  deps.tasks.create(t);
  return t;
}

// ── scanSchedules ─────────────────────────────────────────────────────────

describe("scanSchedules", () => {
  it("returns zeroes when there are no due schedules", async () => {
    const { deps } = makeDeps({});
    const r = await scanSchedules(deps, 1000);
    expect(r).toEqual({ scanned: 0, instantiated: 0, skipped: 0, errors: 0 });
  });

  it("instantiates a due schedule and updates lastGoalId/lastStatus", async () => {
    const { deps, logs } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps, {
      nextRunAt: 500,
      cronExpr: "0 0 * * *",
    });
    const r = await scanSchedules(deps, 1000);
    expect(r.instantiated).toBe(1);
    const s = deps.schedules.get("sched-1")!;
    expect(s.lastGoalId).toBe("g-new");
    expect(s.lastStatus).toBe("running");
    expect(s.nextRunAt).toBeGreaterThan(500);
    expect(logs.some((l) => l.message.includes("instantiated"))).toBe(true);
  });

  it("disables the schedule when the workflow is missing", async () => {
    const { deps, logs } = makeDeps({});
    seedSchedule(deps, { nextRunAt: 500 });
    const r = await scanSchedules(deps, 1000);
    expect(r.errors).toBe(1);
    expect(deps.schedules.get("sched-1")!.enabled).toBe(false);
    expect(logs.some((l) => l.message.includes("not found"))).toBe(true);
  });

  it("skips when maxOverlap=0 and another active goal exists for the workflow", async () => {
    const { deps, logs } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: 500 });
    deps.goals.create({
      id: "g-active",
      name: "active",
      description: "",
      status: "running",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
      sourceWorkflowId: "wf-1",
    });
    const r = await scanSchedules(deps, 1000);
    expect(r.skipped).toBe(1);
    expect(logs.some((l) => l.message.includes("at concurrency cap"))).toBe(true);
  });

  const mkActiveGoal = (id: string) => ({
    id, name: "active", description: "", status: "running" as const,
    type: "project" as const, taskIds: [], createdAt: 0, updatedAt: 0,
    createdBy: "t", sourceWorkflowId: "wf-1",
  });

  it("fires under a positive maxOverlap cap (maxOverlap=1, one active goal)", async () => {
    const { deps } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: 500, maxOverlap: 1 });
    deps.goals.create(mkActiveGoal("g-1"));
    const r = await scanSchedules(deps, 1000);
    expect(r.instantiated).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it("skips at a positive maxOverlap cap (maxOverlap=1, two active goals)", async () => {
    const { deps } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: 500, maxOverlap: 1 });
    deps.goals.create(mkActiveGoal("g-1"));
    deps.goals.create(mkActiveGoal("g-2"));
    const r = await scanSchedules(deps, 1000);
    expect(r.instantiated).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("does not reject the whole tick when a malformed-cron schedule hits the overlap-skip path", async () => {
    // Regression (S1): maxOverlap=0 + an in-flight goal sends processSchedule
    // down the overlap-skip → advanceSchedule path; with a malformed cron,
    // advanceSchedule used to throw out of scanSchedules' catch and reject the
    // entire tick. Now cron is validated first (disable) and advanceSchedule is
    // total, so the tick resolves cleanly.
    const { deps } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: 500, maxOverlap: 0, cronExpr: "totally invalid" });
    deps.goals.create({
      id: "g-active", name: "active", description: "", status: "running",
      type: "project", taskIds: [], createdAt: 0, updatedAt: 0,
      createdBy: "t", sourceWorkflowId: "wf-1",
    });
    const r = await scanSchedules(deps, 1000);
    expect(r.errors).toBe(1);
    expect(deps.schedules.get("sched-1")!.enabled).toBe(false);
  });

  it("disables the schedule when the cron expression is malformed", async () => {
    const { deps, logs } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: 500, cronExpr: "totally invalid" });
    const r = await scanSchedules(deps, 1000);
    expect(r.errors).toBe(1);
    expect(deps.schedules.get("sched-1")!.enabled).toBe(false);
    expect(logs.some((l) => l.message.includes("bad cron"))).toBe(true);
  });

  it("skips when the atomic claim is lost to a concurrent tick", async () => {
    const { deps, logs } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: 500 });
    // Simulate a concurrent claim by advancing the row's next_run_at out from
    // under processSchedule via a direct DB write between the read and the claim.
    const origClaim = deps.schedules.claim.bind(deps.schedules);
    let claimCalls = 0;
    deps.schedules.claim = (id, expected, next, now) => {
      claimCalls++;
      // Force the claim to return false on the first try.
      if (claimCalls === 1) return false;
      return origClaim(id, expected, next, now);
    };
    const r = await scanSchedules(deps, 1000);
    expect(r.skipped).toBe(1);
    expect(logs.some((l) => l.message.includes("already claimed by concurrent tick"))).toBe(true);
  });

  it("marks the schedule lastStatus=failed when the instantiator returns ok:false", async () => {
    const { deps, logs } = makeDeps({
      instantiateWorkflow: async () => ({ ok: false, error: "boom" }),
    });
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: 500 });
    const r = await scanSchedules(deps, 1000);
    expect(r.errors).toBe(1);
    expect(deps.schedules.get("sched-1")!.lastStatus).toBe("failed");
    expect(logs.some((l) => l.message.includes("boom"))).toBe(true);
  });

  it("catches sync throws from processSchedule and still advances the schedule", async () => {
    const { deps, logs } = makeDeps({
      instantiateWorkflow: async () => {
        throw new Error("synthetic instantiator failure");
      },
    });
    seedWorkflow(deps);
    const original = seedSchedule(deps, { nextRunAt: 500 });
    const r = await scanSchedules(deps, 1000);
    expect(r.errors).toBe(1);
    // advanceSchedule should have updated next_run_at past the original.
    expect(deps.schedules.get("sched-1")!.nextRunAt).toBeGreaterThan(
      original.nextRunAt,
    );
    expect(logs.some((l) => l.message.includes("failed to process schedule"))).toBe(true);
  });

  it("catches non-Error throws and formats with String()", async () => {
    const { deps, logs } = makeDeps({
      instantiateWorkflow: async () => {
        throw "raw-string-error";
      },
    });
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: 500 });
    await scanSchedules(deps, 1000);
    expect(logs.some((l) => l.message.includes("raw-string-error"))).toBe(true);
  });

  it("disables a malformed-cron schedule when advanceSchedule is reached via the scan catch path", async () => {
    // Force processSchedule to throw BEFORE its own cron validation so
    // scanSchedules' catch calls advanceSchedule with the malformed expr —
    // its internal parse-failure guard must disable the schedule instead of
    // rejecting the tick.
    const { deps, logs } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: 500, cronExpr: "totally invalid" });
    deps.workflows.get = () => {
      throw new Error("synthetic workflows.get failure");
    };
    const r = await scanSchedules(deps, 1000);
    expect(r.errors).toBe(1);
    expect(deps.schedules.get("sched-1")!.enabled).toBe(false);
    expect(
      logs.some((l) => l.message.includes("advanceSchedule cron parse failed")),
    ).toBe(true);
  });

  it("uses deps.now when no explicit nowMs is passed", async () => {
    const { deps } = makeDeps({ now: 1000 });
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: 500 });
    const r = await scanSchedules(deps);
    expect(r.instantiated).toBe(1);
  });

  it("defaults clock to Date.now when neither nowMs nor deps.now is provided", async () => {
    const { deps } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps, { nextRunAt: Date.now() - 1000 });
    const r = await scanSchedules(deps);
    expect(r.instantiated).toBe(1);
  });

});

// ── finalizeTerminalGoals ─────────────────────────────────────────────────

describe("finalizeTerminalGoals", () => {
  it("transitions a running goal whose tasks all completed", () => {
    const { deps, logs } = makeDeps({});
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "t1", goalId: "g-1", status: "completed" });
    const n = finalizeTerminalGoals(deps);
    expect(n).toBe(1);
    expect(deps.goals.get("g-1")!.status).toBe("completed");
    expect(logs.some((l) => l.message.includes("finalized stale goal"))).toBe(true);
  });

  it("transitions a running goal to failed when any task is failed", () => {
    const { deps } = makeDeps({});
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "t1", goalId: "g-1", status: "failed" });
    expect(finalizeTerminalGoals(deps)).toBe(1);
    expect(deps.goals.get("g-1")!.status).toBe("failed");
  });

  it("returns 0 when no transitions happen", () => {
    const { deps } = makeDeps({});
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "t1", goalId: "g-1", status: "running" });
    expect(finalizeTerminalGoals(deps)).toBe(0);
  });
});

// ── refreshScheduleStatuses ───────────────────────────────────────────────

describe("refreshScheduleStatuses", () => {
  it("updates schedule.lastStatus when the parent goal moved to a new state", () => {
    const { deps } = makeDeps({});
    seedWorkflow(deps);
    seedGoal(deps, { id: "g-done", status: "completed" });
    seedSchedule(deps, {
      lastGoalId: "g-done",
      lastStatus: "running",
    });
    const n = refreshScheduleStatuses(deps);
    expect(n).toBe(1);
    expect(deps.schedules.get("sched-1")!.lastStatus).toBe("completed");
  });

  it("skips schedules with no recorded lastGoalId or lastStatus", () => {
    const { deps } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps); // no lastGoalId/lastStatus
    expect(refreshScheduleStatuses(deps)).toBe(0);
  });

  it("skips schedules whose lastStatus is terminal", () => {
    const { deps } = makeDeps({});
    seedWorkflow(deps);
    seedGoal(deps, { id: "g-1", status: "running" });
    seedSchedule(deps, { lastGoalId: "g-1", lastStatus: "completed" });
    expect(refreshScheduleStatuses(deps)).toBe(0);
  });

  it("skips when the goal referenced by lastGoalId no longer exists", () => {
    const { deps } = makeDeps({});
    seedWorkflow(deps);
    seedSchedule(deps, { lastGoalId: "missing-goal", lastStatus: "running" });
    expect(refreshScheduleStatuses(deps)).toBe(0);
  });

  it("is a no-op when the schedule lastStatus already matches the goal", () => {
    const { deps } = makeDeps({});
    seedWorkflow(deps);
    seedGoal(deps, { id: "g-1", status: "running" });
    seedSchedule(deps, { lastGoalId: "g-1", lastStatus: "running" });
    expect(refreshScheduleStatuses(deps)).toBe(0);
  });

  it("uses Date.now when no clock injected", () => {
    const { deps } = makeDeps({});
    seedWorkflow(deps);
    seedGoal(deps, { id: "g-1", status: "completed" });
    seedSchedule(deps, { lastGoalId: "g-1", lastStatus: "running" });
    const before = Date.now();
    refreshScheduleStatuses(deps);
    expect(deps.schedules.get("sched-1")!.updatedAt).toBeGreaterThanOrEqual(
      before,
    );
  });
});

// ── reconcileCompletedDependencies ────────────────────────────────────────

describe("reconcileCompletedDependencies", () => {
  it("removes completed blockers and marks the dependent ready", () => {
    const { deps, logs } = makeDeps({ now: 1234 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "upstream", status: "completed" });
    seedTask(deps, {
      id: "downstream",
      status: "pending",
      blockedBy: ["upstream"],
    });

    expect(reconcileCompletedDependencies(deps)).toBe(1);

    const downstream = deps.tasks.get("downstream")!;
    expect(downstream.status).toBe("ready");
    expect(downstream.blockedBy).toEqual([]);
    expect(downstream.readyAt).toBe(1234);
    expect(logs.some((l) => l.message.includes("reconciled blockers"))).toBe(
      true,
    );
  });

  it("keeps remaining blockers when only some upstreams are terminal", () => {
    const { deps } = makeDeps({ now: 1234 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "done", status: "completed" });
    seedTask(deps, { id: "still-running", status: "running" });
    seedTask(deps, {
      id: "downstream",
      status: "pending",
      blockedBy: ["done", "still-running"],
    });

    expect(reconcileCompletedDependencies(deps)).toBe(1);

    const downstream = deps.tasks.get("downstream")!;
    expect(downstream.status).toBe("pending");
    expect(downstream.blockedBy).toEqual(["still-running"]);
  });

  it("does not unblock failed upstreams with wait policy", () => {
    const { deps } = makeDeps({ now: 1234 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "failed", status: "failed" });
    seedTask(deps, {
      id: "downstream",
      status: "pending",
      blockedBy: ["failed"],
    });

    expect(reconcileCompletedDependencies(deps)).toBe(0);
    expect(deps.tasks.get("downstream")!.status).toBe("pending");
    expect(deps.tasks.get("downstream")!.blockedBy).toEqual(["failed"]);
  });

  // ── onUpstreamFailure: continue / skip ───────────────────────────────────
  // Without honoring these policies a stalled spawn strands its fallback step
  // at `pending` forever — the exact bug that silently killed the nightly
  // dream-cycle + daily digest after every gateway perturbation.

  it("unblocks a continue dependent past a stalled upstream and marks it ready", () => {
    const { deps } = makeDeps({ now: 1234 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "spawn", status: "stalled" });
    seedTask(deps, {
      id: "apply",
      status: "pending",
      blockedBy: ["spawn"],
      onUpstreamFailure: "continue",
      dispatch: { mode: "exec", command: ["x"] },
    });

    expect(reconcileCompletedDependencies(deps)).toBe(1);

    const apply = deps.tasks.get("apply")!;
    expect(apply.status).toBe("ready");
    expect(apply.blockedBy).toEqual([]);
    expect(apply.readyAt).toBe(1234);
  });

  it("continue: tolerates a failed blocker but still waits on an active one", () => {
    const { deps } = makeDeps({ now: 1234 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "spawn", status: "failed" });
    seedTask(deps, { id: "other", status: "running" });
    seedTask(deps, {
      id: "apply",
      status: "pending",
      blockedBy: ["spawn", "other"],
      onUpstreamFailure: "continue",
    });

    expect(reconcileCompletedDependencies(deps)).toBe(1);
    const apply = deps.tasks.get("apply")!;
    expect(apply.status).toBe("pending");
    expect(apply.blockedBy).toEqual(["other"]);
  });

  it("skip: skips the dependent when an upstream terminally failed", () => {
    const { deps, logs } = makeDeps({ now: 1234 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "spawn", status: "stalled" });
    seedTask(deps, {
      id: "publish",
      status: "pending",
      blockedBy: ["spawn"],
      onUpstreamFailure: "skip",
    });

    expect(reconcileCompletedDependencies(deps)).toBe(1);
    expect(deps.tasks.get("publish")!.status).toBe("skipped");
    expect(logs.some((l) => l.message.includes("onUpstreamFailure=skip"))).toBe(
      true,
    );
  });

  it("leaves an unblocked pending task untouched", () => {
    const { deps } = makeDeps({ now: 1234 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "orphan", status: "pending", blockedBy: [] });

    expect(reconcileCompletedDependencies(deps)).toBe(0);
    expect(deps.tasks.get("orphan")!.status).toBe("pending");
  });

  it("skip: does NOT skip when upstreams are only still-running (no failure)", () => {
    const { deps } = makeDeps({ now: 1234 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "spawn", status: "running" });
    seedTask(deps, {
      id: "publish",
      status: "pending",
      blockedBy: ["spawn"],
      onUpstreamFailure: "skip",
    });

    expect(reconcileCompletedDependencies(deps)).toBe(0);
    expect(deps.tasks.get("publish")!.status).toBe("pending");
  });
});

// ── reconcileStaleRuns ────────────────────────────────────────────────────

describe("reconcileStaleRuns", () => {
  it("transitions long-running tasks to stalled", () => {
    const { deps, logs } = makeDeps({ now: 100_000 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, {
      id: "t1",
      status: "running",
      startedAt: 0,
    });
    const n = reconcileStaleRuns(deps, 1000);
    expect(n).toBe(1);
    expect(deps.tasks.get("t1")!.status).toBe("stalled");
    expect(logs.some((l) => l.level === "warn")).toBe(true);
  });

  it("uses per-task timeoutMs override when present", () => {
    const { deps } = makeDeps({ now: 5_000 });
    seedGoal(deps, { id: "g-1" });
    // task has timeoutMs=10_000 — should NOT stall yet at 5s
    seedTask(deps, {
      id: "t1",
      status: "running",
      startedAt: 0,
      timeoutMs: 10_000,
    });
    expect(reconcileStaleRuns(deps, 1000)).toBe(0);
    expect(deps.tasks.get("t1")!.status).toBe("running");
  });

  it("uses the latest checkpointAt over startedAt for activity", () => {
    const { deps } = makeDeps({ now: 100_000 });
    seedGoal(deps, { id: "g-1" });
    seedTask(deps, {
      id: "t1",
      status: "running",
      startedAt: 0,
      latestCheckpoint: {
        checkpointAt: 99_500, // fresh checkpoint
        phase: "x",
        summary: "x",
      },
    });
    expect(reconcileStaleRuns(deps, 1000)).toBe(0);
  });

  it("stall-checks dispatched tasks too", () => {
    const { deps } = makeDeps({ now: 100_000 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "t1", status: "dispatched", startedAt: 0 });
    expect(reconcileStaleRuns(deps, 1000)).toBe(1);
    expect(deps.tasks.get("t1")!.status).toBe("stalled");
  });

  it("uses a task's readyAt for ready-watchdog when present", () => {
    const { deps, logs } = makeDeps({ now: 100_000 });
    seedGoal(deps, { id: "g-1", createdAt: 0 });
    seedTask(deps, {
      id: "t1",
      status: "ready",
      readyAt: 0, // very old
    });
    // Threshold for ready is 2x default → 2000ms; nowMs - readyAt = 100000 → stall.
    expect(reconcileStaleRuns(deps, 1000)).toBe(1);
    expect(deps.tasks.get("t1")!.status).toBe("stalled");
    expect(logs.some((l) => l.message.includes("stuck-ready"))).toBe(true);
  });

  it("falls back to goal.createdAt when readyAt is missing", () => {
    const { deps } = makeDeps({ now: 100_000 });
    seedGoal(deps, { id: "g-1", createdAt: 0 });
    seedTask(deps, { id: "t1", status: "ready" });
    expect(reconcileStaleRuns(deps, 1000)).toBe(1);
  });

  it("skips ready tasks whose goal no longer exists", () => {
    const { deps } = makeDeps({ now: 100_000 });
    deps.tasks.create({
      id: "orphan",
      goalId: "ghost",
      name: "x",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "ready",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    expect(() => reconcileStaleRuns(deps, 1000)).not.toThrow();
  });

  it("uses Date.now when no clock injected", () => {
    const { deps } = makeDeps({});
    seedGoal(deps, { id: "g-1" });
    seedTask(deps, { id: "t1", status: "running", startedAt: 0 });
    const reconciled = reconcileStaleRuns(deps, 1);
    expect(reconciled).toBe(1);
  });

  it("treats a task with no checkpoint and no startedAt as having activity at epoch 0", () => {
    const { deps } = makeDeps({ now: 100_000 });
    seedGoal(deps);
    seedTask(deps, { id: "t1", status: "running" }); // no startedAt, no checkpoint
    // lastActivity = 0; nowMs - 0 > threshold → stall.
    expect(reconcileStaleRuns(deps, 1000)).toBe(1);
    expect(deps.tasks.get("t1")!.status).toBe("stalled");
  });

  it("re-dispatches a stalled auto_once task and closes the abandoned attempt", () => {
    const { deps, logs } = makeDeps({ now: 100_000 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, {
      id: "t1",
      status: "running",
      startedAt: 0,
      attemptCount: 1,
      retryPolicy: "auto_once",
      activeRunId: "run-1",
      activeSessionKey: "sess-1",
      latestCheckpoint: { checkpointAt: 0, phase: "p", summary: "s" },
    });
    deps.tasks.createAttempt({
      attemptId: "a1",
      taskId: "t1",
      attemptNumber: 1,
      runId: "run-1",
      sessionKey: "sess-1",
      status: "running",
      startedAt: 0,
    });
    expect(reconcileStaleRuns(deps, 1000)).toBe(1);
    const t = deps.tasks.get("t1")!;
    expect(t.status).toBe("ready");
    // Cleared so dispatchOrphanedReadyTasks re-runs it with a fresh clock.
    expect(t.activeRunId).toBeUndefined();
    expect(t.activeSessionKey).toBeUndefined();
    expect(t.startedAt).toBeUndefined();
    expect(t.latestCheckpoint).toBeUndefined();
    expect(t.readyAt).toBe(100_000);
    expect(t.failureReason).toBeUndefined();
    // reconcile must not burn the retry budget — the dispatcher bumps attemptCount.
    expect(t.attemptCount).toBe(1);
    // Abandoned attempt closed so a late completion targets the retry attempt.
    expect(t.attempts.find((a) => a.attemptId === "a1")!.status).toBe("stalled");
    expect(
      logs.some((l) => l.message.includes("re-dispatching stalled auto_once")),
    ).toBe(true);
  });

  it("stalls an auto_once task instead of retrying when its goal is terminal", () => {
    const { deps } = makeDeps({ now: 100_000 });
    seedGoal(deps, { id: "g-1", status: "failed" });
    seedTask(deps, {
      id: "t1",
      status: "running",
      startedAt: 0,
      attemptCount: 1,
      retryPolicy: "auto_once",
    });
    // Goal already failed → no fresh dispatch for a terminal workflow.
    expect(reconcileStaleRuns(deps, 1000)).toBe(1);
    expect(deps.tasks.get("t1")!.status).toBe("stalled");
  });

  it("stalls an auto_once task whose goal no longer exists", () => {
    const { deps } = makeDeps({ now: 100_000 });
    deps.tasks.create({
      id: "t1",
      goalId: "ghost",
      name: "x",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "spawn", agentId: "a" },
      status: "running",
      startedAt: 0,
      attemptCount: 1,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
      retryPolicy: "auto_once",
    });
    expect(reconcileStaleRuns(deps, 1000)).toBe(1);
    expect(deps.tasks.get("t1")!.status).toBe("stalled");
  });

  it("stalls an auto_once task terminally once its single retry is used", () => {
    const { deps } = makeDeps({ now: 100_000 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, {
      id: "t1",
      status: "running",
      startedAt: 0,
      attemptCount: 2, // first run + one retry already dispatched
      retryPolicy: "auto_once",
    });
    expect(reconcileStaleRuns(deps, 1000)).toBe(1);
    expect(deps.tasks.get("t1")!.status).toBe("stalled");
  });

  it("re-dispatches a stalled auto_once task in the dispatched state too", () => {
    const { deps } = makeDeps({ now: 100_000 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, {
      id: "t1",
      status: "dispatched",
      startedAt: 0,
      attemptCount: 1,
      retryPolicy: "auto_once",
    });
    expect(reconcileStaleRuns(deps, 1000)).toBe(1);
    expect(deps.tasks.get("t1")!.status).toBe("ready");
  });

  it("re-runs a stalled auto_once task within the same tick", async () => {
    const { dispatcher, spawnCalls } = makeDispatcher();
    const { deps } = makeDeps({ now: 100_000, dispatcher });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, {
      id: "t1",
      status: "running",
      startedAt: 0,
      attemptCount: 1,
      retryPolicy: "auto_once",
      activeRunId: "run-1",
    });
    await tick(deps, 1000);
    // reconcileStaleRuns resets it to ready; dispatchOrphanedReadyTasks re-runs it.
    expect(spawnCalls.map((t) => t.id)).toContain("t1");
  });
});

// ── dispatchOrphanedReadyTasks ────────────────────────────────────────────

describe("dispatchOrphanedReadyTasks", () => {
  it("dispatches a spawn-mode ready task via the dispatcher", async () => {
    const { dispatcher, spawnCalls } = makeDispatcher();
    const { deps, logs } = makeDeps({ dispatcher });
    seedGoal(deps, { id: "g-1" });
    seedTask(deps, {
      id: "t1",
      status: "ready",
      dispatch: { mode: "spawn", agentId: "agent-x" },
    });
    expect(await dispatchOrphanedReadyTasks(deps)).toBe(1);
    expect(spawnCalls).toHaveLength(1);
    expect(logs.some((l) => l.message.includes("dispatched orphaned"))).toBe(true);
  });

  it("dispatches an exec-mode ready task via the dispatcher", async () => {
    const { dispatcher, execCalls } = makeDispatcher();
    const { deps } = makeDeps({ dispatcher });
    seedGoal(deps);
    seedTask(deps, {
      id: "t1",
      status: "ready",
      dispatch: { mode: "exec", command: ["echo", "hi"] },
    });
    expect(await dispatchOrphanedReadyTasks(deps)).toBe(1);
    expect(execCalls).toHaveLength(1);
  });

  it("resets failedDispatchCount on a successful dispatch", async () => {
    const { dispatcher } = makeDispatcher();
    const { deps } = makeDeps({ dispatcher });
    seedGoal(deps);
    seedTask(deps, {
      id: "t1",
      status: "ready",
      failedDispatchCount: 3,
    });
    await dispatchOrphanedReadyTasks(deps);
    expect(deps.tasks.get("t1")!.failedDispatchCount).toBe(0);
  });

  it("skips manual-mode and approval-mode tasks", async () => {
    const { dispatcher, spawnCalls } = makeDispatcher();
    const { deps } = makeDeps({ dispatcher });
    seedGoal(deps);
    seedTask(deps, {
      id: "t1",
      status: "ready",
      dispatch: { mode: "manual" },
    });
    expect(await dispatchOrphanedReadyTasks(deps)).toBe(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it("skips tasks that already have an activeRunId", async () => {
    const { dispatcher, spawnCalls } = makeDispatcher();
    const { deps } = makeDeps({ dispatcher });
    seedGoal(deps);
    seedTask(deps, {
      id: "t1",
      status: "ready",
      activeRunId: "run-123",
    });
    expect(await dispatchOrphanedReadyTasks(deps)).toBe(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it("doesn't count a dispatcher that returns false as a success", async () => {
    const { dispatcher } = makeDispatcher({
      async dispatchSpawnTask() {
        return false;
      },
    });
    const { deps } = makeDeps({ dispatcher });
    seedGoal(deps);
    seedTask(deps, { id: "t1", status: "ready" });
    expect(await dispatchOrphanedReadyTasks(deps)).toBe(0);
  });

  it("increments failedDispatchCount on dispatcher throw without crossing the cap", async () => {
    const { dispatcher } = makeDispatcher({
      async dispatchSpawnTask() {
        throw new Error("temporary network blip");
      },
    });
    const { deps, logs } = makeDeps({ dispatcher });
    seedGoal(deps);
    seedTask(deps, { id: "t1", status: "ready" });
    await dispatchOrphanedReadyTasks(deps);
    expect(deps.tasks.get("t1")!.failedDispatchCount).toBe(1);
    expect(deps.tasks.get("t1")!.status).toBe("ready");
    expect(logs.some((l) => l.level === "warn")).toBe(true);
  });

  it("terminal-fails a task after the dispatch retry cap", async () => {
    const { dispatcher } = makeDispatcher({
      async dispatchSpawnTask() {
        throw new Error("permanent failure");
      },
    });
    const { deps, logs } = makeDeps({ dispatcher });
    seedGoal(deps);
    seedTask(deps, {
      id: "t1",
      status: "ready",
      failedDispatchCount: 4, // one more failure crosses the cap of 5
    });
    await dispatchOrphanedReadyTasks(deps);
    const t = deps.tasks.get("t1")!;
    expect(t.status).toBe("failed");
    expect(t.failureReason).toMatch(/dispatch retries exhausted/);
    expect(logs.some((l) => l.level === "error")).toBe(true);
  });

  it("defers (no budget burn) on the gateway-scope transient error", async () => {
    const { dispatcher } = makeDispatcher({
      async dispatchSpawnTask() {
        throw new Error(
          "Plugin runtime subagent methods are only available during a gateway request scope",
        );
      },
    });
    const { deps, logs } = makeDeps({ dispatcher });
    seedGoal(deps);
    seedTask(deps, {
      id: "t1",
      status: "ready",
      failedDispatchCount: 2,
    });
    await dispatchOrphanedReadyTasks(deps);
    // failure count NOT incremented for the transient.
    expect(deps.tasks.get("t1")!.failedDispatchCount).toBe(2);
    expect(deps.tasks.get("t1")!.status).toBe("ready");
    expect(logs.some((l) => l.message.includes("deferring"))).toBe(true);
  });

  it("wraps non-Error throws with String()", async () => {
    const { dispatcher } = makeDispatcher({
      async dispatchSpawnTask() {
        throw "raw-string-failure";
      },
    });
    const { deps, logs } = makeDeps({ dispatcher });
    seedGoal(deps);
    seedTask(deps, { id: "t1", status: "ready" });
    await dispatchOrphanedReadyTasks(deps);
    expect(logs.some((l) => l.message.includes("raw-string-failure"))).toBe(true);
  });
});

// ── tick ──────────────────────────────────────────────────────────────────

describe("tick", () => {
  it("runs the full pipeline and aggregates the result", async () => {
    const { dispatcher } = makeDispatcher({
      async probeSessionLiveness() {
        // Hand-built record — we just need probed > 0; the scheduler only
        // looks at the array length, not its contents.
        const stub: OrchestratorTaskRecord = {
          id: "probe-stub",
          goalId: "g-stub",
          name: "stub",
          task: "x",
          blockedBy: [],
          dispatch: { mode: "manual" },
          status: "running",
          attemptCount: 0,
          attempts: [],
          priority: "normal",
          onUpstreamFailure: "wait",
        };
        return [stub];
      },
    });
    const { deps } = makeDeps({
      dispatcher,
      instantiateWorkflow: vi.fn(async () => ({
        ok: true as const,
        goalId: "g-new",
        taskCount: 1,
        dispatched: 1,
      })),
      now: 100_000,
    });
    seedWorkflow(deps);
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "t1", goalId: "g-1", status: "completed" });
    seedSchedule(deps, { nextRunAt: 500 });
    const r = await tick(deps, 60_000);
    expect(r.scanned).toBe(1);
    expect(r.instantiated).toBe(1);
    expect(r.goalsFinalized).toBe(1);
    expect(r.dependenciesReconciled).toBe(0);
    expect(r.reconciled).toBe(0);
    expect(typeof r.probed).toBe("number");
    expect(typeof r.statusRefreshed).toBe("number");
    expect(typeof r.orphansDispatched).toBe("number");
  });

  it("reconciles completed blockers before dispatching orphaned ready tasks", async () => {
    const { dispatcher, execCalls } = makeDispatcher();
    const { deps } = makeDeps({ dispatcher, now: 1000 });
    seedGoal(deps, { id: "g-1", status: "running" });
    seedTask(deps, { id: "upstream", status: "completed" });
    seedTask(deps, {
      id: "downstream",
      status: "pending",
      blockedBy: ["upstream"],
      dispatch: { mode: "exec", command: ["next"] },
    });

    const r = await tick(deps, 60_000);

    expect(r.dependenciesReconciled).toBe(1);
    expect(r.orphansDispatched).toBe(1);
    expect(execCalls.map((t) => t.id)).toEqual(["downstream"]);
  });
});

// ── sweepCronGoalRetention ────────────────────────────────────────────────

describe("sweepCronGoalRetention", () => {
  it("deletes expired terminal cron goals with their tasks, attempts, and traces", () => {
    const traces = createTracesStore({ db });
    const { deps, logs } = makeDeps({
      now: 10_000,
      traces,
      cronGoalRetentionMs: 1_000, // cutoff = 9_000
    });
    seedWorkflow(deps, "wf-1");
    seedSchedule(deps, { workflowId: "wf-1" });

    // Expired terminal cron goal — everything below must go.
    seedGoal(deps, {
      id: "g-old",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 100,
      createdBy: "scheduler",
    });
    seedTask(deps, { id: "t-old", goalId: "g-old", status: "completed" });
    deps.tasks.createAttempt({
      taskId: "t-old",
      attemptId: "att-old",
      attemptNumber: 1,
      runId: "run-old",
      status: "completed",
      startedAt: 50,
    });
    traces.create({
      id: "trc-old",
      agentId: "a-1",
      kind: "task_complete",
      payload: {},
      goalId: "g-old",
      t: 100,
    });
    // Task-scoped trace with NO goal_id — must be swept via its task id,
    // not orphaned when the task row is deleted.
    traces.create({
      id: "trc-task-only",
      agentId: "a-1",
      kind: "tool_call",
      payload: {},
      taskId: "t-old",
      t: 100,
    });

    // Survivors: fresh terminal, still-active, and manual (unscheduled) goals.
    seedGoal(deps, {
      id: "g-fresh",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 9_500,
      createdBy: "scheduler",
    });
    seedGoal(deps, {
      id: "g-active",
      status: "running",
      sourceWorkflowId: "wf-1",
      createdBy: "scheduler",
    });
    seedGoal(deps, { id: "g-manual", status: "completed", completedAt: 100 });

    const r = sweepCronGoalRetention(deps);

    expect(r).toEqual({ goalsDeleted: 1, tasksDeleted: 1, tracesDeleted: 2 });
    expect(deps.goals.get("g-old")).toBeUndefined();
    expect(deps.tasks.get("t-old")).toBeUndefined();
    expect(deps.tasks.findAttemptByRunId("run-old")).toBeUndefined();
    expect(traces.query({ goalId: "g-old" })).toEqual([]);
    expect(traces.query({ taskId: "t-old" })).toEqual([]);
    expect(deps.goals.get("g-fresh")).toBeDefined();
    expect(deps.goals.get("g-active")).toBeDefined();
    expect(deps.goals.get("g-manual")).toBeDefined();
    expect(logs.some((l) => l.message.includes("retention sweep deleted 1"))).toBe(true);
  });

  it("sweeps manual run_workflow replays and pre-stamping legacy goals of a scheduled template (ratified 2026-07-10)", () => {
    const { deps } = makeDeps({ now: 10_000, cronGoalRetentionMs: 1_000 });
    seedWorkflow(deps, "wf-1");
    seedSchedule(deps, { workflowId: "wf-1" });
    // Any terminal goal of a SCHEDULED workflow past retention is exhaust,
    // regardless of created_by: manual replays and rows predating
    // origin-stamping (which the old created_by guard left immortal).
    seedGoal(deps, {
      id: "g-manual-run",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 100,
      createdBy: "orchestrator",
    });
    seedGoal(deps, {
      id: "g-cron-run",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 100,
      createdBy: "scheduler",
    });
    const r = sweepCronGoalRetention(deps);
    expect(r.goalsDeleted).toBe(2);
    expect(deps.goals.get("g-manual-run")).toBeUndefined();
    expect(deps.goals.get("g-cron-run")).toBeUndefined();
  });

  it("sweeps failed cron goals too", () => {
    const { deps } = makeDeps({ now: 10_000, cronGoalRetentionMs: 1_000 });
    seedWorkflow(deps, "wf-1");
    seedSchedule(deps, { workflowId: "wf-1" });
    seedGoal(deps, {
      id: "g-failed",
      status: "failed",
      sourceWorkflowId: "wf-1",
      completedAt: 100,
      createdBy: "scheduler",
    });
    expect(sweepCronGoalRetention(deps).goalsDeleted).toBe(1);
    expect(deps.goals.get("g-failed")).toBeUndefined();
  });

  it("works without a traces store (tracesDeleted stays 0)", () => {
    const { deps } = makeDeps({ now: 10_000, cronGoalRetentionMs: 1_000 });
    seedWorkflow(deps, "wf-1");
    seedSchedule(deps, { workflowId: "wf-1" });
    seedGoal(deps, {
      id: "g-old",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 100,
      createdBy: "scheduler",
    });
    const r = sweepCronGoalRetention(deps);
    expect(r.goalsDeleted).toBe(1);
    expect(r.tracesDeleted).toBe(0);
  });

  it("uses the 7-day default window when no override is given", () => {
    const now = CRON_GOAL_RETENTION_MS + 10_000;
    const { deps, logs } = makeDeps({ now });
    seedWorkflow(deps, "wf-1");
    seedSchedule(deps, { workflowId: "wf-1" });
    // Inside the window — survives.
    seedGoal(deps, {
      id: "g-inside",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 20_000,
      createdBy: "scheduler",
    });
    // Outside the window — swept.
    seedGoal(deps, {
      id: "g-outside",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 5_000,
      createdBy: "scheduler",
    });
    const r = sweepCronGoalRetention(deps);
    expect(r.goalsDeleted).toBe(1);
    expect(deps.goals.get("g-inside")).toBeDefined();
    expect(deps.goals.get("g-outside")).toBeUndefined();
    expect(logs.some((l) => l.message.includes("older than 7d"))).toBe(true);
  });

  it("is silent and a no-op when nothing expired", () => {
    const { deps, logs } = makeDeps({ now: 10_000, cronGoalRetentionMs: 1_000 });
    seedWorkflow(deps, "wf-1");
    seedSchedule(deps, { workflowId: "wf-1" });
    const r = sweepCronGoalRetention(deps);
    expect(r).toEqual({ goalsDeleted: 0, tasksDeleted: 0, tracesDeleted: 0 });
    expect(logs.some((l) => l.message.includes("retention sweep"))).toBe(false);
  });
});

describe("tick — retention sweep throttle", () => {
  beforeEach(() => {
    resetRetentionSweepForTests();
  });

  it("runs the sweep once the interval elapsed, then throttles subsequent ticks", async () => {
    const now = RETENTION_SWEEP_INTERVAL_MS + 10_000;
    const { deps } = makeDeps({ now, cronGoalRetentionMs: 1_000 });
    seedWorkflow(deps, "wf-1");
    seedSchedule(deps, { workflowId: "wf-1", nextRunAt: now + 1 }); // not due
    seedGoal(deps, {
      id: "g-old-1",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 100,
      createdBy: "scheduler",
    });

    const first = await tick(deps, 60_000);
    expect(first.retentionSweptGoals).toBe(1);
    expect(deps.goals.get("g-old-1")).toBeUndefined();

    // Another expired goal appears, but the next tick is inside the
    // throttle window — no sweep.
    seedGoal(deps, {
      id: "g-old-2",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 100,
      createdBy: "scheduler",
    });
    const second = await tick(deps, 60_000);
    expect(second.retentionSweptGoals).toBe(0);
    expect(deps.goals.get("g-old-2")).toBeDefined();
  });

  it("uses Date.now when no clock is injected and sweeps on the first tick", async () => {
    const { deps } = makeDeps({ cronGoalRetentionMs: 1_000 });
    seedWorkflow(deps, "wf-1");
    seedSchedule(deps, { workflowId: "wf-1", nextRunAt: Date.now() + 60_000 });
    seedGoal(deps, {
      id: "g-old",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 100,
      createdBy: "scheduler",
    });
    const r = await tick(deps, 60_000);
    expect(r.retentionSweptGoals).toBe(1);
    expect(deps.goals.get("g-old")).toBeUndefined();
  });

  it("skips the sweep when the interval has not elapsed since process start", async () => {
    const { deps } = makeDeps({ now: 10_000, cronGoalRetentionMs: 1_000 });
    seedWorkflow(deps, "wf-1");
    seedSchedule(deps, { workflowId: "wf-1", nextRunAt: 20_000 });
    seedGoal(deps, {
      id: "g-old",
      status: "completed",
      sourceWorkflowId: "wf-1",
      completedAt: 100,
      createdBy: "scheduler",
    });
    const r = await tick(deps, 60_000);
    expect(r.retentionSweptGoals).toBe(0);
    expect(deps.goals.get("g-old")).toBeDefined();
  });
});
