import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  createGoalsStore,
  GOALS_MIGRATIONS,
  type GoalRecord,
  type GoalStatus,
} from "../store/goals.js";
import {
  createTasksStore,
  TASKS_MIGRATIONS,
  type OrchestratorTaskRecord,
} from "../store/tasks.js";
import type { Migration } from "../store/migrations.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "../store/migrations.js";
import {
  approveTask,
  cancelGoal,
  claimTask,
  completeTask,
  deriveGoalStatus,
  recordCheckpoint,
  recordHandoff,
  refreshGoalStatus,
  rejectTask,
  resolveDependents,
  type ResolverDeps,
} from "./resolver-status.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of [...GOALS_MIGRATIONS, ...TASKS_MIGRATIONS] as Migration[])
    registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function deps(now: number = 1000): ResolverDeps {
  return {
    goals: createGoalsStore({ db, now: () => now }),
    tasks: createTasksStore({ db }),
    now: () => now,
  };
}

function makeGoal(d: ResolverDeps, overrides: Partial<GoalRecord> = {}): string {
  const g: GoalRecord = {
    id: "g-1",
    name: "G",
    description: "",
    status: "pending",
    type: "project",
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "t",
    ...overrides,
  };
  d.goals.create(g);
  return g.id;
}

function makeTask(
  d: ResolverDeps,
  overrides: Partial<OrchestratorTaskRecord> = {},
): OrchestratorTaskRecord {
  const t: OrchestratorTaskRecord = {
    id: "t-1",
    goalId: "g-1",
    name: "T",
    task: "do",
    blockedBy: [],
    dispatch: { mode: "manual" },
    status: "pending",
    attemptCount: 0,
    attempts: [],
    priority: "normal",
    onUpstreamFailure: "wait",
    ...overrides,
  };
  d.tasks.create(t);
  return t;
}

// ── deriveGoalStatus ───────────────────────────────────────────────────────

describe("deriveGoalStatus", () => {
  it("returns 'pending' when the goal has no tasks", () => {
    const d = deps();
    makeGoal(d);
    expect(deriveGoalStatus(d, "g-1")).toBe("pending");
  });

  it("returns 'completed' when every task is terminal-success", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "completed" });
    makeTask(d, { id: "t2", status: "skipped" });
    makeTask(d, { id: "t3", status: "acknowledged" });
    expect(deriveGoalStatus(d, "g-1")).toBe("completed");
  });

  it("returns 'failed' when any task is failed or stalled", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "completed" });
    makeTask(d, { id: "t2", status: "stalled" });
    expect(deriveGoalStatus(d, "g-1")).toBe("failed");
    // failed dominates stalled
    d.tasks.update({ ...d.tasks.get("t2")!, status: "failed" });
    expect(deriveGoalStatus(d, "g-1")).toBe("failed");
  });

  it("returns 'running' when any task is in an active state", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "completed" });
    makeTask(d, { id: "t2", status: "running" });
    expect(deriveGoalStatus(d, "g-1")).toBe("running");
  });

  for (const active of [
    "dispatched",
    "ready",
    "awaiting_approval",
  ] as const) {
    it(`returns 'running' when a task is ${active}`, () => {
      const d = deps();
      makeGoal(d);
      makeTask(d, { id: "t1", status: active });
      expect(deriveGoalStatus(d, "g-1")).toBe("running");
    });
  }

  it("returns 'pending' when no task is active or terminal", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "pending" });
    expect(deriveGoalStatus(d, "g-1")).toBe("pending");
  });

  it("passes evergreen goal status through unchanged", () => {
    const d = deps();
    makeGoal(d, { type: "evergreen", status: "healthy" });
    makeTask(d, { id: "t1", status: "failed" });
    // Despite a failed task, evergreen status is held.
    expect(deriveGoalStatus(d, "g-1")).toBe("healthy");
  });

  // ── onUpstreamFailure: handled failures (continue/skip) ──────────────────
  // A stalled/failed upstream that has a continue/skip dependent must NOT
  // terminally fail the goal before the dependent (the resilient fallback)
  // runs. This is what makes the nightly dream-cycle + daily digest survive a
  // spawn stall instead of the whole goal failing the instant the watchdog
  // fires.

  it("stays 'running' when a stalled task is handled by a still-pending continue dependent", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "stage", status: "completed" });
    makeTask(d, { id: "spawn", status: "stalled" });
    // apply runs even if the spawn stalled; still blocked → not yet active.
    makeTask(d, {
      id: "apply",
      status: "ready",
      blockedBy: ["spawn"],
      onUpstreamFailure: "continue",
    });
    expect(deriveGoalStatus(d, "g-1")).toBe("running");
  });

  it("completes when a continue dependent finished despite a stalled upstream", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "stage", status: "completed" });
    makeTask(d, { id: "spawn", status: "stalled" });
    makeTask(d, {
      id: "apply",
      status: "completed",
      blockedBy: ["spawn"],
      onUpstreamFailure: "continue",
    });
    // The stalled spawn is "handled" → its fallback ran → goal is completed,
    // not failed.
    expect(deriveGoalStatus(d, "g-1")).toBe("completed");
  });

  it("completes when a skip dependent was skipped past a failed upstream", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "spawn", status: "failed" });
    makeTask(d, {
      id: "publish",
      status: "skipped",
      blockedBy: ["spawn"],
      onUpstreamFailure: "skip",
    });
    expect(deriveGoalStatus(d, "g-1")).toBe("completed");
  });

  it("still fails when a failed upstream has only a wait dependent (default)", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "spawn", status: "stalled" });
    makeTask(d, {
      id: "apply",
      status: "pending",
      blockedBy: ["spawn"],
      onUpstreamFailure: "wait",
    });
    // wait policy does not tolerate the failure → goal fails (prior behavior).
    expect(deriveGoalStatus(d, "g-1")).toBe("failed");
  });

  it("fails when the continue fallback itself fails (failure becomes unhandled)", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "spawn", status: "stalled" });
    makeTask(d, {
      id: "apply",
      status: "failed",
      blockedBy: ["spawn"],
      onUpstreamFailure: "continue",
    });
    // The handled spawn is resolved, but the fallback (apply) failed with no
    // dependent of its own → unhandled → goal fails.
    expect(deriveGoalStatus(d, "g-1")).toBe("failed");
  });
});

