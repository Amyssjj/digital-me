import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import {
  GOALS_MIGRATIONS,
  TASKS_MIGRATIONS,
  createGoalsStore,
  createTasksStore,
  type GoalRecord,
  type OrchestratorTaskRecord,
} from "@digital-me/brain-orchestrator";

import {
  buildBrainKanbanRouter,
  dispatchAgentId,
  queryKanban,
  queryWorkflowRunStats,
  withBrainDb,
  type KanbanResponse,
} from "./brain-kanban.js";

// The fixture is written through brain-orchestrator's own migrations and
// stores — the exact rows brain-host writes — so a schema change there fails
// here instead of silently blanking the live board.

const NOW = 1_790_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let tmpDir: string;
let dbPath: string;

type Fixture = {
  readonly goal: (g: Partial<GoalRecord> & { id: string }) => void;
  readonly task: (t: Partial<OrchestratorTaskRecord> & { id: string; goalId: string }) => void;
  readonly attempt: (taskId: string, a: { id: string; n: number; status: "running" | "completed" | "failed"; paths?: string[] }) => void;
  readonly sql: (statement: string) => void;
  readonly close: () => void;
};

function openFixture(file: string): Fixture {
  const raw = new DatabaseSync(file);
  for (const m of [...GOALS_MIGRATIONS, ...TASKS_MIGRATIONS]) m.up(raw);
  const goals = createGoalsStore({ db: raw });
  const tasks = createTasksStore({ db: raw });
  return {
    goal: (g) =>
      goals.create({
        name: g.id,
        description: `${g.id} desc`,
        status: "pending",
        taskIds: [],
        createdAt: NOW - DAY,
        updatedAt: NOW - DAY,
        createdBy: "test",
        ...g,
      }),
    task: (t) =>
      tasks.create({
        name: t.id,
        task: `do ${t.id}`,
        blockedBy: [],
        dispatch: { mode: "spawn", agentId: "coo" },
        status: "pending",
        attemptCount: 0,
        attempts: [],
        priority: "normal",
        onUpstreamFailure: "wait",
        ...t,
      }),
    attempt: (taskId, a) =>
      tasks.createAttempt({
        taskId,
        attemptId: a.id,
        attemptNumber: a.n,
        status: a.status,
        startedAt: NOW - 2 * DAY,
        ...(a.status === "running" ? {} : { endedAt: NOW - DAY }),
        ...(a.paths ? { artifactPaths: a.paths } : {}),
      }),
    sql: (statement) => raw.exec(statement),
    close: () => raw.close(),
  };
}

/** The board most tests read: every column status, a 40-day-old straggler,
 *  an evergreen goal, and tasks exercising each stored-field shape. */
function seedBoard(file: string): void {
  const f = openFixture(file);
  f.goal({ id: "run-1", status: "running", updatedAt: NOW - 1 * DAY, sourceWorkflowId: "wf-a" });
  f.goal({ id: "pend-1", status: "pending", updatedAt: NOW - 2 * DAY });
  f.goal({ id: "pend-old", status: "pending", updatedAt: NOW - 40 * DAY });
  f.goal({ id: "done-1", status: "completed", updatedAt: NOW - 3 * DAY, completedAt: NOW - 3 * DAY, sourceWorkflowId: "wf-a" });
  f.goal({ id: "done-old", status: "completed", updatedAt: NOW - 10 * DAY, completedAt: NOW - 10 * DAY });
  f.goal({ id: "fail-1", status: "failed", updatedAt: NOW - 4 * DAY });
  f.goal({ id: "cancel-1", status: "cancelled", updatedAt: NOW - 5 * DAY });
  f.goal({ id: "layer", status: "healthy", type: "evergreen", updatedAt: NOW - DAY });

  f.task({
    id: "run-1-a",
    goalId: "run-1",
    status: "running",
    attemptCount: 1,
    blockedBy: ["x"],
    startedAt: NOW - 2 * DAY,
    latestCheckpoint: { checkpointAt: NOW - DAY, phase: "build", summary: "half way", progressPercent: 50, artifactPaths: ["a.md"], blocker: "waiting" },
    latestOutput: { deliverableState: "partial", summary: "first pass" },
  });
  f.attempt("run-1-a", { id: "att-1", n: 1, status: "failed", paths: ["log.txt"] });
  f.attempt("run-1-a", { id: "att-2", n: 2, status: "running" });
  f.task({ id: "run-1-b", goalId: "run-1", status: "cancelled", dispatch: { mode: "exec", command: ["true"], agentId: "claude-code-cli" } });
  f.task({ id: "pend-1-a", goalId: "pend-1", dispatch: { mode: "manual" } });
  f.task({ id: "done-1-a", goalId: "done-1", status: "completed", completedAt: NOW - 3 * DAY });
  f.task({ id: "fail-1-a", goalId: "fail-1", status: "failed", failureReason: "boom", dispatch: { mode: "spawn", agentId: "main" } });
  f.task({ id: "cancel-1-a", goalId: "cancel-1", status: "cancelled" });
  // Legacy/degenerate stored shapes the adapter must tolerate.
  f.sql(`UPDATE tasks SET blocked_by = 'not json', latest_checkpoint = '{}', latest_output = '"plain text"'
         WHERE id = 'done-1-a'`);
  f.sql(`UPDATE tasks SET latest_checkpoint = '{"checkpointAt":"2026-09-01T00:00:00Z","artifactPaths":[1,"b.md"]}',
           latest_output = '{"deliverableState":"complete"}'
         WHERE id = 'fail-1-a'`);
  f.sql(`UPDATE tasks SET latest_checkpoint = '[1]', latest_output = 'raw log line' WHERE id = 'pend-1-a'`);
  f.close();
}

