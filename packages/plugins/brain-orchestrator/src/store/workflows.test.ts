import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  WORKFLOWS_MIGRATIONS,
  createWorkflowsStore,
  type WorkflowStepTemplateRecord,
  type WorkflowTemplateRecord,
} from "./workflows.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "./migrations.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of WORKFLOWS_MIGRATIONS) registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function baseTemplate(
  overrides: Partial<WorkflowTemplateRecord> = {},
): WorkflowTemplateRecord {
  const now = Date.parse("2026-05-17T12:00:00Z");
  return {
    id: "wf-1",
    name: "Test workflow",
    description: "do something repeatable",
    variables: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

function baseStep(
  overrides: Partial<WorkflowStepTemplateRecord> = {},
): WorkflowStepTemplateRecord {
  return {
    id: "s-1",
    workflowId: "wf-1",
    stepKey: "step-1",
    name: "First step",
    promptTemplate: "Do {{thing}}",
    blockedByKeys: [],
    dispatch: { mode: "manual" },
    priority: "normal",
    onUpstreamFailure: "wait",
    sortOrder: 0,
    ...overrides,
  };
}

describe("createWorkflowsStore — template CRUD", () => {
  it("round-trips a minimal template", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    const t = store.get("wf-1");
    expect(t).toBeDefined();
    expect(t!.id).toBe("wf-1");
    expect(t!.name).toBe("Test workflow");
    expect(t!.description).toBe("do something repeatable");
    expect(t!.variables).toEqual([]);
    expect(t!.version).toBe(1);
    expect(t!.tags).toEqual([]);
    expect(t!.branching).toBeUndefined();
    expect(t!.notifyTarget).toBeUndefined();
  });

  it("returns undefined for an unknown id", () => {
    const store = createWorkflowsStore({ db });
    expect(store.get("missing")).toBeUndefined();
  });

  it("round-trips every optional field", () => {
    const store = createWorkflowsStore({ db });
    store.create(
      baseTemplate({
        variables: [
          {
            name: "thing",
            description: "what to do",
            required: true,
            defaultValue: "stuff",
          },
        ],
        tags: ["devloop", "ci"],
        branching: {
          repoPath: "/repo",
          baseBranch: "main",
          worktreeRoot: "/wt",
          onSuccess: "ff-merge",
          namePrefix: "wf/",
        },
        notifyTarget: { channel: "discord", accountId: "u-1" },
      }),
    );
    const t = store.get("wf-1")!;
    expect(t.variables).toEqual([
      {
        name: "thing",
        description: "what to do",
        required: true,
        defaultValue: "stuff",
      },
    ]);
    expect(t.tags).toEqual(["devloop", "ci"]);
    expect(t.branching).toEqual({
      repoPath: "/repo",
      baseBranch: "main",
      worktreeRoot: "/wt",
      onSuccess: "ff-merge",
      namePrefix: "wf/",
    });
    expect(t.notifyTarget).toEqual({ channel: "discord", accountId: "u-1" });
  });

  it("listAll returns every template sorted by name ASC", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate({ id: "wf-b", name: "Beta" }));
    store.create(baseTemplate({ id: "wf-a", name: "Alpha" }));
    store.create(baseTemplate({ id: "wf-c", name: "Gamma" }));
    const ids = store.listAll().map((t) => t.id);
    expect(ids).toEqual(["wf-a", "wf-b", "wf-c"]);
  });

  it("listAll returns an empty array when the table is empty", () => {
    const store = createWorkflowsStore({ db });
    expect(store.listAll()).toEqual([]);
  });

  it("update overwrites every mutable field", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    store.update({
      ...baseTemplate(),
      name: "Renamed",
      description: "new desc",
      variables: [
        { name: "x", description: "the x", required: false },
      ],
      updatedAt: 42,
      version: 2,
      tags: ["t1"],
      branching: { repoPath: "/r2", baseBranch: "dev" },
      notifyTarget: { channel: "telegram", accountId: "u-2" },
    });
    const t = store.get("wf-1")!;
    expect(t.name).toBe("Renamed");
    expect(t.description).toBe("new desc");
    expect(t.updatedAt).toBe(42);
    expect(t.version).toBe(2);
    expect(t.tags).toEqual(["t1"]);
    expect(t.branching).toEqual({ repoPath: "/r2", baseBranch: "dev" });
    expect(t.notifyTarget).toEqual({ channel: "telegram", accountId: "u-2" });
  });

  it("update can clear branching + notifyTarget back to undefined", () => {
    const store = createWorkflowsStore({ db });
    store.create(
      baseTemplate({
        branching: { repoPath: "/r", baseBranch: "main" },
        notifyTarget: { channel: "discord", accountId: "u-1" },
      }),
    );
    store.update(baseTemplate());
    const t = store.get("wf-1")!;
    expect(t.branching).toBeUndefined();
    expect(t.notifyTarget).toBeUndefined();
  });

  it("delete removes the template row and returns true", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    expect(store.delete("wf-1")).toBe(true);
    expect(store.get("wf-1")).toBeUndefined();
  });

  it("delete returns false for an unknown id", () => {
    const store = createWorkflowsStore({ db });
    expect(store.delete("missing")).toBe(false);
  });

  it("delete cascades to step rows (manual cascade via explicit transaction)", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    store.createStep(baseStep());
    store.createStep(baseStep({ id: "s-2", stepKey: "step-2", sortOrder: 1 }));
    expect(store.listSteps("wf-1")).toHaveLength(2);
    expect(store.delete("wf-1")).toBe(true);
    expect(store.listSteps("wf-1")).toEqual([]);
  });

  it("delete rolls back the transaction when an underlying DELETE fails", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    // Drop the step table so the first DELETE inside the transaction throws,
    // forcing the catch -> ROLLBACK path.
    db.exec("DROP TABLE workflow_step_templates");
    expect(() => store.delete("wf-1")).toThrow();
    // The template row predates the BEGIN, so it must still exist after
    // the inner rollback.
    expect(store.get("wf-1")).toBeDefined();
  });
});