// ── refreshGoalStatus ──────────────────────────────────────────────────────

describe("refreshGoalStatus", () => {
  it("updates goal status to the derived value when they differ", () => {
    const d = deps(5000);
    makeGoal(d, { status: "pending" });
    makeTask(d, { id: "t1", status: "completed" });
    expect(refreshGoalStatus(d, "g-1")).toBe("completed");
    const g = d.goals.get("g-1")!;
    expect(g.status).toBe("completed");
    expect(g.completedAt).toBe(5000);
  });

  it("is a no-op when the status already matches", () => {
    const d = deps();
    makeGoal(d, { status: "pending" });
    makeTask(d, { id: "t1", status: "pending" });
    expect(refreshGoalStatus(d, "g-1")).toBe("pending");
    expect(d.goals.get("g-1")!.completedAt).toBeUndefined();
  });

  it("returns the derived status when the goal doesn't exist", () => {
    const d = deps();
    expect(refreshGoalStatus(d, "missing")).toBe("pending");
  });

  it("passes evergreen status through unchanged", () => {
    const d = deps();
    makeGoal(d, { type: "evergreen", status: "healthy" });
    expect(refreshGoalStatus(d, "g-1")).toBe("healthy");
  });

  it("cascades completion up to a parent goal when all children are done", () => {
    const d = deps(2000);
    d.goals.create({
      id: "parent",
      name: "P",
      description: "",
      status: "running",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    d.goals.create({
      id: "child",
      name: "C",
      description: "",
      status: "pending",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
      parentGoalId: "parent",
    });
    d.tasks.create({
      id: "tc",
      goalId: "child",
      name: "ChildTask",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "completed",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    refreshGoalStatus(d, "child");
    // Parent has no tasks of its own so deriveGoalStatus(parent) is "pending"
    // — refresh of the parent should run; but parent rollup is "pending"
    // because it has no tasks. Cascade only marks the parent completed when
    // child rollup is complete AND parent's own tasks are done.
    expect(d.goals.get("child")!.status).toBe("completed");
    // Parent has no tasks → deriveGoalStatus is "pending", not "completed".
    // So parent should NOT auto-complete here.
    expect(d.goals.get("parent")!.status).toBe("running");
  });

  it("cascades completion to the parent when parent has its own tasks all done", () => {
    const d = deps(3000);
    d.goals.create({
      id: "parent",
      name: "P",
      description: "",
      status: "running",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    d.goals.create({
      id: "child",
      name: "C",
      description: "",
      status: "pending",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
      parentGoalId: "parent",
    });
    d.tasks.create({
      id: "tp",
      goalId: "parent",
      name: "ParentTask",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "completed",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    d.tasks.create({
      id: "tc",
      goalId: "child",
      name: "ChildTask",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "completed",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    refreshGoalStatus(d, "child");
    expect(d.goals.get("parent")!.status).toBe("completed");
  });

  it("does not cascade when an evergreen parent would be touched", () => {
    const d = deps();
    d.goals.create({
      id: "ever",
      name: "E",
      description: "",
      status: "healthy",
      type: "evergreen",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    d.goals.create({
      id: "child",
      name: "C",
      description: "",
      status: "pending",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
      parentGoalId: "ever",
    });
    d.tasks.create({
      id: "tc",
      goalId: "child",
      name: "ChildTask",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "completed",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    refreshGoalStatus(d, "child");
    expect(d.goals.get("ever")!.status).toBe("healthy");
  });

  it("recurses upward through three levels when every layer derives to completed", () => {
    const d = deps(4000);
    for (const id of ["root", "mid", "leaf"]) {
      d.goals.create({
        id,
        name: id,
        description: "",
        status: "running",
        type: "project",
        taskIds: [],
        createdAt: 0,
        updatedAt: 0,
        createdBy: "t",
        ...(id === "mid" ? { parentGoalId: "root" } : {}),
        ...(id === "leaf" ? { parentGoalId: "mid" } : {}),
      });
    }
    // Each goal has one completed task — every layer derives to "completed",
    // so the cascade can propagate all the way up.
    for (const goalId of ["leaf", "mid", "root"]) {
      d.tasks.create({
        id: `t-${goalId}`,
        goalId,
        name: goalId,
        task: "x",
        blockedBy: [],
        dispatch: { mode: "manual" },
        status: "completed",
        attemptCount: 0,
        attempts: [],
        priority: "normal",
        onUpstreamFailure: "wait",
      });
    }
    refreshGoalStatus(d, "leaf");
    expect(d.goals.get("leaf")!.status).toBe("completed");
    expect(d.goals.get("mid")!.status).toBe("completed");
    expect(d.goals.get("root")!.status).toBe("completed");
  });

  it("stops the cascade when the parent is already terminal", () => {
    const d = deps();
    d.goals.create({
      id: "parent",
      name: "P",
      description: "",
      status: "cancelled" as GoalStatus,
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    d.goals.create({
      id: "child",
      name: "C",
      description: "",
      status: "running",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
      parentGoalId: "parent",
    });
    d.tasks.create({
      id: "tc",
      goalId: "child",
      name: "C",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "completed",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    refreshGoalStatus(d, "child");
    expect(d.goals.get("parent")!.status).toBe("cancelled");
  });

  it("is a no-op when the parent goal referenced by the child is missing", () => {
    const d = deps(7000);
    d.goals.create({
      id: "orphan-child",
      name: "C",
      description: "",
      status: "running",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
      parentGoalId: "ghost", // doesn't exist
    });
    d.tasks.create({
      id: "tc",
      goalId: "orphan-child",
      name: "x",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "completed",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    // Should NOT throw — the cascade hits the missing-parent branch and returns.
    expect(() => refreshGoalStatus(d, "orphan-child")).not.toThrow();
    expect(d.goals.get("orphan-child")!.status).toBe("completed");
  });

  it("does not cascade when not all children are done", () => {
    const d = deps();
    d.goals.create({
      id: "parent",
      name: "P",
      description: "",
      status: "running",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    for (const id of ["a", "b"]) {
      d.goals.create({
        id,
        name: id,
        description: "",
        status: "pending",
        type: "project",
        taskIds: [],
        createdAt: 0,
        updatedAt: 0,
        createdBy: "t",
        parentGoalId: "parent",
      });
    }
    d.tasks.create({
      id: "ta",
      goalId: "a",
      name: "A",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "completed",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    refreshGoalStatus(d, "a");
    expect(d.goals.get("a")!.status).toBe("completed");
    expect(d.goals.get("parent")!.status).toBe("running");
  });

  it("uses Date.now as a fallback when no clock is injected", () => {
    const d: ResolverDeps = {
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
    };
    makeGoal(d, { status: "pending" });
    makeTask(d, { id: "t1", status: "completed" });
    const before = Date.now();
    refreshGoalStatus(d, "g-1");
    expect(d.goals.get("g-1")!.completedAt).toBeGreaterThanOrEqual(before);
  });
});

// ── claimTask / completeTask ───────────────────────────────────────────────

describe("claimTask", () => {
  it("transitions ready→running and refreshes goal status", () => {
    const d = deps(1000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "ready" });
    const r = claimTask(d, "t1");
    expect(r.ok).toBe(true);
    expect(d.tasks.get("t1")!.status).toBe("running");
    expect(d.tasks.get("t1")!.startedAt).toBe(1000);
  });

  it("rejects an unknown task", () => {
    expect(claimTask(deps(), "missing")).toEqual({
      ok: false,
      error: "Task not found.",
    });
  });

  it("rejects a task in a non-claimable status", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "completed" });
    const r = claimTask(d, "t1");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/Cannot claim/);
  });

  it("rejects a pending task that still has blockers", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "pending", blockedBy: ["x"] });
    const r = claimTask(d, "t1");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/still blocked/);
  });

  it("uses Date.now when no clock injected", () => {
    const d: ResolverDeps = {
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
    };
    makeGoal(d);
    makeTask(d, { id: "t1", status: "ready" });
    const before = Date.now();
    claimTask(d, "t1");
    expect(d.tasks.get("t1")!.startedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("completeTask", () => {
  it("transitions running→completed and refreshes goal status", () => {
    const d = deps(5000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "running" });
    const r = completeTask(d, "t1");
    expect(r.ok).toBe(true);
    expect(d.tasks.get("t1")!.status).toBe("completed");
    expect(d.tasks.get("t1")!.completedAt).toBe(5000);
    expect(d.goals.get("g-1")!.status).toBe("completed");
  });

  it("unblocks dependents immediately (not only on the next schedule tick)", () => {
    const d = deps(5000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "running" });
    makeTask(d, { id: "t2", status: "pending", blockedBy: ["t1"] });
    completeTask(d, "t1");
    expect(d.tasks.get("t2")!.status).toBe("ready");
    expect(d.tasks.get("t2")!.blockedBy).toEqual([]);
  });

  it("rejects an unknown task", () => {
    expect(completeTask(deps(), "missing")).toEqual({
      ok: false,
      error: "Task not found.",
    });
  });

  it("rejects a task in a non-completable status", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "pending" });
    const r = completeTask(d, "t1");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/Cannot complete/);
  });

  it("uses Date.now when no clock injected", () => {
    const d: ResolverDeps = {
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
    };
    makeGoal(d);
    makeTask(d, { id: "t1", status: "running" });
    const before = Date.now();
    completeTask(d, "t1");
    expect(d.tasks.get("t1")!.completedAt).toBeGreaterThanOrEqual(before);
  });
});

// ── approveTask / rejectTask ───────────────────────────────────────────────

describe("approveTask", () => {
  it("transitions awaiting_approval→completed", () => {
    const d = deps(7000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "awaiting_approval" });
    const r = approveTask(d, "t1");
    expect(r.ok).toBe(true);
    expect(d.tasks.get("t1")!.status).toBe("completed");
    expect(d.tasks.get("t1")!.completedAt).toBe(7000);
  });

  it("unblocks dependents on approval", () => {
    const d = deps(7000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "awaiting_approval" });
    makeTask(d, { id: "t2", status: "pending", blockedBy: ["t1"] });
    approveTask(d, "t1");
    expect(d.tasks.get("t2")!.status).toBe("ready");
    expect(d.tasks.get("t2")!.blockedBy).toEqual([]);
  });

  it("rejects an unknown task", () => {
    expect(approveTask(deps(), "missing")).toEqual({
      ok: false,
      error: "Task not found.",
    });
  });

  it("rejects a task not in awaiting_approval state", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "running" });
    const r = approveTask(d, "t1");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/not awaiting approval/);
  });

  it("uses Date.now when no clock injected", () => {
    const d: ResolverDeps = {
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
    };
    makeGoal(d);
    makeTask(d, { id: "t1", status: "awaiting_approval" });
    const before = Date.now();
    approveTask(d, "t1");
    expect(d.tasks.get("t1")!.completedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("rejectTask", () => {
  it("transitions awaiting_approval→failed with default reason", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "awaiting_approval" });
    const r = rejectTask(d, "t1");
    expect(r.ok).toBe(true);
    const t = d.tasks.get("t1")!;
    expect(t.status).toBe("failed");
    expect(t.failureReason).toBe("rejected on approval");
  });

  it("uses the provided reason when supplied", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "awaiting_approval" });
    rejectTask(d, "t1", "wrong direction");
    expect(d.tasks.get("t1")!.failureReason).toBe("wrong direction");
  });

  it("rejects an unknown task", () => {
    expect(rejectTask(deps(), "missing")).toEqual({
      ok: false,
      error: "Task not found.",
    });
  });

  it("rejects a task not in awaiting_approval", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "running" });
    expect(rejectTask(d, "t1").ok).toBe(false);
  });
});

// ── recordCheckpoint ───────────────────────────────────────────────────────

describe("recordCheckpoint", () => {
  it("records a checkpoint and auto-transitions ready→running with startedAt", () => {
    const d = deps(8000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "ready" });
    const ok = recordCheckpoint(d, "t1", {
      checkpointAt: 0,
      phase: "p",
      summary: "s",
    });
    expect(ok).toBe(true);
    const t = d.tasks.get("t1")!;
    expect(t.status).toBe("running");
    expect(t.startedAt).toBe(8000);
    expect(t.latestCheckpoint?.phase).toBe("p");
  });

  it("auto-transitions dispatched→running with startedAt", () => {
    const d = deps(9000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "dispatched" });
    recordCheckpoint(d, "t1", { checkpointAt: 0, phase: "p", summary: "s" });
    expect(d.tasks.get("t1")!.status).toBe("running");
    expect(d.tasks.get("t1")!.startedAt).toBe(9000);
  });

  it("preserves existing startedAt when re-checkpointing a running task", () => {
    const d = deps(10_000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "running", startedAt: 1234 });
    recordCheckpoint(d, "t1", { checkpointAt: 0, phase: "p", summary: "s" });
    expect(d.tasks.get("t1")!.startedAt).toBe(1234);
  });

  it("returns false when the task doesn't exist", () => {
    expect(
      recordCheckpoint(deps(), "missing", {
        checkpointAt: 0,
        phase: "p",
        summary: "s",
      }),
    ).toBe(false);
  });

  it("returns false when the task isn't in an active status", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "completed" });
    expect(
      recordCheckpoint(d, "t1", { checkpointAt: 0, phase: "p", summary: "s" }),
    ).toBe(false);
  });
});

