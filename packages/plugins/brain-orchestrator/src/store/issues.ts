/**
 * issue.* tool family for brain-orchestrator.
 *
 * Bugs, improvements, and automation opportunities. Read by the dashboard's
 * goals view, improvements page, and issues panels. Writes happen from any
 * plugin that detects an issue (heartbeat fixer, ops health workflow, etc.).
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  IssueListArgs,
  IssueListResult,
  IssueOpenArgs,
  IssueRecord,
  IssueStatus,
  IssueSummaryResult,
  IssueTimeseriesArgs,
  IssueTimeseriesResult,
  IssueType,
  IssueUpdateArgs,
} from "@digital-me/contracts";

export function initIssueSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id           TEXT PRIMARY KEY,
      date         TEXT NOT NULL,
      type         TEXT NOT NULL,
      goal         TEXT,
      title        TEXT NOT NULL,
      description  TEXT,
      category     TEXT,
      severity     TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      reported_by  TEXT,
      resolution   TEXT,
      closed_date  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_issues_date ON issues(date);
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_issues_goal ON issues(goal);
  `);
}

type IssueRow = {
  id: string;
  date: string;
  type: IssueType;
  goal: string | null;
  title: string;
  description: string | null;
  category: string | null;
  severity: string | null;
  status: IssueStatus;
  reported_by: string | null;
};

function rowToRecord(row: IssueRow): IssueRecord {
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    goal: row.goal,
    title: row.title,
    description: row.description,
    category: row.category,
    severity: row.severity,
    status: row.status,
    reported_by: row.reported_by,
  };
}

function dateFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export type IssueTools = {
  open(args: IssueOpenArgs): string;
  update(args: IssueUpdateArgs): void;
  list(args: IssueListArgs): IssueListResult;
  summary(): IssueSummaryResult;
  timeseries(args: IssueTimeseriesArgs): IssueTimeseriesResult;
};

export function createIssueTools(deps: {
  db: DatabaseSync;
  now: () => Date;
  idGen: () => string;
}): IssueTools {
  const { db, now, idGen } = deps;

  const insert = db.prepare(`
    INSERT INTO issues (id, date, type, goal, title, description, category, severity, status, reported_by)
    VALUES (@id, @date, @type, @goal, @title, @description, @category, @severity, 'open', @reported_by)
  `);

  const updateStatusOnly = db.prepare(`
    UPDATE issues SET status = @status,
      closed_date = CASE WHEN @status = 'closed' THEN @today ELSE closed_date END
    WHERE id = @id
  `);
  const updateStatusAndResolution = db.prepare(`
    UPDATE issues SET status = @status, resolution = @resolution,
      closed_date = CASE WHEN @status = 'closed' THEN @today ELSE closed_date END
    WHERE id = @id
  `);

  function open(args: IssueOpenArgs): string {
    const id = idGen();
    insert.run({
      id,
      date: now().toISOString().slice(0, 10),
      type: args.type,
      goal: args.goal ?? null,
      title: args.title,
      description: args.description ?? null,
      category: args.category ?? null,
      severity: args.severity ?? null,
      reported_by: args.reported_by ?? null,
    });
    return id;
  }

  function update(args: IssueUpdateArgs): void {
    const today = now().toISOString().slice(0, 10);
    if (args.resolution !== undefined) {
      updateStatusAndResolution.run({
        id: args.id,
        status: args.status,
        resolution: args.resolution,
        today,
      });
    } else {
      updateStatusOnly.run({ id: args.id, status: args.status, today });
    }
  }

  function list(args: IssueListArgs): IssueListResult {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (args.type !== undefined) {
      clauses.push("type = @type");
      params.type = args.type;
    }
    if (args.status !== undefined) {
      clauses.push("status = @status");
      params.status = args.status;
    }
    if (args.goal !== undefined) {
      clauses.push("goal = @goal");
      params.goal = args.goal;
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
    // Bind LIMIT as a parameter, never string-interpolate it — a non-integer
    // `limit` reaching here (e.g. from an unvalidated caller) would otherwise be
    // SQL injection. Bound params make injection structurally impossible.
    let limitClause = "";
    if (args.limit !== undefined) {
      limitClause = "LIMIT @limit";
      params.limit = args.limit;
    }
    const rows = db
      .prepare(
        `SELECT id, date, type, goal, title, description, category, severity, status, reported_by
         FROM issues ${where} ORDER BY date DESC, id DESC ${limitClause}`,
      )
      .all(params) as IssueRow[];
    return { issues: rows.map(rowToRecord) };
  }

  function summary(): IssueSummaryResult {
    const totalsRow = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed
         FROM issues`,
      )
      .get() as { total: number; closed: number | null };
    const total = totalsRow.total;
    const closed = totalsRow.closed ?? 0;
    const fix_rate =
      total > 0 ? Math.round((closed / total) * 1000) / 10 : 0;

    const reporterRows = db
      .prepare(
        `SELECT COALESCE(reported_by, 'unknown') AS reporter, COUNT(*) AS count
         FROM issues GROUP BY COALESCE(reported_by, 'unknown') ORDER BY count DESC`,
      )
      .all() as Array<{ reporter: string; count: number }>;

    return {
      by_reporter: reporterRows,
      total,
      closed,
      fix_rate,
    };
  }

  function timeseries(args: IssueTimeseriesArgs): IssueTimeseriesResult {
    const dimCol =
      args.by === "type"
        ? "type"
        : args.by === "goal"
          ? "COALESCE(goal, 'unknown')"
          : "COALESCE(reported_by, 'unknown')";
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
    const openedWhere =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const openedRows = db
      .prepare(
        `SELECT date, ${dimCol} AS dim, COUNT(*) AS opened
         FROM issues ${openedWhere}
         GROUP BY date, dim
         ORDER BY date ASC, dim ASC`,
      )
      .all(params) as Array<{ date: string; dim: string; opened: number }>;

    const closedClauses: string[] = ["closed_date IS NOT NULL"];
    const closedParams: Record<string, string> = {};
    if (args.since !== undefined) {
      closedClauses.push("closed_date >= @since");
      closedParams.since = dateFromEpochMs(args.since);
    }
    if (args.until !== undefined) {
      closedClauses.push("closed_date <= @until");
      closedParams.until = dateFromEpochMs(args.until);
    }
    const closedRows = db
      .prepare(
        `SELECT closed_date AS date, ${dimCol} AS dim, COUNT(*) AS closed
         FROM issues WHERE ${closedClauses.join(" AND ")}
         GROUP BY closed_date, dim`,
      )
      .all(closedParams) as Array<{ date: string; dim: string; closed: number }>;

    const closedByKey = new Map<string, number>();
    for (const r of closedRows) {
      closedByKey.set(`${r.date}|${r.dim}`, r.closed);
    }

    const allKeys = new Set<string>();
    for (const r of openedRows) allKeys.add(`${r.date}|${r.dim}`);
    for (const r of closedRows) allKeys.add(`${r.date}|${r.dim}`);

    const openedByKey = new Map<string, number>();
    for (const r of openedRows) {
      openedByKey.set(`${r.date}|${r.dim}`, r.opened);
    }

    // Keys are always `${date}|${dim}` — split is safe to destructure into
    // exactly two pieces (the `|` is never present in date or dim values).
    const points = [...allKeys]
      .sort()
      .map((k) => {
        const sep = k.indexOf("|");
        const date = k.slice(0, sep);
        const dim = k.slice(sep + 1);
        return {
          date,
          dim,
          opened: openedByKey.get(k) ?? 0,
          closed: closedByKey.get(k) ?? 0,
        };
      });

    return { points };
  }

  return { open, update, list, summary, timeseries };
}
