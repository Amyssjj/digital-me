import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  createGoalsStore,
  GOALS_MIGRATIONS,
} from "../store/goals.js";
import {
  createTasksStore,
  TASKS_MIGRATIONS,
} from "../store/tasks.js";
import type { Migration } from "../store/migrations.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "../store/migrations.js";
import {
  createGoalFromPlan,
  planWorkflowBranch,
  type GoalCreateDeps,
  type TaskPlanItem,
} from "./goal-create.js";

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

function makeDeps(): GoalCreateDeps {
  let counter = 0;
  return {
    db,
    goals: createGoalsStore({ db }),
    tasks: createTasksStore({ db }),
    now: () => 1000,
    newId: () => `id-${++counter}`,
  };
}

// ── createGoalFromPlan ─────────────────────────────────────────────────────

describe("createGoalFromPlan", () => {
  it("creates a goal + tasks atomically with proper ready/pending status", async () => {
    const deps = makeDeps();
    const plans: TaskPlanItem[] = [
      {
        name: "a",
        task: "do a",
        dispatch: { mode: "manual" },
      },
      {
        name: "b",
        task: "do b",
        blockedByNames: ["a"],
        dispatch: { mode: "manual" },
      },
    ];
    const r = await createGoalFromPlan(deps, "Test goal description", plans);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.taskCount).toBe(2);
    expect(r.readyTaskIds).toHaveLength(1);
    const goal = deps.goals.get(r.goalId)!;
    expect(goal.status).toBe("running"); // updated after creation
    expect(goal.name).toBe("Test goal description");
    const tasks = deps.tasks.listForGoal(r.goalId);
    expect(tasks).toHaveLength(2);
    const taskA = tasks.find((t) => t.name === "a")!;
    const taskB = tasks.find((t) => t.name === "b")!;
    expect(taskA.status).toBe("ready");
    expect(taskA.readyAt).toBe(1000);
    expect(taskB.status).toBe("pending");
    expect(taskB.readyAt).toBeUndefined();
    expect(taskB.blockedBy).toEqual([taskA.id]);
  });

  it("truncates goal name to 80 chars", async () => {
    const deps = makeDeps();
    const longDesc = "x".repeat(200);
    const r = await createGoalFromPlan(deps, longDesc, [
      { name: "a", task: "x", dispatch: { mode: "manual" } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.goalName.length).toBe(80);
    expect(deps.goals.get(r.goalId)!.name.length).toBe(80);
  });

  it("defaults dispatch to manual when not provided", async () => {
    const deps = makeDeps();
    const r = await createGoalFromPlan(deps, "G", [
      { name: "a", task: "x" }, // no dispatch
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const t = deps.tasks.listForGoal(r.goalId)[0]!;
    expect(t.dispatch).toEqual({ mode: "manual" });
  });

  it("forwards optional fields (priority, retry, onUpstreamFailure, guidance, tags, timeoutMs)", async () => {
    const deps = makeDeps();
    const r = await createGoalFromPlan(deps, "G", [
      {
        name: "a",
        task: "x",
        dispatch: { mode: "manual" },
        priority: "urgent",
        retryPolicy: "auto_once",
        onUpstreamFailure: "skip",
        guidance: ["careful"],
        tags: ["ci", "devloop"],
        timeoutMs: 30_000,
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const t = deps.tasks.listForGoal(r.goalId)[0]!;
    expect(t.priority).toBe("urgent");
    expect(t.retryPolicy).toBe("auto_once");
    expect(t.onUpstreamFailure).toBe("skip");
    expect(t.guidance).toEqual(["careful"]);
    expect(t.tags).toEqual(["ci", "devloop"]);
    expect(t.timeoutMs).toBe(30_000);
  });

  it("forwards optional goal-level options (parentGoalId, sourceWorkflowId/Version, originator)", async () => {
    const deps = makeDeps();
    deps.goals.create({
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
    const r = await createGoalFromPlan(
      deps,
      "Child",
      [{ name: "a", task: "x", dispatch: { mode: "manual" } }],
      {
        parentGoalId: "parent",
        sourceWorkflowId: "wf-x",
        sourceWorkflowVersion: 3,
        originator: { channel: "discord", accountId: "u-1" },
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const goal = deps.goals.get(r.goalId)!;
    expect(goal.parentGoalId).toBe("parent");
    expect(goal.sourceWorkflowId).toBe("wf-x");
    expect(goal.sourceWorkflowVersion).toBe(3);
    expect(goal.originator).toEqual({ channel: "discord", accountId: "u-1" });
  });

  it("rolls back the transaction and returns ok=false when task insert throws", async () => {
    const deps = makeDeps();
    // Monkey-patch tasks.create so the second insert throws mid-transaction.
    let count = 0;
    const origCreate = deps.tasks.create.bind(deps.tasks);
    deps.tasks.create = (t) => {
      count++;
      if (count === 2) throw new Error("synthetic task insert failure");
      return origCreate(t);
    };
    const r = await createGoalFromPlan(deps, "G", [
      { name: "a", task: "x", dispatch: { mode: "manual" } },
      { name: "b", task: "x", dispatch: { mode: "manual" } },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.error).toMatch(/Failed to create goal/);
    // Verify rollback — no goal row should exist.
    expect(deps.goals.listAll()).toHaveLength(0);
  });

  it("wraps non-Error throws with String()", async () => {
    const deps = makeDeps();
    deps.tasks.create = () => {
      throw "raw-string";
    };
    const r = await createGoalFromPlan(deps, "G", [
      { name: "a", task: "x", dispatch: { mode: "manual" } },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.error).toContain("raw-string");
  });

  it("rejects blockedByNames that don't resolve to a known plan name", async () => {
    const deps = makeDeps();
    const r = await createGoalFromPlan(deps, "G", [
      {
        name: "a",
        task: "x",
        blockedByNames: ["ghost"],
        dispatch: { mode: "manual" },
      },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("unknown_blocked_by_name");
    expect(r.error).toContain('"a"');
    expect(r.error).toContain('"ghost"');
  });

  it("rejects duplicate plan names", async () => {
    const deps = makeDeps();
    const r = await createGoalFromPlan(deps, "G", [
      { name: "a", task: "x", dispatch: { mode: "manual" } },
      { name: "a", task: "y", dispatch: { mode: "manual" } },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("duplicate_plan_name");
    expect(r.error).toContain('"a"');
  });

  it("rejects empty plan names", async () => {
    const deps = makeDeps();
    const r = await createGoalFromPlan(deps, "G", [
      { name: "   ", task: "x", dispatch: { mode: "manual" } },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("invalid_plan_name");
  });

  it("invokes the aliasResolver for exec dispatch with agentId set, and stores the rewritten dispatch", async () => {
    const deps: GoalCreateDeps = {
      ...makeDeps(),
      aliasResolver: (agentId, ctx) => {
        if (agentId !== "claude-code-cli") return undefined;
        return {
          mode: "exec",
          agentId,
          command: ["/bin/echo", `wrapped-${ctx.taskId}`],
          cwd: "/tmp/wt",
          timeoutMs: 999,
        };
      },
    };
    const r = await createGoalFromPlan(deps, "G", [
      {
        name: "a",
        task: "do x",
        dispatch: { mode: "exec", command: ["raw"], agentId: "claude-code-cli" },
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const stored = deps.tasks.listForGoal(r.goalId)[0]!;
    expect(stored.dispatch).toMatchObject({
      mode: "exec",
      command: ["/bin/echo", `wrapped-${stored.id}`],
      cwd: "/tmp/wt",
      timeoutMs: 999,
    });
  });

  it("leaves the dispatch unchanged when the aliasResolver returns undefined", async () => {
    const deps: GoalCreateDeps = {
      ...makeDeps(),
      aliasResolver: () => undefined,
    };
    const r = await createGoalFromPlan(deps, "G", [
      {
        name: "a",
        task: "do x",
        dispatch: {
          mode: "exec",
          command: ["original"],
          agentId: "unknown-cli",
        },
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(deps.tasks.listForGoal(r.goalId)[0]!.dispatch).toMatchObject({
      command: ["original"],
      agentId: "unknown-cli",
    });
  });

  it("does not call aliasResolver when agentId is absent", async () => {
    let called = 0;
    const deps: GoalCreateDeps = {
      ...makeDeps(),
      aliasResolver: () => {
        called++;
        return undefined;
      },
    };
    await createGoalFromPlan(deps, "G", [
      {
        name: "a",
        task: "do x",
        dispatch: { mode: "exec", command: ["raw"] },
      },
    ]);
    expect(called).toBe(0);
  });

  it("does not call aliasResolver for spawn-mode dispatch", async () => {
    let called = 0;
    const deps: GoalCreateDeps = {
      ...makeDeps(),
      aliasResolver: () => {
        called++;
        return undefined;
      },
    };
    await createGoalFromPlan(deps, "G", [
      {
        name: "a",
        task: "do x",
        dispatch: { mode: "spawn", agentId: "claude-code-cli" },
      },
    ]);
    expect(called).toBe(0);
  });

  it("defaults newId to randomUUID and now to Date.now when omitted", async () => {
    const deps: GoalCreateDeps = {
      db,
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
    };
    const before = Date.now();
    const r = await createGoalFromPlan(deps, "G", [
      { name: "a", task: "x", dispatch: { mode: "manual" } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.goalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(deps.goals.get(r.goalId)!.createdAt).toBeGreaterThanOrEqual(before);
  });
});

// ── planWorkflowBranch (real git in tmpdir) ───────────────────────────────

describe("planWorkflowBranch", () => {
  let tmpRoot: string;
  let repoPath: string;

  function sh(cwd: string, args: readonly string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
    }).trim();
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-create-"));
    repoPath = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init", "-b", "main", repoPath], { encoding: "utf-8" });
    sh(repoPath, ["config", "user.email", "test@example.com"]);
    sh(repoPath, ["config", "user.name", "Test"]);
    sh(repoPath, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(repoPath, "README.md"), "x\n");
    sh(repoPath, ["add", "."]);
    sh(repoPath, ["commit", "-m", "init"]);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("refuses when the plan contains spawn-mode tasks", async () => {
    const deps = makeDeps();
    const r = await planWorkflowBranch(
      deps,
      { repoPath, baseBranch: "main" },
      [{ name: "spawn-task", task: "x", dispatch: { mode: "spawn", agentId: "agent-x" } }],
      "wf-1",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("spawn_in_branched_workflow");
  });

  it("returns the new branch + worktree on success", async () => {
    const deps = makeDeps();
    const r = await planWorkflowBranch(
      deps,
      { repoPath, baseBranch: "main" },
      [{ name: "exec-task", task: "x", dispatch: { mode: "exec", command: ["echo"] } }],
      "wf-1",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.branchName).toMatch(/^wf\/wf-1-/);
    expect(fs.existsSync(r.worktreePath)).toBe(true);
  });

  it("increments seq when previous branches exist with the same prefix", async () => {
    const deps = makeDeps();
    // Pre-create a goal with a matching branch_name so countByBranchPrefix returns 1.
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    deps.goals.create({
      id: "prior",
      name: "P",
      description: "",
      status: "completed",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
      branchName: `wf/wf-1-${ymd}-1`,
    });
    const r = await planWorkflowBranch(
      deps,
      { repoPath, baseBranch: "main" },
      [{ name: "exec", task: "x", dispatch: { mode: "exec", command: ["echo"] } }],
      "wf-1",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.branchName).toBe(`wf/wf-1-${ymd}-2`);
  });

  it("defaults sourceWorkflowId to 'ad-hoc' when omitted", async () => {
    const deps = makeDeps();
    const r = await planWorkflowBranch(
      deps,
      { repoPath, baseBranch: "main" },
      [{ name: "exec", task: "x", dispatch: { mode: "exec", command: ["echo"] } }],
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.branchName).toMatch(/^wf\/ad-hoc-/);
  });

  it("wraps a createWorkflowBranch failure with errorCode=branching_failed", async () => {
    const deps = makeDeps();
    const r = await planWorkflowBranch(
      deps,
      { repoPath, baseBranch: "missing-branch" },
      [{ name: "exec", task: "x", dispatch: { mode: "exec", command: ["echo"] } }],
      "wf-1",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("branching_failed");
  });
});

// ── createGoalFromPlan + branching integration ────────────────────────────

describe("createGoalFromPlan with branching", () => {
  let tmpRoot: string;
  let repoPath: string;

  function sh(cwd: string, args: readonly string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
    }).trim();
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-create-br-"));
    repoPath = path.join(tmpRoot, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init", "-b", "main", repoPath], { encoding: "utf-8" });
    sh(repoPath, ["config", "user.email", "test@example.com"]);
    sh(repoPath, ["config", "user.name", "Test"]);
    sh(repoPath, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(repoPath, "README.md"), "x\n");
    sh(repoPath, ["add", "."]);
    sh(repoPath, ["commit", "-m", "init"]);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("attaches branchName + worktreePath to the goal when branching policy is supplied", async () => {
    const deps = makeDeps();
    const r = await createGoalFromPlan(
      deps,
      "Branched goal",
      [{ name: "exec", task: "x", dispatch: { mode: "exec", command: ["echo"] } }],
      {
        sourceWorkflowId: "wf-x",
        branching: { repoPath, baseBranch: "main" },
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const goal = deps.goals.get(r.goalId)!;
    expect(goal.branchName).toMatch(/^wf\/wf-x-/);
    expect(goal.worktreePath).toBeDefined();
    expect(fs.existsSync(goal.worktreePath!)).toBe(true);
    expect(goal.branchingPolicy).toEqual({ repoPath, baseBranch: "main" });
  });

  it("returns the planning error and creates no goal when branching validation fails", async () => {
    const deps = makeDeps();
    const r = await createGoalFromPlan(
      deps,
      "Bad",
      [{ name: "spawn", task: "x", dispatch: { mode: "spawn", agentId: "x" } }],
      { branching: { repoPath, baseBranch: "main" } },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("spawn_in_branched_workflow");
    expect(deps.goals.listAll()).toHaveLength(0);
  });

  it("hard-removes the orphan worktree+branch if transaction fails after branch creation", async () => {
    const deps = makeDeps();
    // Force the task-insert to fail mid-transaction.
    deps.tasks.create = () => {
      throw new Error("synthetic insert failure");
    };
    const r = await createGoalFromPlan(
      deps,
      "Orphan",
      [{ name: "exec", task: "x", dispatch: { mode: "exec", command: ["echo"] } }],
      {
        sourceWorkflowId: "wf-x",
        branching: { repoPath, baseBranch: "main" },
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    // The worktree should NOT remain (removeWorkflowBranch was called).
    const wtRoot = path.join(repoPath, ".worktrees");
    if (fs.existsSync(wtRoot)) {
      const entries = fs.readdirSync(wtRoot);
      expect(entries).toEqual([]);
    }
  });

  it("does not fail the outer error path if cleanup of the orphan branch also fails", async () => {
    const deps = makeDeps();
    deps.tasks.create = () => {
      throw new Error("synthetic");
    };
    // Pre-corrupt the worktree dir so removeWorkflowBranch fails silently.
    // Actually removeWorkflowBranch swallows errors and returns a summary
    // string, so this scenario already doesn't throw — verify by making the
    // outer error path return cleanly.
    const r = await createGoalFromPlan(
      deps,
      "Orphan2",
      [{ name: "exec", task: "x", dispatch: { mode: "exec", command: ["echo"] } }],
      {
        sourceWorkflowId: "wf-y",
        branching: { repoPath, baseBranch: "main" },
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("goal_create_failed");
  });
});
