import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync: Database } = require("node:sqlite") as typeof import("node:sqlite");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSystemStatus,
  checkDbTables,
  checkCronJobs,
  checkFile,
  checkSkill,
  computeOverallHealth,
  detectDrift,
  resolveHomePath,
} from "./drift-status.js";

let tmpDir: string;
let tmpDb: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-status-test-"));
  tmpDb = path.join(tmpDir, "dashboard.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveHomePath", () => {
  it("expands a leading ~/ to the provided home directory", () => {
    expect(resolveHomePath("~/foo/bar", "/home/u")).toBe("/home/u/foo/bar");
  });

  it("expands a leading ~\\ (windows-style) to the home directory", () => {
    expect(resolveHomePath("~\\foo\\bar", "/home/u")).toBe("/home/u/foo\\bar");
  });

  it("returns an absolute path unchanged", () => {
    expect(resolveHomePath("/abs/path", "/home/u")).toBe("/abs/path");
  });

  it("returns a relative path unchanged", () => {
    expect(resolveHomePath("relative/path", "/home/u")).toBe("relative/path");
  });

  it("does not expand a path that only contains ~ (without separator)", () => {
    expect(resolveHomePath("~tilde-prefix", "/home/u")).toBe("~tilde-prefix");
  });
});

describe("checkFile", () => {
  it("reports exists=true and a lastModified ISO timestamp for an existing file", () => {
    const f = path.join(tmpDir, "hello.txt");
    fs.writeFileSync(f, "hi");
    const result = checkFile(f);
    expect(result.exists).toBe(true);
    expect(result.name).toBe("hello.txt");
    expect(result.path).toBe(f);
    expect(result.lastModified).toBeTruthy();
    expect(new Date(result.lastModified!).toString()).not.toBe("Invalid Date");
  });

  it("reports exists=false and lastModified=null for a missing file", () => {
    const f = path.join(tmpDir, "nope.txt");
    const result = checkFile(f);
    expect(result.exists).toBe(false);
    expect(result.lastModified).toBeNull();
  });

  it("handles stat errors gracefully (lastModified=null when stat throws)", () => {
    // Force the rare existsSync=true / statSync=throws race by mocking
    // statSync. Tests the catch branch in checkFile.
    const f = path.join(tmpDir, "racy.txt");
    fs.writeFileSync(f, "hi");
    const spy = vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
      throw new Error("simulated stat failure");
    });
    try {
      const result = checkFile(f);
      expect(result.exists).toBe(true);
      expect(result.lastModified).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("checkSkill", () => {
  it("expands ~ paths via the provided home before checking", () => {
    const sub = path.join(tmpDir, "skill-dir");
    fs.mkdirSync(sub);
    const result = checkSkill(
      { name: "Test", location: "~/skill-dir", role: "tester" },
      tmpDir,
    );
    expect(result.exists).toBe(true);
    expect(result.name).toBe("Test");
    expect(result.path).toBe("~/skill-dir");
    expect(result.role).toBe("tester");
  });

  it("reports exists=false when the resolved path is missing", () => {
    const result = checkSkill(
      { name: "Gone", location: path.join(tmpDir, "missing"), role: "ghost" },
      tmpDir,
    );
    expect(result.exists).toBe(false);
  });
});

describe("checkCronJobs", () => {
  function seedCronRunsDb(rows: Array<{ cron_name: string; date: string; status: string }>): void {
    const db = new Database(tmpDb);
    db.exec(`
      CREATE TABLE cron_runs (
        cron_name TEXT,
        date TEXT,
        scheduled_time TEXT,
        status TEXT
      );
    `);
    const insert = db.prepare(
      "INSERT INTO cron_runs (cron_name, date, scheduled_time, status) VALUES (?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(r.cron_name, r.date, "12:00:00", r.status);
    }
    db.close();
  }

  it("returns empty array for empty input", () => {
    expect(checkCronJobs([], tmpDb)).toEqual([]);
  });

  it("returns null/0 stats when the DB file is missing", () => {
    const result = checkCronJobs(["any-job"], path.join(tmpDir, "no.db"));
    expect(result).toEqual([
      {
        name: "any-job",
        lastRun: null,
        lastSuccess: null,
        recentSuccessRate: null,
        totalRuns: 0,
      },
    ]);
  });

  it("returns null/0 when the job has no rows in the last 7 days", () => {
    seedCronRunsDb([]);
    const result = checkCronJobs(["my-job"], tmpDb);
    expect(result[0]).toMatchObject({
      name: "my-job",
      lastRun: null,
      totalRuns: 0,
    });
  });

  it("computes recent success rate (rounded to int) across recent rows", () => {
    const today = new Date().toISOString().slice(0, 10);
    seedCronRunsDb([
      { cron_name: "j", date: today, status: "success" },
      { cron_name: "j", date: today, status: "success" },
      { cron_name: "j", date: today, status: "success" },
      { cron_name: "j", date: today, status: "failure" },
    ]);
    const result = checkCronJobs(["j"], tmpDb);
    expect(result[0]).toMatchObject({
      name: "j",
      totalRuns: 4,
      recentSuccessRate: 75,
    });
  });

  it("ignores 'skipped' rows", () => {
    const today = new Date().toISOString().slice(0, 10);
    seedCronRunsDb([
      { cron_name: "j", date: today, status: "success" },
      { cron_name: "j", date: today, status: "skipped" },
      { cron_name: "j", date: today, status: "skipped" },
    ]);
    const result = checkCronJobs(["j"], tmpDb);
    expect(result[0]?.totalRuns).toBe(1);
    expect(result[0]?.recentSuccessRate).toBe(100);
  });

  it("marks lastSuccess=false when the most recent run failed", () => {
    const today = new Date().toISOString().slice(0, 10);
    seedCronRunsDb([
      { cron_name: "j", date: today, status: "failure" },
      { cron_name: "j", date: today, status: "success" },
    ]);
    const result = checkCronJobs(["j"], tmpDb);
    expect(result[0]?.lastSuccess).toBe(false);
  });

  it("caps results at 14 rows", () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = Array.from({ length: 20 }, () => ({
      cron_name: "j",
      date: today,
      status: "success",
    }));
    seedCronRunsDb(rows);
    const result = checkCronJobs(["j"], tmpDb);
    expect(result[0]?.totalRuns).toBe(14);
  });

  it("returns degraded results when the DB exists but is corrupt", () => {
    fs.writeFileSync(tmpDb, "not a sqlite file");
    const result = checkCronJobs(["x"], tmpDb);
    expect(result).toEqual([
      { name: "x", lastRun: null, lastSuccess: null, recentSuccessRate: null, totalRuns: 0 },
    ]);
  });
});

describe("checkDbTables", () => {
  function seedDb(): void {
    const db = new Database(tmpDb);
    db.exec(`
      CREATE TABLE has_date (id INTEGER, date TEXT);
      CREATE TABLE has_created_at (id INTEGER, created_at TEXT);
      CREATE TABLE has_neither (id INTEGER, label TEXT);
      INSERT INTO has_date VALUES (1, '2026-05-01'), (2, '2026-05-02');
      INSERT INTO has_created_at VALUES (1, '2026-05-10');
      INSERT INTO has_neither VALUES (1, 'x');
    `);
    db.close();
  }

  it("returns empty array for empty input", () => {
    expect(checkDbTables([], tmpDb)).toEqual([]);
  });

  it("reports missing tables with rowCount=0", () => {
    seedDb();
    const result = checkDbTables(["never_existed"], tmpDb);
    expect(result[0]).toEqual({
      name: "never_existed",
      exists: false,
      rowCount: 0,
      lastEntry: null,
    });
  });

  it("returns rowCount and lastEntry from `date` column when present", () => {
    seedDb();
    const result = checkDbTables(["has_date"], tmpDb);
    expect(result[0]).toMatchObject({
      name: "has_date",
      exists: true,
      rowCount: 2,
      lastEntry: "2026-05-02",
    });
  });

  it("falls back to `created_at` column when `date` is absent", () => {
    seedDb();
    const result = checkDbTables(["has_created_at"], tmpDb);
    expect(result[0]).toMatchObject({
      exists: true,
      rowCount: 1,
      lastEntry: "2026-05-10",
    });
  });

  it("returns lastEntry=null when the table has neither `date` nor `created_at`", () => {
    seedDb();
    const result = checkDbTables(["has_neither"], tmpDb);
    expect(result[0]).toMatchObject({
      exists: true,
      rowCount: 1,
      lastEntry: null,
    });
  });

  it("returns lastEntry=null for an empty `date`-column table (r is undefined)", () => {
    const db = new Database(tmpDb);
    db.exec("CREATE TABLE empty_date (id INTEGER, date TEXT);");
    db.close();
    const result = checkDbTables(["empty_date"], tmpDb);
    expect(result[0]).toMatchObject({
      exists: true,
      rowCount: 0,
      lastEntry: null,
    });
  });

  it("returns lastEntry=null for an empty `created_at`-column table (r is undefined)", () => {
    const db = new Database(tmpDb);
    db.exec("CREATE TABLE empty_ca (id INTEGER, created_at TEXT);");
    db.close();
    const result = checkDbTables(["empty_ca"], tmpDb);
    expect(result[0]).toMatchObject({
      exists: true,
      rowCount: 0,
      lastEntry: null,
    });
  });

  it("returns degraded result when the DB file is missing", () => {
    const result = checkDbTables(["any"], path.join(tmpDir, "no.db"));
    expect(result[0]).toEqual({
      name: "any",
      exists: false,
      rowCount: 0,
      lastEntry: null,
    });
  });

  it("returns degraded result when the DB exists but is corrupt", () => {
    fs.writeFileSync(tmpDb, "garbage");
    const result = checkDbTables(["any"], tmpDb);
    expect(result[0]).toEqual({
      name: "any",
      exists: false,
      rowCount: 0,
      lastEntry: null,
    });
  });
});

describe("detectDrift", () => {
  it("returns empty array when everything is healthy", () => {
    const drift = detectDrift({
      skills: [{ name: "ok", path: "x", exists: true, role: "" }],
      files: [{ name: "f", path: "y", exists: true, lastModified: null }],
      cronJobs: [
        {
          name: "c",
          lastRun: "2026-05-15",
          lastSuccess: true,
          recentSuccessRate: 100,
          totalRuns: 5,
        },
      ],
      dbTables: [{ name: "t", exists: true, rowCount: 10, lastEntry: null }],
    });
    expect(drift).toEqual([]);
  });

  it("flags a missing skill as error", () => {
    const drift = detectDrift({
      skills: [{ name: "lost", path: "p", exists: false, role: "" }],
      files: [],
      cronJobs: [],
      dbTables: [],
    });
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ type: "missing_skill", severity: "error" });
  });

  it("flags a missing file as warning", () => {
    const drift = detectDrift({
      skills: [],
      files: [{ name: "f", path: "p", exists: false, lastModified: null }],
      cronJobs: [],
      dbTables: [],
    });
    expect(drift[0]).toMatchObject({ type: "missing_file", severity: "warning" });
  });

  it("flags a cron with zero runs as warning (no_recent_data)", () => {
    const drift = detectDrift({
      skills: [],
      files: [],
      cronJobs: [
        { name: "c", lastRun: null, lastSuccess: null, recentSuccessRate: null, totalRuns: 0 },
      ],
      dbTables: [],
    });
    expect(drift[0]).toMatchObject({ type: "no_recent_data", severity: "warning" });
  });

  it("flags a cron whose last run failed as error", () => {
    const drift = detectDrift({
      skills: [],
      files: [],
      cronJobs: [
        { name: "c", lastRun: "x", lastSuccess: false, recentSuccessRate: 0, totalRuns: 3 },
      ],
      dbTables: [],
    });
    expect(drift[0]).toMatchObject({ type: "cron_failing", severity: "error" });
  });

  it("flags low recent success rate (<80%) as warning when last run did succeed", () => {
    const drift = detectDrift({
      skills: [],
      files: [],
      cronJobs: [
        { name: "c", lastRun: "x", lastSuccess: true, recentSuccessRate: 60, totalRuns: 5 },
      ],
      dbTables: [],
    });
    expect(drift[0]).toMatchObject({ type: "cron_failing", severity: "warning" });
    expect(drift[0]?.message).toContain("60%");
    expect(drift[0]?.message).toContain("3/5");
  });

  it("does not flag a cron with success rate >= 80% and lastSuccess=true", () => {
    const drift = detectDrift({
      skills: [],
      files: [],
      cronJobs: [
        { name: "c", lastRun: "x", lastSuccess: true, recentSuccessRate: 80, totalRuns: 5 },
      ],
      dbTables: [],
    });
    expect(drift).toEqual([]);
  });

  it("does not warn on low rate when recentSuccessRate is null", () => {
    const drift = detectDrift({
      skills: [],
      files: [],
      cronJobs: [
        { name: "c", lastRun: "x", lastSuccess: true, recentSuccessRate: null, totalRuns: 1 },
      ],
      dbTables: [],
    });
    expect(drift).toEqual([]);
  });

  it("flags a missing DB table as error", () => {
    const drift = detectDrift({
      skills: [],
      files: [],
      cronJobs: [],
      dbTables: [{ name: "t", exists: false, rowCount: 0, lastEntry: null }],
    });
    expect(drift[0]).toMatchObject({ type: "missing_table", severity: "error" });
  });

  it("flags an empty DB table as warning", () => {
    const drift = detectDrift({
      skills: [],
      files: [],
      cronJobs: [],
      dbTables: [{ name: "t", exists: true, rowCount: 0, lastEntry: null }],
    });
    expect(drift[0]).toMatchObject({ type: "empty_table", severity: "warning" });
  });
});

