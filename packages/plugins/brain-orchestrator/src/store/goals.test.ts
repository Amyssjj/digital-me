import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  GOALS_MIGRATIONS,
  createGoalsStore,
  type GoalRecord,
  type GoalStatus,
} from "./goals.js";
import {
  resetMigrationRegistryForTests,
  registerMigration,
  runMigrations,
  type Migration,
} from "./migrations.js";

// Inline tasks-stub migration so goals.test.ts is self-contained — it
// needs a minimal `tasks` table to verify the taskIds aggregation
// cross-read. The real tasks store provides the full schema at v200.
const TASKS_STUB_MIGRATION: Migration = {
  version: 99,
  description: "v99: tasks-table stub for goals-store isolated tests",
  up: (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, goal_id TEXT);
      CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
    `);
  },
};

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  registerMigration(TASKS_STUB_MIGRATION);
  for (const m of GOALS_MIGRATIONS) registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function baseGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  const now = Date.parse("2026-05-17T12:00:00Z");
  return {
    id: "g-1",
    name: "Test goal",
    description: "do something",
    status: "pending",
    type: "project",
    taskIds: [],
    createdAt: now,
    updatedAt: now,
    createdBy: "test-agent",
    ...overrides,
  };
}

describe("createGoalsStore.create + get", () => {
  it("round-trips a minimal goal", () => {
    const store = createGoalsStore({ db });
    const g = baseGoal();
    store.create(g);
    const out = store.get("g-1");
    expect(out).toBeDefined();
    expect(out!.id).toBe("g-1");
    expect(out!.name).toBe("Test goal");
    expect(out!.status).toBe("pending");
    expect(out!.type).toBe("project");
    expect(out!.taskIds).toEqual([]);
  });

  it("returns undefined for a missing id", () => {
    const store = createGoalsStore({ db });
    expect(store.get("nope")).toBeUndefined();
  });

  it("persists every optional field on round-trip", () => {
    const store = createGoalsStore({ db });
    store.create(
      baseGoal({
        parentGoalId: "parent-1",
        completedAt: 999,
        sourceWorkflowId: "wf-1",
        sourceWorkflowVersion: 3,
        branchName: "wf/x",
        worktreePath: "/tmp/wt",
        branchingPolicy: { repoPath: "/repo", baseBranch: "main" },
        originator: { channel: "discord", accountId: "u-1" },
      }),
    );
    const g = store.get("g-1")!;
    expect(g.parentGoalId).toBe("parent-1");
    expect(g.completedAt).toBe(999);
    expect(g.sourceWorkflowId).toBe("wf-1");
    expect(g.sourceWorkflowVersion).toBe(3);
    expect(g.branchName).toBe("wf/x");
    expect(g.worktreePath).toBe("/tmp/wt");
    expect(g.branchingPolicy).toEqual({ repoPath: "/repo", baseBranch: "main" });
    expect(g.originator).toEqual({ channel: "discord", accountId: "u-1" });
  });

  it("defaults type=project when not provided in the input record", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal({ type: undefined }));
    expect(store.get("g-1")!.type).toBe("project");
  });

  it("supports type=evergreen with healthy status", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal({ type: "evergreen", status: "healthy" }));
    const g = store.get("g-1")!;
    expect(g.type).toBe("evergreen");
    expect(g.status).toBe("healthy");
  });

  it("rejects a project goal with an evergreen-only status", () => {
    const store = createGoalsStore({ db });
    expect(() =>
      store.create(baseGoal({ type: "project", status: "healthy" as GoalStatus })),
    ).toThrow(/invalid status.*project/i);
  });

  it("rejects an evergreen goal with a project-only status", () => {
    const store = createGoalsStore({ db });
    expect(() =>
      store.create(baseGoal({ type: "evergreen", status: "completed" })),
    ).toThrow(/invalid status.*evergreen/i);
  });
});

describe("createGoalsStore.taskIds aggregation", () => {
  it("returns the task IDs whose goal_id matches", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal());
    db.prepare("INSERT INTO tasks (id, goal_id) VALUES ('t1', 'g-1'), ('t2', 'g-1')").run();
    const g = store.get("g-1")!;
    expect(g.taskIds.sort()).toEqual(["t1", "t2"]);
  });

  it("returns empty taskIds when no tasks reference the goal", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal());
    db.prepare("INSERT INTO tasks (id, goal_id) VALUES ('t-other', 'g-2')").run();
    expect(store.get("g-1")!.taskIds).toEqual([]);
  });
});

describe("createGoalsStore.updateStatus", () => {
  it("updates status and advances updated_at", () => {
    const clock = vi.fn(() => Date.parse("2026-05-17T13:00:00Z"));
    const store = createGoalsStore({ db, now: clock });
    store.create(baseGoal());
    store.updateStatus("g-1", "running");
    const g = store.get("g-1")!;
    expect(g.status).toBe("running");
    expect(g.updatedAt).toBe(Date.parse("2026-05-17T13:00:00Z"));
  });

  it("sets completedAt when explicitly provided", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal());
    store.updateStatus("g-1", "completed", 5000);
    expect(store.get("g-1")!.completedAt).toBe(5000);
  });

  it("preserves existing completedAt when none is supplied (COALESCE)", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal());
    store.updateStatus("g-1", "completed", 5000);
    store.updateStatus("g-1", "failed");
    expect(store.get("g-1")!.completedAt).toBe(5000);
  });

  it("validates new status against the goal's type", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal({ type: "project" }));
    expect(() => store.updateStatus("g-1", "healthy" as GoalStatus)).toThrow(
      /invalid status.*project/i,
    );
  });

  it("fires the status-change callback on real transitions", () => {
    const cb = vi.fn();
    const store = createGoalsStore({ db });
    store.setStatusChangeCallback(cb);
    store.create(baseGoal());
    store.updateStatus("g-1", "running");
    expect(cb).toHaveBeenCalledWith("g-1", "pending", "running");
  });

  it("does NOT fire the callback when status is unchanged", () => {
    const cb = vi.fn();
    const store = createGoalsStore({ db });
    store.setStatusChangeCallback(cb);
    store.create(baseGoal({ status: "running" }));
    store.updateStatus("g-1", "running");
    expect(cb).not.toHaveBeenCalled();
  });

  it("swallows callback errors so observer bugs don't corrupt store state", () => {
    const cb = vi.fn(() => {
      throw new Error("observer is buggy");
    });
    const store = createGoalsStore({ db });
    store.setStatusChangeCallback(cb);
    store.create(baseGoal());
    expect(() => store.updateStatus("g-1", "running")).not.toThrow();
    expect(store.get("g-1")!.status).toBe("running");
  });

  it("does nothing for an unknown id (no row updated; no callback fired)", () => {
    const cb = vi.fn();
    const store = createGoalsStore({ db });
    store.setStatusChangeCallback(cb);
    expect(() => store.updateStatus("missing", "running")).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("createGoalsStore.list operations", () => {
  function seed(): ReturnType<typeof createGoalsStore> {
    const store = createGoalsStore({ db });
    store.create(baseGoal({ id: "p1", type: "project", status: "pending" }));
    store.create(baseGoal({ id: "p2", type: "project", status: "running" }));
    store.create(baseGoal({ id: "p3", type: "project", status: "completed" }));
    store.create(baseGoal({ id: "e1", type: "evergreen", status: "healthy" }));
    store.create(baseGoal({ id: "e2", type: "evergreen", status: "retired" }));
    store.create(
      baseGoal({ id: "c1", type: "project", status: "pending", parentGoalId: "p1" }),
    );
    store.create(
      baseGoal({
        id: "wf1",
        type: "project",
        status: "running",
        sourceWorkflowId: "wf-x",
      }),
    );
    return store;
  }

  it("listAll returns every row, newest-first by created_at", () => {
    const store = seed();
    const all = store.listAll();
    expect(all).toHaveLength(7);
  });

  it("listActive returns only project goals with pending/running status", () => {
    const store = seed();
    const ids = store.listActive().map((g) => g.id).sort();
    expect(ids).toEqual(["c1", "p1", "p2", "wf1"]);
  });

  it("listEvergreen returns evergreen goals excluding retired", () => {
    const store = seed();
    const ids = store.listEvergreen().map((g) => g.id);
    expect(ids).toEqual(["e1"]);
  });

  it("findActiveByWorkflow returns active project goals sourced from the given workflow", () => {
    const store = seed();
    const goals = store.findActiveByWorkflow("wf-x");
    expect(goals.map((g) => g.id)).toEqual(["wf1"]);
  });

  it("listChildren returns project goals with the given parent", () => {
    const store = seed();
    const ids = store.listChildren("p1").map((g) => g.id);
    expect(ids).toEqual(["c1"]);
  });

  it("listChildren returns empty when no children exist", () => {
    const store = seed();
    expect(store.listChildren("p2")).toEqual([]);
  });
});

describe("createGoalsStore.findTerminalIdsByWorkflowBefore", () => {
  it("returns terminal project goals for the workflow whose completion predates the cutoff", () => {
    const store = createGoalsStore({ db });
    store.create(
      baseGoal({ id: "old-done", status: "completed", sourceWorkflowId: "wf-1", completedAt: 100, createdBy: "scheduler" }),
    );
    store.create(
      baseGoal({ id: "old-failed", status: "failed", sourceWorkflowId: "wf-1", completedAt: 200, createdBy: "scheduler" }),
    );
    store.create(
      baseGoal({ id: "fresh-done", status: "completed", sourceWorkflowId: "wf-1", completedAt: 5_000, createdBy: "scheduler" }),
    );
    store.create(
      baseGoal({ id: "still-running", status: "running", sourceWorkflowId: "wf-1", createdBy: "scheduler" }),
    );
    store.create(
      baseGoal({ id: "other-wf", status: "completed", sourceWorkflowId: "wf-2", completedAt: 100, createdBy: "scheduler" }),
    );
    const ids = store.findTerminalIdsByWorkflowBefore("wf-1", 1_000).sort();
    expect(ids).toEqual(["old-done", "old-failed"]);
  });

  it("falls back to updated_at when completed_at is null", () => {
    const store = createGoalsStore({ db });
    store.create(
      baseGoal({
        id: "no-stamp",
        status: "failed",
        sourceWorkflowId: "wf-1",
        updatedAt: 100,
        createdBy: "scheduler",
      }),
    );
    expect(store.findTerminalIdsByWorkflowBefore("wf-1", 1_000)).toEqual([
      "no-stamp",
    ]);
    expect(store.findTerminalIdsByWorkflowBefore("wf-1", 50)).toEqual([]);
  });

  it("never returns cancelled goals or goals with no workflow linkage", () => {
    const store = createGoalsStore({ db });
    store.create(
      baseGoal({ id: "cancelled", status: "cancelled", sourceWorkflowId: "wf-1", completedAt: 100, createdBy: "scheduler" }),
    );
    store.create(baseGoal({ id: "manual", status: "completed", completedAt: 100 }));
    expect(store.findTerminalIdsByWorkflowBefore("wf-1", 1_000)).toEqual([]);
  });

  it("includes goals of the workflow regardless of created_by (ratified 2026-07-10: terminal runs of a scheduled workflow past retention are exhaust — manual replays and pre-stamping legacy rows included)", () => {
    const store = createGoalsStore({ db });
    store.create(
      baseGoal({ id: "cron-run", status: "completed", sourceWorkflowId: "wf-1", completedAt: 100, createdBy: "scheduler" }),
    );
    store.create(
      baseGoal({ id: "manual-run", status: "completed", sourceWorkflowId: "wf-1", completedAt: 100, createdBy: "orchestrator" }),
    );
    const ids = store.findTerminalIdsByWorkflowBefore("wf-1", 1_000).sort();
    expect(ids).toEqual(["cron-run", "manual-run"]);
  });
});

describe("createGoalsStore.countByBranchPrefix", () => {
  it("counts goals whose branch_name starts with the given prefix", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal({ id: "g1", branchName: "wf/foo-2026-05-17-1" }));
    store.create(baseGoal({ id: "g2", branchName: "wf/foo-2026-05-17-2" }));
    store.create(baseGoal({ id: "g3", branchName: "wf/bar-2026-05-17-1" }));
    store.create(baseGoal({ id: "g4" })); // no branch
    expect(store.countByBranchPrefix("wf/foo-2026-05-17-")).toBe(2);
    expect(store.countByBranchPrefix("wf/bar-2026-05-17-")).toBe(1);
    expect(store.countByBranchPrefix("wf/baz-")).toBe(0);
  });
});

describe("createGoalsStore.setBranch", () => {
  it("stores branchName + worktreePath + policy and advances updated_at", () => {
    const clock = vi.fn(() => 999_999);
    const store = createGoalsStore({ db, now: clock });
    store.create(baseGoal());
    store.setBranch("g-1", "wf/x", "/tmp/wt", {
      repoPath: "/r",
      baseBranch: "main",
    });
    const g = store.get("g-1")!;
    expect(g.branchName).toBe("wf/x");
    expect(g.worktreePath).toBe("/tmp/wt");
    expect(g.branchingPolicy).toEqual({ repoPath: "/r", baseBranch: "main" });
    expect(g.updatedAt).toBe(999_999);
  });

  it("preserves existing branchingPolicy via COALESCE when not passed", () => {
    const store = createGoalsStore({ db });
    store.create(
      baseGoal({ branchingPolicy: { repoPath: "/r", baseBranch: "main" } }),
    );
    store.setBranch("g-1", "wf/x", "/tmp/wt");
    expect(store.get("g-1")!.branchingPolicy).toEqual({
      repoPath: "/r",
      baseBranch: "main",
    });
  });
});

describe("createGoalsStore.delete", () => {
  it("removes the goal row", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal());
    store.delete("g-1");
    expect(store.get("g-1")).toBeUndefined();
  });

  it("is a no-op for an unknown id", () => {
    const store = createGoalsStore({ db });
    expect(() => store.delete("missing")).not.toThrow();
  });
});

describe("createGoalsStore — defensive JSON parsing", () => {
  it("returns undefined for branchingPolicy when the stored JSON is malformed", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal());
    // Corrupt the column directly to simulate a downgrade/edit anomaly.
    db.prepare(
      "UPDATE goals SET branching_policy = 'not-json' WHERE id = 'g-1'",
    ).run();
    expect(store.get("g-1")!.branchingPolicy).toBeUndefined();
  });

  it("returns undefined for originator when the stored JSON is malformed", () => {
    const store = createGoalsStore({ db });
    store.create(baseGoal());
    db.prepare(
      "UPDATE goals SET originator = 'not-json' WHERE id = 'g-1'",
    ).run();
    expect(store.get("g-1")!.originator).toBeUndefined();
  });
});

describe("GOALS_MIGRATIONS", () => {
  it("registers the goals table at a stable version", () => {
    expect(GOALS_MIGRATIONS).toHaveLength(1);
    expect(GOALS_MIGRATIONS[0]!.version).toBeGreaterThan(0);
    expect(GOALS_MIGRATIONS[0]!.description).toMatch(/goals/i);
  });

  it("produces a usable goals table when applied to a fresh DB", () => {
    const fresh = new DatabaseSync(":memory:");
    for (const m of GOALS_MIGRATIONS) m.up(fresh);
    const cols = fresh.prepare("PRAGMA table_info(goals)").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("status");
    expect(names).toContain("type");
    expect(names).toContain("originator");
    expect(names).toContain("branching_policy");
    fresh.close();
  });
});
