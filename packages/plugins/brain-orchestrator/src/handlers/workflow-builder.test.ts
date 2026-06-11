import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import { createGoalsStore, GOALS_MIGRATIONS, type Migration } from "../store/goals.js";
import { createTasksStore, TASKS_MIGRATIONS } from "../store/tasks.js";
import { createWorkflowsStore, WORKFLOWS_MIGRATIONS } from "../store/workflows.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "../store/migrations.js";
import {
  createWorkflowFromSteps,
  importWorkflowFromJson,
  saveGoalAsWorkflow,
  type WorkflowBuilderDeps,
} from "./workflow-builder.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of [
    ...GOALS_MIGRATIONS,
    ...TASKS_MIGRATIONS,
    ...WORKFLOWS_MIGRATIONS,
  ] as Migration[])
    registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function makeDeps(
  overrides: Partial<WorkflowBuilderDeps> = {},
): WorkflowBuilderDeps {
  let counter = 0;
  return {
    db,
    goals: createGoalsStore({ db }),
    tasks: createTasksStore({ db }),
    workflows: createWorkflowsStore({ db }),
    now: () => 1000,
    newId: () => `id-${++counter}`,
    ...overrides,
  };
}

function seedGoalWithTasks(deps: WorkflowBuilderDeps): void {
  deps.goals.create({
    id: "g-1",
    name: "Test goal",
    description: "do something",
    status: "pending",
    type: "project",
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "test",
  });
  deps.tasks.create({
    id: "t-1",
    goalId: "g-1",
    name: "First Step",
    task: "Do part 1",
    blockedBy: [],
    dispatch: { mode: "manual" },
    status: "pending",
    attemptCount: 0,
    attempts: [],
    priority: "normal",
    onUpstreamFailure: "wait",
  });
  deps.tasks.create({
    id: "t-2",
    goalId: "g-1",
    name: "Second Step!",
    task: "Do part 2",
    blockedBy: ["t-1"],
    dispatch: { mode: "manual" },
    status: "pending",
    attemptCount: 0,
    attempts: [],
    priority: "normal",
    onUpstreamFailure: "wait",
  });
}

