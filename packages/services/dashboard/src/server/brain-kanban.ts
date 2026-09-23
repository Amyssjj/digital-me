/**
 * Kanban board + Mechanism run stats — read side, straight from brain.db.
 *
 * Both views used to go through the brain's `tasks board` JSON over MCP. That
 * payload is every goal in a 7-day window with every task and attempt inlined:
 * ~10k goals / 55 MB (the every-minute `dashboard-intake` schedule alone mints
 * 1,440 goals a day), built in 5-20 s on brain-host's single event loop. The
 * Kanban polls four of them every 10 s, so an open Kanban tab never loaded —
 * each request outlived the MCP client's 60 s timeout — and it starved
 * brain-host, whose `memory_search` the prompt-injection hooks call with
 * 2-12 s budgets.
 *
 * SQL answers both views exactly and in milliseconds: the status filter, sort
 * and LIMIT run in SQLite, the window stats are GROUP BYs, and only the
 * requested page is hydrated with tasks and attempts. brain.db is opened
 * readonly per request (WAL: readers never block brain-host's writer), the
 * same pattern as remote-clients.ts. The tables are brain-orchestrator's
 * (`goals` / `tasks` / `attempts`); brain-kanban.test.ts seeds them through
 * brain-orchestrator's own stores, so a schema change fails the tests here
 * instead of blanking the board.
 *
 * Response shapes mirror frontend/hooks/useKanban.ts.
 */

import Database from "better-sqlite3";
import { Router } from "express";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Terminal-goal window when the caller sends no `days` (the brain board's
 *  own default, kept so an un-ranged request means the same thing). */
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Only project goals reach the Kanban; evergreen goals use a different
 *  status vocabulary (healthy/degraded/…). */
const PROJECT_GOAL = "COALESCE(g.type, 'project') = 'project'";
/** The five Kanban columns — always present in the stats, even at zero. */
const COLUMN_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;

// ── Response shapes (mirror frontend/hooks/useKanban.ts) ──────────────────

export type KanbanCheckpoint = {
  readonly phase: string;
  readonly summary: string;
  readonly progressPercent: number;
  readonly artifactPaths: readonly string[];
  readonly blocker: string | null;
  readonly timestamp: string | null;
};

export type KanbanAttempt = {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outputSummary: string | null;
  readonly failureReason: string | null;
  readonly artifactPaths: readonly string[];
};

export type KanbanTask = {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly status: string;
  readonly priority: string;
  readonly blockedBy: readonly string[];
  readonly attemptCount: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failureReason: string | null;
  readonly onUpstreamFailure: string;
  readonly latestCheckpoint: KanbanCheckpoint | null;
  /** Rendered as text by the card, so the stored output record is reduced to
   *  its summary here (a raw object would crash the React render). */
  readonly latestOutput: string | null;
  readonly activeAttempt: KanbanAttempt | null;
  readonly attempts: readonly KanbanAttempt[];
};

export type KanbanGoal = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly parentGoalId: string | null;
  readonly sourceWorkflowId: string | null;
  readonly sourceWorkflowVersion: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly createdBy: string;
  /** The first task's dispatch agent — the only per-goal agent the
   *  orchestrator records. */
  readonly agentId: string | null;
  readonly tasks: readonly KanbanTask[];
};

export type KanbanStats = {
  readonly goals: { readonly total: number; readonly byStatus: Record<string, number> };
  readonly tasks: { readonly total: number; readonly byStatus: Record<string, number> };
  readonly agents: ReadonlyArray<{ readonly agentId: string; readonly goalCount: number }>;
};

export type KanbanResponse = {
  readonly goals: readonly KanbanGoal[];
  readonly stats: KanbanStats;
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
    readonly hasMore: boolean;
  };
};

export type KanbanQuery = {
  /** Comma-separated goal statuses; omitted = every status. */
  readonly status?: string;
  readonly limit?: number;
  readonly offset?: number;
  /** "updated_at" (default) | "created_at" | "name". */
  readonly sort?: string;
  /** "desc" (default) | "asc". */
  readonly order?: string;
  /** Window on the goal's last update. Omitted = open goals plus terminal
   *  goals from the last 7 days. */
  readonly days?: number;
};

export type WorkflowRunStats = {
  readonly totalRuns: number;
  /** Completed share of all runs, in percent with one decimal. */
  readonly successRate: number;
  readonly latestRun: {
    readonly goalId: string;
    readonly status: string;
    readonly startedAt: string;
    readonly completedAt: string | null;
    readonly taskStatuses: Readonly<Record<string, string>>;
  };
};

