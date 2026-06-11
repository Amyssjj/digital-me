/**
 * feedback.* tool family. User/agent observations submitted into the brain
 * and surfaced on the dashboard's feedback panel.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  FeedbackListArgs,
  FeedbackListResult,
  FeedbackRecord,
  FeedbackSubmitArgs,
} from "@digital-me/contracts";

export function initFeedbackSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT NOT NULL,
      type          TEXT NOT NULL,
      agent         TEXT NOT NULL,
      description   TEXT NOT NULL,
      severity      TEXT,
      source        TEXT NOT NULL,
      related_goal  TEXT,
      resolved      INTEGER NOT NULL DEFAULT 0,
      resolution    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_date ON feedback(date);
  `);
}

type FeedbackRow = {
  id: number;
  date: string;
  type: string;
  agent: string;
  description: string;
  severity: string | null;
  source: string;
  related_goal: string | null;
  resolved: number;
};

function rowToRecord(row: FeedbackRow): FeedbackRecord {
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    agent: row.agent,
    description: row.description,
    severity: row.severity,
    source: row.source,
    related_goal: row.related_goal,
    resolved: row.resolved === 1,
  };
}

function dateFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export type FeedbackTools = {
  submit(args: FeedbackSubmitArgs): number;
  list(args: FeedbackListArgs): FeedbackListResult;
  resolve(args: { id: number; resolved: boolean; resolution?: string }): void;
};

export function createFeedbackTools(deps: {
  db: DatabaseSync;
  now: () => Date;
}): FeedbackTools {
  const { db, now } = deps;

  const insert = db.prepare(`
    INSERT INTO feedback (date, type, agent, description, severity, source, related_goal)
    VALUES (@date, @type, @agent, @description, @severity, @source, @related_goal)
  `);

  const resolveWithText = db.prepare(`
    UPDATE feedback SET resolved = @resolved, resolution = @resolution WHERE id = @id
  `);
  const resolveOnly = db.prepare(`
    UPDATE feedback SET resolved = @resolved WHERE id = @id
  `);

  function submit(args: FeedbackSubmitArgs): number {
    const info = insert.run({
      date: now().toISOString().slice(0, 10),
      type: args.type,
      agent: args.agent,
      description: args.description,
      severity: args.severity ?? null,
      source: args.source,
      related_goal: args.related_goal ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  function list(args: FeedbackListArgs): FeedbackListResult {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (args.since !== undefined) {
      clauses.push("date >= @since");
      params.since = dateFromEpochMs(args.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = args.limit !== undefined ? `LIMIT ${args.limit}` : "";
    const rows = db
      .prepare(
        `SELECT id, date, type, agent, description, severity, source, related_goal, resolved
         FROM feedback ${where} ORDER BY date DESC, id DESC ${limitClause}`,
      )
      .all(params) as FeedbackRow[];
    return { feedback: rows.map(rowToRecord) };
  }

  function resolve(args: {
    id: number;
    resolved: boolean;
    resolution?: string;
  }): void {
    const resolvedFlag = args.resolved ? 1 : 0;
    if (args.resolution !== undefined) {
      resolveWithText.run({
        id: args.id,
        resolved: resolvedFlag,
        resolution: args.resolution,
      });
    } else {
      resolveOnly.run({ id: args.id, resolved: resolvedFlag });
    }
  }

  return { submit, list, resolve };
}
