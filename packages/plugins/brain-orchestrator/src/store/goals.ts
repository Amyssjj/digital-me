/**
 * Goals store — port of upstream `task-orchestrator`'s goal-related methods
 * from src/store.ts into a per-domain module.
 *
 * The goal entity is the parent of tasks. Schema fields preserve every
 * upstream column so existing data files load without migration churn.
 * The `taskIds` field is computed at read time by joining against the
 * tasks table (this cross-entity read is preserved from upstream; the
 * tasks store owns the canonical task rows).
 *
 * Status-vocabulary validation is type-scoped (project vs evergreen) —
 * matches upstream's `assertValidGoalStatusForType` guard.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migrations.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type ProjectGoalStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type EvergreenGoalStatus =
  | "healthy"
  | "degraded"
  | "paused"
  | "retired";

export type GoalStatus = ProjectGoalStatus | EvergreenGoalStatus;
export type GoalType = "project" | "evergreen";

/**
 * Per-template policy for isolating workflow runs onto their own git branch.
 * Carried opaquely by the goals store — interpretation lives in the
 * workflow-branching plugin (planned C9 extraction).
 */
export type WorkflowBranchingPolicy = {
  readonly repoPath: string;
  readonly baseBranch: string;
  readonly worktreeRoot?: string;
  readonly onSuccess?: "ff-merge" | "tag-only" | "leave";
  readonly namePrefix?: string;
};

/**
 * Chat-channel binding attached to a goal at creation time. Routed through
 * dispatch so spawned subagents can deliver approval prompts back to the
 * originating chat surface. Stored opaquely as JSON by the goals store;
 * shape interpretation is the dispatch layer's responsibility.
 *
 * NOTE: this matches upstream's `Originator` type verbatim for parity.
 * A planned future refactor (C6) replaces this with a generic
 * `DispatchContext { routingKey }` so the goals schema doesn't embed
 * chat-platform concepts.
 */
export type Originator = {
  readonly channel: string;
  readonly to?: string;
  readonly accountId: string;
  readonly threadId?: string;
};

export type GoalRecord = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: GoalStatus;
  readonly type?: GoalType;
  readonly parentGoalId?: string;
  readonly taskIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly createdBy: string;
  readonly sourceWorkflowId?: string;
  readonly sourceWorkflowVersion?: number;
  readonly branchName?: string;
  readonly worktreePath?: string;
  readonly branchingPolicy?: WorkflowBranchingPolicy;
  readonly originator?: Originator;
};

// ── Status validation (matches upstream assertValidGoalStatusForType) ──────

const PROJECT_STATUSES: ReadonlySet<string> = new Set<ProjectGoalStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const EVERGREEN_STATUSES: ReadonlySet<string> = new Set<EvergreenGoalStatus>([
  "healthy",
  "degraded",
  "paused",
  "retired",
]);

function assertValidGoalStatusForType(type: GoalType, status: string): void {
  const ok =
    type === "project"
      ? PROJECT_STATUSES.has(status)
      : EVERGREEN_STATUSES.has(status);
  if (!ok) {
    throw new Error(`Invalid status "${status}" for goal type "${type}"`);
  }
}

// ── Schema migration ───────────────────────────────────────────────────────

const GOALS_VERSION = 100;