describe("saveGoalAsWorkflow", () => {
  it("snapshots a goal's tasks into a workflow template with derived step keys", () => {
    const deps = makeDeps();
    seedGoalWithTasks(deps);
    const r = saveGoalAsWorkflow(deps, "wf-1", "g-1");
    expect(r).toEqual({
      ok: true,
      message: 'Workflow "wf-1" saved with 2 steps from goal "Test goal".',
    });
    const wf = deps.workflows.get("wf-1")!;
    expect(wf.name).toBe("Test goal");
    const steps = deps.workflows.listSteps("wf-1");
    expect(steps.map((s) => s.stepKey)).toEqual(["first-step", "second-step"]);
    expect(steps[1]!.blockedByKeys).toEqual(["first-step"]);
  });

  it("returns ok=false when the goal does not exist", () => {
    const deps = makeDeps();
    const r = saveGoalAsWorkflow(deps, "wf-1", "missing");
    expect(r).toEqual({ ok: false, error: 'Goal "missing" not found.' });
  });

  it("returns ok=false when the goal has no tasks", () => {
    const deps = makeDeps();
    deps.goals.create({
      id: "g-empty",
      name: "Empty",
      description: "",
      status: "pending",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    const r = saveGoalAsWorkflow(deps, "wf-1", "g-empty");
    expect(r).toEqual({ ok: false, error: "Goal has no tasks to save." });
  });

  it("returns ok=false when the workflow already exists", () => {
    const deps = makeDeps();
    seedGoalWithTasks(deps);
    saveGoalAsWorkflow(deps, "wf-1", "g-1");
    const r = saveGoalAsWorkflow(deps, "wf-1", "g-1");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/already exists/);
  });

  it("uses 'step-<idprefix>' when the task name strips to empty", () => {
    const deps = makeDeps();
    deps.goals.create({
      id: "g-2",
      name: "G",
      description: "",
      status: "pending",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    deps.tasks.create({
      id: "task-abcdefgh-x",
      goalId: "g-2",
      name: "!!!",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "pending",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    saveGoalAsWorkflow(deps, "wf-x", "g-2");
    expect(deps.workflows.listSteps("wf-x")[0]!.stepKey).toBe("step-task-abc");
  });

  it("returns ok=false when a task references a blockedBy id that is not in the goal's task list", () => {
    const deps = makeDeps();
    deps.goals.create({
      id: "g-orphan",
      name: "Goal with orphan blocker",
      description: "",
      status: "pending",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "test",
    });
    deps.tasks.create({
      id: "t-only",
      goalId: "g-orphan",
      name: "Only Step",
      task: "x",
      blockedBy: ["t-ghost"], // id is not a sibling in this goal
      dispatch: { mode: "manual" },
      status: "pending",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    const r = saveGoalAsWorkflow(deps, "wf-orphan", "g-orphan");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("t-ghost");
    expect((r as { error: string }).error).toContain("Only Step");
    // Nothing should have been persisted.
    expect(deps.workflows.get("wf-orphan")).toBeUndefined();
  });

  it("rolls back the transaction and returns ok=false when a step insert throws", () => {
    const deps = makeDeps();
    seedGoalWithTasks(deps);
    // Monkey-patch createStep to throw mid-transaction so the catch path runs.
    deps.workflows.createStep = () => {
      throw new Error("synthetic step failure");
    };
    const r = saveGoalAsWorkflow(deps, "wf-new", "g-1");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(
      /Failed to save workflow.*synthetic step failure/,
    );
    // The template row should NOT exist — txn rolled back.
    expect(deps.workflows.get("wf-new")).toBeUndefined();
  });

  it("defaults clock + newId to Date.now / randomUUID when omitted", () => {
    const before = Date.now();
    const goals = createGoalsStore({ db });
    const tasks = createTasksStore({ db });
    const workflows = createWorkflowsStore({ db });
    // Deps with NO now and NO newId — exercise the default fallbacks.
    const deps: WorkflowBuilderDeps = { db, goals, tasks, workflows };
    deps.goals.create({
      id: "g-x",
      name: "x",
      description: "",
      status: "pending",
      type: "project",
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "t",
    });
    deps.tasks.create({
      id: "t-x",
      goalId: "g-x",
      name: "Step",
      task: "x",
      blockedBy: [],
      dispatch: { mode: "manual" },
      status: "pending",
      attemptCount: 0,
      attempts: [],
      priority: "normal",
      onUpstreamFailure: "wait",
    });
    const r = saveGoalAsWorkflow(deps, "wf-defaults", "g-x");
    expect(r.ok).toBe(true);
    const wf = deps.workflows.get("wf-defaults")!;
    expect(wf.createdAt).toBeGreaterThanOrEqual(before);
    const stepId = deps.workflows.listSteps("wf-defaults")[0]!.id;
    expect(stepId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns ok=false with String() wrapping when a non-Error is thrown", () => {
    const deps = makeDeps();
    seedGoalWithTasks(deps);
    deps.workflows.createStep = () => {
      throw "not-an-error";
    };
    const r = saveGoalAsWorkflow(deps, "wf-x", "g-1");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("not-an-error");
  });
});

describe("createWorkflowFromSteps", () => {
  it("creates a workflow with normalized step defaults", () => {
    const deps = makeDeps();
    const r = createWorkflowFromSteps(
      deps,
      "wf-1",
      "Name",
      "Desc",
      [{ name: "var", description: "", required: false }],
      [
        {
          stepKey: "s1",
          name: "Step 1",
          promptTemplate: "Do X",
          blockedByKeys: [],
          dispatch: { mode: "manual" },
        },
      ],
    );
    expect(r).toEqual({
      ok: true,
      message: 'Workflow "wf-1" created with 1 steps.',
    });
    const wf = deps.workflows.get("wf-1")!;
    expect(wf.variables).toEqual([
      { name: "var", description: "", required: false },
    ]);
    const steps = deps.workflows.listSteps("wf-1");
    expect(steps[0]!.priority).toBe("normal");
    expect(steps[0]!.onUpstreamFailure).toBe("wait");
    expect(steps[0]!.sortOrder).toBe(0);
  });

  it("honors explicit overrides on priority, onUpstreamFailure, and sortOrder", () => {
    const deps = makeDeps();
    createWorkflowFromSteps(
      deps,
      "wf-1",
      "n",
      "d",
      [],
      [
        {
          stepKey: "s1",
          name: "s1",
          promptTemplate: "p",
          blockedByKeys: [],
          dispatch: { mode: "manual" },
          priority: "urgent",
          onUpstreamFailure: "skip",
          sortOrder: 5,
        },
      ],
    );
    const s = deps.workflows.listSteps("wf-1")[0]!;
    expect(s.priority).toBe("urgent");
    expect(s.onUpstreamFailure).toBe("skip");
    expect(s.sortOrder).toBe(5);
  });

  it("rejects blockedByKeys that do not reference a workflow stepKey", () => {
    const deps = makeDeps();
    const r = createWorkflowFromSteps(
      deps,
      "wf-1",
      "n",
      "d",
      [],
      [
        {
          stepKey: "build",
          name: "Build",
          promptTemplate: "build",
          blockedByKeys: [],
          dispatch: { mode: "manual" },
        },
        {
          stepKey: "deploy",
          name: "Deploy",
          promptTemplate: "deploy",
          blockedByKeys: ["buid"],
          dispatch: { mode: "manual" },
        },
      ],
    );
    expect(r).toEqual({
      ok: false,
      error: 'Step "deploy" references unknown blockedByKey "buid".',
    });
    expect(deps.workflows.get("wf-1")).toBeUndefined();
  });

  it("persists valid blockedByKeys", () => {
    const deps = makeDeps();
    const r = createWorkflowFromSteps(
      deps,
      "wf-1",
      "n",
      "d",
      [],
      [
        {
          stepKey: "build",
          name: "Build",
          promptTemplate: "build",
          blockedByKeys: [],
          dispatch: { mode: "manual" },
        },
        {
          stepKey: "deploy",
          name: "Deploy",
          promptTemplate: "deploy",
          blockedByKeys: ["build"],
          dispatch: { mode: "manual" },
        },
      ],
    );
    expect(r.ok).toBe(true);
    const deploy = deps.workflows
      .listSteps("wf-1")
      .find((s) => s.stepKey === "deploy")!;
    expect(deploy.blockedByKeys).toEqual(["build"]);
  });

  it("rejects duplicate stepKeys before persisting", () => {
    const deps = makeDeps();
    const r = createWorkflowFromSteps(
      deps,
      "wf-dup-steps",
      "n",
      "d",
      [],
      [
        { stepKey: "s", name: "s", promptTemplate: "p", blockedByKeys: [], dispatch: { mode: "manual" } },
        { stepKey: "s", name: "s", promptTemplate: "p", blockedByKeys: [], dispatch: { mode: "manual" } },
      ],
    );
    expect(r).toEqual({ ok: false, error: 'Duplicate workflow stepKey "s".' });
    expect(deps.workflows.get("wf-dup-steps")).toBeUndefined();
  });

  it("rejects empty stepKeys before persisting", () => {
    const deps = makeDeps();
    const r = createWorkflowFromSteps(deps, "wf-empty-key", "n", "d", [], [
      { stepKey: "  ", name: "s", promptTemplate: "p", blockedByKeys: [], dispatch: { mode: "manual" } },
    ]);
    expect(r).toEqual({ ok: false, error: "Workflow stepKey must be non-empty." });
    expect(deps.workflows.get("wf-empty-key")).toBeUndefined();
  });

  it("returns ok=false when the workflow already exists", () => {
    const deps = makeDeps();
    createWorkflowFromSteps(deps, "wf-1", "n", "d", [], [
      { stepKey: "s", name: "s", promptTemplate: "p", blockedByKeys: [], dispatch: { mode: "manual" } },
    ]);
    const r = createWorkflowFromSteps(deps, "wf-1", "n", "d", [], [
      { stepKey: "s", name: "s", promptTemplate: "p", blockedByKeys: [], dispatch: { mode: "manual" } },
    ]);
    expect(r).toEqual({ ok: false, error: 'Workflow "wf-1" already exists.' });
  });

  it("defaults clock + newId for createWorkflowFromSteps when omitted", () => {
    const goals = createGoalsStore({ db });
    const tasks = createTasksStore({ db });
    const workflows = createWorkflowsStore({ db });
    const deps: WorkflowBuilderDeps = { db, goals, tasks, workflows };
    const before = Date.now();
    const r = createWorkflowFromSteps(deps, "wf-d", "n", "d", [], [
      { stepKey: "s", name: "s", promptTemplate: "p", blockedByKeys: [], dispatch: { mode: "manual" } },
    ]);
    expect(r.ok).toBe(true);
    const wf = deps.workflows.get("wf-d")!;
    expect(wf.createdAt).toBeGreaterThanOrEqual(before);
    expect(deps.workflows.listSteps("wf-d")[0]!.id).toMatch(
      /^[0-9a-f]{8}-/,
    );
  });

  it("returns ok=false when given an empty step list", () => {
    const deps = makeDeps();
    const r = createWorkflowFromSteps(deps, "wf-1", "n", "d", [], []);
    expect(r).toEqual({ ok: false, error: "Workflow must have at least one step." });
  });

  it("fails fast when dispatch is missing and no defaultDispatchAgentId is configured", () => {
    const deps = makeDeps();
    const r = createWorkflowFromSteps(deps, "wf-1", "n", "d", [], [
      { stepKey: "bad", name: "Bad", promptTemplate: "p", blockedByKeys: [] },
    ]);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/dispatch is required/);
  });

  it("uses defaultDispatchAgentId when dispatch is missing", () => {
    const deps = makeDeps({ defaultDispatchAgentId: "fallback-agent" });
    createWorkflowFromSteps(deps, "wf-1", "n", "d", [], [
      { stepKey: "s", name: "S", promptTemplate: "p", blockedByKeys: [] },
    ]);
    const s = deps.workflows.listSteps("wf-1")[0]!;
    expect(s.dispatch).toEqual({ mode: "spawn", agentId: "fallback-agent" });
  });

  it("fills in agentId on a spawn dispatch missing one (defaultDispatchAgentId configured)", () => {
    const deps = makeDeps({ defaultDispatchAgentId: "fallback" });
    createWorkflowFromSteps(deps, "wf-1", "n", "d", [], [
      {
        stepKey: "s",
        name: "S",
        promptTemplate: "p",
        blockedByKeys: [],
        dispatch: { mode: "spawn", agentId: "" },
      },
    ]);
    const s = deps.workflows.listSteps("wf-1")[0]!;
    expect((s.dispatch as { agentId: string }).agentId).toBe("fallback");
  });

  it("fails when spawn dispatch is missing agentId and no default configured", () => {
    const deps = makeDeps();
    const r = createWorkflowFromSteps(deps, "wf-1", "n", "d", [], [
      {
        stepKey: "s",
        name: "S",
        promptTemplate: "p",
        blockedByKeys: [],
        dispatch: { mode: "spawn", agentId: "" },
      },
    ]);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/dispatch.mode=spawn requires agentId/);
  });

  it("returns the error message when the wrapping transaction throws", () => {
    const deps = makeDeps();
    deps.workflows.createStep = () => {
      throw new Error("synthetic step failure");
    };
    const r = createWorkflowFromSteps(
      deps,
      "wf-txn-fail",
      "n",
      "d",
      [],
      [
        { stepKey: "s", name: "s", promptTemplate: "p", blockedByKeys: [], dispatch: { mode: "manual" } },
      ],
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/Failed to create workflow.*synthetic step failure/);
  });

  it("wraps non-Error throws inside the transaction with String()", () => {
    const deps = makeDeps();
    // Monkey-patch workflows.createStep to throw a non-Error value.
    const orig = deps.workflows.createStep;
    deps.workflows.createStep = () => {
      throw "boom";
    };
    const r = createWorkflowFromSteps(
      deps,
      "wf-x",
      "n",
      "d",
      [],
      [
        { stepKey: "s", name: "s", promptTemplate: "p", blockedByKeys: [], dispatch: { mode: "manual" } },
      ],
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("boom");
    deps.workflows.createStep = orig;
  });
});

describe("importWorkflowFromJson", () => {
  it("imports a minimal workflow from JSON", () => {
    const deps = makeDeps();
    const json = JSON.stringify({
      id: "wf-imp",
      name: "Imported",
      steps: [
        {
          stepKey: "s1",
          name: "S1",
          promptTemplate: "p",
          dispatch: { mode: "manual" },
        },
      ],
    });
    const r = importWorkflowFromJson(deps, json);
    expect(r.ok).toBe(true);
    expect(deps.workflows.get("wf-imp")!.name).toBe("Imported");
  });

  it("rejects imports with missing blockedByKeys targets", () => {
    const deps = makeDeps();
    const r = importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "wf-bad-dep",
        name: "Bad dependency",
        steps: [
          { stepKey: "build", dispatch: { mode: "manual" } },
          {
            stepKey: "deploy",
            blockedByKeys: ["buid"],
            dispatch: { mode: "manual" },
          },
        ],
      }),
    );
    expect(r).toEqual({
      ok: false,
      error: 'Step "deploy" references unknown blockedByKey "buid".',
    });
    expect(deps.workflows.get("wf-bad-dep")).toBeUndefined();
  });

  it("returns ok=false for malformed JSON", () => {
    const deps = makeDeps();
    const r = importWorkflowFromJson(deps, "{not json");
    expect(r).toEqual({ ok: false, error: "Invalid JSON." });
  });

  it("returns ok=false when id is missing", () => {
    const deps = makeDeps();
    const r = importWorkflowFromJson(
      deps,
      JSON.stringify({ name: "n", steps: [{}] }),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/missing id/);
  });

  it("returns ok=false when name is missing", () => {
    const deps = makeDeps();
    const r = importWorkflowFromJson(
      deps,
      JSON.stringify({ id: "x", steps: [{}] }),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/missing id/);
  });

  it("returns ok=false when steps is missing", () => {
    const deps = makeDeps();
    const r = importWorkflowFromJson(
      deps,
      JSON.stringify({ id: "x", name: "n" }),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/missing/);
  });

  it("returns ok=false when steps is not an array", () => {
    const deps = makeDeps();
    const r = importWorkflowFromJson(
      deps,
      JSON.stringify({ id: "x", name: "n", steps: "nope" }),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/non-empty array/);
  });

  it("returns ok=false when steps is an empty array", () => {
    const deps = makeDeps();
    const r = importWorkflowFromJson(
      deps,
      JSON.stringify({ id: "x", name: "n", steps: [] }),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/non-empty array/);
  });

  it("fills in step defaults (stepKey, name, promptTemplate) for sparse rows", () => {
    const deps = makeDeps({ defaultDispatchAgentId: "fallback" });
    importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "wf-sparse",
        name: "n",
        steps: [{}, { stepKey: "explicit" }],
      }),
    );
    const steps = deps.workflows.listSteps("wf-sparse");
    expect(steps[0]!.stepKey).toBe("step-1");
    expect(steps[0]!.name).toBe("Step 1");
    expect(steps[0]!.promptTemplate).toBe("");
    expect(steps[1]!.stepKey).toBe("explicit");
  });

  it("ignores string dispatch shorthand and applies the default agent", () => {
    const deps = makeDeps({ defaultDispatchAgentId: "fallback" });
    importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "wf-str",
        name: "n",
        steps: [{ stepKey: "s", dispatch: "should-be-ignored" }],
      }),
    );
    const s = deps.workflows.listSteps("wf-str")[0]!;
    expect(s.dispatch).toEqual({ mode: "spawn", agentId: "fallback" });
  });

  it("validates notifyTarget: rejects null", () => {
    const deps = makeDeps();
    const r = importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "x",
        name: "n",
        steps: [{ stepKey: "s", dispatch: { mode: "manual" } }],
        notifyTarget: null,
      }),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/Invalid notifyTarget/);
  });

  it("validates notifyTarget: rejects malformed object (missing channel)", () => {
    const deps = makeDeps();
    const r = importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "x",
        name: "n",
        steps: [{ stepKey: "s", dispatch: { mode: "manual" } }],
        notifyTarget: { accountId: "u" },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("validates notifyTarget: rejects malformed object (empty accountId)", () => {
    const deps = makeDeps();
    const r = importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "x",
        name: "n",
        steps: [{ stepKey: "s", dispatch: { mode: "manual" } }],
        notifyTarget: { channel: "discord", accountId: "  " },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("accepts a notifyTarget with channel + accountId and trims them", () => {
    const deps = makeDeps();
    importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "wf-nt",
        name: "n",
        steps: [{ stepKey: "s", dispatch: { mode: "manual" } }],
        notifyTarget: { channel: " discord ", accountId: " u1 " },
      }),
    );
    expect(deps.workflows.get("wf-nt")!.notifyTarget).toEqual({
      channel: "discord",
      accountId: "u1",
    });
  });

  it("accepts notifyTarget with optional to + threadId", () => {
    const deps = makeDeps();
    importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "wf-nt2",
        name: "n",
        steps: [{ stepKey: "s", dispatch: { mode: "manual" } }],
        notifyTarget: {
          channel: "discord",
          accountId: "u1",
          to: "channel-id",
          threadId: "thread-id",
        },
      }),
    );
    expect(deps.workflows.get("wf-nt2")!.notifyTarget).toEqual({
      channel: "discord",
      accountId: "u1",
      to: "channel-id",
      threadId: "thread-id",
    });
  });

  it("drops to/threadId when they are empty strings", () => {
    const deps = makeDeps();
    importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "wf-nt3",
        name: "n",
        steps: [{ stepKey: "s", dispatch: { mode: "manual" } }],
        notifyTarget: {
          channel: "discord",
          accountId: "u1",
          to: "  ",
          threadId: "",
        },
      }),
    );
    const nt = deps.workflows.get("wf-nt3")!.notifyTarget!;
    expect(nt.to).toBeUndefined();
    expect(nt.threadId).toBeUndefined();
  });

  it("drops to/threadId when they are non-strings", () => {
    const deps = makeDeps();
    importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "wf-nt4",
        name: "n",
        steps: [{ stepKey: "s", dispatch: { mode: "manual" } }],
        notifyTarget: {
          channel: "discord",
          accountId: "u1",
          to: 42,
          threadId: false,
        },
      }),
    );
    const nt = deps.workflows.get("wf-nt4")!.notifyTarget!;
    expect(nt.to).toBeUndefined();
    expect(nt.threadId).toBeUndefined();
  });

  it("defaults description, variables, blockedByKeys, sortOrder when missing", () => {
    const deps = makeDeps();
    importWorkflowFromJson(
      deps,
      JSON.stringify({
        id: "wf-def",
        name: "n",
        steps: [
          { stepKey: "s1", dispatch: { mode: "manual" } },
        ],
      }),
    );
    const wf = deps.workflows.get("wf-def")!;
    expect(wf.description).toBe("");
    expect(wf.variables).toEqual([]);
    expect(deps.workflows.listSteps("wf-def")[0]!.blockedByKeys).toEqual([]);
    expect(deps.workflows.listSteps("wf-def")[0]!.sortOrder).toBe(0);
  });
});
