/**
 * insight.* tool family. Discovered observations surfaced to the user
 * (analogous to feedback but emitted by automated agents rather than humans).
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  InsightCaptureArgs,
  InsightListArgs,
  InsightListResult,
  InsightRecord,
  InsightStatus,
} from "@digital-me/contracts";

export function initInsightSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id                 TEXT PRIMARY KEY,
      date               TEXT NOT NULL,
      type               TEXT NOT NULL,
      observation        TEXT NOT NULL,
      why_it_matters     TEXT,
      question_for_jing  TEXT,
      proposed_action    TEXT,
      related_goal       TEXT,
      status             TEXT NOT NULL DEFAULT 'surfaced'
    );

    CREATE INDEX IF NOT EXISTS idx_insights_date ON insights(date);
    CREATE INDEX IF NOT EXISTS idx_insights_status ON insights(status);
  `);
}

type InsightRow = {
  id: string;
  date: string;
  type: string;
  observation: string;
  why_it_matters: string | null;
  question_for_jing: string | null;
  proposed_action: string | null;
  related_goal: string | null;
  status: InsightStatus;
};

function rowToRecord(row: InsightRow): InsightRecord {
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    observation: row.observation,
    why_it_matters: row.why_it_matters,
    question_for_jing: row.question_for_jing,
    proposed_action: row.proposed_action,
    related_goal: row.related_goal,
    status: row.status,
  };
}

function dateFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export type InsightTools = {
  capture(args: InsightCaptureArgs): string;
  list(args: InsightListArgs): InsightListResult;
  updateStatus(args: { id: string; status: InsightStatus }): void;
};

export function createInsightTools(deps: {
  db: DatabaseSync;
  now: () => Date;
  idGen: () => string;
}): InsightTools {
  const { db, now, idGen } = deps;

  const insert = db.prepare(`
    INSERT INTO insights
      (id, date, type, observation, why_it_matters, question_for_jing,
       proposed_action, related_goal, status)
    VALUES (@id, @date, @type, @observation, @why_it_matters, @question_for_jing,
       @proposed_action, @related_goal, 'surfaced')
  `);
  const updateStatus = db.prepare(
    `UPDATE insights SET status = @status WHERE id = @id`,
  );

  function capture(args: InsightCaptureArgs): string {
    const id = idGen();
    insert.run({
      id,
      date: now().toISOString().slice(0, 10),
      type: args.type,
      observation: args.observation,
      why_it_matters: args.why_it_matters ?? null,
      question_for_jing: args.question_for_jing ?? null,
      proposed_action: args.proposed_action ?? null,
      related_goal: args.related_goal ?? null,
    });
    return id;
  }

  function list(args: InsightListArgs): InsightListResult {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (args.since !== undefined) {
      clauses.push("date >= @since");
      params.since = dateFromEpochMs(args.since);
    }
    if (args.status_filter !== undefined && args.status_filter.length > 0) {
      const placeholders = args.status_filter
        .map((_, i) => `@s${i}`)
        .join(", ");
      clauses.push(`status IN (${placeholders})`);
      args.status_filter.forEach((s, i) => {
        params[`s${i}`] = s;
      });
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
        `SELECT id, date, type, observation, why_it_matters, question_for_jing,
                proposed_action, related_goal, status
         FROM insights ${where}
         ORDER BY date DESC, id DESC ${limitClause}`,
      )
      .all(params) as InsightRow[];
    return { insights: rows.map(rowToRecord) };
  }

  return {
    capture,
    list,
    updateStatus: (args): void => {
      updateStatus.run({ id: args.id, status: args.status });
    },
  };
}