// ── recordHandoff ──────────────────────────────────────────────────────────

describe("recordHandoff", () => {
  it("finalizes the task on deliverableState='complete' and refreshes goal", () => {
    const d = deps(11_000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "running" });
    const ok = recordHandoff(d, "t1", {
      deliverableState: "complete",
      summary: "done",
      producedAt: 0,
    });
    expect(ok).toBe(true);
    const t = d.tasks.get("t1")!;
    expect(t.status).toBe("completed");
    expect(t.completedAt).toBe(11_000);
    expect(t.latestOutput?.summary).toBe("done");
    expect(d.goals.get("g-1")!.status).toBe("completed");
  });

  it("finalizes the running attempt with output summary", () => {
    const d = deps(12_000);
    makeGoal(d);
    makeTask(d, {
      id: "t1",
      status: "running",
      startedAt: 100,
      attemptCount: 1,
      attempts: [
        {
          attemptId: "att-1",
          attemptNumber: 1,
          status: "running",
          startedAt: 100,
        },
      ],
    });
    d.tasks.createAttempt({
      taskId: "t1",
      attemptId: "att-1",
      attemptNumber: 1,
      status: "running",
      startedAt: 100,
    });
    recordHandoff(d, "t1", {
      deliverableState: "complete",
      summary: "done",
      producedAt: 0,
    });
    const updated = d.tasks.get("t1")!;
    const a = updated.attempts.find((x) => x.attemptId === "att-1")!;
    expect(a.status).toBe("completed");
    expect(a.endedAt).toBe(12_000);
    expect(a.outputSummary).toBe("done");
  });

  it("auto-transitions ready→running on a complete handoff and stamps startedAt", () => {
    const d = deps(13_000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "ready" });
    recordHandoff(d, "t1", {
      deliverableState: "complete",
      summary: "done",
      producedAt: 0,
    });
    const t = d.tasks.get("t1")!;
    expect(t.status).toBe("completed");
    expect(t.startedAt).toBe(13_000);
  });

  it("preserves a non-complete handoff: just records output + auto-transitions to running", () => {
    const d = deps(14_000);
    makeGoal(d);
    makeTask(d, { id: "t1", status: "dispatched" });
    const ok = recordHandoff(d, "t1", {
      deliverableState: "partial",
      summary: "midway",
      producedAt: 0,
    });
    expect(ok).toBe(true);
    const t = d.tasks.get("t1")!;
    expect(t.status).toBe("running");
    expect(t.completedAt).toBeUndefined();
    expect(t.latestOutput?.deliverableState).toBe("partial");
  });

  it("preserves existing startedAt on partial handoff for a running task", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "running", startedAt: 500 });
    recordHandoff(d, "t1", {
      deliverableState: "partial",
      summary: "x",
      producedAt: 0,
    });
    expect(d.tasks.get("t1")!.startedAt).toBe(500);
  });

  it("returns false when the task doesn't exist", () => {
    expect(
      recordHandoff(deps(), "missing", {
        deliverableState: "complete",
        summary: "s",
        producedAt: 0,
      }),
    ).toBe(false);
  });

  it("returns false when the task isn't in an active status", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "completed" });
    expect(
      recordHandoff(d, "t1", {
        deliverableState: "complete",
        summary: "s",
        producedAt: 0,
      }),
    ).toBe(false);
  });

  it("complete-handoff with no running attempt is still ok (idempotent)", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "running" });
    // No attempt created — finalizeRunningAttempt finds nothing.
    expect(
      recordHandoff(d, "t1", {
        deliverableState: "complete",
        summary: "s",
        producedAt: 0,
      }),
    ).toBe(true);
  });
});

