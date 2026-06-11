import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  SCHEDULES_MIGRATIONS,
  createSchedulesStore,
  type ScheduleRecord,
} from "./schedules.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "./migrations.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of SCHEDULES_MIGRATIONS) registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function baseSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = Date.parse("2026-05-17T12:00:00Z");
  return {
    id: "sched-1",
    workflowId: "wf-1",
    name: "nightly",
    cronExpr: "0 2 * * *",
    timezone: "UTC",
    variables: {},
    enabled: true,
    nextRunAt: now + 3600_000,
    maxOverlap: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("createSchedulesStore — CRUD", () => {
  it("round-trips a minimal schedule", () => {
    const store = createSchedulesStore({ db });
    store.create(baseSchedule());
    const s = store.get("sched-1");
    expect(s).toBeDefined();
    expect(s!.id).toBe("sched-1");
    expect(s!.name).toBe("nightly");
    expect(s!.workflowId).toBe("wf-1");
    expect(s!.cronExpr).toBe("0 2 * * *");
    expect(s!.timezone).toBe("UTC");
    expect(s!.variables).toEqual({});
    expect(s!.enabled).toBe(true);
    expect(s!.maxOverlap).toBe(0);
    expect(s!.lastRunAt).toBeUndefined();
    expect(s!.lastGoalId).toBeUndefined();
    expect(s!.lastStatus).toBeUndefined();
  });

  it("returns undefined for an unknown id", () => {
    const store = createSchedulesStore({ db });
    expect(store.get("missing")).toBeUndefined();
  });

  it("round-trips every optional field", () => {
    const store = createSchedulesStore({ db });
    store.create(
      baseSchedule({
        variables: { env: "prod", target: "main" },
        enabled: false,
        lastRunAt: 1000,
        lastGoalId: "g-99",
        lastStatus: "completed",
        maxOverlap: 3,
      }),
    );
    const s = store.get("sched-1")!;
    expect(s.variables).toEqual({ env: "prod", target: "main" });
    expect(s.enabled).toBe(false);
    expect(s.lastRunAt).toBe(1000);
    expect(s.lastGoalId).toBe("g-99");
    expect(s.lastStatus).toBe("completed");
    expect(s.maxOverlap).toBe(3);
  });

  it("getByName returns the matching schedule", () => {
    const store = createSchedulesStore({ db });
    store.create(baseSchedule({ name: "alpha" }));
    store.create(baseSchedule({ id: "sched-2", name: "beta" }));
    expect(store.getByName("alpha")!.id).toBe("sched-1");
    expect(store.getByName("beta")!.id).toBe("sched-2");
  });

  it("getByName returns undefined for an unknown name", () => {
    const store = createSchedulesStore({ db });
    expect(store.getByName("missing")).toBeUndefined();
  });

  it("listAll returns schedules sorted by name ASC", () => {
    const store = createSchedulesStore({ db });
    store.create(baseSchedule({ id: "s-b", name: "beta" }));
    store.create(baseSchedule({ id: "s-a", name: "alpha" }));
    store.create(baseSchedule({ id: "s-c", name: "gamma" }));
    const ids = store.listAll().map((s) => s.id);
    expect(ids).toEqual(["s-a", "s-b", "s-c"]);
  });

  it("update overwrites every mutable field", () => {
    const store = createSchedulesStore({ db });
    store.create(baseSchedule());
    store.update({
      ...baseSchedule(),
      workflowId: "wf-2",
      name: "renamed",
      cronExpr: "*/5 * * * *",
      timezone: "America/New_York",
      variables: { x: "1" },
      enabled: false,
      nextRunAt: 9000,
      lastRunAt: 8000,
      lastGoalId: "g-1",
      lastStatus: "failed",
      maxOverlap: 1,
      updatedAt: 9999,
    });
    const s = store.get("sched-1")!;
    expect(s.workflowId).toBe("wf-2");
    expect(s.name).toBe("renamed");
    expect(s.cronExpr).toBe("*/5 * * * *");
    expect(s.timezone).toBe("America/New_York");
    expect(s.variables).toEqual({ x: "1" });
    expect(s.enabled).toBe(false);
    expect(s.nextRunAt).toBe(9000);
    expect(s.lastRunAt).toBe(8000);
    expect(s.lastGoalId).toBe("g-1");
    expect(s.lastStatus).toBe("failed");
    expect(s.maxOverlap).toBe(1);
    expect(s.updatedAt).toBe(9999);
  });

  it("update can clear optional fields back to undefined", () => {
    const store = createSchedulesStore({ db });
    store.create(
      baseSchedule({
        lastRunAt: 1,
        lastGoalId: "g",
        lastStatus: "completed",
      }),
    );
    store.update(baseSchedule());
    const s = store.get("sched-1")!;
    expect(s.lastRunAt).toBeUndefined();
    expect(s.lastGoalId).toBeUndefined();
    expect(s.lastStatus).toBeUndefined();
  });

  it("delete removes the row and returns true", () => {
    const store = createSchedulesStore({ db });
    store.create(baseSchedule());
    expect(store.delete("sched-1")).toBe(true);
    expect(store.get("sched-1")).toBeUndefined();
  });

  it("delete returns false for an unknown id", () => {
    const store = createSchedulesStore({ db });
    expect(store.delete("missing")).toBe(false);
  });
});

describe("createSchedulesStore — findDue", () => {
  it("returns enabled schedules whose next_run_at <= now", () => {
    const store = createSchedulesStore({ db });
    store.create(baseSchedule({ id: "a", name: "a", nextRunAt: 100 }));
    store.create(baseSchedule({ id: "b", name: "b", nextRunAt: 200 }));
    store.create(baseSchedule({ id: "c", name: "c", nextRunAt: 300 }));
    const due = store.findDue(200).map((s) => s.id).sort();
    expect(due).toEqual(["a", "b"]);
  });

  it("excludes disabled schedules even when past due", () => {
    const store = createSchedulesStore({ db });
    store.create(
      baseSchedule({ id: "a", name: "a", nextRunAt: 100, enabled: false }),
    );
    store.create(baseSchedule({ id: "b", name: "b", nextRunAt: 100 }));
    const due = store.findDue(1000).map((s) => s.id);
    expect(due).toEqual(["b"]);
  });

  it("returns empty when no schedule is due", () => {
    const store = createSchedulesStore({ db });
    store.create(baseSchedule({ nextRunAt: 9999 }));
    expect(store.findDue(100)).toEqual([]);
  });
});

describe("createSchedulesStore — claim (atomic advance)", () => {
  it("returns true and advances next_run_at when expected matches", () => {
    const store = createSchedulesStore({ db });
    store.create(baseSchedule({ nextRunAt: 100 }));
    const won = store.claim("sched-1", 100, 200, 150);
    expect(won).toBe(true);
    const s = store.get("sched-1")!;
    expect(s.nextRunAt).toBe(200);
    expect(s.lastRunAt).toBe(150);
    expect(s.updatedAt).toBe(150);
  });

  it("returns false when expected next_run_at no longer matches", () => {
    const store = createSchedulesStore({ db });
    store.create(baseSchedule({ nextRunAt: 100 }));
    // Another scanner won the claim first by advancing to 200.
    store.claim("sched-1", 100, 200, 150);
    // This scanner still has the stale expected=100; loses.
    const won = store.claim("sched-1", 100, 300, 160);
    expect(won).toBe(false);
    expect(store.get("sched-1")!.nextRunAt).toBe(200);
  });

  it("returns false for an unknown id", () => {
    const store = createSchedulesStore({ db });
    expect(store.claim("missing", 100, 200, 150)).toBe(false);
  });
});

describe("createSchedulesStore — defensive JSON parsing", () => {
  it("falls back to {} when variables JSON is malformed", () => {
    const store = createSchedulesStore({ db });
    store.create(baseSchedule({ variables: { x: "1" } }));
    db.prepare(
      "UPDATE schedules SET variables = 'not-json' WHERE id = ?",
    ).run("sched-1");
    expect(store.get("sched-1")!.variables).toEqual({});
  });
});

describe("SCHEDULES_MIGRATIONS", () => {
  it("registers the schedules table at a stable version", () => {
    expect(SCHEDULES_MIGRATIONS).toHaveLength(1);
    expect(SCHEDULES_MIGRATIONS[0]!.version).toBeGreaterThan(0);
    expect(SCHEDULES_MIGRATIONS[0]!.description).toMatch(/schedule/i);
  });

  it("produces a usable schedules table when applied to a fresh DB", () => {
    const fresh = new DatabaseSync(":memory:");
    for (const m of SCHEDULES_MIGRATIONS) m.up(fresh);
    const cols = fresh
      .prepare("PRAGMA table_info(schedules)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("cron_expr");
    expect(names).toContain("timezone");
    expect(names).toContain("next_run_at");
    expect(names).toContain("max_overlap");
    fresh.close();
  });

  it("uses 'UTC' as the timezone default (not an owner-specific zone)", () => {
    const fresh = new DatabaseSync(":memory:");
    for (const m of SCHEDULES_MIGRATIONS) m.up(fresh);
    fresh
      .prepare(
        "INSERT INTO schedules (id, workflow_id, name, cron_expr, variables, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("z", "wf", "z", "* * * * *", "{}", 0, 0, 0);
    const row = fresh
      .prepare("SELECT timezone FROM schedules WHERE id = 'z'")
      .get() as { timezone: string };
    expect(row.timezone).toBe("UTC");
    fresh.close();
  });
});
