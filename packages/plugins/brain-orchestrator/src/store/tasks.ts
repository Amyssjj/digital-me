/**
 * Tasks + attempts store — port of upstream `task-orchestrator/src/store.ts`
 * for task and attempt entities.
 *
 * Tasks and attempts are stored in two SQL tables but exposed as one
 * logical entity: `getTask(id)` returns the task with its attempts array
 * aggregated. This matches upstream's `rowToTask` behavior.
 *
 * Status-vocabulary is closed; see `TaskStatus` union for the canonical
 * list. Dispatch modes are a discriminated union — spawn/exec/manual/
 * approval/notify/wake. Stored as JSON in the dispatch column.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Originator } from "./goals.js";
import type { Migration } from "./migrations.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "ready"
  | "dispatched"
  | "running"
  | "stalled"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "skipped"
  | "acknowledged";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type UpstreamFailurePolicy = "skip" | "wait" | "continue";

export type VerifyStep = {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly expectedExitCode?: number;
};

type TaskDispatchBase = {
  readonly touchedFiles?: readonly string[];
};

export type TaskDispatch = TaskDispatchBase &
  (
    | { mode: "spawn"; agentId: string; model?: string; thinking?: string }
    | {
        mode: "exec";
        command: readonly string[];
        /**
         * Optional alias name. When set, workflow-instantiate /
         * goal-create may call the caller-supplied `aliasResolver` to
         * materialize a richer dispatch (e.g. wrap the command in a
         * worker script that runs a specific CLI). Free-form string so
         * users can define their own aliases via config — no hardcoded
         * set of allowed values.
         */
        agentId?: string;
        cwd?: string;
        env?: Readonly<Record<string, string>>;
        timeoutMs?: number;
        verify?: VerifyStep;
      }
    | { mode: "manual" }
    | { mode: "approval" }
    | { mode: "notify"; targetAgentId?: string; channel?: string }
    | { mode: "wake"; targetAgentId: string; reason?: string }
  );

export type AttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "killed"
  | "stalled";

export type TaskAttemptRecord = {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly runId?: string;
  readonly sessionKey?: string;
  readonly status: AttemptStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly outputSummary?: string;
  readonly failureReason?: string;
  readonly transcriptPath?: string;
  readonly artifactPaths?: readonly string[];
};

export type TaskCheckpointRecord = {
  readonly checkpointAt: number;
  readonly phase: string;
  readonly summary: string;
  readonly artifactPaths?: readonly string[];
  readonly blocker?: string;
  readonly progressPercent?: number;
  readonly recommendedNextStep?: string;
};

export type FixCategory =
  | "band-aid"
  | "surgical"
  | "refactor"
  | "feature"
  | "no-op";

export type TaskOutputRecord = {
  readonly deliverableState: "partial" | "complete";
  readonly summary: string;
  readonly artifactPaths?: readonly string[];
  readonly blockingIssue?: string;
  readonly recommendedNextStep?: string;
  readonly symptom?: string;
  readonly rootCause?: string;
  readonly fixScope?: string;
  readonly systemImpact?: string;
  readonly fixCategory?: FixCategory;
};

export type OrchestratorTaskRecord = {
  readonly id: string;
  readonly goalId: string;
  readonly name: string;
  readonly task: string;
  readonly blockedBy: readonly string[];
  readonly dispatch: TaskDispatch;
  readonly status: TaskStatus;
  readonly activeRunId?: string;
  readonly activeSessionKey?: string;
  readonly attemptCount: number;
  readonly failedDispatchCount?: number;
  readonly attempts: readonly TaskAttemptRecord[];
  readonly latestCheckpoint?: TaskCheckpointRecord;
  readonly latestOutput?: TaskOutputRecord;
  readonly priority: TaskPriority;
  readonly startedAt?: number;
  readonly readyAt?: number;
  readonly completedAt?: number;
  readonly failureReason?: string;
  readonly retryPolicy?: "manual_only" | "auto_once";
  readonly onUpstreamFailure: UpstreamFailurePolicy;
  readonly guidance?: readonly string[];
  readonly tags?: readonly string[];
  readonly timeoutMs?: number;
  readonly originator?: Originator;
};

