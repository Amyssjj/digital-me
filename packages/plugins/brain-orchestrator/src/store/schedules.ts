/**
 * Schedules store — port of upstream task-orchestrator/src/store.ts for
 * recurring workflow runs.
 *
 * A schedule is "fire workflow W with variables V on cron expression C in
 * timezone T". The scheduler watchdog scans `findDueSchedules(now)` for
 * rows whose `next_run_at <= now`, claims each via `claimSchedule` (a
 * conditional UPDATE that prevents two scanners from double-firing), then
 * runs the workflow.
 *
 * Open-source note: upstream had a hardcoded `'America/Los_Angeles'`
 * default timezone in the SQL DEFAULT clause. digital-me-os neutralizes
 * that to `'UTC'` — owner-specific timezone preferences belong in the
 * caller, not in the table schema.
 */

import type { DatabaseSync } from "node:sqlite";
import type { GoalStatus } from "./goals.js";
import type { Migration } from "./migrations.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type ScheduleRecord = {
  readonly id: string;
  readonly workflowId: string;
  readonly name: string;
  readonly cronExpr: string;
  readonly timezone: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  /** Pre-computed next-fire epoch-ms. The watchdog scans by this column. */
  readonly nextRunAt: number;
  readonly lastRunAt?: number;
  readonly lastGoalId?: string;
  readonly lastStatus?: GoalStatus;
  /** 0 = skip if a prior run is still active. Higher values cap concurrent runs. */
  readonly maxOverlap: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

// ── Schema migration ──────────────────────────────────────────────────────

const SCHEDULES_VERSION = 400;

export const SCHEDULES_MIGRATIONS: readonly Migration[] = [
  {
    version: SCHEDULES_VERSION,
    description: "v400: schedules table",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
          id           TEXT PRIMARY KEY,
          workflow_id  TEXT NOT NULL,
          name         TEXT NOT NULL,
          cron_expr    TEXT NOT NULL,
          timezone     TEXT NOT NULL DEFAULT 'UTC',
          variables    TEXT NOT NULL DEFAULT '{}',
          enabled      INTEGER NOT NULL DEFAULT 1,
          next_run_at  INTEGER NOT NULL,
          last_run_at  INTEGER,
          last_goal_id TEXT,
          last_status  TEXT,
          max_overlap  INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, next_run_at);
      `);
    },
  },
];

// ── Row mapping ────────────────────────────────────────────────────────────

type ScheduleRow = {
  id: string;
  workflow_id: string;
  name: string;
  cron_expr: string;
  timezone: string;
  variables: string;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
  last_goal_id: string | null;
  last_status: string | null;
  max_overlap: number;
  created_at: number;
  updated_at: number;
};

function jsonParseOr<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    name: row.name,
    cronExpr: row.cron_expr,
    timezone: row.timezone,
    variables: jsonParseOr<Record<string, string>>(row.variables, {}),
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at ?? undefined,
    lastGoalId: row.last_goal_id ?? undefined,
    lastStatus: (row.last_status as GoalStatus | null) ?? undefined,
    maxOverlap: row.max_overlap,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Public factory ─────────────────────────────────────────────────────────

export type SchedulesStore = {
  create(schedule: ScheduleRecord): void;
  get(id: string): ScheduleRecord | undefined;
  getByName(name: string): ScheduleRecord | undefined;
  listAll(): ScheduleRecord[];
  /** Enabled schedules whose `nextRunAt <= nowMs`. */
  findDue(nowMs: number): ScheduleRecord[];
  update(schedule: ScheduleRecord): void;
  /** Returns true if a row was deleted, false if id didn't exist. */
  delete(id: string): boolean;
  /**
   * Atomically advance `next_run_at` IF it still matches expectedNextRunAt.
   * Returns true if this caller won the claim; false if another scanner
   * already advanced it. Used to prevent double-dispatch.
   */
  claim(
    id: string,
    expectedNextRunAt: number,
    newNextRunAt: number,
    nowMs: number,
  ): boolean;
};

export function createSchedulesStore(deps: {
  db: DatabaseSync;
}): SchedulesStore {
  const { db } = deps;

  const insertStmt = db.prepare(`
    INSERT INTO schedules
      (id, workflow_id, name, cron_expr, timezone, variables, enabled,
       next_run_at, last_run_at, last_goal_id, last_status, max_overlap,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectById = db.prepare("SELECT * FROM schedules WHERE id = ?");
  const selectByName = db.prepare("SELECT * FROM schedules WHERE name = ?");
  const selectAll = db.prepare(
    "SELECT * FROM schedules ORDER BY name ASC",
  );
  const selectDue = db.prepare(
    "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ?",
  );
  const updateStmt = db.prepare(`
    UPDATE schedules SET
      workflow_id = ?, name = ?, cron_expr = ?, timezone = ?, variables = ?,
      enabled = ?, next_run_at = ?, last_run_at = ?, last_goal_id = ?,
      last_status = ?, max_overlap = ?, updated_at = ?
    WHERE id = ?
  `);
  const deleteStmt = db.prepare("DELETE FROM schedules WHERE id = ?");
  const claimStmt = db.prepare(`
    UPDATE schedules
       SET next_run_at = ?, last_run_at = ?, updated_at = ?
     WHERE id = ? AND next_run_at = ?
  `);

  function create(schedule: ScheduleRecord): void {
    insertStmt.run(
      schedule.id,
      schedule.workflowId,
      schedule.name,
      schedule.cronExpr,
      schedule.timezone,
      JSON.stringify(schedule.variables),
      schedule.enabled ? 1 : 0,
      schedule.nextRunAt,
      schedule.lastRunAt ?? null,
      schedule.lastGoalId ?? null,
      schedule.lastStatus ?? null,
      schedule.maxOverlap,
      schedule.createdAt,
      schedule.updatedAt,
    );
  }

  function get(id: string): ScheduleRecord | undefined {
    const row = selectById.get(id) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  function getByName(name: string): ScheduleRecord | undefined {
    const row = selectByName.get(name) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  function listAll(): ScheduleRecord[] {
    return (selectAll.all() as ScheduleRow[]).map(rowToSchedule);
  }

  function findDue(nowMs: number): ScheduleRecord[] {
    return (selectDue.all(nowMs) as ScheduleRow[]).map(rowToSchedule);
  }

  function update(schedule: ScheduleRecord): void {
    updateStmt.run(
      schedule.workflowId,
      schedule.name,
      schedule.cronExpr,
      schedule.timezone,
      JSON.stringify(schedule.variables),
      schedule.enabled ? 1 : 0,
      schedule.nextRunAt,
      schedule.lastRunAt ?? null,
      schedule.lastGoalId ?? null,
      schedule.lastStatus ?? null,
      schedule.maxOverlap,
      schedule.updatedAt,
      schedule.id,
    );
  }

  function del(id: string): boolean {
    const result = deleteStmt.run(id);
    return Number(result.changes) > 0;
  }

  function claim(
    id: string,
    expectedNextRunAt: number,
    newNextRunAt: number,
    nowMs: number,
  ): boolean {
    const result = claimStmt.run(
      newNextRunAt,
      nowMs,
      nowMs,
      id,
      expectedNextRunAt,
    );
    return Number(result.changes) > 0;
  }

  return {
    create,
    get,
    getByName,
    listAll,
    findDue,
    update,
    delete: del,
    claim,
  };
}