// ── Row shapes (brain-orchestrator schema, snake_case) ────────────────────

type GoalRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly parent_goal_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly completed_at: number | null;
  readonly created_by: string;
  readonly source_workflow_id: string | null;
  readonly source_workflow_version: number | null;
};

type TaskRow = {
  readonly id: string;
  readonly goal_id: string;
  readonly name: string;
  readonly task: string;
  readonly blocked_by: string;
  readonly dispatch: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly latest_checkpoint: string | null;
  readonly latest_output: string | null;
  readonly priority: string;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly failure_reason: string | null;
  readonly on_upstream_failure: string;
};

type AttemptRow = {
  readonly attempt_id: string;
  readonly task_id: string;
  readonly attempt_number: number;
  readonly status: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly output_summary: string | null;
  readonly failure_reason: string | null;
  readonly artifact_paths: string | null;
};

type CountRow = { readonly status: string; readonly c: number };

// ── Helpers ───────────────────────────────────────────────────────────────

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function toIso(epochMs: number | null): string | null {
  return epochMs === null ? null : iso(epochMs);
}

function parseJson(raw: string | null): unknown {
  if (raw === null || raw === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(raw: string | null): string[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed)
    ? parsed.filter((v): v is string => typeof v === "string")
    : [];
}

function optString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** dispatch JSON → its agentId (spawn target or exec alias), else null. */
export function dispatchAgentId(raw: string): string | null {
  const agentId = asRecord(parseJson(raw))?.["agentId"];
  return typeof agentId === "string" && agentId !== "" ? agentId : null;
}

function adaptCheckpoint(raw: string | null): KanbanCheckpoint | null {
  const cp = asRecord(parseJson(raw));
  if (cp === undefined) return null;
  const progress = cp["progressPercent"];
  const at = cp["checkpointAt"];
  const paths = cp["artifactPaths"];
  return {
    phase: optString(cp["phase"]) ?? "",
    summary: optString(cp["summary"]) ?? "",
    progressPercent: typeof progress === "number" ? progress : 0,
    artifactPaths: Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === "string")
      : [],
    blocker: optString(cp["blocker"]),
    timestamp: typeof at === "number" ? toIso(at) : optString(at),
  };
}

/** The stored output record → the text the card shows: its summary, else
 *  the raw value when it is not a record (legacy plain-text outputs). */
function adaptOutput(raw: string | null): string | null {
  if (raw === null || raw === "") return null;
  const parsed = parseJson(raw);
  const record = asRecord(parsed);
  if (record !== undefined) return optString(record["summary"]);
  return typeof parsed === "string" ? parsed : raw;
}

function adaptAttempt(row: AttemptRow): KanbanAttempt {
  return {
    attemptId: row.attempt_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    startedAt: iso(row.started_at),
    endedAt: toIso(row.ended_at),
    outputSummary: row.output_summary,
    failureReason: row.failure_reason,
    artifactPaths: stringArray(row.artifact_paths),
  };
}