describe("createWorkflowsStore — step CRUD", () => {
  it("round-trips a minimal step", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    store.createStep(baseStep());
    const steps = store.listSteps("wf-1");
    expect(steps).toHaveLength(1);
    expect(steps[0]!.id).toBe("s-1");
    expect(steps[0]!.stepKey).toBe("step-1");
    expect(steps[0]!.dispatch).toEqual({ mode: "manual" });
    expect(steps[0]!.priority).toBe("normal");
    expect(steps[0]!.onUpstreamFailure).toBe("wait");
    expect(steps[0]!.blockedByKeys).toEqual([]);
    expect(steps[0]!.retryPolicy).toBeUndefined();
    expect(steps[0]!.guidance).toBeUndefined();
    expect(steps[0]!.timeoutMs).toBeUndefined();
  });

  it("round-trips every optional field on steps", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    store.createStep(
      baseStep({
        blockedByKeys: ["a", "b"],
        dispatch: {
          mode: "spawn",
          agentId: "agent-x",
          model: "sonnet-4.6",
          thinking: "high",
        },
        priority: "urgent",
        retryPolicy: "auto_once",
        onUpstreamFailure: "skip",
        guidance: ["careful here", "verify output"],
        timeoutMs: 30000,
      }),
    );
    const s = store.listSteps("wf-1")[0]!;
    expect(s.blockedByKeys).toEqual(["a", "b"]);
    expect(s.dispatch).toEqual({
      mode: "spawn",
      agentId: "agent-x",
      model: "sonnet-4.6",
      thinking: "high",
    });
    expect(s.priority).toBe("urgent");
    expect(s.retryPolicy).toBe("auto_once");
    expect(s.onUpstreamFailure).toBe("skip");
    expect(s.guidance).toEqual(["careful here", "verify output"]);
    expect(s.timeoutMs).toBe(30000);
  });

  it("listSteps returns rows ordered by sort_order ASC", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    store.createStep(baseStep({ id: "s-3", stepKey: "k3", sortOrder: 30 }));
    store.createStep(baseStep({ id: "s-1", stepKey: "k1", sortOrder: 10 }));
    store.createStep(baseStep({ id: "s-2", stepKey: "k2", sortOrder: 20 }));
    const keys = store.listSteps("wf-1").map((s) => s.stepKey);
    expect(keys).toEqual(["k1", "k2", "k3"]);
  });

  it("listSteps returns empty when the workflow has no steps", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    expect(store.listSteps("wf-1")).toEqual([]);
  });

  it("listSteps scopes by workflowId — other workflows' steps are not returned", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate({ id: "wf-1" }));
    store.create(baseTemplate({ id: "wf-2", name: "Other" }));
    store.createStep(baseStep({ id: "s-a", workflowId: "wf-1", stepKey: "a" }));
    store.createStep(baseStep({ id: "s-b", workflowId: "wf-2", stepKey: "b" }));
    expect(store.listSteps("wf-1").map((s) => s.stepKey)).toEqual(["a"]);
    expect(store.listSteps("wf-2").map((s) => s.stepKey)).toEqual(["b"]);
  });

  it("deleteSteps removes only the targeted workflow's steps", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate({ id: "wf-1" }));
    store.create(baseTemplate({ id: "wf-2", name: "Other" }));
    store.createStep(baseStep({ id: "s-a", workflowId: "wf-1", stepKey: "a" }));
    store.createStep(baseStep({ id: "s-b", workflowId: "wf-2", stepKey: "b" }));
    store.deleteSteps("wf-1");
    expect(store.listSteps("wf-1")).toEqual([]);
    expect(store.listSteps("wf-2").map((s) => s.stepKey)).toEqual(["b"]);
  });

  it("UNIQUE(workflow_id, step_key) prevents duplicate keys per workflow", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    store.createStep(baseStep({ id: "s-1", stepKey: "k1" }));
    expect(() =>
      store.createStep(baseStep({ id: "s-2", stepKey: "k1" })),
    ).toThrow();
  });
});

