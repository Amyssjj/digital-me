import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
  type Migration,
} from "./migrations.js";
import { GOALS_MIGRATIONS } from "./goals.js";
import { TASKS_MIGRATIONS } from "./tasks.js";
import { WORKFLOWS_MIGRATIONS } from "./workflows.js";
import { SCHEDULES_MIGRATIONS } from "./schedules.js";
import { AGENTS_MIGRATIONS } from "./agents.js";
import { LEARNINGS_MIGRATIONS } from "./learnings.js";
import { TRACES_MIGRATIONS } from "./traces.js";
import { M1_EVENTS_MIGRATIONS } from "./m1-events.js";

let db: DatabaseSync;

beforeEach(() => {
  resetMigrationRegistryForTests();
  db = new DatabaseSync(":memory:");
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function getUserVersion(d: DatabaseSync): number {
  const row = d.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function setUserVersion(d: DatabaseSync, n: number): void {
  d.exec(`PRAGMA user_version = ${n}`);
}

describe("registerMigration / runMigrations", () => {
  it("starts with user_version=0 on a fresh DB", () => {
    expect(getUserVersion(db)).toBe(0);
  });

  it("runs every registered migration in version order against a fresh DB", () => {
    const order: number[] = [];
    registerMigration({
      version: 2,
      description: "v2",
      up: () => order.push(2),
    });
    registerMigration({
      version: 1,
      description: "v1",
      up: () => order.push(1),
    });
    runMigrations(db);
    expect(order).toEqual([1, 2]);
  });

  it("advances PRAGMA user_version to the highest applied migration", () => {
    registerMigration({ version: 1, description: "v1", up: () => {} });
    registerMigration({ version: 5, description: "v5", up: () => {} });
    runMigrations(db);
    expect(getUserVersion(db)).toBe(5);
  });

  it("skips migrations with version <= current user_version", () => {
    const ran: number[] = [];
    registerMigration({ version: 1, description: "v1", up: () => ran.push(1) });
    registerMigration({ version: 2, description: "v2", up: () => ran.push(2) });
    registerMigration({ version: 3, description: "v3", up: () => ran.push(3) });
    setUserVersion(db, 2);
    runMigrations(db);
    expect(ran).toEqual([3]);
    expect(getUserVersion(db)).toBe(3);
  });

  it("is a no-op when all migrations are already applied", () => {
    const ran: number[] = [];
    registerMigration({ version: 1, description: "v1", up: () => ran.push(1) });
    runMigrations(db);
    expect(ran).toEqual([1]);
    runMigrations(db);
    expect(ran).toEqual([1]); // still just one run
    expect(getUserVersion(db)).toBe(1);
  });

  it("creates the schema declared by each migration's up()", () => {
    registerMigration({
      version: 1,
      description: "create table",
      up: (d) => {
        d.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
      },
    });
    registerMigration({
      version: 2,
      description: "add column",
      up: (d) => {
        d.exec(`ALTER TABLE t ADD COLUMN extra TEXT`);
      },
    });
    runMigrations(db);
    db.prepare("INSERT INTO t (id, name, extra) VALUES (1, 'a', 'b')").run();
    const row = db.prepare("SELECT * FROM t WHERE id = 1").get() as Record<string, unknown>;
    expect(row).toEqual({ id: 1, name: "a", extra: "b" });
  });

  it("does NOT rerun an already-applied migration when its up() side-effects would be destructive", () => {
    // First run creates a table; second run would throw if attempted.
    registerMigration({
      version: 1,
      description: "create-only",
      up: (d) => d.exec(`CREATE TABLE t (id INT)`), // Not IF NOT EXISTS!
    });
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it("rejects duplicate version registrations at register time", () => {
    registerMigration({ version: 1, description: "first", up: () => {} });
    expect(() =>
      registerMigration({ version: 1, description: "second", up: () => {} }),
    ).toThrow(/duplicate.*version 1/i);
  });

  it("rejects non-positive version numbers", () => {
    expect(() =>
      registerMigration({ version: 0, description: "zero", up: () => {} }),
    ).toThrow(/positive integer/i);
    expect(() =>
      registerMigration({ version: -1, description: "neg", up: () => {} }),
    ).toThrow(/positive integer/i);
    expect(() =>
      registerMigration({
        version: 1.5,
        description: "frac",
        up: () => {},
      }),
    ).toThrow(/positive integer/i);
  });

  it("rolls back via PRAGMA when an up() throws so the DB stays on the prior version", () => {
    let ran = 0;
    registerMigration({
      version: 1,
      description: "ok",
      up: () => {
        ran++;
      },
    });
    registerMigration({
      version: 2,
      description: "boom",
      up: () => {
        throw new Error("boom");
      },
    });
    expect(() => runMigrations(db)).toThrow("boom");
    // v1 should have applied successfully; v2 failed.
    expect(getUserVersion(db)).toBe(1);
    expect(ran).toBe(1);
  });

  it("each migration runs once even across multiple runMigrations() calls", () => {
    let ran = 0;
    registerMigration({
      version: 1,
      description: "counted",
      up: () => {
        ran++;
      },
    });
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);
    expect(ran).toBe(1);
  });
});

describe("resetMigrationRegistryForTests", () => {
  it("clears all registered migrations so isolated tests start fresh", () => {
    registerMigration({ version: 1, description: "x", up: () => {} });
    resetMigrationRegistryForTests();
    // Re-registering the same version should succeed (no duplicate detected).
    expect(() =>
      registerMigration({ version: 1, description: "x", up: () => {} }),
    ).not.toThrow();
  });
});

describe("Migration type contract", () => {
  it("Migration objects are plain data — no hidden state", () => {
    const m: Migration = { version: 1, description: "test", up: () => {} };
    expect(m.version).toBe(1);
    expect(m.description).toBe("test");
    expect(typeof m.up).toBe("function");
  });
});


// ── upgrade-path invariant ───────────────────────────────────────────────────
//
// `runMigrations` keeps ONE global `PRAGMA user_version` and skips anything
// `<= current`. A migration numbered inside its store's block (e.g. 301 for
// workflows) therefore never runs on a DB already advanced past it by another
// store (e.g. 711 from traces) — while the code that depends on its columns
// ships anyway. Fresh installs pass because they replay from 0, so only an
// upgrade reproduces it. These tests encode the invariant.

describe("upgrade path", () => {
  function allMigrations() {
    resetMigrationRegistryForTests();
    const all = [
      ...GOALS_MIGRATIONS,
      ...TASKS_MIGRATIONS,
      ...WORKFLOWS_MIGRATIONS,
      ...SCHEDULES_MIGRATIONS,
      ...AGENTS_MIGRATIONS,
      ...LEARNINGS_MIGRATIONS,
      ...TRACES_MIGRATIONS,
      ...M1_EVENTS_MIGRATIONS,
    ] as Migration[];
    for (const m of all) registerMigration(m);
    return all;
  }

  function schemaOf(database: DatabaseSync): string {
    const rows = database
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
      )
      .all() as { sql: string }[];
    return rows.map((r) => r.sql).join("\n");
  }

  it("every migration version is unique", () => {
    const versions = allMigrations().map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  // Every migration ever shipped, in the order it was ADDED — newest last.
  // `runMigrations` keeps ONE global `PRAGMA user_version` and skips
  // `m.version <= current`, so each new migration must outrank every earlier
  // one. Per-store numeric blocks (100s goals, 300s workflows…) actively work
  // against that: workflow provenance was numbered 301, sorted under the
  // already-applied 711 from traces, and was skipped forever on every existing
  // DB — while the store code depending on its columns shipped anyway, so
  // register() threw and the whole plugin died on upgrade. Fresh installs
  // replay from 0 and were fine, which is why nothing caught it.
  //
  // Adding a migration? Append its version here. If that number isn't larger
  // than the last entry, it will not run on anyone's existing database.
  const MIGRATION_SHIP_ORDER = [100, 200, 300, 400, 500, 600, 700, 710, 711, 800];

  it("each shipped migration outranks every earlier one", () => {
    for (let i = 1; i < MIGRATION_SHIP_ORDER.length; i++) {
      expect(
        MIGRATION_SHIP_ORDER[i]!,
        `migration ${MIGRATION_SHIP_ORDER[i]} ships after ${MIGRATION_SHIP_ORDER[i - 1]} ` +
          "but does not outrank it — it will be skipped on every existing DB",
      ).toBeGreaterThan(MIGRATION_SHIP_ORDER[i - 1]!);
    }
  });

  it("no registered migration is missing from the ship order", () => {
    // Without this, a new migration could dodge the rule by never being listed.
    const registered = allMigrations().map((m) => m.version).sort((a, b) => a - b);
    expect(registered).toEqual([...MIGRATION_SHIP_ORDER].sort((a, b) => a - b));
  });

  it("a fresh install and the ship order agree on the final version", () => {
    allMigrations();
    const fresh = new DatabaseSync(":memory:");
    runMigrations(fresh);
    const row = fresh.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(Math.max(...MIGRATION_SHIP_ORDER));
    fresh.close();
  });
});