function kanban(query: Parameters<typeof queryKanban>[1]): KanbanResponse {
  return withBrainDb(dbPath, (db) => queryKanban(db, query, NOW));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-kanban-"));
  dbPath = path.join(tmpDir, "brain.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("queryKanban", () => {
  it("scopes the stats to project goals in the window, before the status filter", () => {
    seedBoard(dbPath);
    const res = kanban({ status: "pending", days: 7 });

    // pend-old (40d) and done-old (10d) fall outside; the evergreen never counts.
    expect(res.stats.goals.byStatus).toEqual({ pending: 1, running: 1, completed: 1, failed: 1, cancelled: 1 });
    expect(res.stats.goals.total).toBe(5);
    expect(res.stats.tasks.byStatus).toEqual({ pending: 1, running: 1, completed: 1, failed: 1, cancelled: 2 });
    expect(res.stats.tasks.total).toBe(6);
    // Agent = first task's dispatch agent; a manual first task has none.
    expect(res.stats.agents).toEqual([
      { agentId: "coo", goalCount: 3 },
      { agentId: "main", goalCount: 1 },
    ]);
    expect(res.goals.map((g) => g.id)).toEqual(["pend-1"]);
    expect(res.pagination).toEqual({ limit: 50, offset: 0, total: 1, hasMore: false });
  });

  it("without days keeps every open goal but only last-7-day terminal goals", () => {
    seedBoard(dbPath);
    const ids = kanban({}).goals.map((g) => g.id).sort();
    expect(ids).toEqual(["cancel-1", "done-1", "fail-1", "pend-1", "pend-old", "run-1"]);
  });

  it("a wide window reaches old goals too", () => {
    seedBoard(dbPath);
    const ids = kanban({ days: 60, status: "pending, completed" }).goals.map((g) => g.id);
    expect(ids).toEqual(["pend-1", "done-1", "done-old", "pend-old"]);
  });

  it("sorts, orders and pages in SQL", () => {
    seedBoard(dbPath);
    expect(kanban({ days: 7, sort: "name", order: "asc" }).goals.map((g) => g.id)).toEqual([
      "cancel-1", "done-1", "fail-1", "pend-1", "run-1",
    ]);
    expect(kanban({ days: 7, sort: "created_at", order: "asc", limit: 2 }).goals.map((g) => g.id)).toEqual([
      "cancel-1", "done-1",
    ]);
    const page = kanban({ days: 7, limit: 2, offset: 2 });
    expect(page.goals.map((g) => g.id)).toEqual(["done-1", "fail-1"]);
    expect(page.pagination).toEqual({ limit: 2, offset: 2, total: 5, hasMore: true });
    expect(kanban({ days: 7, limit: 999 }).pagination.limit).toBe(200);
  });

  it("hydrates the page with tasks, attempts and the first task's agent", () => {
    seedBoard(dbPath);
    const run = kanban({ status: "running", days: 7 }).goals[0]!;

    expect(run).toMatchObject({
      id: "run-1",
      status: "running",
      sourceWorkflowId: "wf-a",
      agentId: "coo",
      createdAt: new Date(NOW - DAY).toISOString(),
      completedAt: null,
    });
    // The cancelled second task stays off the card.
    expect(run.tasks.map((t) => t.id)).toEqual(["run-1-a"]);
    const t = run.tasks[0]!;
    expect(t).toMatchObject({
      priority: "normal",
      blockedBy: ["x"],
      attemptCount: 1,
      onUpstreamFailure: "wait",
      startedAt: new Date(NOW - 2 * DAY).toISOString(),
      completedAt: null,
      latestOutput: "first pass",
      latestCheckpoint: {
        phase: "build",
        summary: "half way",
        progressPercent: 50,
        artifactPaths: ["a.md"],
        blocker: "waiting",
        timestamp: new Date(NOW - DAY).toISOString(),
      },
    });
    expect(t.attempts.map((a) => [a.attemptId, a.status, a.artifactPaths])).toEqual([
      ["att-1", "failed", ["log.txt"]],
      ["att-2", "running", []],
    ]);
    expect(t.attempts[1]!.endedAt).toBeNull();
    expect(t.activeAttempt?.attemptId).toBe("att-2");
  });

  it("tolerates legacy and malformed stored fields", () => {
    seedBoard(dbPath);
    const byId = new Map(
      kanban({ days: 7 }).goals.flatMap((g) => g.tasks).map((t) => [t.id, t] as const),
    );

    expect(byId.get("done-1-a")).toMatchObject({
      blockedBy: [],
      latestOutput: "plain text",
      activeAttempt: null,
      latestCheckpoint: { phase: "", summary: "", progressPercent: 0, artifactPaths: [], blocker: null, timestamp: null },
    });
    expect(byId.get("fail-1-a")).toMatchObject({
      failureReason: "boom",
      latestOutput: null, // an output record without a summary
      latestCheckpoint: { timestamp: "2026-09-01T00:00:00Z", artifactPaths: ["b.md"] },
    });
    expect(byId.get("pend-1-a")).toMatchObject({ latestCheckpoint: null, latestOutput: "raw log line" });
  });

  it("returns goals with no tasks, and an empty page", () => {
    const f = openFixture(dbPath);
    f.goal({ id: "bare", status: "pending", updatedAt: NOW - DAY });
    f.close();

    const res = kanban({ days: 7 });
    expect(res.goals).toEqual([expect.objectContaining({ id: "bare", agentId: null, tasks: [] })]);
    expect(res.stats.tasks.total).toBe(0);
    expect(kanban({ days: 7, status: "failed" }).goals).toEqual([]);
  });

  it("keeps malformed or non-text dispatch agents out of the agent stats", () => {
    const f = openFixture(dbPath);
    for (const id of ["g1", "g2", "g3", "g4"]) f.goal({ id, updatedAt: NOW - DAY });
    f.task({ id: "t1", goalId: "g1" });
    f.task({ id: "t2", goalId: "g2" });
    f.task({ id: "t3", goalId: "g3" });
    f.task({ id: "t4", goalId: "g4" });
    f.sql(`UPDATE tasks SET dispatch = 'not json' WHERE id = 't2'`);
    f.sql(`UPDATE tasks SET dispatch = '{"mode":"exec","agentId":7}' WHERE id = 't3'`);
    f.sql(`UPDATE tasks SET dispatch = '{"mode":"spawn","agentId":""}' WHERE id = 't4'`);
    f.close();

    const res = kanban({ days: 7 });
    expect(res.stats.agents).toEqual([{ agentId: "coo", goalCount: 1 }]);
    // Same updated_at → id DESC tie-break: g4, g3, g2, g1.
    expect(res.goals.map((g) => g.agentId)).toEqual([null, null, null, "coo"]);
  });
});

