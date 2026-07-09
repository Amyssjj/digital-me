import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { buildKanbanRouter, buildMechanismRouter } from "./mechanism-routes.js";
import { brainBoard, brainWorkflowList } from "./brain-client.mc.js";

// The routers import module-level singletons from the legacy brain client —
// mock the whole module so tests control what the brain "returns" without a
// live proxy (the .mc module itself is migration-window code, excluded from
// coverage; these tests target mechanism-routes.ts only).
vi.mock("./brain-client.mc.js", () => ({
  brainBoard: vi.fn(),
  brainWorkflowList: vi.fn(),
}));

const mockBoard = vi.mocked(brainBoard);
const mockWorkflowList = vi.mocked(brainWorkflowList);

let server: http.Server;
let base: string;

async function listen(): Promise<void> {
  const app = express();
  app.use("/api/mechanism", buildMechanismRouter());
  app.use("/api/kanban", buildKanbanRouter());
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await listen();
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

type Awaitable<T> = T | Promise<T>;
type WorkflowListResult = Awaited<ReturnType<typeof brainWorkflowList>>;
type BoardResult = Awaited<ReturnType<typeof brainBoard>>;

/** Loosely-shaped brain payloads: the routes normalize snake_case/camelCase
 *  variants at runtime, so mocks are authored untyped and cast once here. */
function givenWorkflows(templates: unknown[]): void {
  mockWorkflowList.mockResolvedValue(templates as Awaitable<never> & WorkflowListResult);
}
function givenBoard(board: unknown): void {
  mockBoard.mockResolvedValue(board as Awaitable<never> & BoardResult);
}

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  version: number | null;
  steps: Array<{ stepKey: string; name: string; blockedByKeys: string[]; sortOrder: number }>;
  latestRun: unknown;
  totalRuns: number;
  successRate: number | null;
  mechanismVisibility: { explicit: boolean; enabled: boolean | null; autoIncluded: boolean };
}

