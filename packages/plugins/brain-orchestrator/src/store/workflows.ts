/**
 * Workflows store — port of upstream task-orchestrator/src/store.ts for
 * workflow templates and their step templates.
 *
 * Two SQL tables (workflow_templates + workflow_step_templates) but exposed
 * as one logical entity per template. Steps are returned in sort_order ASC.
 *
 * deleteWorkflow uses an explicit transaction to delete step rows AND the
 * template row, because the schema's ON DELETE CASCADE is a no-op when
 * PRAGMA foreign_keys is OFF (the upstream default) -- otherwise re-importing
 * the same workflow id later collides on UNIQUE(workflow_id, step_key).
 */

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migrations.js";
import type { Originator } from "./goals.js";
import type {
  TaskDispatch,
  TaskPriority,
  UpstreamFailurePolicy,
} from "./tasks.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type WorkflowVariable = {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly defaultValue?: string;
};

/** Per-template policy for isolating workflow runs onto their own git branch.
 *  Mirrors goals.WorkflowBranchingPolicy; lives here too so workflow imports
 *  don't depend on the goals module's type. */
export type WorkflowBranchingPolicy = {
  readonly repoPath: string;
  readonly baseBranch: string;
  readonly worktreeRoot?: string;
  readonly onSuccess?: "ff-merge" | "tag-only" | "leave";
  readonly namePrefix?: string;
};

export type WorkflowTemplateRecord = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly variables: readonly WorkflowVariable[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
  readonly tags?: readonly string[];
  readonly branching?: WorkflowBranchingPolicy;
  readonly notifyTarget?: Originator;
  /**
   * Where this template was imported from, when it came from a file.
   * Absent for hand-authored templates and for rows imported before the
   * v301 migration. `hash` is the sha256 of the source file's raw bytes at
   * import time — `digital-me doctor` re-hashes the file on disk and
   * compares, which is how a drifted live template becomes visible.
   */
  readonly source?: WorkflowSource;
};

export type WorkflowSource = {
  readonly path: string;
  readonly hash: string;
  /** Version of the package that shipped the file, when known. */
  readonly version?: string;
};

export type WorkflowStepTemplateRecord = {
  readonly id: string;
  readonly workflowId: string;
  readonly stepKey: string;
  readonly name: string;
  readonly promptTemplate: string;
  readonly blockedByKeys: readonly string[];
  readonly dispatch: TaskDispatch;
  readonly priority: TaskPriority;
  readonly retryPolicy?: "manual_only" | "auto_once";
  readonly onUpstreamFailure: UpstreamFailurePolicy;
  readonly sortOrder: number;
  readonly guidance?: readonly string[];
  readonly timeoutMs?: number;
};

// ── Schema migration ──────────────────────────────────────────────────────

const WORKFLOWS_VERSION = 300;
// 800, NOT 301. `runMigrations` tracks a SINGLE global `PRAGMA user_version`
// and skips `m.version <= current`, so a new migration must outrank the highest
// version ever shipped — not sit in its store's numeric block. Numbered 301 it
// sorted under the already-applied 711 (traces), was skipped forever on every
// existing DB, and the store's prepared statements then threw
// "table workflow_templates has no column named source_path" during register(),
// taking the whole plugin down on upgrade. Fresh installs were fine, which is
// why tests missed it. Next migration: pick a number above 800.
const WORKFLOWS_PROVENANCE_VERSION = 800;