describe("dispatchAgentId", () => {
  it("reads agentId from dispatch JSON and rejects everything else", () => {
    expect(dispatchAgentId('{"mode":"spawn","agentId":"coo"}')).toBe("coo");
    expect(dispatchAgentId('{"mode":"manual"}')).toBeNull();
    expect(dispatchAgentId('{"agentId":""}')).toBeNull();
    expect(dispatchAgentId("[]")).toBeNull();
    expect(dispatchAgentId("null")).toBeNull();
    expect(dispatchAgentId("oops")).toBeNull();
    expect(dispatchAgentId("")).toBeNull();
  });
});

describe("queryWorkflowRunStats", () => {
  it("counts runs per workflow and reports the latest run's steps", () => {
    const f = openFixture(dbPath);
    f.goal({ id: "a1", status: "completed", createdAt: NOW - 3 * DAY, completedAt: NOW - 3 * DAY, sourceWorkflowId: "wf-a" });
    f.goal({ id: "a2", status: "failed", createdAt: NOW - 2 * DAY, sourceWorkflowId: "wf-a" });
    f.goal({ id: "a3", status: "running", createdAt: NOW - DAY, sourceWorkflowId: "wf-a" });
    f.goal({ id: "b1", status: "completed", createdAt: NOW - DAY, completedAt: NOW - DAY / 2, sourceWorkflowId: "wf-b" });
    f.goal({ id: "adhoc", status: "completed" });
    f.task({ id: "a3-s1", goalId: "a3", name: "Collect", status: "completed" });
    f.task({ id: "a3-s2", goalId: "a3", name: "Publish", status: "running" });
    f.close();

    const stats = withBrainDb(dbPath, queryWorkflowRunStats);
    expect([...stats.keys()].sort()).toEqual(["wf-a", "wf-b"]);
    expect(stats.get("wf-a")).toEqual({
      totalRuns: 3,
      successRate: 33.3,
      latestRun: {
        goalId: "a3",
        status: "running",
        startedAt: new Date(NOW - DAY).toISOString(),
        completedAt: null,
        taskStatuses: { Collect: "completed", Publish: "running" },
      },
    });
    // A latest run with no task rows still reports, with empty step statuses.
    expect(stats.get("wf-b")).toMatchObject({
      totalRuns: 1,
      successRate: 100,
      latestRun: { goalId: "b1", completedAt: new Date(NOW - DAY / 2).toISOString(), taskStatuses: {} },
    });
  });

  it("is empty when no goal came from a workflow", () => {
    const f = openFixture(dbPath);
    f.goal({ id: "adhoc" });
    f.close();
    expect(withBrainDb(dbPath, queryWorkflowRunStats).size).toBe(0);
  });
});