describe("buildMechanismRouter (HTTP)", () => {
  it("includes explicit-true and >=3-step workflows; hides explicit-false and short ones", async () => {
    givenWorkflows([
      // Explicitly opted in despite having no steps.
      { id: "wf-explicit", name: "Explicit", display: { mechanism_view: true } },
      // Explicitly hidden despite having plenty of steps.
      {
        id: "wf-hidden",
        name: "Hidden",
        display: { mechanism_view: false },
        steps: [{ name: "a" }, { name: "b" }, { name: "c" }],
      },
      // No flag, >=3 steps → auto-included.
      {
        id: "wf-auto",
        name: "Auto",
        description: "three steps",
        version: 2,
        steps: [
          { stepKey: "one", name: "One", blockedByKeys: ["zero"], sortOrder: 10 },
          { step_key: "two", name: "Two", blocked_by_keys: ["one"], sort_order: 20 },
          { name: "Three", blocked_by_keys: "one, two, ,three" },
          { name: "Four", blocked_by_keys: "" },
          { name: "Five" },
        ],
        latestRun: { goalId: "g1", status: "done", startedAt: "2026-06-01T00:00:00Z" },
        totalRuns: 7,
        successRate: 0.85,
      },
      // No flag, <3 steps → hidden by default.
      { id: "wf-short", name: "Short", steps: [{ name: "only" }] },
      // No flag, no steps at all → hidden.
      { id: "wf-empty", name: "Empty" },
    ]);

    const res = await fetch(`${base}/api/mechanism/workflows`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { workflows: WorkflowRow[]; rule: string };
    expect(json.rule).toBe("display.mechanism_view ?? (steps.length >= 3)");
    expect(json.workflows.map((w) => w.id)).toEqual(["wf-explicit", "wf-auto"]);

    // Explicit opt-in: missing optional fields default; no steps → [].
    const explicit = json.workflows[0]!;
    expect(explicit).toMatchObject({
      description: null,
      version: null,
      steps: [],
      latestRun: null,
      totalRuns: 0,
      successRate: null,
      mechanismVisibility: { explicit: true, enabled: true, autoIncluded: false },
    });

    // Auto-included: step key/blockedByKeys/sortOrder normalization.
    const auto = json.workflows[1]!;
    expect(auto).toMatchObject({
      description: "three steps",
      version: 2,
      totalRuns: 7,
      successRate: 0.85,
      mechanismVisibility: { explicit: false, enabled: null, autoIncluded: true },
    });
    expect(auto.latestRun).toMatchObject({ goalId: "g1" });
    expect(auto.steps).toEqual([
      { stepKey: "one", name: "One", blockedByKeys: ["zero"], sortOrder: 10 },
      { stepKey: "two", name: "Two", blockedByKeys: ["one"], sortOrder: 20 },
      // Comma-separated string arm: trimmed, empties filtered out.
      { stepKey: "step-2", name: "Three", blockedByKeys: ["one", "two", "three"], sortOrder: 2 },
      // Empty-string arm degrades to no blockers.
      { stepKey: "step-3", name: "Four", blockedByKeys: [], sortOrder: 3 },
      // No blocker field at all.
      { stepKey: "step-4", name: "Five", blockedByKeys: [], sortOrder: 4 },
    ]);
  });

  it("500s when the brain workflow list is unavailable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockWorkflowList.mockRejectedValue(new Error("brain down"));
      const res = await fetch(`${base}/api/mechanism/workflows`);
      expect(res.status).toBe(500);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Failed to fetch mechanism workflows");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("buildKanbanRouter (HTTP)", () => {
  const eligibleTemplates = [
    {
      id: "wf-auto",
      name: "Auto",
      steps: [{ name: "a" }, { name: "b" }, { name: "c" }],
    },
    { id: "wf-short", name: "Short", steps: [{ name: "only" }] }, // ineligible
  ];

  it("flattens tasks of mechanism-eligible workflows only, normalizing field variants", async () => {
    givenWorkflows(eligibleTemplates);
    givenBoard({
      goals: [
        {
          id: "g1",
          sourceWorkflowId: "wf-auto", // camelCase variant
          tasks: [
            { id: "t1", name: "Task 1", status: "done", updated_at: "2026-06-01T00:00:00Z" },
            { id: "t2", name: "Task 2", status: "running", updatedAt: "2026-06-02T00:00:00Z" },
            { id: "t3", name: "Task 3", status: "queued" }, // no timestamp variant
          ],
        },
        {
          id: "g2",
          source_workflow_id: "wf-auto", // snake_case variant, no tasks array
        },
        {
          id: "g3",
          source_workflow_id: "wf-short", // ineligible workflow → skipped
          tasks: [{ id: "tx", name: "X", status: "done" }],
        },
        { id: "g4" }, // no workflow id at all → skipped
      ],
    });

    const res = await fetch(`${base}/api/kanban`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { tasks: Array<Record<string, unknown>> };
    expect(json.tasks).toEqual([
      {
        id: "t1",
        workflow_id: "wf-auto",
        workflow_name: "Auto",
        status: "done",
        name: "Task 1",
        last_update_ts: "2026-06-01T00:00:00Z",
      },
      {
        id: "t2",
        workflow_id: "wf-auto",
        workflow_name: "Auto",
        status: "running",
        name: "Task 2",
        last_update_ts: "2026-06-02T00:00:00Z",
      },
      {
        id: "t3",
        workflow_id: "wf-auto",
        workflow_name: "Auto",
        status: "queued",
        name: "Task 3",
        last_update_ts: null,
      },
    ]);
  });

  it("falls back to the workflow id when the template has no name, and to [] without goals", async () => {
    // A brain payload may omit `name`; the route echoes the id instead.
    givenWorkflows([{ id: "wf-anon", steps: [{ name: "a" }, { name: "b" }, { name: "c" }] }]);
    givenBoard({
      goals: [
        {
          id: "g1",
          sourceWorkflowId: "wf-anon",
          tasks: [{ id: "t1", name: "Task 1", status: "done" }],
        },
      ],
    });
    const withAnon = (await (await fetch(`${base}/api/kanban`)).json()) as {
      tasks: Array<{ workflow_name: string }>;
    };
    expect(withAnon.tasks[0]!.workflow_name).toBe("wf-anon");

    // A board without a goals array degrades to an empty task list.
    givenWorkflows(eligibleTemplates);
    givenBoard({});
    const empty = (await (await fetch(`${base}/api/kanban`)).json()) as { tasks: unknown[] };
    expect(empty.tasks).toEqual([]);
  });

  it("500s when the brain board is unavailable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      givenWorkflows(eligibleTemplates);
      mockBoard.mockRejectedValue(new Error("brain down"));
      const res = await fetch(`${base}/api/kanban`);
      expect(res.status).toBe(500);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("Failed to fetch kanban tasks");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