describe("createWorkflowsStore — defensive JSON parsing", () => {
  it("normalizes legacy variables stored as '{}' (object) to empty array", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    db.prepare("UPDATE workflow_templates SET variables = '{}' WHERE id = ?").run(
      "wf-1",
    );
    expect(store.get("wf-1")!.variables).toEqual([]);
  });

  it("falls back to [] when variables JSON is malformed", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    db.prepare(
      "UPDATE workflow_templates SET variables = 'not-json' WHERE id = ?",
    ).run("wf-1");
    expect(store.get("wf-1")!.variables).toEqual([]);
  });

  it("falls back to [] when tags JSON is malformed", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    db.prepare(
      "UPDATE workflow_templates SET tags = 'not-json' WHERE id = ?",
    ).run("wf-1");
    expect(store.get("wf-1")!.tags).toEqual([]);
  });

  it("returns undefined for branching when stored JSON is malformed", () => {
    const store = createWorkflowsStore({ db });
    store.create(
      baseTemplate({ branching: { repoPath: "/r", baseBranch: "main" } }),
    );
    db.prepare(
      "UPDATE workflow_templates SET branching = 'not-json' WHERE id = ?",
    ).run("wf-1");
    expect(store.get("wf-1")!.branching).toBeUndefined();
  });

  it("returns undefined for notifyTarget when stored JSON is malformed", () => {
    const store = createWorkflowsStore({ db });
    store.create(
      baseTemplate({ notifyTarget: { channel: "discord", accountId: "u-1" } }),
    );
    db.prepare(
      "UPDATE workflow_templates SET notify_target = 'not-json' WHERE id = ?",
    ).run("wf-1");
    expect(store.get("wf-1")!.notifyTarget).toBeUndefined();
  });

  it("falls back to [] when step blocked_by_keys JSON is malformed", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    store.createStep(baseStep({ blockedByKeys: ["a", "b"] }));
    db.prepare(
      "UPDATE workflow_step_templates SET blocked_by_keys = 'not-json' WHERE id = ?",
    ).run("s-1");
    expect(store.listSteps("wf-1")[0]!.blockedByKeys).toEqual([]);
  });

  it("falls back to { mode: manual } when step dispatch JSON is malformed", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    store.createStep(baseStep());
    db.prepare(
      "UPDATE workflow_step_templates SET dispatch = 'not-json' WHERE id = ?",
    ).run("s-1");
    expect(store.listSteps("wf-1")[0]!.dispatch).toEqual({ mode: "manual" });
  });

  it("returns undefined for step guidance when stored JSON is malformed", () => {
    const store = createWorkflowsStore({ db });
    store.create(baseTemplate());
    store.createStep(baseStep({ guidance: ["careful"] }));
    db.prepare(
      "UPDATE workflow_step_templates SET guidance = 'not-json' WHERE id = ?",
    ).run("s-1");
    expect(store.listSteps("wf-1")[0]!.guidance).toBeUndefined();
  });
});

describe("WORKFLOWS_MIGRATIONS", () => {
  it("registers both tables at a stable version", () => {
    expect(WORKFLOWS_MIGRATIONS).toHaveLength(1);
    expect(WORKFLOWS_MIGRATIONS[0]!.version).toBeGreaterThan(0);
    expect(WORKFLOWS_MIGRATIONS[0]!.description).toMatch(/workflow/i);
  });

  it("produces usable tables when applied to a fresh DB", () => {
    const fresh = new DatabaseSync(":memory:");
    for (const m of WORKFLOWS_MIGRATIONS) m.up(fresh);
    const templateCols = fresh
      .prepare("PRAGMA table_info(workflow_templates)")
      .all() as Array<{ name: string }>;
    const stepCols = fresh
      .prepare("PRAGMA table_info(workflow_step_templates)")
      .all() as Array<{ name: string }>;
    expect(templateCols.map((c) => c.name)).toContain("variables");
    expect(templateCols.map((c) => c.name)).toContain("branching");
    expect(templateCols.map((c) => c.name)).toContain("notify_target");
    expect(stepCols.map((c) => c.name)).toContain("step_key");
    expect(stepCols.map((c) => c.name)).toContain("dispatch");
    expect(stepCols.map((c) => c.name)).toContain("sort_order");
    fresh.close();
  });
});
