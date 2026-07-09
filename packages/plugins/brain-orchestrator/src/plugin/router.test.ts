import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  type OrchestratorTaskRecord,
} from "../store/tasks.js";
import {
  createWorkflowsStore,
  WORKFLOWS_MIGRATIONS,
} from "../store/workflows.js";
import {
  createSchedulesStore,
  SCHEDULES_MIGRATIONS,
} from "../store/schedules.js";
import type { Migration } from "../store/migrations.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "../store/migrations.js";
import type { Dispatcher, SchedulerRuntime } from "../handlers/scheduler.js";
import {
  dispatchAction,
  TASKS_ACTIONS,
  type RouterDeps,
} from "./router.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of [
    ...GOALS_MIGRATIONS,
    ...TASKS_MIGRATIONS,
    ...WORKFLOWS_MIGRATIONS,
    ...SCHEDULES_MIGRATIONS,
  ] as Migration[]) {
    registerMigration(m);
  }
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function makeDispatcher(
  overrides: Partial<Dispatcher> = {},
): { dispatcher: Dispatcher; spawnCalls: number; execCalls: number } {
  let spawnCalls = 0;
  let execCalls = 0;
  const dispatcher: Dispatcher = {
    async dispatchSpawnTask() {
      spawnCalls++;
      return true;
    },
    async dispatchExecTask() {
      execCalls++;
      return true;
    },
    async probeSessionLiveness() {
      return [];
    },
    ...overrides,
  };
  return {
    dispatcher,
    get spawnCalls() {
      return spawnCalls;
    },
    get execCalls() {
      return execCalls;
    },
  };
}

function makeDeps(opts: {
  dispatcher?: Dispatcher;
  now?: number;
} = {}): RouterDeps {
  const runtime: SchedulerRuntime = {
    log() {
      // no-op for tests
    },
  };
  let counter = 0;
  return {
    db,
    goals: createGoalsStore({ db }),
    tasks: createTasksStore({ db }),
    workflows: createWorkflowsStore({ db }),
    schedules: createSchedulesStore({ db }),
    runtime,
    dispatcher: opts.dispatcher ?? makeDispatcher().dispatcher,
    now: opts.now !== undefined ? () => opts.now! : undefined,
    newId: () => `id-${++counter}`,
  };
}

function seedWorkflow(deps: RouterDeps, id: string = "wf-1"): void {
  deps.workflows.create({
    id,
    name: id,
    description: "",
    variables: [],
    createdAt: 0,
    updatedAt: 0,
    version: 1,
  });
  deps.workflows.createStep({
    id: `step-${id}-1`,
    workflowId: id,
    stepKey: "s1",
    name: "Step 1",
    promptTemplate: "Do X",
    blockedByKeys: [],
    dispatch: { mode: "manual" },
    priority: "normal",
    onUpstreamFailure: "wait",
    sortOrder: 0,
  });
}

function seedGoalWithTask(
  deps: RouterDeps,
  taskOverrides: Partial<OrchestratorTaskRecord> = {},
): OrchestratorTaskRecord {
  deps.goals.create({
    id: "g-1",
    name: "G",
    description: "",
    status: "running",
    type: "project",
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "t",
  });
  const t: OrchestratorTaskRecord = {
    id: "t-1",
    goalId: "g-1",
    name: "Task A",
    task: "do x",
    blockedBy: [],
    dispatch: { mode: "manual" },
    status: "running",
    attemptCount: 0,
    attempts: [],
    priority: "normal",
    onUpstreamFailure: "wait",
    ...taskOverrides,
  };
  deps.tasks.create(t);
  return t;
}

// ── TASKS_ACTIONS shape ────────────────────────────────────────────────────

describe("TASKS_ACTIONS", () => {
  it("exposes the 20-action vocabulary", () => {
    expect(TASKS_ACTIONS).toContain("run_goal");
    expect(TASKS_ACTIONS).toContain("run_workflow");
    expect(TASKS_ACTIONS).toContain("schedule_tick");
    expect(TASKS_ACTIONS).toContain("workflow_delete");
    expect(TASKS_ACTIONS.length).toBeGreaterThanOrEqual(20);
  });
});

// ── Unknown action ────────────────────────────────────────────────────────

