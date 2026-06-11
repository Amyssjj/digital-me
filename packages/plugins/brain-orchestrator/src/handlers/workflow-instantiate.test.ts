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
} from "../store/tasks.js";
import {
  createWorkflowsStore,
  WORKFLOWS_MIGRATIONS,
  type WorkflowStepTemplateRecord,
  type WorkflowTemplateRecord,
} from "../store/workflows.js";
import type { Migration } from "../store/migrations.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "../store/migrations.js";
import {
  instantiateWorkflow,
  interpolateVariables,
  type InstantiateWorkflowDeps,
} from "./workflow-instantiate.js";

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

function makeDeps(): InstantiateWorkflowDeps {
  let counter = 0;
  return {
    db,
    goals: createGoalsStore({ db }),
    tasks: createTasksStore({ db }),
    workflows: createWorkflowsStore({ db }),
    now: () => 1000,
    newId: () => `id-${++counter}`,
  };
}

function seedTemplate(
  deps: InstantiateWorkflowDeps,
  overrides: Partial<WorkflowTemplateRecord> = {},
  steps: Partial<WorkflowStepTemplateRecord>[] = [],
): void {
  const template: WorkflowTemplateRecord = {
    id: "wf-1",
    name: "Test workflow",
    description: "Run for {{env}}",
    variables: [],
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    ...overrides,
  };
  deps.workflows.create(template);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    deps.workflows.createStep({
      id: `step-${i}`,
      workflowId: template.id,
      stepKey: `key-${i}`,
      name: `Step ${i}`,
      promptTemplate: "Do {{thing}}",
      blockedByKeys: [],
      dispatch: { mode: "manual" },
      priority: "normal",
      onUpstreamFailure: "wait",
      sortOrder: i,
      ...s,
    });
  }
}

// ── interpolateVariables ──────────────────────────────────────────────────

describe("interpolateVariables", () => {
  it("substitutes known variables", () => {
    expect(interpolateVariables("Hello {{name}}", { name: "world" })).toBe(
      "Hello world",
    );
  });

  it("leaves unknown variables as literal {{x}}", () => {
    expect(interpolateVariables("Hello {{unknown}}", {})).toBe(
      "Hello {{unknown}}",
    );
  });

  it("substitutes multiple variables", () => {
    expect(
      interpolateVariables("{{a}}+{{b}}={{c}}", { a: "1", b: "2", c: "3" }),
    ).toBe("1+2=3");
  });

  it("returns the template unchanged when there are no placeholders", () => {
    expect(interpolateVariables("no vars here", { x: "y" })).toBe(
      "no vars here",
    );
  });
});

// ── instantiateWorkflow ───────────────────────────────────────────────────

