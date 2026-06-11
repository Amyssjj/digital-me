import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
// Vite/vitest doesn't recognize experimental node:sqlite as a builtin
// (`module.builtinModules` excludes it); use createRequire so Node's loader
// resolves it at runtime instead of letting Vite try to bundle.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import { createCronTools, initCronSchema } from "./cron-runs.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initCronSchema(db);
});

afterEach(() => {
  db.close();
});

function seed(): void {
  const rows = [
    { date: "2026-05-13", cron_name: "wiki-distill", scheduled_time: "02:47", run_time: "02:47:01", status: "success", duration_ms: 1000, error: null },
    { date: "2026-05-13", cron_name: "wiki-distill", scheduled_time: "02:47", run_time: null, status: "skipped", duration_ms: null, error: null },
    { date: "2026-05-14", cron_name: "wiki-distill", scheduled_time: "02:47", run_time: "02:47:02", status: "success", duration_ms: 1200, error: null },
    { date: "2026-05-14", cron_name: "ops-health", scheduled_time: "08:00", run_time: "08:00:01", status: "failed", duration_ms: 300, error: "exec timeout" },
    { date: "2026-05-15", cron_name: "wiki-distill", scheduled_time: "02:47", run_time: null, status: "missed", duration_ms: null, error: null },
    { date: "2026-05-15", cron_name: "ops-health", scheduled_time: "08:00", run_time: "08:00:01", status: "success", duration_ms: 250, error: null },
  ];
  const insert = db.prepare(
    `INSERT INTO cron_runs (date, cron_name, scheduled_time, run_time, status, duration_ms, error)
     VALUES (@date, @cron_name, @scheduled_time, @run_time, @status, @duration_ms, @error)`,
  );
  for (const r of rows) insert.run(r);
}

describe("cron.history", () => {
  it("returns all runs by default in ascending date order", () => {
    seed();
    const tools = createCronTools({ db });
    const out = tools.history({});
    expect(out.runs).toHaveLength(6);
    expect(out.runs[0]!.date).toBe("2026-05-13");
    expect(out.runs[out.runs.length - 1]!.date).toBe("2026-05-15");
  });

  it("filters by cron_name", () => {
    seed();
    const tools = createCronTools({ db });
    const out = tools.history({ cron_name: "ops-health" });
    expect(out.runs).toHaveLength(2);
    expect(out.runs.every((r) => r.cron_name === "ops-health")).toBe(true);
  });

  it("filters by since (epoch ms)", () => {
    seed();
    const tools = createCronTools({ db });
    const since = new Date("2026-05-14T00:00:00Z").getTime();
    const out = tools.history({ since });
    expect(out.runs.every((r) => r.date >= "2026-05-14")).toBe(true);
  });

  it("filters by until", () => {
    seed();
    const tools = createCronTools({ db });
    const until = new Date("2026-05-13T23:59:59Z").getTime();
    const out = tools.history({ until });
    expect(out.runs.every((r) => r.date <= "2026-05-13")).toBe(true);
  });

  it("respects limit", () => {
    seed();
    const tools = createCronTools({ db });
    expect(tools.history({ limit: 2 }).runs).toHaveLength(2);
  });
});

describe("cron.summary", () => {
  it("aggregates per-day counts and success rate (excluding skipped)", () => {
    seed();
    const tools = createCronTools({ db });
    const out = tools.summary({});
    expect(out.points).toHaveLength(3);
    const may13 = out.points.find((p) => p.date === "2026-05-13")!;
    // 1 success + 1 skipped on 5/13 → success_rate over non-skipped = 100%
    expect(may13.total_scheduled).toBe(2);
    expect(may13.success_count).toBe(1);
    expect(may13.skipped_count).toBe(1);
    expect(may13.failed_count).toBe(0);
    expect(may13.missed_count).toBe(0);
    expect(may13.success_rate).toBe(100);
  });

  it("computes success_rate correctly for mixed success/failure days", () => {
    seed();
    const tools = createCronTools({ db });
    const may14 = tools.summary({}).points.find((p) => p.date === "2026-05-14")!;
    // wiki-distill success + ops-health failed → 1/2 = 50%
    expect(may14.success_count).toBe(1);
    expect(may14.failed_count).toBe(1);
    expect(may14.success_rate).toBe(50);
  });

  it("counts missed runs and treats them as non-success", () => {
    seed();
    const tools = createCronTools({ db });
    const may15 = tools.summary({}).points.find((p) => p.date === "2026-05-15")!;
    // wiki-distill missed + ops-health success → 1/2 = 50%
    expect(may15.missed_count).toBe(1);
    expect(may15.success_rate).toBe(50);
  });

  it("returns success_rate=100 when all rows are skipped", () => {
    db.prepare(
      `INSERT INTO cron_runs (date, cron_name, scheduled_time, status) VALUES (?,?,?,?)`,
    ).run("2026-05-20", "j", "12:00", "skipped");
    const tools = createCronTools({ db });
    const p = tools.summary({}).points.find((p) => p.date === "2026-05-20")!;
    expect(p.success_rate).toBe(100);
  });

  it("filters by since / until", () => {
    seed();
    const tools = createCronTools({ db });
    const since = new Date("2026-05-15T00:00:00Z").getTime();
    const out = tools.summary({ since });
    expect(out.points.map((p) => p.date)).toEqual(["2026-05-15"]);
  });

  it("returns empty points list when no rows exist", () => {
    const tools = createCronTools({ db });
    expect(tools.summary({}).points).toEqual([]);
  });
});

describe("cron.per_job_summary", () => {
  it("aggregates per-(date, cron_name) tuple", () => {
    seed();
    const tools = createCronTools({ db });
    const out = tools.perJobSummary({});
    expect(out.points.length).toBeGreaterThanOrEqual(4);
    const distill14 = out.points.find(
      (p) => p.date === "2026-05-14" && p.cron_name === "wiki-distill",
    )!;
    expect(distill14.success_count).toBe(1);
    expect(distill14.failed_count).toBe(0);
    expect(distill14.success_rate).toBe(100);

    const ops14 = out.points.find(
      (p) => p.date === "2026-05-14" && p.cron_name === "ops-health",
    )!;
    expect(ops14.success_count).toBe(0);
    expect(ops14.failed_count).toBe(1);
    expect(ops14.success_rate).toBe(0);
  });

  it("filters by since", () => {
    seed();
    const tools = createCronTools({ db });
    const since = new Date("2026-05-15T00:00:00Z").getTime();
    const out = tools.perJobSummary({ since });
    expect(out.points.every((p) => p.date === "2026-05-15")).toBe(true);
  });

  it("filters by until", () => {
    seed();
    const tools = createCronTools({ db });
    const until = new Date("2026-05-13T23:59:59Z").getTime();
    const out = tools.perJobSummary({ until });
    expect(out.points.every((p) => p.date === "2026-05-13")).toBe(true);
  });
});