export const WORKFLOWS_MIGRATIONS: readonly Migration[] = [
  {
    version: WORKFLOWS_VERSION,
    description: "v300: workflow_templates + workflow_step_templates tables",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_templates (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          variables     TEXT NOT NULL DEFAULT '[]',
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          version       INTEGER NOT NULL DEFAULT 1,
          tags          TEXT NOT NULL DEFAULT '[]',
          branching     TEXT,
          notify_target TEXT
        );
        CREATE TABLE IF NOT EXISTS workflow_step_templates (
          id                  TEXT PRIMARY KEY,
          workflow_id         TEXT NOT NULL,
          step_key            TEXT NOT NULL,
          name                TEXT NOT NULL,
          prompt_template     TEXT NOT NULL,
          blocked_by_keys     TEXT NOT NULL DEFAULT '[]',
          dispatch            TEXT NOT NULL,
          priority            TEXT NOT NULL DEFAULT 'normal',
          retry_policy        TEXT,
          on_upstream_failure TEXT NOT NULL DEFAULT 'wait',
          sort_order          INTEGER NOT NULL DEFAULT 0,
          guidance            TEXT,
          timeout_ms          INTEGER,
          UNIQUE(workflow_id, step_key)
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_steps ON workflow_step_templates(workflow_id);
      `);
    },
  },
  {
    version: WORKFLOWS_PROVENANCE_VERSION,
    description:
      "v301: workflow_templates provenance (source_path/source_hash/source_version)",
    up: (db: DatabaseSync) => {
      // Templates are imported FROM a bundled file but kept no link back to
      // it, so a drifted copy was undetectable. These columns record which
      // file a template was imported from and what it hashed to at the time,
      // which is what `digital-me doctor` compares against on disk.
      // Nullable throughout: rows imported before this migration, and
      // hand-authored templates with no file behind them, legitimately have
      // no provenance.
      for (const col of [
        "source_path TEXT",
        "source_hash TEXT",
        "source_version TEXT",
      ]) {
        try {
          db.exec(`ALTER TABLE workflow_templates ADD COLUMN ${col};`);
        } catch {
          // Column already present (re-run against a partially migrated DB).
        }
      }
    },
  },
];

// ── Row mapping ────────────────────────────────────────────────────────────

type WorkflowRow = {
  id: string;
  name: string;
  description: string;
  variables: string;
  created_at: number;
  updated_at: number;
  version: number;
  tags: string;
  branching: string | null;
  notify_target: string | null;
  source_path: string | null;
  source_hash: string | null;
  source_version: string | null;
};

type WorkflowStepRow = {
  id: string;
  workflow_id: string;
  step_key: string;
  name: string;
  prompt_template: string;
  blocked_by_keys: string;
  dispatch: string;
  priority: string;
  retry_policy: string | null;
  on_upstream_failure: string;
  sort_order: number;
  guidance: string | null;
  timeout_ms: number | null;
};

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

function rowToWorkflow(row: WorkflowRow): WorkflowTemplateRecord {
  // Defensive: legacy rows may have stored variables as '{}' (object)
  // instead of '[]'. Treat any non-array as empty.
  const parsedVars = jsonParseOr<unknown>(row.variables, []);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    variables: Array.isArray(parsedVars)
      ? (parsedVars as WorkflowVariable[])
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    tags: jsonParseOr<readonly string[]>(row.tags, []),
    branching: jsonParseOpt<WorkflowBranchingPolicy>(row.branching),
    notifyTarget: jsonParseOpt<Originator>(row.notify_target),
    source: row.source_path
      ? {
          path: row.source_path,
          hash: row.source_hash ?? "",
          version: row.source_version ?? undefined,
        }
      : undefined,
  };
}

function rowToStep(row: WorkflowStepRow): WorkflowStepTemplateRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    stepKey: row.step_key,
    name: row.name,
    promptTemplate: row.prompt_template,
    blockedByKeys: jsonParseOr<readonly string[]>(row.blocked_by_keys, []),
    dispatch: jsonParseOr<TaskDispatch>(row.dispatch, { mode: "manual" }),
    priority: row.priority as TaskPriority,
    retryPolicy:
      (row.retry_policy as "manual_only" | "auto_once" | null) ?? undefined,
    onUpstreamFailure: row.on_upstream_failure as UpstreamFailurePolicy,
    sortOrder: row.sort_order,
    guidance: jsonParseOpt<readonly string[]>(row.guidance),
    timeoutMs: row.timeout_ms ?? undefined,
  };
}

// ── Public factory ─────────────────────────────────────────────────────────

export type WorkflowsStore = {
  // Template CRUD
  create(template: WorkflowTemplateRecord): void;
  get(id: string): WorkflowTemplateRecord | undefined;
  listAll(): WorkflowTemplateRecord[];
  update(template: WorkflowTemplateRecord): void;
  /** Returns true if a row was deleted, false if id didn't exist. */
  delete(id: string): boolean;
  // Step CRUD
  createStep(step: WorkflowStepTemplateRecord): void;
  listSteps(workflowId: string): WorkflowStepTemplateRecord[];
  deleteSteps(workflowId: string): void;
};

export function createWorkflowsStore(deps: {
  db: DatabaseSync;
}): WorkflowsStore {
  const { db } = deps;

  const insertWorkflow = db.prepare(`
    INSERT INTO workflow_templates
      (id, name, description, variables, created_at, updated_at,
       version, tags, branching, notify_target,
       source_path, source_hash, source_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectById = db.prepare(
    "SELECT * FROM workflow_templates WHERE id = ?",
  );
  const selectAll = db.prepare(
    "SELECT * FROM workflow_templates ORDER BY name ASC",
  );
  const updateStmt = db.prepare(`
    UPDATE workflow_templates SET
      name = ?, description = ?, variables = ?, updated_at = ?, version = ?,
      tags = ?, branching = ?, notify_target = ?,
      source_path = ?, source_hash = ?, source_version = ?
    WHERE id = ?
  `);
  const deleteSteps = db.prepare(
    "DELETE FROM workflow_step_templates WHERE workflow_id = ?",
  );
  const deleteTemplate = db.prepare(
    "DELETE FROM workflow_templates WHERE id = ?",
  );

  const insertStep = db.prepare(`
    INSERT INTO workflow_step_templates
      (id, workflow_id, step_key, name, prompt_template, blocked_by_keys,
       dispatch, priority, retry_policy, on_upstream_failure, sort_order,
       guidance, timeout_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectSteps = db.prepare(
    "SELECT * FROM workflow_step_templates WHERE workflow_id = ? ORDER BY sort_order ASC",
  );

  function create(template: WorkflowTemplateRecord): void {
    insertWorkflow.run(
      template.id,
      template.name,
      template.description,
      JSON.stringify(template.variables),
      template.createdAt,
      template.updatedAt,
      template.version,
      JSON.stringify(template.tags ?? []),
      template.branching ? JSON.stringify(template.branching) : null,
      template.notifyTarget ? JSON.stringify(template.notifyTarget) : null,
      template.source?.path ?? null,
      template.source?.hash ?? null,
      template.source?.version ?? null,
    );
  }

  function get(id: string): WorkflowTemplateRecord | undefined {
    const row = selectById.get(id) as WorkflowRow | undefined;
    return row ? rowToWorkflow(row) : undefined;
  }

  function listAll(): WorkflowTemplateRecord[] {
    return (selectAll.all() as WorkflowRow[]).map(rowToWorkflow);
  }

  function update(template: WorkflowTemplateRecord): void {
    updateStmt.run(
      template.name,
      template.description,
      JSON.stringify(template.variables),
      template.updatedAt,
      template.version,
      JSON.stringify(template.tags ?? []),
      template.branching ? JSON.stringify(template.branching) : null,
      template.notifyTarget ? JSON.stringify(template.notifyTarget) : null,
      template.source?.path ?? null,
      template.source?.hash ?? null,
      template.source?.version ?? null,
      template.id,
    );
  }

  function del(id: string): boolean {
    db.exec("BEGIN");
    try {
      deleteSteps.run(id);
      const result = deleteTemplate.run(id);
      db.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function createStep(step: WorkflowStepTemplateRecord): void {
    insertStep.run(
      step.id,
      step.workflowId,
      step.stepKey,
      step.name,
      step.promptTemplate,
      JSON.stringify(step.blockedByKeys),
      JSON.stringify(step.dispatch),
      step.priority,
      step.retryPolicy ?? null,
      step.onUpstreamFailure,
      step.sortOrder,
      step.guidance ? JSON.stringify(step.guidance) : null,
      step.timeoutMs ?? null,
    );
  }

  function listSteps(workflowId: string): WorkflowStepTemplateRecord[] {
    return (selectSteps.all(workflowId) as WorkflowStepRow[]).map(rowToStep);
  }

  function deleteStepsFn(workflowId: string): void {
    deleteSteps.run(workflowId);
  }

  return {
    create,
    get,
    listAll,
    update,
    delete: del,
    createStep,
    listSteps,
    deleteSteps: deleteStepsFn,
  };
}
