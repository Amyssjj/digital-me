import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { coerceFilter, queryActivityFeed } from "./activity-feed.js";
import { migrate } from "./migrate.js";

let tmpDir: string;
let dbPath: string;
let db: Database.Database;

interface SeedRow {
  id: string;
  ts: string;
  agent_id: string;
  activity: "captured" | "applied" | "workflow";
  title: string;
  description?: string | null;
  meta?: string | null;
  attachments?: string | null;
}

function seed(rows: SeedRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO activity (id, ts, agent_id, activity, title, description, meta, attachments)
     VALUES (@id, @ts, @agent_id, @activity, @title, @description, @meta, @attachments)`,
  );
  for (const r of rows) {
    stmt.run({ description: null, meta: null, attachments: null, ...r });
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-feed-"));
  dbPath = path.join(tmpDir, "dashboard.db");
  // Use the real migration so the test exercises the actual `activity` schema.
  migrate(dbPath);
  db = new Database(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("migrate", () => {
  it("creates `activity` and drops the superseded `learning_capture`", () => {
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>).map((r) => r.name),
    );
    expect(tables.has("activity")).toBe(true);
    expect(tables.has("learning_capture")).toBe(false);
  });

  it("includes the `attachments` column", () => {
    const cols = (db.prepare(`PRAGMA table_info(activity)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("attachments");
  });

  it("adds `attachments` to a pre-existing activity table (additive migration)", () => {
    // Simulate an older DB whose `activity` table predates the column.
    const legacyPath = path.join(tmpDir, "legacy.db");
    const legacy = new Database(legacyPath);
    legacy.exec(
      `CREATE TABLE activity (id TEXT PRIMARY KEY, ts TEXT NOT NULL, agent_id TEXT NOT NULL,
        activity TEXT NOT NULL, title TEXT NOT NULL, description TEXT, meta TEXT)`,
    );
    legacy.close();
    migrate(legacyPath, { keepLegacy: true });
    const reopened = new Database(legacyPath);
    const cols = (reopened.prepare(`PRAGMA table_info(activity)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    reopened.close();
    expect(cols).toContain("attachments");
  });
});

describe("queryActivityFeed", () => {
  it("returns an empty feed when the table has no rows", () => {
    const res = queryActivityFeed(db);
    expect(res.items).toHaveLength(0);
    expect(res.latest_ts).toBeNull();
  });

  it("returns rows newest-first with latest_ts from the top row", () => {
    seed([
      { id: "c1", ts: "2026-06-03T16:00:00.000Z", agent_id: "podcast", activity: "captured", title: "Always X", description: "Prevents Z", meta: "project · x.md" },
      { id: "a1", ts: "2026-06-04T01:00:00.000Z", agent_id: "claude-code", activity: "applied", title: "Applied 2 learnings", description: "a.md, b.md", meta: "recalled" },
      { id: "w1", ts: "2026-06-01T12:00:00.000Z", agent_id: "intake", activity: "workflow", title: "Fix wiki drift", meta: "project" },
    ]);
    const res = queryActivityFeed(db);
    expect(res.items.map((i) => i.id)).toEqual(["a1", "c1", "w1"]);
    expect(res.latest_ts).toBe("2026-06-04T01:00:00.000Z");
    // Field passthrough is faithful.
    const captured = res.items.find((i) => i.id === "c1");
    expect(captured).toMatchObject({
      agent_id: "podcast",
      activity: "captured",
      title: "Always X",
      description: "Prevents Z",
      meta: "project · x.md",
    });
  });

  it("scopes to a single activity when filtered", () => {
    seed([
      { id: "c1", ts: "2026-06-03T16:00:00.000Z", agent_id: "podcast", activity: "captured", title: "T" },
      { id: "a1", ts: "2026-06-04T01:00:00.000Z", agent_id: "cc", activity: "applied", title: "Applied 1 learning" },
      { id: "w1", ts: "2026-06-01T12:00:00.000Z", agent_id: "intake", activity: "workflow", title: "WF" },
    ]);
    expect(queryActivityFeed(db, { filter: "captured" }).items.map((i) => i.activity)).toEqual(["captured"]);
    expect(queryActivityFeed(db, { filter: "applied" }).items.map((i) => i.activity)).toEqual(["applied"]);
    expect(queryActivityFeed(db, { filter: "workflow" }).items.map((i) => i.activity)).toEqual(["workflow"]);
  });

  it("respects the limit", () => {
    seed(
      Array.from({ length: 10 }, (_, i) => ({
        id: `x${i}`,
        ts: `2026-06-04T0${i}:00:00.000Z`,
        agent_id: "cc",
        activity: "applied" as const,
        title: `t${i}`,
      })),
    );
    expect(queryActivityFeed(db, { limit: 3 }).items).toHaveLength(3);
  });

  it("parses the attachments JSON into a typed array, separating each learning", () => {
    seed([
      {
        id: "a1",
        ts: "2026-06-04T01:00:00.000Z",
        agent_id: "claude-code",
        activity: "applied",
        title: "Applied 2 learnings",
        description: "a.md, b.md",
        attachments: JSON.stringify([
          { title: "Learning A", path: "a.md", markdown: "# A\n\nbody a" },
          { title: "Learning B", path: "b.md", markdown: "# B\n\nbody b" },
        ]),
      },
    ]);
    const item = queryActivityFeed(db).items[0]!;
    expect(item.attachments).toHaveLength(2);
    expect(item.attachments![0]).toEqual({ title: "Learning A", path: "a.md", markdown: "# A\n\nbody a" });
    expect(item.attachments![1]!.markdown).toContain("body b");
  });

  it("degrades malformed/absent attachments to null", () => {
    seed([
      { id: "bad", ts: "2026-06-04T02:00:00.000Z", agent_id: "cc", activity: "applied", title: "x", attachments: "{not json" },
      { id: "none", ts: "2026-06-04T01:00:00.000Z", agent_id: "cc", activity: "workflow", title: "y" },
    ]);
    const byId = Object.fromEntries(queryActivityFeed(db).items.map((i) => [i.id, i]));
    expect(byId["bad"]!.attachments).toBeNull();
    expect(byId["none"]!.attachments).toBeNull();
  });

  it("scopes to the taste stream and parses its attachment", () => {
    seed([
      {
        id: "t1",
        ts: "2026-05-23T00:00:00.000Z",
        agent_id: "dream-cycle",
        activity: "taste",
        title: "Every element earns its place",
        description: "Restraint is the default.",
        meta: "design · promoted",
        attachments: JSON.stringify([
          { title: "Every element earns its place", path: "restraint.md", markdown: "## Principle\n\nRestraint." },
        ]),
      },
      { id: "c1", ts: "2026-05-22T00:00:00.000Z", agent_id: "podcast", activity: "captured", title: "X" },
    ]);
    const taste = queryActivityFeed(db, { filter: "taste" }).items;
    expect(taste.map((i) => i.activity)).toEqual(["taste"]);
    expect(taste[0]!.attachments![0]!.markdown).toContain("Principle");
  });

  it("coerceFilter accepts valid filters and falls back to 'all'", () => {
    expect(coerceFilter("captured")).toBe("captured");
    expect(coerceFilter("applied")).toBe("applied");
    expect(coerceFilter("workflow")).toBe("workflow");
    expect(coerceFilter("taste")).toBe("taste");
    expect(coerceFilter("all")).toBe("all");
    expect(coerceFilter("bogus")).toBe("all");
    expect(coerceFilter(undefined)).toBe("all");
  });
});