describe("default clock fallbacks (Date.now)", () => {
  function depsNoNow(): ResolverDeps {
    return {
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
    };
  }

  it("refreshGoalStatus cascade uses Date.now when no clock is injected", () => {
    const d = depsNoNow();
    d.goals.create({
      id: "root",
      name: "R",
      description: "",
      status: "running",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    d.goals.create({
      id: "child",
      name: "C",
      description: "",
      status: "running",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
      parentGoalId: "root",
    });
    d.tasks.create({
      id: "tp",
      goalId: "root",
      name: "p",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "completed",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    d.tasks.create({
      id: "tc",
      goalId: "child",
      name: "c",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "completed",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    const before = Date.now();
    refreshGoalStatus(d, "child");
    expect(d.goals.get("root")!.status).toBe("completed");
    expect(d.goals.get("root")!.completedAt).toBeGreaterThanOrEqual(before);
  });

  it("recordCheckpoint uses Date.now when no clock is injected", () => {
    const d = depsNoNow();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "ready" });
    const before = Date.now();
    recordCheckpoint(d, "t1", { checkpointAt: 0, phase: "p", summary: "s" });
    expect(d.tasks.get("t1")!.startedAt).toBeGreaterThanOrEqual(before);
  });

  it("recordHandoff uses Date.now when no clock is injected", () => {
    const d = depsNoNow();
    makeGoal(d);
    makeTask(d, { id: "t1", status: "running" });
    const before = Date.now();
    recordHandoff(d, "t1", {
      deliverableState: "complete",
      summary: "x",
      producedAt: 0,
    });
    expect(d.tasks.get("t1")!.completedAt).toBeGreaterThanOrEqual(before);
  });

  it("resolveDependents uses Date.now when no clock is injected", () => {
    const d = depsNoNow();
    makeGoal(d);
    makeTask(d, { id: "a", status: "completed" });
    makeTask(d, { id: "b", status: "pending", blockedBy: ["a"] });
    const before = Date.now();
    const newly = resolveDependents(d, "a");
    expect(newly[0]!.readyAt).toBeGreaterThanOrEqual(before);
  });
});

// ── resolveDependents ──────────────────────────────────────────────────────

describe("resolveDependents", () => {
  it("transitions dependents with no remaining blockers from pending→ready", () => {
    const d = deps(20_000);
    makeGoal(d);
    makeTask(d, { id: "a", status: "completed" });
    makeTask(d, { id: "b", status: "pending", blockedBy: ["a"] });
    const newly = resolveDependents(d, "a");
    expect(newly.map((t) => t.id)).toEqual(["b"]);
    const b = d.tasks.get("b")!;
    expect(b.status).toBe("ready");
    expect(b.blockedBy).toEqual([]);
    expect(b.readyAt).toBe(20_000);
  });

  it("strips the completed task from blockedBy but leaves status=pending when others remain", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "a", status: "completed" });
    makeTask(d, { id: "b", status: "pending", blockedBy: ["a", "c"] });
    const newly = resolveDependents(d, "a");
    expect(newly).toEqual([]);
    expect(d.tasks.get("b")!.status).toBe("pending");
    expect(d.tasks.get("b")!.blockedBy).toEqual(["c"]);
  });

  it("skips non-pending dependents", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "a", status: "completed" });
    makeTask(d, { id: "b", status: "running", blockedBy: ["a"] });
    const newly = resolveDependents(d, "a");
    expect(newly).toEqual([]);
    expect(d.tasks.get("b")!.status).toBe("running");
  });

  it("preserves an existing readyAt rather than overwriting it", () => {
    const d = deps(50_000);
    makeGoal(d);
    makeTask(d, { id: "a", status: "completed" });
    makeTask(d, {
      id: "b",
      status: "pending",
      blockedBy: ["a"],
      readyAt: 999,
    });
    resolveDependents(d, "a");
    expect(d.tasks.get("b")!.readyAt).toBe(999);
  });

  it("returns an empty array when there are no dependents", () => {
    const d = deps();
    makeGoal(d);
    makeTask(d, { id: "a", status: "completed" });
    expect(resolveDependents(d, "a")).toEqual([]);
  });
});