// ── Schema migration ───────────────────────────────────────────────────────

const TASKS_VERSION = 200;

export const TASKS_MIGRATIONS: readonly Migration[] = [
  {
    version: TASKS_VERSION,
    description: "v200: tasks + attempts tables",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id                    TEXT PRIMARY KEY,
          goal_id               TEXT NOT NULL,
          name                  TEXT NOT NULL,
          task                  TEXT NOT NULL,
          blocked_by            TEXT NOT NULL DEFAULT '[]',
          dispatch              TEXT NOT NULL,
          status                TEXT NOT NULL DEFAULT 'pending',
          active_run_id         TEXT,
          active_session_key    TEXT,
          attempt_count         INTEGER NOT NULL DEFAULT 0,
          failed_dispatch_count INTEGER NOT NULL DEFAULT 0,
          latest_checkpoint     TEXT,
          latest_output         TEXT,
          priority              TEXT NOT NULL DEFAULT 'normal',
          started_at            INTEGER,
          ready_at              INTEGER,
          completed_at          INTEGER,
          failure_reason        TEXT,
          retry_policy          TEXT,
          on_upstream_failure   TEXT NOT NULL DEFAULT 'wait',
          guidance              TEXT,
          tags                  TEXT NOT NULL DEFAULT '[]',
          timeout_ms            INTEGER,
          originator            TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(active_run_id);

        CREATE TABLE IF NOT EXISTS attempts (
          attempt_id      TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL,
          attempt_number  INTEGER NOT NULL,
          run_id          TEXT,
          session_key     TEXT,
          status          TEXT NOT NULL DEFAULT 'running',
          started_at      INTEGER NOT NULL,
          ended_at        INTEGER,
          output_summary  TEXT,
          failure_reason  TEXT,
          transcript_path TEXT,
          artifact_paths  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id);
        CREATE INDEX IF NOT EXISTS idx_attempts_run ON attempts(run_id);
      `);
    },
  },
];

// ── Row mapping ────────────────────────────────────────────────────────────

type TaskRow = {
  id: string;
  goal_id: string;
  name: string;
  task: string;
  blocked_by: string;
  dispatch: string;
  status: string;
  active_run_id: string | null;
  active_session_key: string | null;
  attempt_count: number;
  failed_dispatch_count: number;
  latest_checkpoint: string | null;
  latest_output: string | null;
  priority: string;
  started_at: number | null;
  ready_at: number | null;
  completed_at: number | null;
  failure_reason: string | null;
  retry_policy: string | null;
  on_upstream_failure: string;
  guidance: string | null;
  tags: string;
  timeout_ms: number | null;
  originator: string | null;
};

type AttemptRow = {
  attempt_id: string;
  task_id: string;
  attempt_number: number;
  run_id: string | null;
  session_key: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  output_summary: string | null;
  failure_reason: string | null;
  transcript_path: string | null;
  artifact_paths: string | null;
};

// Called only with NOT NULL columns whose DEFAULT is a valid JSON literal
// ('[]' for blocked_by/tags, dispatch JSON for newly-created tasks). The
// raw input is always a non-null string; we only catch JSON.parse errors.
function jsonParseOr<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function jsonParseOpt<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function rowToAttempt(row: AttemptRow): TaskAttemptRecord {
  return {
    attemptId: row.attempt_id,
    attemptNumber: row.attempt_number,
    runId: row.run_id ?? undefined,
    sessionKey: row.session_key ?? undefined,
    status: row.status as AttemptStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    outputSummary: row.output_summary ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    transcriptPath: row.transcript_path ?? undefined,
    artifactPaths: jsonParseOpt<readonly string[]>(row.artifact_paths),
  };
}

function rowToTask(
  row: TaskRow,
  attempts: readonly TaskAttemptRecord[],
): OrchestratorTaskRecord {
  return {
    id: row.id,
    goalId: row.goal_id,
    name: row.name,
    task: row.task,
    blockedBy: jsonParseOr<readonly string[]>(row.blocked_by, []),
    dispatch: jsonParseOr<TaskDispatch>(row.dispatch, { mode: "manual" }),
    status: row.status as TaskStatus,
    activeRunId: row.active_run_id ?? undefined,
    activeSessionKey: row.active_session_key ?? undefined,
    attemptCount: row.attempt_count,
    failedDispatchCount: row.failed_dispatch_count,
    attempts,
    latestCheckpoint: jsonParseOpt<TaskCheckpointRecord>(row.latest_checkpoint),
    latestOutput: jsonParseOpt<TaskOutputRecord>(row.latest_output),
    priority: row.priority as TaskPriority,
    startedAt: row.started_at ?? undefined,
    readyAt: row.ready_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    retryPolicy:
      (row.retry_policy as "manual_only" | "auto_once" | null) ?? undefined,
    onUpstreamFailure: row.on_upstream_failure as UpstreamFailurePolicy,
    guidance: jsonParseOpt<readonly string[]>(row.guidance),
    tags: jsonParseOr<readonly string[]>(row.tags, []),
    timeoutMs: row.timeout_ms ?? undefined,
    originator: jsonParseOpt<Originator>(row.originator),
  };
}

// ── Public factory ─────────────────────────────────────────────────────────

export type AttemptUpdate = Partial<
  Pick<TaskAttemptRecord, "status" | "endedAt" | "outputSummary" | "failureReason">
>;

export type TasksStore = {
  // Task CRUD
  create(task: OrchestratorTaskRecord): void;
  get(id: string): OrchestratorTaskRecord | undefined;
  update(task: OrchestratorTaskRecord): void;
  listForGoal(goalId: string): OrchestratorTaskRecord[];
  listRunning(): OrchestratorTaskRecord[];
  findByRunId(runId: string): OrchestratorTaskRecord | undefined;
  findBySessionKey(sessionKey: string): OrchestratorTaskRecord | undefined;
  findByName(name: string): OrchestratorTaskRecord | undefined;
  findByStatus(status: TaskStatus): OrchestratorTaskRecord[];
  findBlockedBy(taskId: string): OrchestratorTaskRecord[];
  /** Delete every task for a goal plus their attempts (retention sweep —
   *  there are no FK cascades, so children are removed explicitly).
   *  Returns the number of task rows deleted. */
  deleteByGoal(goalId: string): number;
  // Attempt CRUD
  createAttempt(
    attempt: TaskAttemptRecord & { taskId: string },
  ): void;
  updateAttempt(attemptId: string, updates: AttemptUpdate): void;
  findAttemptByRunId(
    runId: string,
  ): (TaskAttemptRecord & { taskId: string }) | undefined;
};

export function createTasksStore(deps: { db: DatabaseSync }): TasksStore {
  const { db } = deps;

  const insertTask = db.prepare(`
    INSERT INTO tasks
      (id, goal_id, name, task, blocked_by, dispatch, status, active_run_id,
       active_session_key, attempt_count, failed_dispatch_count, latest_checkpoint,
       latest_output, priority, started_at, ready_at, completed_at, failure_reason,
       retry_policy, on_upstream_failure, guidance, tags, timeout_ms, originator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateTaskStmt = db.prepare(`
    UPDATE tasks SET
      name = ?, task = ?, blocked_by = ?, dispatch = ?, status = ?,
      active_run_id = ?, active_session_key = ?, attempt_count = ?,
      failed_dispatch_count = ?, latest_checkpoint = ?, latest_output = ?,
      priority = ?, started_at = ?, ready_at = ?, completed_at = ?,
      failure_reason = ?, retry_policy = ?, on_upstream_failure = ?,
      guidance = ?, tags = ?, timeout_ms = ?
    WHERE id = ?
  `);

  const selectTaskById = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const selectAttemptsForTask = db.prepare(
    "SELECT * FROM attempts WHERE task_id = ? ORDER BY attempt_number ASC",
  );
  const selectTasksForGoal = db.prepare("SELECT * FROM tasks WHERE goal_id = ?");
  const selectRunning = db.prepare(
    "SELECT * FROM tasks WHERE status = 'running'",
  );
  const selectByRunId = db.prepare(
    "SELECT * FROM tasks WHERE active_run_id = ?",
  );
  const selectBySessionExact = db.prepare(
    "SELECT * FROM tasks WHERE active_session_key = ?",
  );
  const selectBySessionSuffix = db.prepare(
    "SELECT * FROM tasks WHERE active_session_key IS NOT NULL AND ? LIKE '%' || active_session_key",
  );
  const selectByName = db.prepare(`
    SELECT * FROM tasks WHERE name = ?
    ORDER BY CASE status
      WHEN 'running' THEN 0
      WHEN 'dispatched' THEN 1
      WHEN 'ready' THEN 2
      WHEN 'awaiting_approval' THEN 3
      WHEN 'pending' THEN 4
      WHEN 'stalled' THEN 5
      WHEN 'failed' THEN 6
      WHEN 'completed' THEN 7
      WHEN 'skipped' THEN 8
      ELSE 9
    END ASC
    LIMIT 1
  `);
  const selectByStatus = db.prepare("SELECT * FROM tasks WHERE status = ?");
  const selectBlockedBy = db.prepare(
    "SELECT * FROM tasks WHERE blocked_by LIKE ?",
  );
  const deleteAttemptsByGoalStmt = db.prepare(
    "DELETE FROM attempts WHERE task_id IN (SELECT id FROM tasks WHERE goal_id = ?)",
  );
  const deleteTasksByGoalStmt = db.prepare(
    "DELETE FROM tasks WHERE goal_id = ?",
  );

  const insertAttempt = db.prepare(`
    INSERT INTO attempts
      (attempt_id, task_id, attempt_number, run_id, session_key, status,
       started_at, ended_at, output_summary, failure_reason, transcript_path,
       artifact_paths)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectAttemptByRunId = db.prepare(
    "SELECT * FROM attempts WHERE run_id = ?",
  );

  function attemptsForTask(taskId: string): TaskAttemptRecord[] {
    const rows = selectAttemptsForTask.all(taskId) as AttemptRow[];
    return rows.map(rowToAttempt);
  }

  function hydrate(row: TaskRow): OrchestratorTaskRecord {
    return rowToTask(row, attemptsForTask(row.id));
  }

  function create(task: OrchestratorTaskRecord): void {
    insertTask.run(
      task.id,
      task.goalId,
      task.name,
      task.task,
      JSON.stringify(task.blockedBy),
      JSON.stringify(task.dispatch),
      task.status,
      task.activeRunId ?? null,
      task.activeSessionKey ?? null,
      task.attemptCount,
      task.failedDispatchCount ?? 0,
      task.latestCheckpoint ? JSON.stringify(task.latestCheckpoint) : null,
      task.latestOutput ? JSON.stringify(task.latestOutput) : null,
      task.priority,
      task.startedAt ?? null,
      task.readyAt ?? null,
      task.completedAt ?? null,
      task.failureReason ?? null,
      task.retryPolicy ?? null,
      task.onUpstreamFailure,
      task.guidance ? JSON.stringify(task.guidance) : null,
      JSON.stringify(task.tags ?? []),
      task.timeoutMs ?? null,
      task.originator ? JSON.stringify(task.originator) : null,
    );
  }

  function get(id: string): OrchestratorTaskRecord | undefined {
    const row = selectTaskById.get(id) as TaskRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function update(task: OrchestratorTaskRecord): void {
    updateTaskStmt.run(
      task.name,
      task.task,
      JSON.stringify(task.blockedBy),
      JSON.stringify(task.dispatch),
      task.status,
      task.activeRunId ?? null,
      task.activeSessionKey ?? null,
      task.attemptCount,
      task.failedDispatchCount ?? 0,
      task.latestCheckpoint ? JSON.stringify(task.latestCheckpoint) : null,
      task.latestOutput ? JSON.stringify(task.latestOutput) : null,
      task.priority,
      task.startedAt ?? null,
      task.readyAt ?? null,
      task.completedAt ?? null,
      task.failureReason ?? null,
      task.retryPolicy ?? null,
      task.onUpstreamFailure,
      task.guidance ? JSON.stringify(task.guidance) : null,
      JSON.stringify(task.tags ?? []),
      task.timeoutMs ?? null,
      task.id,
    );
  }

  function listForGoal(goalId: string): OrchestratorTaskRecord[] {
    return (selectTasksForGoal.all(goalId) as TaskRow[]).map(hydrate);
  }

  function listRunning(): OrchestratorTaskRecord[] {
    return (selectRunning.all() as TaskRow[]).map(hydrate);
  }

  function findByRunId(runId: string): OrchestratorTaskRecord | undefined {
    const row = selectByRunId.get(runId) as TaskRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function findBySessionKey(
    sessionKey: string,
  ): OrchestratorTaskRecord | undefined {
    const exact = selectBySessionExact.get(sessionKey) as TaskRow | undefined;
    if (exact) return hydrate(exact);
    // Suffix match: runtime may prepend "agent:{host}:" to the key the
    // plugin requested. Try matching where the stored key is a suffix of
    // the queried key.
    const suffix = selectBySessionSuffix.get(sessionKey) as TaskRow | undefined;
    return suffix ? hydrate(suffix) : undefined;
  }

  function findByName(name: string): OrchestratorTaskRecord | undefined {
    const row = selectByName.get(name) as TaskRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function findByStatus(status: TaskStatus): OrchestratorTaskRecord[] {
    return (selectByStatus.all(status) as TaskRow[]).map(hydrate);
  }

  function findBlockedBy(taskId: string): OrchestratorTaskRecord[] {
    const rows = selectBlockedBy.all(`%"${taskId}"%`) as TaskRow[];
    return rows.map(hydrate);
  }

  function deleteByGoal(goalId: string): number {
    // Attempts first — they reference tasks and have no FK cascade.
    deleteAttemptsByGoalStmt.run(goalId);
    const result = deleteTasksByGoalStmt.run(goalId);
    return Number(result.changes);
  }

  function createAttempt(
    attempt: TaskAttemptRecord & { taskId: string },
  ): void {
    insertAttempt.run(
      attempt.attemptId,
      attempt.taskId,
      attempt.attemptNumber,
      attempt.runId ?? null,
      attempt.sessionKey ?? null,
      attempt.status,
      attempt.startedAt,
      attempt.endedAt ?? null,
      attempt.outputSummary ?? null,
      attempt.failureReason ?? null,
      attempt.transcriptPath ?? null,
      attempt.artifactPaths ? JSON.stringify(attempt.artifactPaths) : null,
    );
  }

  function updateAttempt(attemptId: string, updates: AttemptUpdate): void {
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    if (updates.status !== undefined) {
      setClauses.push("status = ?");
      values.push(updates.status);
    }
    if (updates.endedAt !== undefined) {
      setClauses.push("ended_at = ?");
      values.push(updates.endedAt);
    }
    if (updates.outputSummary !== undefined) {
      setClauses.push("output_summary = ?");
      values.push(updates.outputSummary);
    }
    if (updates.failureReason !== undefined) {
      setClauses.push("failure_reason = ?");
      values.push(updates.failureReason);
    }
    if (setClauses.length === 0) return;
    values.push(attemptId);
    db.prepare(
      `UPDATE attempts SET ${setClauses.join(", ")} WHERE attempt_id = ?`,
    ).run(...values);
  }

  function findAttemptByRunId(
    runId: string,
  ): (TaskAttemptRecord & { taskId: string }) | undefined {
    const row = selectAttemptByRunId.get(runId) as AttemptRow | undefined;
    if (row === undefined) return undefined;
    return { ...rowToAttempt(row), taskId: row.task_id };
  }

  return {
    create,
    get,
    update,
    listForGoal,
    listRunning,
    findByRunId,
    findBySessionKey,
    findByName,
    findByStatus,
    findBlockedBy,
    deleteByGoal,
    createAttempt,
    updateAttempt,
    findAttemptByRunId,
  };
}