describe("instantiateWorkflow", () => {
  it("creates a goal + tasks from a simple template", async () => {
    const deps = makeDeps();
    seedTemplate(deps, {}, [{}, {}]);
    const r = await instantiateWorkflow(deps, {
      templateId: "wf-1",
      variables: { env: "prod", thing: "X" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.taskCount).toBe(2);
    const goal = deps.goals.get(r.goalId)!;
    expect(goal.description).toBe("Run for prod");
    expect(goal.sourceWorkflowId).toBe("wf-1");
    expect(goal.sourceWorkflowVersion).toBe(1);
    const tasks = deps.tasks.listForGoal(r.goalId);
    expect(tasks[0]!.task).toBe("Do X");
  });

  it("returns workflow_not_found for an unknown template", async () => {
    const deps = makeDeps();
    const r = await instantiateWorkflow(deps, { templateId: "missing" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("workflow_not_found");
  });

  it("returns workflow_has_no_steps for an empty template", async () => {
    const deps = makeDeps();
    seedTemplate(deps); // no steps
    const r = await instantiateWorkflow(deps, { templateId: "wf-1" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("workflow_has_no_steps");
  });

  it("rejects when a required variable is missing and has no default", async () => {
    const deps = makeDeps();
    seedTemplate(
      deps,
      {
        variables: [
          { name: "env", description: "Environment", required: true },
        ],
      },
      [{}],
    );
    const r = await instantiateWorkflow(deps, { templateId: "wf-1" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("missing_required_variable");
    expect(r.error).toMatch(/env/);
  });

  it("fills missing variables from defaults", async () => {
    const deps = makeDeps();
    seedTemplate(
      deps,
      {
        variables: [
          {
            name: "env",
            description: "Environment",
            required: true,
            defaultValue: "staging",
          },
        ],
        description: "Run for {{env}}",
      },
      [{}],
    );
    const r = await instantiateWorkflow(deps, { templateId: "wf-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(deps.goals.get(r.goalId)!.description).toBe("Run for staging");
  });

  it("doesn't override caller-supplied values with defaults", async () => {
    const deps = makeDeps();
    seedTemplate(
      deps,
      {
        variables: [
          {
            name: "env",
            description: "Environment",
            required: false,
            defaultValue: "staging",
          },
        ],
        description: "Run for {{env}}",
      },
      [{}],
    );
    const r = await instantiateWorkflow(deps, {
      templateId: "wf-1",
      variables: { env: "prod" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(deps.goals.get(r.goalId)!.description).toBe("Run for prod");
  });

  it("refuses when an active goal already exists for the workflow", async () => {
    const deps = makeDeps();
    seedTemplate(deps, {}, [{}]);
    // First instantiation succeeds.
    const r1 = await instantiateWorkflow(deps, { templateId: "wf-1" });
    expect(r1.ok).toBe(true);
    // Second instantiation refuses.
    const r2 = await instantiateWorkflow(deps, { templateId: "wf-1" });
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error();
    expect(r2.errorCode).toBe("workflow_in_flight");
    expect(r2.error).toMatch(/already has an active goal/);
  });

  it("bypasses the mutex when force=true", async () => {
    const deps = makeDeps();
    seedTemplate(deps, {}, [{}]);
    const r1 = await instantiateWorkflow(deps, { templateId: "wf-1" });
    expect(r1.ok).toBe(true);
    const r2 = await instantiateWorkflow(deps, {
      templateId: "wf-1",
      force: true,
    });
    expect(r2.ok).toBe(true);
  });

  it("maps step blockedByKeys to task blockedBy chains", async () => {
    const deps = makeDeps();
    seedTemplate(
      deps,
      {},
      [
        { stepKey: "k1" },
        { stepKey: "k2", blockedByKeys: ["k1"] },
      ],
    );
    const r = await instantiateWorkflow(deps, { templateId: "wf-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const tasks = deps.tasks.listForGoal(r.goalId);
    const t1 = tasks.find((t) => t.name === "Step 0")!;
    const t2 = tasks.find((t) => t.name === "Step 1")!;
    expect(t1.status).toBe("ready");
    expect(t2.status).toBe("pending");
    expect(t2.blockedBy).toEqual([t1.id]);
  });

  it("uses the caller's originator over the template's notifyTarget", async () => {
    const deps = makeDeps();
    seedTemplate(
      deps,
      {
        notifyTarget: { channel: "discord", accountId: "static-u" },
      },
      [{}],
    );
    const r = await instantiateWorkflow(deps, {
      templateId: "wf-1",
      originator: { channel: "telegram", accountId: "caller-u" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(deps.goals.get(r.goalId)!.originator).toEqual({
      channel: "telegram",
      accountId: "caller-u",
    });
  });

  it("stamps created_by = 'scheduler' for origin 'schedule', default otherwise", async () => {
    const deps = makeDeps();
    seedTemplate(deps, {}, [{}]);
    const cron = await instantiateWorkflow(deps, {
      templateId: "wf-1",
      origin: "schedule",
    });
    expect(cron.ok).toBe(true);
    if (!cron.ok) throw new Error();
    expect(deps.goals.get(cron.goalId)!.createdBy).toBe("scheduler");

    const manual = await instantiateWorkflow(deps, {
      templateId: "wf-1",
      force: true,
    });
    expect(manual.ok).toBe(true);
    if (!manual.ok) throw new Error();
    expect(deps.goals.get(manual.goalId)!.createdBy).toBe("orchestrator");
  });

  it("falls back to template's notifyTarget when no caller originator", async () => {
    const deps = makeDeps();
    seedTemplate(
      deps,
      {
        notifyTarget: { channel: "discord", accountId: "u" },
      },
      [{}],
    );
    const r = await instantiateWorkflow(deps, { templateId: "wf-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(deps.goals.get(r.goalId)!.originator).toEqual({
      channel: "discord",
      accountId: "u",
    });
  });

  it("uses Date.now when no clock injected", async () => {
    const deps: InstantiateWorkflowDeps = {
      db,
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
      workflows: createWorkflowsStore({ db }),
    };
    seedTemplate(deps, {}, [{}]);
    const r = await instantiateWorkflow(deps, { templateId: "wf-1" });
    expect(r.ok).toBe(true);
    // Once active, the mutex blocks a second call — the ageMin computation
    // uses Date.now via the default.
    const r2 = await instantiateWorkflow(deps, { templateId: "wf-1" });
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error();
    expect(r2.error).toMatch(/started \d+min ago/);
  });
});
