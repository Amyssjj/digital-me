import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  createSchedulesStore,
  SCHEDULES_MIGRATIONS,
  type ScheduleRecord,
} from "../store/schedules.js";
import type { Migration } from "../store/migrations.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "../store/migrations.js";
import {
  addSchedule,
  formatSchedulesList,
  removeSchedule,
  setScheduleEnabled,
  type ScheduleAdminDeps,
} from "./schedule-admin.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of SCHEDULES_MIGRATIONS as Migration[]) registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function makeDeps(now: number = Date.parse("2026-05-17T12:00:00Z")): ScheduleAdminDeps {
  let counter = 0;
  return {
    schedules: createSchedulesStore({ db }),
    now: () => now,
    newId: () => `id-${++counter}`,
  };
}

const wfExists = (id: string) => id === "wf-1" || id === "wf-2";

// ── addSchedule ───────────────────────────────────────────────────────────

describe("addSchedule", () => {
  it("creates a schedule and computes nextRunAt", () => {
    const deps = makeDeps();
    const r = addSchedule(
      deps,
      { workflowId: "wf-1", cronExpr: "0 0 * * *" },
      wfExists,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.scheduleId).toBe("id-1");
    expect(r.nextRunAt).toBeGreaterThan(0);
    const stored = deps.schedules.get("id-1")!;
    expect(stored.workflowId).toBe("wf-1");
    expect(stored.cronExpr).toBe("0 0 * * *");
    expect(stored.timezone).toBe("UTC");
    expect(stored.enabled).toBe(true);
    expect(stored.maxOverlap).toBe(0);
  });

  it("uses provided name when given (else falls back to workflowId)", () => {
    const deps = makeDeps();
    addSchedule(
      deps,
      { workflowId: "wf-1", name: "nightly-cron", cronExpr: "0 0 * * *" },
      wfExists,
    );
    expect(deps.schedules.get("id-1")!.name).toBe("nightly-cron");
  });

  it("returns workflow_not_found when the workflow doesn't exist", () => {
    const deps = makeDeps();
    const r = addSchedule(
      deps,
      { workflowId: "ghost", cronExpr: "0 0 * * *" },
      wfExists,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("workflow_not_found");
  });

  it("returns schedule_name_exists when the name is taken", () => {
    const deps = makeDeps();
    addSchedule(deps, { workflowId: "wf-1", name: "dup", cronExpr: "0 0 * * *" }, wfExists);
    const r = addSchedule(
      deps,
      { workflowId: "wf-2", name: "dup", cronExpr: "0 0 * * *" },
      wfExists,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("schedule_name_exists");
  });

  it("returns invalid_cron when the expression is malformed", () => {
    const deps = makeDeps();
    const r = addSchedule(
      deps,
      { workflowId: "wf-1", cronExpr: "bad expr" },
      wfExists,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("invalid_cron");
  });

  it("forwards timezone, variables, maxOverlap when provided", () => {
    const deps = makeDeps();
    addSchedule(
      deps,
      {
        workflowId: "wf-1",
        name: "S",
        cronExpr: "0 0 * * *",
        timezone: "America/New_York",
        variables: { x: "1" },
        maxOverlap: 3,
      },
      wfExists,
    );
    const s = deps.schedules.get("id-1")!;
    expect(s.timezone).toBe("America/New_York");
    expect(s.variables).toEqual({ x: "1" });
    expect(s.maxOverlap).toBe(3);
  });

  it("uses Date.now + randomUUID when no clock/id injected", () => {
    const deps: ScheduleAdminDeps = {
      schedules: createSchedulesStore({ db }),
    };
    const before = Date.now();
    const r = addSchedule(
      deps,
      { workflowId: "wf-1", cronExpr: "0 0 * * *" },
      wfExists,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.scheduleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(deps.schedules.get(r.scheduleId)!.createdAt).toBeGreaterThanOrEqual(
      before,
    );
  });
});

// ── removeSchedule ────────────────────────────────────────────────────────

describe("removeSchedule", () => {
  it("removes by id", () => {
    const deps = makeDeps();
    addSchedule(deps, { workflowId: "wf-1", cronExpr: "0 0 * * *" }, wfExists);
    const r = removeSchedule(deps, "id-1");
    expect(r).toEqual({ ok: true, removed: "wf-1" });
    expect(deps.schedules.get("id-1")).toBeUndefined();
  });

  it("removes by name", () => {
    const deps = makeDeps();
    addSchedule(
      deps,
      { workflowId: "wf-1", name: "nightly", cronExpr: "0 0 * * *" },
      wfExists,
    );
    const r = removeSchedule(deps, "nightly");
    expect(r).toEqual({ ok: true, removed: "nightly" });
  });

  it("returns schedule_not_found for an unknown id/name", () => {
    const deps = makeDeps();
    const r = removeSchedule(deps, "ghost");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("schedule_not_found");
  });
});

// ── setScheduleEnabled ────────────────────────────────────────────────────

describe("setScheduleEnabled", () => {
  it("disables a schedule and preserves nextRunAt", () => {
    const deps = makeDeps();
    addSchedule(deps, { workflowId: "wf-1", cronExpr: "0 0 * * *" }, wfExists);
    const original = deps.schedules.get("id-1")!.nextRunAt;
    const r = setScheduleEnabled(deps, "id-1", false);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.enabled).toBe(false);
    expect(deps.schedules.get("id-1")!.enabled).toBe(false);
    expect(deps.schedules.get("id-1")!.nextRunAt).toBe(original);
  });

  it("recomputes nextRunAt on re-enable", () => {
    const deps = makeDeps();
    addSchedule(deps, { workflowId: "wf-1", cronExpr: "0 0 * * *" }, wfExists);
    setScheduleEnabled(deps, "id-1", false);
    const r = setScheduleEnabled(deps, "id-1", true);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.enabled).toBe(true);
    expect(r.nextRunAt).toBeGreaterThan(0);
  });

  it("accepts a name lookup as well as id", () => {
    const deps = makeDeps();
    addSchedule(
      deps,
      { workflowId: "wf-1", name: "by-name", cronExpr: "0 0 * * *" },
      wfExists,
    );
    const r = setScheduleEnabled(deps, "by-name", false);
    expect(r.ok).toBe(true);
  });

  it("returns schedule_not_found for an unknown id/name", () => {
    const deps = makeDeps();
    const r = setScheduleEnabled(deps, "ghost", true);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("schedule_not_found");
  });

  it("returns invalid_cron when the stored cron has become unparseable on re-enable", () => {
    const deps = makeDeps();
    addSchedule(deps, { workflowId: "wf-1", cronExpr: "0 0 * * *" }, wfExists);
    // Corrupt the stored cron expression via a direct update.
    const s = deps.schedules.get("id-1")!;
    deps.schedules.update({ ...s, cronExpr: "garbage" });
    const r = setScheduleEnabled(deps, "id-1", true);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errorCode).toBe("invalid_cron");
  });

  it("uses Date.now when no clock injected", () => {
    const deps: ScheduleAdminDeps = {
      schedules: createSchedulesStore({ db }),
    };
    addSchedule(deps, { workflowId: "wf-1", cronExpr: "0 0 * * *" }, wfExists);
    const before = Date.now();
    setScheduleEnabled(
      deps,
      deps.schedules.listAll()[0]!.id,
      false,
    );
    expect(deps.schedules.listAll()[0]!.updatedAt).toBeGreaterThanOrEqual(
      before,
    );
  });
});

// ── formatSchedulesList ───────────────────────────────────────────────────

describe("formatSchedulesList", () => {
  it("returns 'No schedules configured.' for an empty list", () => {
    expect(formatSchedulesList([])).toBe("No schedules configured.");
  });

  it("renders a markdown list with status, cron, next/last, workflow", () => {
    const sched: ScheduleRecord = {
      id: "s1",
      workflowId: "wf-x",
      name: "S",
      cronExpr: "0 0 * * *",
      timezone: "UTC",
      variables: {},
      enabled: true,
      nextRunAt: 1000,
      maxOverlap: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const out = formatSchedulesList([sched]);
    expect(out).toContain("## Schedules");
    expect(out).toContain("**S** [enabled]");
    expect(out).toContain("cron: `0 0 * * *`");
    expect(out).toContain("workflow: wf-x");
    expect(out).toContain("last: never");
  });

  it("renders 'disabled' status and lastRunAt timestamp when present", () => {
    const sched: ScheduleRecord = {
      id: "s1",
      workflowId: "wf-x",
      name: "S",
      cronExpr: "0 0 * * *",
      timezone: "UTC",
      variables: {},
      enabled: false,
      nextRunAt: 1000,
      lastRunAt: 500,
      lastStatus: "completed",
      maxOverlap: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const out = formatSchedulesList([sched]);
    expect(out).toContain("[disabled]");
    expect(out).toContain("(completed)");
    expect(out).toContain(new Date(500).toISOString());
  });
});
