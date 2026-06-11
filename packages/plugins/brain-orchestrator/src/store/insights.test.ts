import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
// Vite/vitest doesn't recognize experimental node:sqlite as a builtin
// (`module.builtinModules` excludes it); use createRequire so Node's loader
// resolves it at runtime instead of letting Vite try to bundle.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import { createInsightTools, initInsightSchema } from "./insights.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initInsightSchema(db);
});

afterEach(() => {
  db.close();
});

describe("insight.capture", () => {
  it("inserts a row with required fields", () => {
    const tools = createInsightTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "ins-1",
    });
    const id = tools.capture({
      type: "observation",
      observation: "Cron success rate dipped",
    });
    expect(id).toBe("ins-1");
    const row = db.prepare("SELECT * FROM insights WHERE id = 'ins-1'").get() as {
      id: string;
      date: string;
      type: string;
      observation: string;
      why_it_matters: string | null;
      question_for_jing: string | null;
      proposed_action: string | null;
      related_goal: string | null;
      status: string;
    };
    expect(row).toMatchObject({
      id: "ins-1",
      date: "2026-05-15",
      type: "observation",
      observation: "Cron success rate dipped",
      status: "surfaced",
    });
    expect(row.why_it_matters).toBeNull();
    expect(row.question_for_jing).toBeNull();
    expect(row.proposed_action).toBeNull();
    expect(row.related_goal).toBeNull();
  });

  it("stores all optional context fields", () => {
    const tools = createInsightTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "ins-1",
    });
    tools.capture({
      type: "trend",
      observation: "Knowledge growth flat for 7 days",
      why_it_matters: "Indicates ingest pipeline stalled",
      question_for_jing: "Should we trigger a backfill?",
      proposed_action: "Run wiki re-index",
      related_goal: "knowledge",
    });
    const row = db.prepare("SELECT * FROM insights WHERE id = 'ins-1'").get() as {
      why_it_matters: string;
      question_for_jing: string;
      proposed_action: string;
      related_goal: string;
    };
    expect(row.why_it_matters).toBe("Indicates ingest pipeline stalled");
    expect(row.question_for_jing).toBe("Should we trigger a backfill?");
    expect(row.proposed_action).toBe("Run wiki re-index");
    expect(row.related_goal).toBe("knowledge");
  });
});

describe("insight.list", () => {
  function seed(): void {
    let day = 13;
    let n = 0;
    const at = (): ReturnType<typeof createInsightTools> =>
      createInsightTools({
        db,
        now: () => new Date(`2026-05-${day++}T00:00:00Z`),
        idGen: () => `ins-${++n}`,
      });
    at().capture({ type: "a", observation: "oldest" });
    at().capture({ type: "a", observation: "middle" });
    at().capture({ type: "a", observation: "newest" });
  }

  it("returns insights in date DESC order", () => {
    seed();
    const tools = createInsightTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    const out = tools.list({});
    expect(out.insights.map((i) => i.observation)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("filters by status_filter (single status)", () => {
    const tools = createInsightTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "i1",
    });
    tools.capture({ type: "a", observation: "x" });
    tools.updateStatus({ id: "i1", status: "archived" });
    expect(tools.list({ status_filter: ["surfaced"] }).insights).toEqual([]);
    expect(tools.list({ status_filter: ["archived"] }).insights).toHaveLength(1);
  });

  it("filters by status_filter (multiple statuses)", () => {
    let n = 0;
    const tools = createInsightTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => `i${++n}`,
    });
    tools.capture({ type: "a", observation: "1" });
    tools.capture({ type: "a", observation: "2" });
    tools.capture({ type: "a", observation: "3" });
    tools.updateStatus({ id: "i1", status: "discussed" });
    tools.updateStatus({ id: "i2", status: "resolved" });
    expect(
      tools.list({ status_filter: ["surfaced", "discussed"] }).insights,
    ).toHaveLength(2);
  });

  it("respects limit", () => {
    seed();
    const tools = createInsightTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    expect(tools.list({ limit: 1 }).insights).toHaveLength(1);
  });

  it("filters by since", () => {
    seed();
    const tools = createInsightTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    const since = new Date("2026-05-14T00:00:00Z").getTime();
    const out = tools.list({ since });
    expect(out.insights.map((i) => i.observation)).toEqual(["newest", "middle"]);
  });
});

describe("insight.update_status", () => {
  it("changes the status of an existing insight", () => {
    const tools = createInsightTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "i1",
    });
    tools.capture({ type: "a", observation: "x" });
    tools.updateStatus({ id: "i1", status: "discussed" });
    const row = db.prepare("SELECT status FROM insights WHERE id = 'i1'").get() as {
      status: string;
    };
    expect(row.status).toBe("discussed");
  });

  it("supports the full status lifecycle", () => {
    const tools = createInsightTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "i1",
    });
    tools.capture({ type: "a", observation: "x" });
    for (const status of ["surfaced", "discussed", "resolved", "archived"] as const) {
      tools.updateStatus({ id: "i1", status });
      const row = db
        .prepare("SELECT status FROM insights WHERE id = 'i1'")
        .get() as { status: string };
      expect(row.status).toBe(status);
    }
  });
});
