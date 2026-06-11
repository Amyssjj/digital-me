import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  AGENTS_MIGRATIONS,
  GOALS_MIGRATIONS,
  LEARNINGS_MIGRATIONS,
  SCHEDULES_MIGRATIONS,
  TASKS_MIGRATIONS,
  TRACES_MIGRATIONS,
  WORKFLOWS_MIGRATIONS,
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
  type Migration,
} from "@digital-me/brain-orchestrator";
import {
  TABLE_PLAN,
  buildInsert,
  buildSelect,
  formatReport,
  migrateBrainDb,
} from "./migrate.js";

let source: DatabaseSync;
let target: DatabaseSync;

beforeEach(() => {
  source = new DatabaseSync(":memory:");
  target = new DatabaseSync(":memory:");
  // Build target with the canonical brain-orchestrator schema.
  resetMigrationRegistryForTests();
  for (const m of [
    ...GOALS_MIGRATIONS,
    ...TASKS_MIGRATIONS,
    ...WORKFLOWS_MIGRATIONS,
    ...SCHEDULES_MIGRATIONS,
    ...AGENTS_MIGRATIONS,
    ...LEARNINGS_MIGRATIONS,
    ...TRACES_MIGRATIONS,
  ] as Migration[]) {
    registerMigration(m);
  }
  runMigrations(target);
  // Build source with the SAME schema (upstream and brain-orchestrator
  // are schema-compatible). We re-use the migrations because they're
  // identical to upstream's `addColumnIfMissing` output by design.
  resetMigrationRegistryForTests();
  for (const m of [
    ...GOALS_MIGRATIONS,
    ...TASKS_MIGRATIONS,
    ...WORKFLOWS_MIGRATIONS,
    ...SCHEDULES_MIGRATIONS,
    ...AGENTS_MIGRATIONS,
    ...LEARNINGS_MIGRATIONS,
    ...TRACES_MIGRATIONS,
  ] as Migration[]) {
    registerMigration(m);
  }
  runMigrations(source);
});

afterEach(() => {
  source.close();
  target.close();
  resetMigrationRegistryForTests();
});

function seedGoal(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO goals (id, name, description, type, status,
      created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `Goal ${id}`, "desc", "project", "running", 1000, 1000, "t");
}

function seedTask(db: DatabaseSync, id: string, goalId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, goal_id, name, task, blocked_by, dispatch,
      status, attempt_count, priority, on_upstream_failure)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    goalId,
    `T ${id}`,
    "do x",
    "[]",
    '{"mode":"manual"}',
    "pending",
    0,
    "normal",
    "wait",
  );
}

// ── TABLE_PLAN ────────────────────────────────────────────────────────────

describe("TABLE_PLAN", () => {
  it("lists all 9 canonical brain tables in foreign-key-safe order", () => {
    const names = TABLE_PLAN.map((t) => t.name);
    expect(names).toEqual([
      "goals",
      "tasks",
      "attempts",
      "workflow_templates",
      "workflow_step_templates",
      "schedules",
      "brain_agents",
      "learnings",
      "traces",
    ]);
  });

  it("every table has a non-empty columns array", () => {
    for (const t of TABLE_PLAN) {
      expect(t.columns.length).toBeGreaterThan(0);
    }
  });
});

// ── buildSelect / buildInsert ──────────────────────────────────────────────

describe("buildSelect", () => {
  it("emits a SELECT with every requested column when source has them", () => {
    const cols = new Set(["a", "b", "c"]);
    const sql = buildSelect(cols, { name: "tbl", columns: ["a", "b", "c"] });
    expect(sql).toBe("SELECT a, b, c FROM tbl");
  });

  it("substitutes NULL AS <col> for columns missing from the source", () => {
    const cols = new Set(["a"]);
    const sql = buildSelect(cols, { name: "tbl", columns: ["a", "missing"] });
    expect(sql).toBe("SELECT a, NULL AS missing FROM tbl");
  });
});

describe("buildInsert", () => {
  it("emits INSERT OR IGNORE with positional placeholders", () => {
    const sql = buildInsert({ name: "tbl", columns: ["a", "b", "c"] });
    expect(sql).toBe("INSERT OR IGNORE INTO tbl (a, b, c) VALUES (?, ?, ?)");
  });
});

// ── migrateBrainDb (integration) ──────────────────────────────────────────