export const GOALS_MIGRATIONS: readonly Migration[] = [
  {
    version: GOALS_VERSION,
    description: "v100: goals table (project + evergreen)",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS goals (
          id                      TEXT PRIMARY KEY,
          name                    TEXT NOT NULL,
          description             TEXT NOT NULL,
          status                  TEXT NOT NULL DEFAULT 'pending',
          type                    TEXT NOT NULL DEFAULT 'project',
          parent_goal_id          TEXT,
          created_at              INTEGER NOT NULL,
          updated_at              INTEGER NOT NULL,
          completed_at            INTEGER,
          created_by              TEXT NOT NULL,
          source_workflow_id      TEXT,
          source_workflow_version INTEGER,
          branch_name             TEXT,
          worktree_path           TEXT,
          branching_policy        TEXT,
          originator              TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
        CREATE INDEX IF NOT EXISTS idx_goals_type ON goals(type);
        CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_goal_id);
        CREATE INDEX IF NOT EXISTS idx_goals_workflow ON goals(source_workflow_id);
      `);
    },
  },
];

// ── Row mapping ────────────────────────────────────────────────────────────

type GoalRow = {
  id: string;
  name: string;
  description: string;
  status: string;
  // Column is `NOT NULL DEFAULT 'project'`, so always a string after migration.
  type: string;
  parent_goal_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  created_by: string;
  source_workflow_id: string | null;
  source_workflow_version: number | null;
  branch_name: string | null;
  worktree_path: string | null;
  branching_policy: string | null;
  originator: string | null;
};

function jsonParseOpt<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function rowToGoal(row: GoalRow, taskIds: readonly string[]): GoalRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as GoalStatus,
    type: row.type as GoalType,
    parentGoalId: row.parent_goal_id ?? undefined,
    taskIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    createdBy: row.created_by,
    sourceWorkflowId: row.source_workflow_id ?? undefined,
    sourceWorkflowVersion: row.source_workflow_version ?? undefined,
    branchName: row.branch_name ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    branchingPolicy: jsonParseOpt<WorkflowBranchingPolicy>(row.branching_policy),
    originator: jsonParseOpt<Originator>(row.originator),
  };
}

// ── Public factory ─────────────────────────────────────────────────────────

export type GoalsStore = {
  create(goal: GoalRecord): void;
  get(id: string): GoalRecord | undefined;
  listAll(): GoalRecord[];
  listActive(): GoalRecord[];
  listEvergreen(): GoalRecord[];
  findActiveByWorkflow(workflowId: string): GoalRecord[];
  /** Ids of completed/failed project goals for a workflow whose completion
   *  (falling back to updated_at) predates `completedBefore`. Restricted to
   *  goals with the given `created_by` (the scheduler stamps "scheduler") so
   *  manual `run_workflow` goals of the same template are never returned.
   *  Bare ids — no task hydration — so the retention sweep stays cheap on
   *  large tables. */
  findTerminalIdsByWorkflowBefore(
    workflowId: string,
    completedBefore: number,
  ): string[];
  listChildren(parentGoalId: string): GoalRecord[];
  /** Count existing goals whose branch_name starts with the given prefix.
   *  Used to compute the next sequence number for workflow branch names. */
  countByBranchPrefix(prefix: string): number;
  updateStatus(id: string, status: GoalStatus, completedAt?: number): void;
  setBranch(
    id: string,
    branchName: string,
    worktreePath: string,
    policy?: WorkflowBranchingPolicy,
  ): void;
  delete(id: string): void;
  setStatusChangeCallback(
    cb: (id: string, from: GoalStatus, to: GoalStatus) => void,
  ): void;
};

export function createGoalsStore(deps: {
  db: DatabaseSync;
  now?: () => number;
}): GoalsStore {
  const { db } = deps;
  const now = deps.now ?? ((): number => Date.now());

  let statusChangeCallback:
    | ((id: string, from: GoalStatus, to: GoalStatus) => void)
    | null = null;

  const insertGoal = db.prepare(`
    INSERT INTO goals
      (id, name, description, status, type, parent_goal_id, created_at,
       updated_at, completed_at, created_by, source_workflow_id,
       source_workflow_version, branch_name, worktree_path,
       branching_policy, originator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectById = db.prepare("SELECT * FROM goals WHERE id = ?");
  const selectTaskIds = db.prepare(
    "SELECT id FROM tasks WHERE goal_id = ?",
  );
  const selectAll = db.prepare(
    "SELECT * FROM goals ORDER BY created_at DESC",
  );
  const selectActive = db.prepare(
    "SELECT * FROM goals WHERE status IN ('pending', 'running') AND type = 'project' ORDER BY created_at DESC",
  );
  const selectEvergreen = db.prepare(
    "SELECT * FROM goals WHERE type = 'evergreen' AND status != 'retired' ORDER BY id ASC",
  );
  const selectActiveByWorkflow = db.prepare(
    "SELECT * FROM goals WHERE source_workflow_id = ? AND status IN ('pending', 'running') AND type = 'project' ORDER BY created_at ASC",
  );
  const selectTerminalIdsByWorkflowBefore = db.prepare(
    "SELECT id FROM goals WHERE source_workflow_id = ? AND status IN ('completed', 'failed') AND type = 'project' AND COALESCE(completed_at, updated_at) < ?",
  );
  const selectChildren = db.prepare(
    "SELECT * FROM goals WHERE parent_goal_id = ? ORDER BY created_at ASC",
  );
  const countByBranchPrefixStmt = db.prepare(
    "SELECT COUNT(*) as c FROM goals WHERE branch_name LIKE ?",
  );
  const selectStatusAndType = db.prepare(
    "SELECT type, status FROM goals WHERE id = ?",
  );
  const updateStatusStmt = db.prepare(
    "UPDATE goals SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?",
  );
  const setBranchStmt = db.prepare(
    "UPDATE goals SET branch_name = ?, worktree_path = ?, branching_policy = COALESCE(?, branching_policy), updated_at = ? WHERE id = ?",
  );
  const deleteStmt = db.prepare("DELETE FROM goals WHERE id = ?");

  function getTaskIds(goalId: string): string[] {
    const rows = selectTaskIds.all(goalId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  function hydrate(row: GoalRow): GoalRecord {
    return rowToGoal(row, getTaskIds(row.id));
  }

  function create(goal: GoalRecord): void {
    const type: GoalType = goal.type ?? "project";
    assertValidGoalStatusForType(type, goal.status);
    insertGoal.run(
      goal.id,
      goal.name,
      goal.description,
      goal.status,
      type,
      goal.parentGoalId ?? null,
      goal.createdAt,
      goal.updatedAt,
      goal.completedAt ?? null,
      goal.createdBy,
      goal.sourceWorkflowId ?? null,
      goal.sourceWorkflowVersion ?? null,
      goal.branchName ?? null,
      goal.worktreePath ?? null,
      goal.branchingPolicy ? JSON.stringify(goal.branchingPolicy) : null,
      goal.originator ? JSON.stringify(goal.originator) : null,
    );
  }

  function get(id: string): GoalRecord | undefined {
    const row = selectById.get(id) as GoalRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function listAll(): GoalRecord[] {
    return (selectAll.all() as GoalRow[]).map(hydrate);
  }

  function listActive(): GoalRecord[] {
    return (selectActive.all() as GoalRow[]).map(hydrate);
  }

  function listEvergreen(): GoalRecord[] {
    return (selectEvergreen.all() as GoalRow[]).map(hydrate);
  }

  function findActiveByWorkflow(workflowId: string): GoalRecord[] {
    return (selectActiveByWorkflow.all(workflowId) as GoalRow[]).map(hydrate);
  }

  function findTerminalIdsByWorkflowBefore(
    workflowId: string,
    completedBefore: number,
  ): string[] {
    const rows = selectTerminalIdsByWorkflowBefore.all(
      workflowId,
      completedBefore,
    ) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  function listChildren(parentGoalId: string): GoalRecord[] {
    return (selectChildren.all(parentGoalId) as GoalRow[]).map(hydrate);
  }

  function countByBranchPrefix(prefix: string): number {
    const row = countByBranchPrefixStmt.get(`${prefix}%`) as { c: number };
    return row.c;
  }

  function updateStatus(
    id: string,
    status: GoalStatus,
    completedAt?: number,
  ): void {
    const existing = selectStatusAndType.get(id) as
      | { type: string; status: string }
      | undefined;
    if (existing === undefined) return; // unknown id: no-op (matches upstream)
    const goalType = existing.type as GoalType;
    assertValidGoalStatusForType(goalType, status);
    const fromStatus = existing.status as GoalStatus;
    updateStatusStmt.run(status, now(), completedAt ?? null, id);
    if (fromStatus !== status && statusChangeCallback !== null) {
      try {
        statusChangeCallback(id, fromStatus, status);
      } catch {
        // Observer errors must not propagate -- a buggy callback can't
        // corrupt store state.
      }
    }
  }

  function setBranch(
    id: string,
    branchName: string,
    worktreePath: string,
    policy?: WorkflowBranchingPolicy,
  ): void {
    setBranchStmt.run(
      branchName,
      worktreePath,
      policy ? JSON.stringify(policy) : null,
      now(),
      id,
    );
  }

  function del(id: string): void {
    deleteStmt.run(id);
  }

  function setStatusChangeCallback(
    cb: (id: string, from: GoalStatus, to: GoalStatus) => void,
  ): void {
    statusChangeCallback = cb;
  }

  return {
    create,
    get,
    listAll,
    listActive,
    listEvergreen,
    findActiveByWorkflow,
    findTerminalIdsByWorkflowBefore,
    listChildren,
    countByBranchPrefix,
    updateStatus,
    setBranch,
    delete: del,
    setStatusChangeCallback,
  };
}
