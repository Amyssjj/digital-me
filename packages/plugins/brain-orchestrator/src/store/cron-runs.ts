/**
 * cron.* tool family (READ side). The write side — registering schedules,
 * dispatching ticks — remains in the existing `tasks` tool surface.
 * This module provides the dashboard's view of run history.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  CronHistoryArgs,
  CronHistoryResult,
  CronPerJobPoint,
  CronPerJobSummaryResult,
  CronRunRecord,
  CronRunStatus,
  CronSummaryPoint,
  CronSummaryResult,
} from "@digital-me/contracts";

export function initCronSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_runs (
      date            TEXT NOT NULL,
      cron_name       TEXT NOT NULL,
      scheduled_time  TEXT NOT NULL,
      run_time        TEXT,
      status          TEXT NOT NULL,
      duration_ms     INTEGER,
      error           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cron_runs_date ON cron_runs(date);
    CREATE INDEX IF NOT EXISTS idx_cron_runs_name ON cron_runs(cron_name);
  `);
}

type CronRow = {
  date: string;
  cron_name: string;
  scheduled_time: string;
  run_time: string | null;
  status: CronRunStatus;
  duration_ms: number | null;
  error: string | null;
};

function rowToRecord(row: CronRow): CronRunRecord {
  return {
    date: row.date,
    cron_name: row.cron_name,
    scheduled_time: row.scheduled_time,
    run_time: row.run_time,
    status: row.status,
    duration_ms: row.duration_ms,
    error: row.error,
  };
}

function dateFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export type CronTools = {
  history(args: CronHistoryArgs): CronHistoryResult;
  summary(args: { since?: number; until?: number }): CronSummaryResult;
  perJobSummary(args: { since?: number; until?: number }): CronPerJobSummaryResult;
};

const SUMMARY_SELECT = `
  SELECT date,
    COUNT(*) AS total_scheduled,
    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed_count,
    SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
    SUM(CASE WHEN status = 'missed'  THEN 1 ELSE 0 END) AS missed_count,
    ROUND(
      CASE WHEN (COUNT(*) - SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END)) > 0
      THEN 100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)
           / (COUNT(*) - SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END))
      ELSE 100 END,
    1) AS success_rate
  FROM cron_runs
`;

const PER_JOB_SELECT = `
  SELECT date, cron_name,
    COUNT(*) AS total_slots,
    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed_count,
    SUM(CASE WHEN status = 'missed'  THEN 1 ELSE 0 END) AS missed_count,
    ROUND(
      CASE WHEN (COUNT(*) - SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END)) > 0
      THEN 100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)
           / (COUNT(*) - SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END))
      ELSE 100 END,
    1) AS success_rate
  FROM cron_runs
`;

function buildDateWhere(args: {
  since?: number;
  until?: number;
}): { clause: string; params: Record<string, string> } {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (args.since !== undefined) {
    clauses.push("date >= @since");
    params.since = dateFromEpochMs(args.since);
  }
  if (args.until !== undefined) {
    clauses.push("date <= @until");
    params.until = dateFromEpochMs(args.until);
  }
  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

export function createCronTools(deps: { db: DatabaseSync }): CronTools {
  const { db } = deps;

  function history(args: CronHistoryArgs): CronHistoryResult {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (args.cron_name !== undefined) {
      clauses.push("cron_name = @cron_name");
      params.cron_name = args.cron_name;
    }
    if (args.since !== undefined) {
      clauses.push("date >= @since");
      params.since = dateFromEpochMs(args.since);
    }
    if (args.until !== undefined) {
      clauses.push("date <= @until");
      params.until = dateFromEpochMs(args.until);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    // Bind LIMIT as a parameter, never string-interpolate it (SQLi guard).
    let limitClause = "";
    if (args.limit !== undefined) {
      limitClause = "LIMIT @limit";
      params.limit = args.limit;
    }
    const rows = db
      .prepare(
        `SELECT date, cron_name, scheduled_time, run_time, status, duration_ms, error
         FROM cron_runs ${where}
         ORDER BY date ASC, scheduled_time ASC ${limitClause}`,
      )
      .all(params) as CronRow[];
    return { runs: rows.map(rowToRecord) };
  }

  function summary(args: { since?: number; until?: number }): CronSummaryResult {
    const { clause, params } = buildDateWhere(args);
    const rows = db
      .prepare(`${SUMMARY_SELECT} ${clause} GROUP BY date ORDER BY date ASC`)
      .all(params) as CronSummaryPoint[];
    return { points: rows };
  }

  function perJobSummary(args: {
    since?: number;
    until?: number;
  }): CronPerJobSummaryResult {
    const { clause, params } = buildDateWhere(args);
    const rows = db
      .prepare(
        `${PER_JOB_SELECT} ${clause} GROUP BY date, cron_name ORDER BY date ASC, cron_name ASC`,
      )
      .all(params) as CronPerJobPoint[];
    return { points: rows };
  }

  return { history, summary, perJobSummary };
}