describe("migrateBrainDb", () => {
  it("copies a goal + task from source to target", () => {
    seedGoal(source, "g1");
    seedTask(source, "t1", "g1");
    const report = migrateBrainDb({ source, target });
    expect(report.totalInserted).toBe(2);
    expect(report.totalSkipped).toBe(0);
    expect(
      (target.prepare("SELECT id FROM goals").all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual(["g1"]);
    expect(
      (target.prepare("SELECT id FROM tasks").all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual(["t1"]);
  });

  it("is idempotent — re-running skips rows that already exist", () => {
    seedGoal(source, "g1");
    seedGoal(source, "g2");
    const first = migrateBrainDb({ source, target });
    expect(first.totalInserted).toBe(2);
    const second = migrateBrainDb({ source, target });
    expect(second.totalInserted).toBe(0);
    expect(second.totalSkipped).toBe(2);
  });

  it("reports per-table counts (sourceCount + inserted + skipped)", () => {
    seedGoal(source, "g1");
    seedGoal(source, "g2");
    seedTask(source, "t1", "g1");
    const r = migrateBrainDb({ source, target });
    const goalRow = r.tables.find((t) => t.table === "goals")!;
    expect(goalRow.sourceCount).toBe(2);
    expect(goalRow.inserted).toBe(2);
    const taskRow = r.tables.find((t) => t.table === "tasks")!;
    expect(taskRow.sourceCount).toBe(1);
  });

  it("handles a source missing a table (drops it cleanly with zero counts)", () => {
    source.exec("DROP TABLE traces");
    seedGoal(source, "g1");
    const r = migrateBrainDb({ source, target });
    const traces = r.tables.find((t) => t.table === "traces")!;
    expect(traces.sourceCount).toBe(0);
    expect(traces.inserted).toBe(0);
    const goals = r.tables.find((t) => t.table === "goals")!;
    expect(goals.inserted).toBe(1);
  });

  it("preserves JSON columns verbatim (no re-encoding)", () => {
    seedGoal(source, "g1");
    source
      .prepare(
        `UPDATE goals SET branching_policy = ? WHERE id = ?`,
      )
      .run('{"repoPath":"/r","baseBranch":"main"}', "g1");
    migrateBrainDb({ source, target });
    const row = target
      .prepare(`SELECT branching_policy FROM goals WHERE id = 'g1'`)
      .get() as { branching_policy: string };
    expect(JSON.parse(row.branching_policy)).toEqual({
      repoPath: "/r",
      baseBranch: "main",
    });
  });

  it("copies workflow_templates + workflow_step_templates with FK relationship preserved", () => {
    source
      .prepare(
        `INSERT INTO workflow_templates (id, name, description, variables,
          created_at, updated_at, version, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("wf1", "WF1", "", "[]", 0, 0, 1, "[]");
    source
      .prepare(
        `INSERT INTO workflow_step_templates (id, workflow_id, step_key, name,
          prompt_template, blocked_by_keys, dispatch, priority, on_upstream_failure,
          sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("s1", "wf1", "k1", "Step 1", "p", "[]", '{"mode":"manual"}', "normal", "wait", 0);
    migrateBrainDb({ source, target });
    const steps = target
      .prepare("SELECT id, workflow_id FROM workflow_step_templates")
      .all() as Array<{ id: string; workflow_id: string }>;
    expect(steps).toEqual([{ id: "s1", workflow_id: "wf1" }]);
  });

  it("rolls back the per-table transaction when an INSERT throws", () => {
    seedGoal(source, "g1");
    seedGoal(source, "g2");
    // Pre-insert g1 with corrupted data so the migrator's INSERT OR IGNORE
    // still succeeds — but force a different failure: monkey-patch the
    // target's prepare to throw on the second insert.
    const origPrepare = target.prepare.bind(target);
    let goalsRunCount = 0;
    target.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.startsWith("INSERT OR IGNORE INTO goals")) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = ((...args: unknown[]) => {
          goalsRunCount++;
          if (goalsRunCount === 2) throw new Error("synthetic insert failure");
          return origRun(...(args as [])) as ReturnType<typeof origRun>;
        }) as typeof stmt.run;
      }
      return stmt;
    }) as typeof target.prepare;
    expect(() => migrateBrainDb({ source, target })).toThrow(/synthetic/);
    // Rollback should have undone the first INSERT.
    const count = (target.prepare("SELECT COUNT(*) as c FROM goals").get() as {
      c: number;
    }).c;
    expect(count).toBe(0);
  });

  it("respects table order — goals before tasks so FK references resolve", () => {
    seedGoal(source, "g1");
    seedTask(source, "t1", "g1");
    const r = migrateBrainDb({ source, target });
    const goalsIdx = r.tables.findIndex((t) => t.table === "goals");
    const tasksIdx = r.tables.findIndex((t) => t.table === "tasks");
    expect(goalsIdx).toBeLessThan(tasksIdx);
  });
});

// ── formatReport ──────────────────────────────────────────────────────────

describe("formatReport", () => {
  it("renders one line per table + a totals line", () => {
    const out = formatReport({
      tables: [
        { table: "goals", sourceCount: 3, inserted: 2, skipped: 1 },
        { table: "tasks", sourceCount: 5, inserted: 5, skipped: 0 },
      ],
      totalInserted: 7,
      totalSkipped: 1,
    });
    expect(out).toContain("Migration report:");
    expect(out).toContain("goals");
    expect(out).toContain("source=    3");
    expect(out).toContain("inserted=    2");
    expect(out).toContain("Totals: inserted=7 skipped=1");
  });
});
