import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
// Vite/vitest doesn't recognize experimental node:sqlite as a builtin
// (`module.builtinModules` excludes it); use createRequire so Node's loader
// resolves it at runtime instead of letting Vite try to bundle.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import { createIssueTools, initIssueSchema } from "./issues.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initIssueSchema(db);
});

afterEach(() => {
  db.close();
});

describe("initIssueSchema", () => {
  it("creates the issues table idempotently", () => {
    initIssueSchema(db);
    const t = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='issues'")
      .get();
    expect(t).toBeDefined();
  });
});

describe("issue.open", () => {
  it("creates an issue with the supplied fields", () => {
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "iss-test-1",
    });
    const id = tools.open({
      type: "improvement",
      title: "Add caching",
      goal: "operation",
      description: "API responses are slow",
      category: "perf",
      severity: "medium",
      reported_by: "coo",
    });
    expect(id).toBe("iss-test-1");
    const row = db.prepare("SELECT * FROM issues WHERE id = ?").get("iss-test-1") as {
      id: string;
      date: string;
      type: string;
      goal: string | null;
      title: string;
      description: string | null;
      category: string | null;
      severity: string | null;
      status: string;
      reported_by: string | null;
    };
    expect(row).toMatchObject({
      id: "iss-test-1",
      date: "2026-05-15",
      type: "improvement",
      goal: "operation",
      title: "Add caching",
      description: "API responses are slow",
      category: "perf",
      severity: "medium",
      status: "open",
      reported_by: "coo",
    });
  });

  it("nulls out unspecified optional fields", () => {
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "iss-1",
    });
    tools.open({ type: "bug", title: "Crash on load" });
    const row = db.prepare("SELECT * FROM issues WHERE id = 'iss-1'").get() as {
      goal: string | null;
      description: string | null;
      category: string | null;
      severity: string | null;
      reported_by: string | null;
    };
    expect(row.goal).toBeNull();
    expect(row.description).toBeNull();
    expect(row.category).toBeNull();
    expect(row.severity).toBeNull();
    expect(row.reported_by).toBeNull();
  });

  it("generates unique ids via the injected idGen", () => {
    let n = 0;
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => `iss-${++n}`,
    });
    const a = tools.open({ type: "bug", title: "A" });
    const b = tools.open({ type: "bug", title: "B" });
    expect(a).toBe("iss-1");
    expect(b).toBe("iss-2");
  });
});

describe("issue.update", () => {
  it("changes the status", () => {
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "i1",
    });
    tools.open({ type: "bug", title: "x" });
    tools.update({ id: "i1", status: "in_progress" });
    const row = db.prepare("SELECT status FROM issues WHERE id = 'i1'").get() as {
      status: string;
    };
    expect(row.status).toBe("in_progress");
  });

  it("stores the optional resolution string", () => {
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "i1",
    });
    tools.open({ type: "bug", title: "x" });
    tools.update({ id: "i1", status: "closed", resolution: "fixed in PR #42" });
    const row = db.prepare("SELECT status, resolution FROM issues WHERE id = 'i1'").get() as {
      status: string;
      resolution: string | null;
    };
    expect(row.status).toBe("closed");
    expect(row.resolution).toBe("fixed in PR #42");
  });

  it("treats an omitted resolution as no change to the resolution column", () => {
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "i1",
    });
    tools.open({ type: "bug", title: "x" });
    tools.update({ id: "i1", status: "in_progress", resolution: "first try" });
    tools.update({ id: "i1", status: "verify" });
    const row = db.prepare("SELECT status, resolution FROM issues WHERE id = 'i1'").get() as {
      status: string;
      resolution: string | null;
    };
    expect(row.status).toBe("verify");
    // Resolution preserved from the prior update.
    expect(row.resolution).toBe("first try");
  });
});

