/**
 * Traces store — port of upstream task-orchestrator/src/store.ts
 * `traces` table for the brain API v2 telemetry surface.
 *
 * Each row is one observable event from an agent — tool calls, task
 * lifecycle, session boundaries, learning capture. The dashboard's
 * "what is the agent doing" view reads this; analytics jobs aggregate it.
 *
 * `queryTraces` builds dynamic WHERE clauses from optional filters. The
 * LIMIT is clamped to 1000 to keep a curious or buggy caller from pulling
 * an unbounded result set into memory.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migrations.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type TraceKind =
  | "tool_call"
  | "task_start"
  | "task_complete"
  | "task_failed"
  | "learning_captured"
  | "session_start"
  | "session_end";

export type TraceRecord = {
  readonly id: string;
  readonly agentId: string;
  readonly kind: TraceKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly taskId?: string;
  readonly goalId?: string;
  readonly durationMs?: number;
  readonly t: number;
};

export type TraceQueryFilters = {
  readonly agentId?: string;
  readonly goalId?: string;
  readonly taskId?: string;
  readonly kind?: TraceKind;
  /** Epoch ms inclusive lower bound on `t`. */
  readonly since?: number;
  /** Max rows returned. Defaults to 100, clamped to 1000. */
  readonly limit?: number;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// ── Schema migration ──────────────────────────────────────────────────────

const TRACES_VERSION = 700;
// All store migrations share one PRAGMA user_version counter, and the runner
// skips anything <= the DB's current version. Live DBs are already at 710
// (M1_EVENTS_VERSION), so this index MUST be versioned above the global max
// or upgraded installs would never create it.
const TRACES_KIND_INDEX_VERSION = 711;

export const TRACES_MIGRATIONS: readonly Migration[] = [
  {
    version: TRACES_VERSION,
    description: "v700: traces table (brain telemetry surface)",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS traces (
          id           TEXT PRIMARY KEY,
          agent_id     TEXT NOT NULL,
          kind         TEXT NOT NULL,
          payload      TEXT NOT NULL DEFAULT '{}',
          task_id      TEXT,
          goal_id      TEXT,
          duration_ms  INTEGER,
          t            INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_id);
        CREATE INDEX IF NOT EXISTS idx_traces_task  ON traces(task_id);
        CREATE INDEX IF NOT EXISTS idx_traces_goal  ON traces(goal_id);
        CREATE INDEX IF NOT EXISTS idx_traces_t     ON traces(t);
      `);
    },
  },
  {
    version: TRACES_KIND_INDEX_VERSION,
    description:
      "v711: traces(kind, t) index — the dashboard intake polls `WHERE kind = 'learning_captured'` every minute over a growing table",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_traces_kind_t ON traces(kind, t);
      `);
    },
  },
];

// ── Row mapping ────────────────────────────────────────────────────────────

type TraceRow = {
  id: string;
  agent_id: string;
  kind: string;
  payload: string;
  task_id: string | null;
  goal_id: string | null;
  duration_ms: number | null;
  t: number;
};

function jsonParseOr<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToTrace(row: TraceRow): TraceRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind as TraceKind,
    payload: jsonParseOr<Record<string, unknown>>(row.payload, {}),
    taskId: row.task_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    t: row.t,
  };
}

// ── Public factory ─────────────────────────────────────────────────────────

export type TracesStore = {
  create(trace: TraceRecord): void;
  query(filters: TraceQueryFilters): TraceRecord[];
  /** Delete every trace tied to a goal — by goal_id, and by task_id for the
   *  given task ids (traces may carry a task_id with no goal_id, and would
   *  otherwise orphan when the retention sweep removes their task). Returns
   *  rows deleted. */
  deleteByGoal(goalId: string, taskIds?: readonly string[]): number;
};

export function createTracesStore(deps: { db: DatabaseSync }): TracesStore {
  const { db } = deps;

  const insertStmt = db.prepare(`
    INSERT INTO traces
      (id, agent_id, kind, payload, task_id, goal_id, duration_ms, t)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteByGoalStmt = db.prepare("DELETE FROM traces WHERE goal_id = ?");

  function create(trace: TraceRecord): void {
    insertStmt.run(
      trace.id,
      trace.agentId,
      trace.kind,
      JSON.stringify(trace.payload),
      trace.taskId ?? null,
      trace.goalId ?? null,
      trace.durationMs ?? null,
      trace.t,
    );
  }

  function query(filters: TraceQueryFilters): TraceRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filters.agentId !== undefined) {
      clauses.push("agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.goalId !== undefined) {
      clauses.push("goal_id = ?");
      params.push(filters.goalId);
    }
    if (filters.taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(filters.taskId);
    }
    if (filters.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(filters.kind);
    }
    if (filters.since !== undefined) {
      clauses.push("t >= ?");
      params.push(filters.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const sql = `SELECT * FROM traces ${where} ORDER BY t DESC LIMIT ?`;
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as TraceRow[];
    return rows.map(rowToTrace);
  }

  function deleteByGoal(goalId: string, taskIds: readonly string[] = []): number {
    if (taskIds.length === 0) {
      return Number(deleteByGoalStmt.run(goalId).changes);
    }
    // Dynamic IN list — prepared per call; only the hourly retention sweep
    // takes this path, so per-call prepare cost is irrelevant.
    const placeholders = taskIds.map(() => "?").join(", ");
    const result = db
      .prepare(
        `DELETE FROM traces WHERE goal_id = ? OR task_id IN (${placeholders})`,
      )
      .run(goalId, ...taskIds);
    return Number(result.changes);
  }

  return { create, query, deleteByGoal };
}