function adaptTask(row: TaskRow, attempts: readonly AttemptRow[]): KanbanTask {
  const adapted = attempts.map(adaptAttempt);
  return {
    id: row.id,
    name: row.name,
    task: row.task,
    status: row.status,
    priority: row.priority,
    blockedBy: stringArray(row.blocked_by),
    attemptCount: row.attempt_count,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    failureReason: row.failure_reason,
    onUpstreamFailure: row.on_upstream_failure,
    latestCheckpoint: adaptCheckpoint(row.latest_checkpoint),
    latestOutput: adaptOutput(row.latest_output),
    activeAttempt: adapted.find((a) => a.status === "running") ?? null,
    attempts: adapted,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** `?, ?, ?` for an IN list. Callers never pass an empty list. */
function placeholders(n: number): string {
  return new Array<string>(n).fill("?").join(", ");
}

function zeroedCounts(rows: readonly CountRow[]): { total: number; byStatus: Record<string, number> } {
  const byStatus: Record<string, number> = {};
  for (const s of COLUMN_STATUSES) byStatus[s] = 0;
  let total = 0;
  for (const row of rows) {
    byStatus[row.status] = row.c;
    total += row.c;
  }
  return { total, byStatus };
}

/** The goal window as a WHERE fragment over alias `g`. */
function windowClause(days: number | undefined, now: number): { sql: string; params: number[] } {
  if (days !== undefined) {
    return { sql: "g.updated_at >= ?", params: [now - days * DAY_MS] };
  }
  const cutoff = now - DEFAULT_WINDOW_DAYS * DAY_MS;
  return {
    sql:
      "(g.status NOT IN ('completed', 'failed', 'cancelled')" +
      " OR (g.status = 'completed' AND COALESCE(g.completed_at, g.updated_at) >= ?)" +
      " OR (g.status IN ('failed', 'cancelled') AND g.updated_at >= ?))",
    params: [cutoff, cutoff],
  };
}

function parseStatuses(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function sortColumn(sort: string | undefined): string {
  if (sort === "created_at") return "g.created_at";
  if (sort === "name") return "g.name";
  return "g.updated_at";
}

// ── Queries ───────────────────────────────────────────────────────────────

type GoalTasks = {
  /** Every task in rowid order, cancelled included. */
  readonly tasks: readonly KanbanTask[];
  /** The first task's dispatch agent — the goal's agent on the card. */
  readonly agentId: string | null;
};

/** Tasks (rowid order) for a set of goals, with their attempts. */
function loadTasks(
  db: Database.Database,
  goalIds: readonly string[],
): Map<string, GoalTasks> {
  if (goalIds.length === 0) return new Map();
  const taskRows = db
    .prepare(
      `SELECT * FROM tasks WHERE goal_id IN (${placeholders(goalIds.length)}) ORDER BY rowid`,
    )
    .all(...goalIds) as TaskRow[];
  const attemptsByTask =
    taskRows.length === 0
      ? new Map<string, AttemptRow[]>()
      : groupBy(
          db
            .prepare(
              `SELECT * FROM attempts WHERE task_id IN (${placeholders(taskRows.length)})
                ORDER BY attempt_number`,
            )
            .all(...taskRows.map((t) => t.id)) as AttemptRow[],
          (a) => a.task_id,
        );
  const out = new Map<string, GoalTasks>();
  for (const [goalId, rows] of groupBy(taskRows, (t) => t.goal_id)) {
    out.set(goalId, {
      tasks: rows.map((t) => adaptTask(t, attemptsByTask.get(t.id) ?? [])),
      agentId: dispatchAgentId(rows[0]!.dispatch),
    });
  }
  return out;
}

/**
 * One Kanban page plus the window's stats. The stats cover every project goal
 * in the window (before the status filter), so the four per-status requests
 * the UI fans out all carry the same overview.
 */
export function queryKanban(
  db: Database.Database,
  query: KanbanQuery,
  now: number,
): KanbanResponse {
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = query.offset ?? 0;
  const win = windowClause(query.days, now);
  const scope = `${PROJECT_GOAL} AND ${win.sql}`;

  const goalCounts = db
    .prepare(`SELECT g.status AS status, COUNT(*) AS c FROM goals g WHERE ${scope} GROUP BY g.status`)
    .all(...win.params) as CountRow[];
  const taskCounts = db
    .prepare(
      `SELECT t.status AS status, COUNT(*) AS c
         FROM tasks t JOIN goals g ON g.id = t.goal_id
        WHERE ${scope} GROUP BY t.status`,
    )
    .all(...win.params) as CountRow[];
  // Agent per goal = its first task's dispatch agentId (json_valid guards a
  // malformed row from failing the whole aggregate).
  const agentRows = db
    .prepare(
      `SELECT agent_id AS agentId, COUNT(*) AS goalCount FROM (
         SELECT (SELECT CASE WHEN json_valid(t.dispatch) THEN json_extract(t.dispatch, '$.agentId') END
                   FROM tasks t WHERE t.goal_id = g.id ORDER BY t.rowid LIMIT 1) AS agent_id
           FROM goals g WHERE ${scope}
       )
       WHERE typeof(agent_id) = 'text' AND agent_id != ''
       GROUP BY agent_id ORDER BY goalCount DESC, agentId ASC`,
    )
    .all(...win.params) as Array<{ agentId: string; goalCount: number }>;

  const statuses = parseStatuses(query.status);
  const statusSql = statuses.length > 0 ? ` AND g.status IN (${placeholders(statuses.length)})` : "";
  const filterParams = [...win.params, ...statuses];
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM goals g WHERE ${scope}${statusSql}`).get(...filterParams) as {
      c: number;
    }
  ).c;
  const direction = query.order === "asc" ? "ASC" : "DESC";
  const pageRows = db
    .prepare(
      `SELECT g.* FROM goals g WHERE ${scope}${statusSql}
        ORDER BY ${sortColumn(query.sort)} ${direction}, g.id ${direction}
        LIMIT ? OFFSET ?`,
    )
    .all(...filterParams, limit, offset) as GoalRow[];

  const tasksByGoal = loadTasks(db, pageRows.map((g) => g.id));
  const goals = pageRows.map((g): KanbanGoal => {
    const loaded = tasksByGoal.get(g.id);
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      status: g.status,
      parentGoalId: g.parent_goal_id,
      sourceWorkflowId: g.source_workflow_id,
      sourceWorkflowVersion: g.source_workflow_version,
      createdAt: iso(g.created_at),
      updatedAt: iso(g.updated_at),
      completedAt: toIso(g.completed_at),
      createdBy: g.created_by,
      // Attributed from the first task even when that task was cancelled;
      // cancelled tasks themselves stay off the card.
      agentId: loaded?.agentId ?? null,
      tasks: (loaded?.tasks ?? []).filter((t) => t.status !== "cancelled"),
    };
  });

  return {
    goals,
    stats: {
      goals: zeroedCounts(goalCounts),
      tasks: zeroedCounts(taskCounts),
      agents: agentRows,
    },
    pagination: { limit, offset, total, hasMore: offset + limit < total },
  };
}

/**
 * Per-workflow run stats over every retained goal a workflow instantiated:
 * run count, completed share, and the latest run with its step statuses.
 * One GROUP BY pass — SQLite fills the bare columns from the MAX(created_at)
 * row, i.e. the latest run.
 */
export function queryWorkflowRunStats(db: Database.Database): Map<string, WorkflowRunStats> {
  const rows = db
    .prepare(
      `SELECT source_workflow_id AS wf, id, status, completed_at,
              MAX(created_at) AS created_at, COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM goals WHERE source_workflow_id IS NOT NULL
        GROUP BY source_workflow_id`,
    )
    .all() as Array<{
    wf: string;
    id: string;
    status: string;
    completed_at: number | null;
    created_at: number;
    total: number;
    completed: number;
  }>;
  const stepsByGoal =
    rows.length === 0
      ? new Map<string, Array<{ goal_id: string; name: string; status: string }>>()
      : groupBy(
          db
            .prepare(`SELECT goal_id, name, status FROM tasks WHERE goal_id IN (${placeholders(rows.length)})`)
            .all(...rows.map((r) => r.id)) as Array<{ goal_id: string; name: string; status: string }>,
          (t) => t.goal_id,
        );
  const out = new Map<string, WorkflowRunStats>();
  for (const r of rows) {
    const taskStatuses: Record<string, string> = {};
    for (const t of stepsByGoal.get(r.id) ?? []) taskStatuses[t.name] = t.status;
    out.set(r.wf, {
      totalRuns: r.total,
      successRate: Math.round((r.completed / r.total) * 1000) / 10,
      latestRun: {
        goalId: r.id,
        status: r.status,
        startedAt: iso(r.created_at),
        completedAt: toIso(r.completed_at),
        taskStatuses,
      },
    });
  }
  return out;
}

/** Read helper for callers outside a request: open readonly, query, close. */
export function withBrainDb<T>(brainDbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(brainDbPath, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function parseIntParam(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * GET / → KanbanResponse. Query: status, limit, offset, sort, order, days —
 * the contract the Kanban view already speaks (see useKanban.ts).
 */
export function buildBrainKanbanRouter(
  brainDbPath: string,
  now: () => number = Date.now,
): Router {
  const router = Router();
  router.get("/", (req, res) => {
    const q = req.query;
    try {
      const data = withBrainDb(brainDbPath, (db) =>
        queryKanban(
          db,
          {
            status: typeof q.status === "string" ? q.status : undefined,
            limit: parseIntParam(q.limit),
            offset: parseIntParam(q.offset),
            sort: typeof q.sort === "string" ? q.sort : undefined,
            order: typeof q.order === "string" ? q.order : undefined,
            days: parseIntParam(q.days),
          },
          now(),
        ),
      );
      res.json(data);
    } catch (err) {
      console.error("[/api/kanban]", err);
      res.status(500).json({ error: "Failed to fetch kanban data" });
    }
  });
  return router;
}