describe("dispatchAction — unknown actions", () => {
  it("returns ok=false with 'Unknown action' for an unrecognized verb", async () => {
    const deps = makeDeps();
    const r = await dispatchAction(deps, "totally_invented", {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Unknown action/);
  });
});

// ── run_goal ──────────────────────────────────────────────────────────────

describe("dispatchAction(run_goal)", () => {
  it("creates a goal and dispatches ready spawn tasks", async () => {
    const dCtx = makeDispatcher();
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    const r = await dispatchAction(deps, "run_goal", {
      description: "Test goal",
      tasks: JSON.stringify([
        {
          name: "a",
          task: "do a",
          dispatch: { mode: "spawn", agentId: "agent-x" },
        },
      ]),
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Goal "Test goal" created with 1 tasks. 1 dispatched/);
    expect(dCtx.spawnCalls).toBe(1);
  });

  it("dispatches exec tasks via the exec path", async () => {
    const dCtx = makeDispatcher();
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    const r = await dispatchAction(deps, "run_goal", {
      description: "G",
      tasks: JSON.stringify([
        {
          name: "a",
          task: "x",
          dispatch: { mode: "exec", command: ["echo"] },
        },
      ]),
    });
    expect(r.ok).toBe(true);
    expect(dCtx.execCalls).toBe(1);
  });

  it("accepts tasks as a JS array (object) too, not just JSON string", async () => {
    const deps = makeDeps();
    const r = await dispatchAction(deps, "run_goal", {
      description: "G",
      tasks: [{ name: "a", task: "x", dispatch: { mode: "manual" } }],
    });
    expect(r.ok).toBe(true);
  });

  it("doesn't count manual tasks toward 'dispatched' count", async () => {
    const dCtx = makeDispatcher();
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    const r = await dispatchAction(deps, "run_goal", {
      description: "G",
      tasks: JSON.stringify([
        { name: "a", task: "x", dispatch: { mode: "manual" } },
      ]),
    });
    expect(r.text).toMatch(/0 dispatched/);
    expect(dCtx.spawnCalls).toBe(0);
  });

  it("swallows dispatcher throws without failing the call", async () => {
    const dCtx = makeDispatcher({
      async dispatchSpawnTask() {
        throw new Error("network blip");
      },
    });
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    const r = await dispatchAction(deps, "run_goal", {
      description: "G",
      tasks: JSON.stringify([
        {
          name: "a",
          task: "x",
          dispatch: { mode: "spawn", agentId: "agent-x" },
        },
      ]),
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/0 dispatched/);
  });

  it("skips ready tasks the dispatcher returns false for", async () => {
    const dCtx = makeDispatcher({
      async dispatchSpawnTask() {
        return false;
      },
    });
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    const r = await dispatchAction(deps, "run_goal", {
      description: "G",
      tasks: JSON.stringify([
        {
          name: "a",
          task: "x",
          dispatch: { mode: "spawn", agentId: "agent-x" },
        },
      ]),
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/0 dispatched/);
  });

  it("returns ok=false when description is missing", async () => {
    const r = await dispatchAction(makeDeps(), "run_goal", {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Missing description/);
  });

  it("returns ok=false when tasks param is missing", async () => {
    const r = await dispatchAction(makeDeps(), "run_goal", {
      description: "G",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Missing tasks parameter/);
  });

  it("returns ok=false when tasks JSON is malformed", async () => {
    const r = await dispatchAction(makeDeps(), "run_goal", {
      description: "G",
      tasks: "{not json",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Invalid JSON in tasks/);
  });

  it("returns ok=false when goal-create fails", async () => {
    const deps = makeDeps();
    // Force a goals.create failure by pre-inserting the goal id we'd use.
    // Easier: monkey-patch deps.goals.create to throw.
    deps.goals.create = () => {
      throw new Error("forced");
    };
    const r = await dispatchAction(deps, "run_goal", {
      description: "G",
      tasks: JSON.stringify([
        { name: "a", task: "x", dispatch: { mode: "manual" } },
      ]),
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/forced|Failed to create goal/);
  });

  it("ignores ready tasks whose id no longer resolves (post-creation race)", async () => {
    const dCtx = makeDispatcher();
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    // Monkey-patch tasks.get so the post-creation lookup misses.
    const origGet = deps.tasks.get.bind(deps.tasks);
    deps.tasks.get = () => undefined;
    const r = await dispatchAction(deps, "run_goal", {
      description: "G",
      tasks: JSON.stringify([
        {
          name: "a",
          task: "x",
          dispatch: { mode: "spawn", agentId: "agent-x" },
        },
      ]),
    });
    expect(r.ok).toBe(true);
    expect(dCtx.spawnCalls).toBe(0);
    deps.tasks.get = origGet;
  });

  it("forwards parentGoalId option", async () => {
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
    const r = await dispatchAction(deps, "run_goal", {
      description: "Child",
      tasks: JSON.stringify([
        { name: "a", task: "x", dispatch: { mode: "manual" } },
      ]),
      parentGoalId: "parent",
    });
    expect(r.ok).toBe(true);
    const goals = deps.goals.listAll();
    const child = goals.find((g) => g.id !== "parent")!;
    expect(child.parentGoalId).toBe("parent");
  });
});

// ── run_workflow ──────────────────────────────────────────────────────────

describe("dispatchAction(run_workflow)", () => {
  it("instantiates a workflow and dispatches ready tasks", async () => {
    const dCtx = makeDispatcher();
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "run_workflow", {
      templateId: "wf-1",
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/created from workflow "wf-1"/);
  });

  it("returns ok=false when templateId is missing", async () => {
    const r = await dispatchAction(makeDeps(), "run_workflow", {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Missing templateId/);
  });

  it("accepts variables as JSON string", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "run_workflow", {
      templateId: "wf-1",
      variables: JSON.stringify({ k: "v" }),
    });
    expect(r.ok).toBe(true);
  });

  it("accepts variables as plain object", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "run_workflow", {
      templateId: "wf-1",
      variables: { k: "v" },
    });
    expect(r.ok).toBe(true);
  });

  it("returns ok=false when variables JSON is malformed", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "run_workflow", {
      templateId: "wf-1",
      variables: "{not json",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Invalid JSON in variables/);
  });

  it("returns ok=false when the template doesn't exist", async () => {
    const r = await dispatchAction(makeDeps(), "run_workflow", {
      templateId: "ghost",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not found/);
  });

  it("respects force=true to bypass the mutex", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    await dispatchAction(deps, "run_workflow", { templateId: "wf-1" });
    const r = await dispatchAction(deps, "run_workflow", {
      templateId: "wf-1",
      force: true,
    });
    expect(r.ok).toBe(true);
  });

  it("dispatches exec-mode steps via the exec path", async () => {
    const dCtx = makeDispatcher();
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    deps.workflows.create({
      id: "wf-exec",
      name: "Exec WF",
      description: "",
      variables: [],
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
    deps.workflows.createStep({
      id: "s",
      workflowId: "wf-exec",
      stepKey: "s",
      name: "S",
      promptTemplate: "x",
      blockedByKeys: [],
      dispatch: { mode: "exec", command: ["echo"] },
      priority: "normal",
      onUpstreamFailure: "wait",
      sortOrder: 0,
    });
    const r = await dispatchAction(deps, "run_workflow", {
      templateId: "wf-exec",
    });
    expect(r.ok).toBe(true);
    expect(dCtx.execCalls).toBe(1);
  });

  it("swallows dispatcher throws on workflow instantiation", async () => {
    const dCtx = makeDispatcher({
      async dispatchSpawnTask() {
        throw new Error("blip");
      },
    });
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    deps.workflows.create({
      id: "wf-s",
      name: "Spawn WF",
      description: "",
      variables: [],
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
    deps.workflows.createStep({
      id: "s",
      workflowId: "wf-s",
      stepKey: "s",
      name: "S",
      promptTemplate: "x",
      blockedByKeys: [],
      dispatch: { mode: "spawn", agentId: "a" },
      priority: "normal",
      onUpstreamFailure: "wait",
      sortOrder: 0,
    });
    const r = await dispatchAction(deps, "run_workflow", {
      templateId: "wf-s",
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/0 dispatched/);
  });

  it("skips ready exec tasks the dispatcher returns false for", async () => {
    const dCtx = makeDispatcher({
      async dispatchExecTask() {
        return false;
      },
    });
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    deps.workflows.create({
      id: "wf-e",
      name: "WF",
      description: "",
      variables: [],
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
    deps.workflows.createStep({
      id: "s",
      workflowId: "wf-e",
      stepKey: "s",
      name: "S",
      promptTemplate: "x",
      blockedByKeys: [],
      dispatch: { mode: "exec", command: ["echo"] },
      priority: "normal",
      onUpstreamFailure: "wait",
      sortOrder: 0,
    });
    const r = await dispatchAction(deps, "run_workflow", {
      templateId: "wf-e",
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/0 dispatched/);
  });

  it("dispatches spawn-mode workflow steps successfully", async () => {
    const dCtx = makeDispatcher();
    const deps = makeDeps({ dispatcher: dCtx.dispatcher });
    deps.workflows.create({
      id: "wf-spawn",
      name: "WF",
      description: "",
      variables: [],
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
    deps.workflows.createStep({
      id: "s",
      workflowId: "wf-spawn",
      stepKey: "s",
      name: "S",
      promptTemplate: "x",
      blockedByKeys: [],
      dispatch: { mode: "spawn", agentId: "agent-x" },
      priority: "normal",
      onUpstreamFailure: "wait",
      sortOrder: 0,
    });
    const r = await dispatchAction(deps, "run_workflow", {
      templateId: "wf-spawn",
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/1 dispatched/);
    expect(dCtx.spawnCalls).toBe(1);
  });

  it("ignores ready task whose row vanishes mid-flight", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    deps.tasks.get = () => undefined;
    const r = await dispatchAction(deps, "run_workflow", {
      templateId: "wf-1",
    });
    expect(r.ok).toBe(true);
  });
});

// ── board / status ────────────────────────────────────────────────────────

describe("dispatchAction(board)", () => {
  it("returns markdown by default", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "board", {});
    expect(r.ok).toBe(true);
    expect(r.text).toContain("## Active Goals");
    expect(r.json).toBeUndefined();
  });

  it("returns JSON when format=json (with nested tasks)", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "board", { format: "json" });
    expect(r.ok).toBe(true);
    expect(r.json).toBeDefined();
    const parsed = JSON.parse(r.text) as { goals: unknown[] };
    expect(parsed.goals).toHaveLength(1);
  });

  it("excludes evergreen goals from JSON output", async () => {
    const deps = makeDeps();
    deps.goals.create({
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
    const r = await dispatchAction(deps, "board", { format: "json" });
    expect((r.json as { goals: unknown[] }).goals).toHaveLength(0);
  });

  it("filters completed goals by since window", async () => {
    const deps = makeDeps({ now: 100_000 });
    deps.goals.create({
      id: "old",
      name: "Old",
      description: "",
      status: "completed",
      type: "project",
      taskIds: [],
      completedAt: 1,
      createdAt: 0,
      updatedAt: 1,
      createdBy: "t",
    });
    const r = await dispatchAction(deps, "board", {
      format: "json",
      since: 50_000,
    });
    expect((r.json as { goals: unknown[] }).goals).toHaveLength(0);
  });

  it("uses updatedAt as the cancelled-goal cutoff", async () => {
    const deps = makeDeps();
    deps.goals.create({
      id: "cx",
      name: "Cx",
      description: "",
      status: "cancelled",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 5000,
      createdBy: "t",
    });
    const r = await dispatchAction(deps, "board", {
      format: "json",
      since: 9999,
    });
    expect((r.json as { goals: unknown[] }).goals).toHaveLength(0);
  });

  it("falls back to updatedAt when completed goal has no completedAt", async () => {
    const deps = makeDeps();
    deps.goals.create({
      id: "g",
      name: "G",
      description: "",
      status: "completed",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 5000,
      createdBy: "t",
    });
    const r = await dispatchAction(deps, "board", {
      format: "json",
      since: 1000,
    });
    expect((r.json as { goals: unknown[] }).goals).toHaveLength(1);
  });

  it("defaults since to 7 days ago when format=json without since", async () => {
    const deps = makeDeps();
    deps.goals.create({
      id: "g",
      name: "G",
      description: "",
      status: "running",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    const r = await dispatchAction(deps, "board", { format: "json" });
    expect((r.json as { goals: unknown[] }).goals).toHaveLength(1);
  });
});

describe("dispatchAction(status)", () => {
  it("returns markdown task detail by default", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "status", { taskId: "t-1" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("## Task: Task A");
  });

  it("falls back to findByName when id lookup misses", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "status", { taskId: "Task A" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("## Task: Task A");
  });

  it("returns ok=false when taskId is missing (markdown)", async () => {
    const r = await dispatchAction(makeDeps(), "status", {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Missing taskId/);
  });

  it("returns ok=false when task not found (markdown)", async () => {
    const r = await dispatchAction(makeDeps(), "status", {
      taskId: "ghost",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not found/);
  });

  it("returns JSON wrapping when format=json", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "status", {
      taskId: "t-1",
      format: "json",
    });
    expect(r.ok).toBe(true);
    expect((r.json as { task: { id: string } }).task.id).toBe("t-1");
  });

  it("returns JSON error when format=json + taskId missing", async () => {
    const r = await dispatchAction(makeDeps(), "status", { format: "json" });
    expect(r.ok).toBe(false);
    expect((r.json as { task: null; error: string }).error).toMatch(
      /Missing taskId/,
    );
  });

  it("returns JSON error when format=json + task not found", async () => {
    const r = await dispatchAction(makeDeps(), "status", {
      taskId: "ghost",
      format: "json",
    });
    expect(r.ok).toBe(false);
    expect((r.json as { task: null; error: string }).error).toMatch(
      /not found/,
    );
  });
});

// ── checkpoint / handoff ──────────────────────────────────────────────────

describe("dispatchAction(checkpoint)", () => {
  it("records a checkpoint on a running task", async () => {
    const deps = makeDeps({ now: 5000 });
    seedGoalWithTask(deps, { status: "running" });
    const r = await dispatchAction(deps, "checkpoint", {
      taskId: "t-1",
      phase: "validation",
      summary: "halfway",
      progressPercent: 50,
      blocker: "review",
      artifactPaths: "/x, /y",
      recommendedNextStep: "ship",
    });
    expect(r.ok).toBe(true);
    const t = deps.tasks.get("t-1")!;
    expect(t.latestCheckpoint?.phase).toBe("validation");
    expect(t.latestCheckpoint?.artifactPaths).toEqual(["/x", "/y"]);
    expect(t.latestCheckpoint?.progressPercent).toBe(50);
    expect(t.latestCheckpoint?.blocker).toBe("review");
  });

  it("accepts artifactPaths as a JSON array (native MCP shape), not just a comma string", async () => {
    const deps = makeDeps({ now: 5000 });
    seedGoalWithTask(deps, { status: "running" });
    const r = await dispatchAction(deps, "checkpoint", {
      taskId: "t-1",
      phase: "validation",
      summary: "halfway",
      artifactPaths: ["/x", "/y"],
    });
    expect(r.ok).toBe(true);
    expect(deps.tasks.get("t-1")!.latestCheckpoint?.artifactPaths).toEqual([
      "/x",
      "/y",
    ]);
  });

  it("treats an empty artifactPaths array as absent", async () => {
    const deps = makeDeps({ now: 5000 });
    seedGoalWithTask(deps, { status: "running" });
    const r = await dispatchAction(deps, "checkpoint", {
      taskId: "t-1",
      phase: "validation",
      summary: "halfway",
      artifactPaths: ["  ", ""],
    });
    expect(r.ok).toBe(true);
    expect(
      deps.tasks.get("t-1")!.latestCheckpoint?.artifactPaths,
    ).toBeUndefined();
  });

  it("returns ok=false when taskId is missing", async () => {
    const r = await dispatchAction(makeDeps(), "checkpoint", {
      phase: "x",
      summary: "y",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Missing taskId/);
  });

  it("returns ok=false when phase or summary is missing", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "checkpoint", {
      taskId: "t-1",
      summary: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/requires both phase and summary/);
  });

  it("returns ok=false when task not found", async () => {
    const r = await dispatchAction(makeDeps(), "checkpoint", {
      taskId: "ghost",
      phase: "x",
      summary: "y",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not found/);
  });

  it("returns ok=false when task is in a non-checkpoint-accepting status", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps, { status: "completed" });
    const r = await dispatchAction(deps, "checkpoint", {
      taskId: "t-1",
      phase: "x",
      summary: "y",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not in a checkpoint-accepting status/);
  });
});

describe("dispatchAction(handoff)", () => {
  it("records a complete handoff and finalizes the task", async () => {
    const deps = makeDeps({ now: 9000 });
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "handoff", {
      taskId: "t-1",
      summary: "done",
      deliverableState: "complete",
      artifactPaths: "/out.txt",
      recommendedNextStep: "ship",
    });
    expect(r.ok).toBe(true);
    expect(deps.tasks.get("t-1")!.status).toBe("completed");
    expect(deps.tasks.get("t-1")!.latestOutput?.artifactPaths).toEqual([
      "/out.txt",
    ]);
  });

  it("records a partial handoff without completing", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "handoff", {
      taskId: "t-1",
      summary: "midway",
      deliverableState: "partial",
    });
    expect(r.ok).toBe(true);
    expect(deps.tasks.get("t-1")!.status).toBe("running");
  });

  it("returns ok=false when taskId is missing", async () => {
    const r = await dispatchAction(makeDeps(), "handoff", {
      summary: "x",
      deliverableState: "complete",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Missing taskId/);
  });

  it("returns ok=false when summary or deliverableState is missing", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "handoff", { taskId: "t-1" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/requires both summary and deliverableState/);
  });

  it("returns ok=false on invalid deliverableState", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "handoff", {
      taskId: "t-1",
      summary: "x",
      deliverableState: "bogus",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Invalid deliverableState/);
  });

  it("returns ok=false when task not found", async () => {
    const r = await dispatchAction(makeDeps(), "handoff", {
      taskId: "ghost",
      summary: "x",
      deliverableState: "complete",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not found/);
  });

  it("returns ok=false when task is in a non-handoff-accepting status", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps, { status: "completed" });
    const r = await dispatchAction(deps, "handoff", {
      taskId: "t-1",
      summary: "x",
      deliverableState: "complete",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not in a handoff-accepting status/);
  });
});

// ── approve / reject / claim / complete / cancel ──────────────────────────

describe("dispatchAction — transition actions", () => {
  it("approve transitions a task awaiting approval to completed", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps, { status: "awaiting_approval" });
    const r = await dispatchAction(deps, "approve", { taskId: "t-1" });
    expect(r.ok).toBe(true);
  });

  it("reject moves an approval-pending task to failed (with optional reason)", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps, { status: "awaiting_approval" });
    const r = await dispatchAction(deps, "reject", {
      taskId: "t-1",
      reason: "wrong scope",
    });
    expect(r.ok).toBe(true);
    expect(deps.tasks.get("t-1")!.failureReason).toBe("wrong scope");
  });

  it("claim moves ready → running", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps, { status: "ready" });
    const r = await dispatchAction(deps, "claim", { taskId: "t-1" });
    expect(r.ok).toBe(true);
  });

  it("complete finalizes a running task", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps, { status: "running" });
    const r = await dispatchAction(deps, "complete", { taskId: "t-1" });
    expect(r.ok).toBe(true);
  });

  it("cancel marks the goal cancelled and reports success", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps);
    const r = await dispatchAction(deps, "cancel", { goalId: "g-1" });
    expect(r.ok).toBe(true);
    expect(deps.goals.get("g-1")!.status).toBe("cancelled");
  });

  it("propagates handler error message when transition fails (claim wrong status)", async () => {
    const deps = makeDeps();
    seedGoalWithTask(deps, { status: "completed" });
    const r = await dispatchAction(deps, "claim", { taskId: "t-1" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Cannot claim/);
  });
});

// ── schedule_* ────────────────────────────────────────────────────────────

describe("dispatchAction — schedule_* actions", () => {
  it("schedule_add creates a schedule", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
      cronExpr: "0 0 * * *",
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Schedule "wf-1" created/);
  });

  it("schedule_add returns ok=false when templateId missing", async () => {
    const r = await dispatchAction(makeDeps(), "schedule_add", {
      cronExpr: "0 0 * * *",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Missing templateId/);
  });

  it("schedule_add returns ok=false when cronExpr missing", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Missing cronExpr/);
  });

  it("schedule_add returns ok=false on malformed variables JSON", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
      cronExpr: "0 0 * * *",
      variables: "{not json",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Invalid JSON in variables/);
  });

  it("schedule_add accepts variables as plain object", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
      cronExpr: "0 0 * * *",
      variables: { k: "v" },
    });
    expect(r.ok).toBe(true);
  });

  it("schedule_add forwards scheduleName + timezone to the handler", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
      scheduleName: "nightly",
      cronExpr: "0 0 * * *",
      timezone: "America/New_York",
    });
    expect(deps.schedules.getByName("nightly")!.timezone).toBe(
      "America/New_York",
    );
  });

  it("schedule_add surfaces addSchedule failure (workflow not found)", async () => {
    const deps = makeDeps();
    const r = await dispatchAction(deps, "schedule_add", {
      templateId: "ghost-wf",
      cronExpr: "0 0 * * *",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Workflow "ghost-wf" not found/);
  });

  it("schedule_enable surfaces setScheduleEnabled failure (bad stored cron)", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
      cronExpr: "0 0 * * *",
    });
    const sid = deps.schedules.listAll()[0]!.id;
    // Corrupt the stored cron expression.
    const s = deps.schedules.get(sid)!;
    deps.schedules.update({ ...s, cronExpr: "garbage" });
    const r = await dispatchAction(deps, "schedule_enable", {
      scheduleId: sid,
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/cron expression may be invalid/);
  });

  it("coerces non-string scheduleId / taskId params to '' (then handler reports not-found)", async () => {
    const r = await dispatchAction(makeDeps(), "schedule_remove", {
      scheduleId: 42 as unknown as string,
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not found/);
  });

  it("schedule_list returns markdown when format unset", async () => {
    const deps = makeDeps();
    const r = await dispatchAction(deps, "schedule_list", {});
    expect(r.ok).toBe(true);
    expect(r.text).toBe("No schedules configured.");
  });

  it("schedule_list returns JSON when format=json", async () => {
    const deps = makeDeps();
    const r = await dispatchAction(deps, "schedule_list", { format: "json" });
    expect(r.ok).toBe(true);
    expect(r.json).toEqual({ schedules: [] });
  });

  it("schedule_remove removes by id", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
      cronExpr: "0 0 * * *",
    });
    const id = deps.schedules.listAll()[0]!.id;
    const r = await dispatchAction(deps, "schedule_remove", {
      scheduleId: id,
    });
    expect(r.ok).toBe(true);
  });

  it("schedule_remove returns ok=false when unknown", async () => {
    const r = await dispatchAction(makeDeps(), "schedule_remove", {
      scheduleId: "ghost",
    });
    expect(r.ok).toBe(false);
  });

  it("schedule_enable + schedule_disable toggle the row", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
      cronExpr: "0 0 * * *",
    });
    const id = deps.schedules.listAll()[0]!.id;
    const r1 = await dispatchAction(deps, "schedule_disable", {
      scheduleId: id,
    });
    expect(r1.ok).toBe(true);
    expect(deps.schedules.get(id)!.enabled).toBe(false);
    const r2 = await dispatchAction(deps, "schedule_enable", {
      scheduleId: id,
    });
    expect(r2.ok).toBe(true);
    expect(deps.schedules.get(id)!.enabled).toBe(true);
  });

  it("schedule_tick runs the scheduler tick and returns a summary", async () => {
    const deps = makeDeps({ now: Date.now() });
    seedWorkflow(deps);
    await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
      cronExpr: "* * * * *",
    });
    const r = await dispatchAction(deps, "schedule_tick", {});
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Tick complete/);
  });

  it("schedule_tick summarizes 'no schedules due' when there's nothing to do", async () => {
    const deps = makeDeps({ now: 0 });
    const r = await dispatchAction(deps, "schedule_tick", {});
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/No schedules due/);
  });

  it("schedule_tick summarizes reconciled tasks when watchdog finds stalls", async () => {
    const deps = makeDeps({ now: 100_000_000 });
    seedGoalWithTask(deps, { status: "running", startedAt: 0 });
    const r = await dispatchAction(deps, "schedule_tick", {});
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Reconciled \d+ stale tasks/);
  });

  it("schedule_tick summarizes reconciled completed dependency blockers", async () => {
    const deps = makeDeps({ now: 5000 });
    seedGoalWithTask(deps, { id: "upstream", status: "completed" });
    deps.tasks.create({
      id: "downstream",
      goalId: "g-1",
      name: "Task B",
      task: "do y",
      blockedBy: ["upstream"],
      dispatch: { mode: "manual" },
      status: "pending",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    const r = await dispatchAction(deps, "schedule_tick", {});
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Reconciled \d+ completed dependency blockers/);
    expect(deps.tasks.get("downstream")!.status).toBe("ready");
  });

  it("schedule_tick summarizes refreshed schedule statuses", async () => {
    const deps = makeDeps({ now: Date.now() });
    seedWorkflow(deps);
    await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
      cronExpr: "0 0 * * *",
    });
    // Attach a goal whose status differs from schedule.lastStatus.
    const sid = deps.schedules.listAll()[0]!.id;
    deps.goals.create({
      id: "g",
      name: "G",
      description: "",
      status: "completed",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    const s = deps.schedules.get(sid)!;
    deps.schedules.update({
      ...s,
      lastGoalId: "g",
      lastStatus: "running",
    });
    const r = await dispatchAction(deps, "schedule_tick", {});
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Refreshed \d+ schedule statuses/);
  });

  it("schedule_tick uses an instantiateWorkflow callback that dispatches ready tasks", async () => {
    const dCtx = makeDispatcher();
    const deps = makeDeps({ dispatcher: dCtx.dispatcher, now: Date.now() });
    deps.workflows.create({
      id: "wf-exec",
      name: "Exec WF",
      description: "",
      variables: [],
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
    deps.workflows.createStep({
      id: "s",
      workflowId: "wf-exec",
      stepKey: "s",
      name: "S",
      promptTemplate: "x",
      blockedByKeys: [],
      dispatch: { mode: "exec", command: ["echo"] },
      priority: "normal",
      onUpstreamFailure: "wait",
      sortOrder: 0,
    });
    deps.schedules.create({
      id: "s1",
      workflowId: "wf-exec",
      name: "exec-sched",
      cronExpr: "* * * * *",
      timezone: "UTC",
      variables: {},
      enabled: true,
      nextRunAt: 0,
      maxOverlap: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const r = await dispatchAction(deps, "schedule_tick", {});
    expect(r.ok).toBe(true);
    expect(dCtx.execCalls).toBeGreaterThan(0);
  });

  it("schedule_tick instantiator handles spawn dispatch + returns-false correctly", async () => {
    const dCtx = makeDispatcher({
      async dispatchSpawnTask() {
        return false;
      },
    });
    const deps = makeDeps({ dispatcher: dCtx.dispatcher, now: Date.now() });
    deps.workflows.create({
      id: "wf-sp",
      name: "WF",
      description: "",
      variables: [],
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
    deps.workflows.createStep({
      id: "s",
      workflowId: "wf-sp",
      stepKey: "s",
      name: "S",
      promptTemplate: "x",
      blockedByKeys: [],
      dispatch: { mode: "spawn", agentId: "a" },
      priority: "normal",
      onUpstreamFailure: "wait",
      sortOrder: 0,
    });
    deps.schedules.create({
      id: "sp",
      workflowId: "wf-sp",
      name: "sp",
      cronExpr: "* * * * *",
      timezone: "UTC",
      variables: {},
      enabled: true,
      nextRunAt: 0,
      maxOverlap: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const r = await dispatchAction(deps, "schedule_tick", {});
    expect(r.ok).toBe(true);
  });

  it("schedule_tick instantiator returns ok=false when instantiate fails", async () => {
    const deps = makeDeps({ now: Date.now() });
    // Workflow exists but has NO steps — passes the scheduler's existence check
    // but then instantiateWorkflow fails with workflow_has_no_steps, exercising
    // the !r.ok branch of the router's instantiator callback.
    deps.workflows.create({
      id: "wf-empty",
      name: "Empty",
      description: "",
      variables: [],
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
    deps.schedules.create({
      id: "bad",
      workflowId: "wf-empty",
      name: "bad",
      cronExpr: "* * * * *",
      timezone: "UTC",
      variables: {},
      enabled: true,
      nextRunAt: 0,
      maxOverlap: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const r = await dispatchAction(deps, "schedule_tick", {});
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Scanned/);
  });

  it("schedule_tick instantiator swallows dispatcher throws gracefully", async () => {
    const dCtx = makeDispatcher({
      async dispatchExecTask() {
        throw new Error("blip");
      },
    });
    const deps = makeDeps({ dispatcher: dCtx.dispatcher, now: Date.now() });
    deps.workflows.create({
      id: "wf-e",
      name: "WF",
      description: "",
      variables: [],
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
    deps.workflows.createStep({
      id: "s",
      workflowId: "wf-e",
      stepKey: "s",
      name: "S",
      promptTemplate: "x",
      blockedByKeys: [],
      dispatch: { mode: "exec", command: ["echo"] },
      priority: "normal",
      onUpstreamFailure: "wait",
      sortOrder: 0,
    });
    deps.schedules.create({
      id: "s1",
      workflowId: "wf-e",
      name: "wfe",
      cronExpr: "* * * * *",
      timezone: "UTC",
      variables: {},
      enabled: true,
      nextRunAt: 0,
      maxOverlap: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const r = await dispatchAction(deps, "schedule_tick", {});
    expect(r.ok).toBe(true);
  });

  it("schedule_tick instantiator skips manual tasks (no dispatch attempted)", async () => {
    const dCtx = makeDispatcher();
    const deps = makeDeps({ dispatcher: dCtx.dispatcher, now: Date.now() });
    seedWorkflow(deps); // workflow has 1 manual step
    deps.schedules.create({
      id: "s1",
      workflowId: "wf-1",
      name: "manual-sched",
      cronExpr: "* * * * *",
      timezone: "UTC",
      variables: {},
      enabled: true,
      nextRunAt: 0,
      maxOverlap: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    await dispatchAction(deps, "schedule_tick", {});
    expect(dCtx.spawnCalls).toBe(0);
    expect(dCtx.execCalls).toBe(0);
  });

  it("schedule_tick instantiator ignores ready-task lookup miss", async () => {
    const deps = makeDeps({ now: Date.now() });
    deps.workflows.create({
      id: "wf-x",
      name: "WF",
      description: "",
      variables: [],
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
    deps.workflows.createStep({
      id: "s",
      workflowId: "wf-x",
      stepKey: "s",
      name: "S",
      promptTemplate: "x",
      blockedByKeys: [],
      dispatch: { mode: "exec", command: ["echo"] },
      priority: "normal",
      onUpstreamFailure: "wait",
      sortOrder: 0,
    });
    deps.schedules.create({
      id: "s1",
      workflowId: "wf-x",
      name: "miss-sched",
      cronExpr: "* * * * *",
      timezone: "UTC",
      variables: {},
      enabled: true,
      nextRunAt: 0,
      maxOverlap: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const origGet = deps.tasks.get.bind(deps.tasks);
    deps.tasks.get = () => undefined;
    const r = await dispatchAction(deps, "schedule_tick", {});
    expect(r.ok).toBe(true);
    deps.tasks.get = origGet;
  });
});

// ── workflow_* ────────────────────────────────────────────────────────────

describe("dispatchAction — workflow_* actions", () => {
  it("workflow_import accepts a valid JSON template", async () => {
    const deps = makeDeps();
    const r = await dispatchAction(deps, "workflow_import", {
      workflowJson: JSON.stringify({
        id: "imp",
        name: "Imp",
        steps: [
          { stepKey: "s", dispatch: { mode: "manual" } },
        ],
      }),
    });
    expect(r.ok).toBe(true);
    expect(deps.workflows.get("imp")).toBeDefined();
  });

  it("workflow_import returns ok=false on bad JSON", async () => {
    const r = await dispatchAction(makeDeps(), "workflow_import", {
      workflowJson: "{not json",
    });
    expect(r.ok).toBe(false);
  });

  it("workflow_list (markdown) returns 'No workflow templates.' when empty", async () => {
    const r = await dispatchAction(makeDeps(), "workflow_list", {});
    expect(r.text).toBe("No workflow templates.");
  });

  it("workflow_list (markdown) renders a list when templates exist", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "workflow_list", {});
    expect(r.text).toContain("## Workflow Templates");
    expect(r.text).toContain("**wf-1**");
  });

  it("workflow_list (markdown) shows variable placeholders + guidance count", async () => {
    const deps = makeDeps();
    deps.workflows.create({
      id: "wf-v",
      name: "Wv",
      description: "",
      variables: [{ name: "env", description: "x", required: false }],
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
    deps.workflows.createStep({
      id: "s",
      workflowId: "wf-v",
      stepKey: "s",
      name: "s",
      promptTemplate: "",
      blockedByKeys: [],
      dispatch: { mode: "manual" },
      priority: "normal",
      onUpstreamFailure: "wait",
      sortOrder: 0,
      guidance: ["careful"],
    });
    const r = await dispatchAction(deps, "workflow_list", {});
    expect(r.text).toContain("{{env}}");
    expect(r.text).toContain("with guidance");
  });

  it("workflow_list (json) returns templates with nested steps", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "workflow_list", { format: "json" });
    expect((r.json as { templates: unknown[] }).templates).toHaveLength(1);
  });

  it("workflow_delete deletes when not referenced by enabled schedules", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    const r = await dispatchAction(deps, "workflow_delete", {
      templateId: "wf-1",
    });
    expect(r.ok).toBe(true);
    expect(deps.workflows.get("wf-1")).toBeUndefined();
  });

  it("workflow_delete refuses when an enabled schedule references the workflow", async () => {
    const deps = makeDeps();
    seedWorkflow(deps);
    await dispatchAction(deps, "schedule_add", {
      templateId: "wf-1",
      cronExpr: "0 0 * * *",
    });
    const r = await dispatchAction(deps, "workflow_delete", {
      templateId: "wf-1",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Cannot delete.*referenced by active schedule/);
  });

  it("workflow_delete returns ok=false when templateId is missing", async () => {
    const r = await dispatchAction(makeDeps(), "workflow_delete", {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Missing templateId/);
  });

  it("workflow_delete returns ok=false when template doesn't exist", async () => {
    const r = await dispatchAction(makeDeps(), "workflow_delete", {
      templateId: "ghost",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not found/);
  });
});