describe("issue.list", () => {
  function seed(): ReturnType<typeof createIssueTools> {
    let n = 0;
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => `i${++n}`,
    });
    tools.open({ type: "bug", title: "B1", goal: "operation", reported_by: "coo" });
    tools.open({ type: "improvement", title: "I1", goal: "operation" });
    tools.open({ type: "improvement", title: "I2", goal: "knowledge" });
    tools.open({ type: "automation_opportunity", title: "A1" });
    return tools;
  }

  it("returns all issues by default", () => {
    seed();
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    expect(tools.list({}).issues).toHaveLength(4);
  });

  it("filters by type", () => {
    seed();
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    const out = tools.list({ type: "improvement" });
    expect(out.issues).toHaveLength(2);
    expect(out.issues.every((i) => i.type === "improvement")).toBe(true);
  });

  it("filters by status", () => {
    const tools = seed();
    tools.update({ id: "i1", status: "closed" });
    expect(tools.list({ status: "closed" }).issues).toHaveLength(1);
    expect(tools.list({ status: "open" }).issues).toHaveLength(3);
  });

  it("filters by goal", () => {
    seed();
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    expect(tools.list({ goal: "operation" }).issues).toHaveLength(2);
    expect(tools.list({ goal: "knowledge" }).issues).toHaveLength(1);
  });

  it("filters by since (epoch ms)", () => {
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-10T00:00:00Z"),
      idGen: () => "old",
    });
    tools.open({ type: "bug", title: "old" });
    const tools2 = createIssueTools({
      db,
      now: () => new Date("2026-05-15T00:00:00Z"),
      idGen: () => "new",
    });
    tools2.open({ type: "bug", title: "new" });
    const since = new Date("2026-05-12T00:00:00Z").getTime();
    const out = tools.list({ since });
    expect(out.issues.map((i) => i.id)).toEqual(["new"]);
  });

  it("filters by until (epoch ms)", () => {
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-10T00:00:00Z"),
      idGen: () => "old",
    });
    tools.open({ type: "bug", title: "old" });
    const tools2 = createIssueTools({
      db,
      now: () => new Date("2026-05-15T00:00:00Z"),
      idGen: () => "new",
    });
    tools2.open({ type: "bug", title: "new" });
    const until = new Date("2026-05-12T00:00:00Z").getTime();
    expect(tools.list({ until }).issues.map((i) => i.id)).toEqual(["old"]);
  });

  it("respects limit", () => {
    seed();
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    expect(tools.list({ limit: 2 }).issues).toHaveLength(2);
  });

  it("returns issues in date DESC order", () => {
    const t1 = createIssueTools({
      db,
      now: () => new Date("2026-05-10T00:00:00Z"),
      idGen: () => "first",
    });
    t1.open({ type: "bug", title: "first" });
    const t2 = createIssueTools({
      db,
      now: () => new Date("2026-05-15T00:00:00Z"),
      idGen: () => "second",
    });
    t2.open({ type: "bug", title: "second" });
    const out = t2.list({});
    expect(out.issues[0]!.id).toBe("second");
    expect(out.issues[1]!.id).toBe("first");
  });
});

describe("issue.summary", () => {
  it("returns total + closed counts + fix rate", () => {
    let n = 0;
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => `i${++n}`,
    });
    tools.open({ type: "bug", title: "x", reported_by: "coo" });
    tools.open({ type: "bug", title: "y", reported_by: "coo" });
    tools.open({ type: "bug", title: "z", reported_by: "jing" });
    tools.update({ id: "i1", status: "closed" });
    const s = tools.summary();
    expect(s.total).toBe(3);
    expect(s.closed).toBe(1);
    expect(s.fix_rate).toBe(33.3);
  });

  it("aggregates byReporter counts (sorted by count desc)", () => {
    let n = 0;
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => `i${++n}`,
    });
    tools.open({ type: "bug", title: "1", reported_by: "alpha" });
    tools.open({ type: "bug", title: "2", reported_by: "alpha" });
    tools.open({ type: "bug", title: "3", reported_by: "beta" });
    const s = tools.summary();
    expect(s.by_reporter).toEqual([
      { reporter: "alpha", count: 2 },
      { reporter: "beta", count: 1 },
    ]);
  });

  it("buckets null reported_by as 'unknown'", () => {
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "i1",
    });
    tools.open({ type: "bug", title: "x" });
    const s = tools.summary();
    expect(s.by_reporter).toEqual([{ reporter: "unknown", count: 1 }]);
  });

  it("returns zero stats for an empty store", () => {
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    const s = tools.summary();
    expect(s).toEqual({ by_reporter: [], total: 0, closed: 0, fix_rate: 0 });
  });
});