describe("withBrainDb", () => {
  it("opens readonly and closes even when the callback throws", () => {
    seedBoard(dbPath);
    let handle: Database.Database | undefined;
    expect(() =>
      withBrainDb(dbPath, (db) => {
        handle = db;
        expect(db.readonly).toBe(true);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(handle?.open).toBe(false);
  });

  it("refuses a missing database instead of creating one", () => {
    expect(() => withBrainDb(dbPath, () => 1)).toThrow();
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});

describe("buildBrainKanbanRouter", () => {
  let server: http.Server;
  let base: string;

  async function listen(router: express.Router): Promise<void> {
    const app = express();
    app.use("/api/kanban", router);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    vi.restoreAllMocks();
  });

  it("serves the Kanban contract from query params", async () => {
    seedBoard(dbPath);
    await listen(buildBrainKanbanRouter(dbPath, () => NOW));

    const res = await fetch(
      `${base}/api/kanban?status=running&limit=100&offset=0&sort=updated_at&order=desc&days=14`,
    );
    const body = (await res.json()) as KanbanResponse;
    expect(res.status).toBe(200);
    expect(body.goals.map((g) => g.id)).toEqual(["run-1"]);
    expect(body.pagination.limit).toBe(100);
    expect(body.stats.goals.total).toBe(6);
  });

  it("ignores repeated, negative and non-numeric params", async () => {
    seedBoard(dbPath);
    await listen(buildBrainKanbanRouter(dbPath, () => NOW));

    const res = await fetch(`${base}/api/kanban?status=a&status=b&limit=-5&days=soon&sort=x&sort=y`);
    const body = (await res.json()) as KanbanResponse;
    // status ignored (repeated) → all statuses; limit/days fall back to defaults.
    expect(body.pagination.limit).toBe(50);
    expect(body.goals.map((g) => g.id).sort()).toEqual(["cancel-1", "done-1", "fail-1", "pend-1", "pend-old", "run-1"]);
  });

  it("answers 500 when brain.db is unreadable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await listen(buildBrainKanbanRouter(dbPath));

    const res = await fetch(`${base}/api/kanban`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to fetch kanban data" });
  });
});