describe("computeOverallHealth", () => {
  it("returns 'healthy' when there are no drift issues", () => {
    expect(computeOverallHealth([])).toBe("healthy");
  });

  it("returns 'degraded' when only warnings are present", () => {
    expect(
      computeOverallHealth([{ type: "x", severity: "warning", message: "" }]),
    ).toBe("degraded");
  });

  it("returns 'unhealthy' when any error is present", () => {
    expect(
      computeOverallHealth([
        { type: "x", severity: "warning", message: "" },
        { type: "y", severity: "error", message: "" },
      ]),
    ).toBe("unhealthy");
  });

  it("treats 'info' severity as not affecting health", () => {
    expect(
      computeOverallHealth([{ type: "x", severity: "info", message: "" }]),
    ).toBe("healthy");
  });
});

describe("buildSystemStatus (integration)", () => {
  it("composes a SystemStatus from supplied check inputs", () => {
    const result = buildSystemStatus({
      config: {
        skills: [{ name: "S", location: path.join(tmpDir, "s"), role: "" }],
        liveChecks: { cronJobs: [], files: [], dbTables: [] },
      },
      homeDir: tmpDir,
      dbPath: tmpDb,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    expect(result.checkedAt).toBe("2026-05-15T12:00:00.000Z");
    // skill path doesn't exist → drift error → unhealthy
    expect(result.overallHealth).toBe("unhealthy");
    expect(result.skills).toHaveLength(1);
    expect(result.drift.length).toBeGreaterThan(0);
  });

  it("returns healthy with no drift when everything exists", () => {
    const skillPath = path.join(tmpDir, "skill-ok");
    fs.mkdirSync(skillPath);
    const result = buildSystemStatus({
      config: {
        skills: [{ name: "S", location: skillPath, role: "" }],
        liveChecks: { cronJobs: [], files: [], dbTables: [] },
      },
      homeDir: tmpDir,
      dbPath: tmpDb,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    expect(result.overallHealth).toBe("healthy");
    expect(result.drift).toEqual([]);
  });

  it("defaults `now` to real time when caller omits it", () => {
    const before = Date.now();
    const result = buildSystemStatus({
      config: { skills: [], liveChecks: {} },
      homeDir: tmpDir,
      dbPath: tmpDb,
    });
    const after = Date.now();
    const checkedAt = new Date(result.checkedAt).getTime();
    expect(checkedAt).toBeGreaterThanOrEqual(before);
    expect(checkedAt).toBeLessThanOrEqual(after);
  });

  it("handles liveChecks with all arrays undefined (uses empty defaults)", () => {
    const result = buildSystemStatus({
      config: { skills: [], liveChecks: {} },
      homeDir: tmpDir,
      dbPath: tmpDb,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    expect(result.files).toEqual([]);
    expect(result.cronJobs).toEqual([]);
    expect(result.dbTables).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.overallHealth).toBe("healthy");
  });
});