describe("issue.timeseries", () => {
  function seedTimeseries(): void {
    let n = 0;
    const at = (iso: string): ReturnType<typeof createIssueTools> =>
      createIssueTools({
        db,
        now: () => new Date(iso),
        idGen: () => `i${++n}`,
      });
    at("2026-05-13T00:00:00Z").open({ type: "bug", title: "a", reported_by: "alpha" });
    at("2026-05-13T00:00:00Z").open({ type: "bug", title: "b", reported_by: "alpha" });
    at("2026-05-14T00:00:00Z").open({ type: "improvement", title: "c", reported_by: "beta" });
    at("2026-05-15T00:00:00Z").open({ type: "bug", title: "d", reported_by: "alpha" });
  }

  it("groups by reporter, counting opens per date", () => {
    seedTimeseries();
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    const out = tools.timeseries({ by: "reporter" });
    const flat = out.points
      .map((p) => `${p.date}:${p.dim}:${p.opened}`)
      .sort();
    expect(flat).toContain("2026-05-13:alpha:2");
    expect(flat).toContain("2026-05-14:beta:1");
    expect(flat).toContain("2026-05-15:alpha:1");
  });

  it("groups by type", () => {
    seedTimeseries();
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    const out = tools.timeseries({ by: "type" });
    const flat = out.points
      .map((p) => `${p.date}:${p.dim}:${p.opened}`)
      .sort();
    expect(flat).toContain("2026-05-13:bug:2");
    expect(flat).toContain("2026-05-14:improvement:1");
  });

  it("groups by goal (and uses 'unknown' for null goal)", () => {
    let n = 0;
    const at = (iso: string): ReturnType<typeof createIssueTools> =>
      createIssueTools({
        db,
        now: () => new Date(iso),
        idGen: () => `i${++n}`,
      });
    at("2026-05-15T00:00:00Z").open({ type: "bug", title: "x", goal: "operation" });
    at("2026-05-15T00:00:00Z").open({ type: "bug", title: "y" });
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    const out = tools.timeseries({ by: "goal" });
    const dims = out.points.map((p) => p.dim).sort();
    expect(dims).toContain("operation");
    expect(dims).toContain("unknown");
  });

  it("filters by since / until", () => {
    seedTimeseries();
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-15T12:00:00Z"),
      idGen: () => "n/a",
    });
    const out = tools.timeseries({
      by: "reporter",
      since: new Date("2026-05-14T00:00:00Z").getTime(),
      until: new Date("2026-05-14T23:59:59Z").getTime(),
    });
    expect(out.points).toHaveLength(1);
    expect(out.points[0]).toMatchObject({ date: "2026-05-14", dim: "beta", opened: 1 });
  });

  it("counts closed per date and dim", () => {
    let n = 0;
    const at = (iso: string): ReturnType<typeof createIssueTools> =>
      createIssueTools({
        db,
        now: () => new Date(iso),
        idGen: () => `i${++n}`,
      });
    at("2026-05-13T00:00:00Z").open({ type: "bug", title: "x", reported_by: "alpha" });
    const closer = at("2026-05-15T00:00:00Z");
    closer.update({ id: "i1", status: "closed" });
    const tools = createIssueTools({
      db,
      now: () => new Date("2026-05-16T00:00:00Z"),
      idGen: () => "n/a",
    });
    const out = tools.timeseries({ by: "reporter" });
    const opened = out.points.find((p) => p.date === "2026-05-13" && p.dim === "alpha");
    const closed = out.points.find((p) => p.date === "2026-05-15" && p.dim === "alpha");
    expect(opened?.opened).toBe(1);
    expect(closed?.closed).toBe(1);
  });
});
