import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
// Vite/vitest doesn't recognize experimental node:sqlite as a builtin
// (`module.builtinModules` excludes it); use createRequire so Node's loader
// resolves it at runtime instead of letting Vite try to bundle.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import { createFeedbackTools, initFeedbackSchema } from "./feedback.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initFeedbackSchema(db);
});

afterEach(() => {
  db.close();
});

describe("initFeedbackSchema", () => {
  it("creates the feedback table idempotently", () => {
    initFeedbackSchema(db);
    const t = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'",
      )
      .get();
    expect(t).toBeDefined();
  });
});

describe("feedback.submit", () => {
  it("inserts a row with all fields populated and returns the new id", () => {
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    const id = tools.submit({
      type: "bug",
      agent: "coo",
      description: "Discord notification skipped",
      severity: "medium",
      source: "discord",
      related_goal: "operation",
    });
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
    const row = db.prepare("SELECT * FROM feedback WHERE id = ?").get(id) as {
      date: string;
      type: string;
      agent: string;
      description: string;
      severity: string | null;
      source: string;
      related_goal: string | null;
      resolved: number;
    };
    expect(row).toMatchObject({
      date: "2026-05-15",
      type: "bug",
      agent: "coo",
      description: "Discord notification skipped",
      severity: "medium",
      source: "discord",
      related_goal: "operation",
      resolved: 0,
    });
  });

  it("defaults severity and related_goal to null when omitted", () => {
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    const id = tools.submit({
      type: "compliment",
      agent: "coo",
      description: "Nice work",
      source: "slack",
    });
    const row = db.prepare("SELECT severity, related_goal FROM feedback WHERE id = ?").get(id) as {
      severity: string | null;
      related_goal: string | null;
    };
    expect(row.severity).toBeNull();
    expect(row.related_goal).toBeNull();
  });

  it("auto-increments ids", () => {
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    const a = tools.submit({ type: "x", agent: "a", description: "1", source: "s" });
    const b = tools.submit({ type: "x", agent: "a", description: "2", source: "s" });
    expect(b).toBe(a + 1);
  });
});

describe("feedback.list", () => {
  function seed(): void {
    let day = 13;
    const at = (): ReturnType<typeof createFeedbackTools> =>
      createFeedbackTools({
        db,
        now: () => new Date(`2026-05-${day++}T00:00:00Z`),
      });
    at().submit({ type: "bug", agent: "coo", description: "old", source: "discord" });
    at().submit({ type: "bug", agent: "coo", description: "mid", source: "discord" });
    at().submit({ type: "bug", agent: "coo", description: "new", source: "discord" });
  }

  it("returns all feedback in date DESC order", () => {
    seed();
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    const out = tools.list({});
    expect(out.feedback.map((f) => f.description)).toEqual(["new", "mid", "old"]);
  });

  it("respects limit", () => {
    seed();
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    const out = tools.list({ limit: 2 });
    expect(out.feedback).toHaveLength(2);
  });

  it("filters by since epoch ms", () => {
    seed();
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    const since = new Date("2026-05-14T00:00:00Z").getTime();
    const out = tools.list({ since });
    expect(out.feedback.map((f) => f.description)).toEqual(["new", "mid"]);
  });

  it("returns resolved as a boolean", () => {
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    const id = tools.submit({ type: "x", agent: "a", description: "1", source: "s" });
    tools.resolve({ id, resolved: true });
    const out = tools.list({});
    expect(out.feedback[0]!.resolved).toBe(true);
  });

  it("returns empty when there is no feedback", () => {
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    expect(tools.list({}).feedback).toEqual([]);
  });
});

describe("feedback.resolve", () => {
  it("flips resolved to true and stores resolution text", () => {
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    const id = tools.submit({ type: "x", agent: "a", description: "y", source: "s" });
    tools.resolve({ id, resolved: true, resolution: "rebooted" });
    const row = db.prepare("SELECT resolved, resolution FROM feedback WHERE id = ?").get(id) as {
      resolved: number;
      resolution: string | null;
    };
    expect(row.resolved).toBe(1);
    expect(row.resolution).toBe("rebooted");
  });

  it("flips resolved back to false", () => {
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    const id = tools.submit({ type: "x", agent: "a", description: "y", source: "s" });
    tools.resolve({ id, resolved: true });
    tools.resolve({ id, resolved: false });
    const row = db.prepare("SELECT resolved FROM feedback WHERE id = ?").get(id) as {
      resolved: number;
    };
    expect(row.resolved).toBe(0);
  });

  it("omitted resolution leaves existing resolution unchanged", () => {
    const tools = createFeedbackTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    const id = tools.submit({ type: "x", agent: "a", description: "y", source: "s" });
    tools.resolve({ id, resolved: true, resolution: "first" });
    tools.resolve({ id, resolved: false });
    const row = db.prepare("SELECT resolution FROM feedback WHERE id = ?").get(id) as {
      resolution: string | null;
    };
    expect(row.resolution).toBe("first");
  });
});
