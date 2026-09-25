import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { BrainWorkflowTemplate } from "./brain-client.js";
import { buildMechanismRouter, type RunStatsSource } from "./mechanism-routes.js";

// The router takes its workflow list as an injected source, so tests control
// what the brain "returns" without a live proxy.
const mockWorkflowList = vi.fn<() => Promise<readonly BrainWorkflowTemplate[]>>();

let server: http.Server;
let base: string;

async function listen(): Promise<void> {
  const app = express();
  app.use("/api/mechanism", buildMechanismRouter({ workflowList: mockWorkflowList }));
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

/** Loosely-shaped brain payloads: the route normalizes snake_case/camelCase
 *  variants at runtime, so mocks are authored untyped and cast once here. */
function givenWorkflows(templates: unknown[]): void {
  mockWorkflowList.mockResolvedValue(templates as BrainWorkflowTemplate[]);
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

describe("buildMechanismRouter run stats", () => {
  let statsServer: http.Server;
  let statsBase: string;

  async function listenWith(runStats: RunStatsSource): Promise<void> {
    const app = express();
    app.use("/api/mechanism", buildMechanismRouter({ workflowList: mockWorkflowList, runStats }));
    statsServer = http.createServer(app);
    await new Promise<void>((r) => statsServer.listen(0, "127.0.0.1", r));
    statsBase = `http://127.0.0.1:${(statsServer.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await new Promise((r) => statsServer.close(r));
  });

  const threeSteps = [{ name: "a" }, { name: "b" }, { name: "c" }];

  it("overlays brain.db run stats on the templates that have runs", async () => {
    givenWorkflows([
      { id: "wf-ran", name: "Ran", steps: threeSteps },
      { id: "wf-idle", name: "Idle", steps: threeSteps, totalRuns: 2, successRate: 50 },
    ]);
    const latestRun = {
      goalId: "g9",
      status: "completed",
      startedAt: "2026-09-22T00:00:00.000Z",
      completedAt: "2026-09-22T00:01:00.000Z",
      taskStatuses: { a: "completed" },
    };
    await listenWith(() => new Map([["wf-ran", { totalRuns: 1440, successRate: 99.9, latestRun }]]));

    const json = (await (await fetch(`${statsBase}/api/mechanism/workflows`)).json()) as {
      workflows: WorkflowRow[];
    };
    expect(json.workflows[0]).toMatchObject({ id: "wf-ran", totalRuns: 1440, successRate: 99.9, latestRun });
    // No brain.db runs → the template's own values (or the zero default).
    expect(json.workflows[1]).toMatchObject({ id: "wf-idle", totalRuns: 2, successRate: 50, latestRun: null });
  });

  it("degrades to template values when the run-stats read fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      givenWorkflows([{ id: "wf-ran", name: "Ran", steps: threeSteps }]);
      await listenWith(() => {
        throw new Error("brain.db missing");
      });

      const res = await fetch(`${statsBase}/api/mechanism/workflows`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { workflows: WorkflowRow[] };
      expect(json.workflows[0]).toMatchObject({ totalRuns: 0, successRate: null, latestRun: null });
      expect(spy).toHaveBeenCalledWith(
        "[/api/mechanism/workflows] run stats unavailable:",
        expect.any(Error),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