// ── cancelGoal ─────────────────────────────────────────────────────────────

describe("cancelGoal", () => {
  it("cancels the goal and skips its non-terminal tasks", () => {
    const d = deps(30_000);
    makeGoal(d, { status: "running" });
    makeTask(d, { id: "a", status: "pending" });
    makeTask(d, { id: "b", status: "running" });
    makeTask(d, { id: "c", status: "completed" });
    const r = cancelGoal(d, "g-1");
    expect(r.ok).toBe(true);
    expect((r as { cancelledTaskCount?: number }).cancelledTaskCount).toBe(2);
    expect(d.goals.get("g-1")!.status).toBe("cancelled");
    expect(d.tasks.get("a")!.status).toBe("skipped");
    expect(d.tasks.get("b")!.status).toBe("skipped");
    expect(d.tasks.get("c")!.status).toBe("completed");
  });

  it("rejects an unknown goal", () => {
    expect(cancelGoal(deps(), "missing")).toEqual({
      ok: false,
      error: 'Goal "missing" not found.',
    });
  });

  it("rejects a goal already in a terminal state", () => {
    const d = deps();
    makeGoal(d, { status: "completed" });
    const r = cancelGoal(d, "g-1");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/already completed/);
  });

  it("uses Date.now when no clock injected", () => {
    const d: ResolverDeps = {
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
    };
    makeGoal(d, { status: "running" });
    const before = Date.now();
    cancelGoal(d, "g-1");
    expect(d.goals.get("g-1")!.completedAt).toBeGreaterThanOrEqual(before);
  });
});
