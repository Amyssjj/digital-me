/**
 * `digital-me migrate` — one-shot DB migrator from upstream's
 * `task-orchestrator.db` to brain-orchestrator's `brain.db`.
 *
 * brain-orchestrator's schema is a faithful port of upstream — same
 * tables, same column names, same JSON shapes for `dispatch`,
 * `attempts`, `latest_checkpoint`, `latest_output`, etc. The migration
 * is therefore mostly `INSERT OR IGNORE INTO target SELECT … FROM source`
 * per table, plus a few defensive column-mapping helpers for fields
 * that may not exist in older upstream rows.
 *
 * Idempotent: re-running picks up only rows that don't already exist
 * in the target (by primary key). Source DB is read-only — the migrator
 * never modifies it.
 *
 * Pure data layer: takes a `DatabaseSync` pair, returns row counts.
 * The CLI binary handles fs paths + the actual `new DatabaseSync()`
 * calls (so this stays unit-testable with in-memory DBs).
 */

import type { DatabaseSync } from "node:sqlite";

/** Per-table migration result. */
export type TableResult = {
  readonly table: string;
  readonly sourceCount: number;
  readonly inserted: number;
  readonly skipped: number;
};

export type MigrateReport = {
  readonly tables: readonly TableResult[];
  readonly totalInserted: number;
  readonly totalSkipped: number;
};

/**
 * Ordered table-migration list. Order matters for foreign-key sanity:
 * goals before tasks (tasks reference goal_id), workflow_templates
 * before workflow_step_templates, etc.
 */
const TABLE_PLAN: readonly {
  readonly name: string;
  readonly columns: readonly string[];
}[] = [
  {
    name: "goals",
    columns: [
      "id", "name", "description", "status", "type", "created_at",
      "updated_at", "created_by", "completed_at", "parent_goal_id",
      "source_workflow_id", "source_workflow_version", "branch_name",
      "worktree_path", "branching_policy", "originator",
    ],
  },
  {
    name: "tasks",
    columns: [
      "id", "goal_id", "name", "task", "blocked_by", "dispatch",
      "status", "started_at", "completed_at", "attempt_count",
      "active_run_id", "active_session_key", "failure_reason",
      "priority", "retry_policy", "on_upstream_failure",
      "latest_checkpoint", "latest_output", "guidance", "timeout_ms",
      "tags", "ready_at", "failed_dispatch_count", "originator",
    ],
  },
  {
    name: "attempts",
    columns: [
      "attempt_id", "task_id", "attempt_number", "run_id", "session_key",
      "status", "started_at", "ended_at", "output_summary",
      "failure_reason", "transcript_path", "artifact_paths",
    ],
  },
  {
    name: "workflow_templates",
    columns: [
      "id", "name", "description", "variables", "created_at",
      "updated_at", "version", "tags", "branching", "notify_target",
    ],
  },
  {
    name: "workflow_step_templates",
    columns: [
      "id", "workflow_id", "step_key", "name", "prompt_template",
      "blocked_by_keys", "dispatch", "priority", "retry_policy",
      "on_upstream_failure", "sort_order", "guidance", "timeout_ms",
    ],
  },
  {
    name: "schedules",
    columns: [
      "id", "workflow_id", "name", "cron_expr", "timezone", "variables",
      "enabled", "next_run_at", "last_run_at", "last_goal_id",
      "last_status", "max_overlap", "created_at", "updated_at",
    ],
  },
  {
    name: "brain_agents",
    columns: [
      "agent_id", "runtime", "version", "capabilities", "first_seen_at",
      "last_seen_at", "session_token", "token_expires_at",
    ],
  },
  {
    name: "learnings",
    columns: [
      "id", "agent_id", "kind", "text", "why", "apply_when",
      "source_context", "confidence", "proposed_wiki_path", "created_at",
    ],
  },
  {
    name: "traces",
    columns: [
      "id", "agent_id", "kind", "payload", "task_id", "goal_id",
      "duration_ms", "t",
    ],
  },
];

/**
 * Build the SELECT statement for a single table. Picks only the
 * canonical columns brain-orchestrator's schema declares, ignoring any
 * stray columns upstream may have added.
 *
 * For columns missing in the source DB, returns NULL — so older
 * upstream rows without the newer columns (e.g. `ready_at`,
 * `failed_dispatch_count`) migrate cleanly.
 */
export function buildSelect(
  sourceCols: ReadonlySet<string>,
  table: { name: string; columns: readonly string[] },
): string {
  const exprs = table.columns.map((c) =>
    sourceCols.has(c) ? c : `NULL AS ${c}`,
  );
  return `SELECT ${exprs.join(", ")} FROM ${table.name}`;
}

export function buildInsert(table: {
  name: string;
  columns: readonly string[];
}): string {
  const cols = table.columns.join(", ");
  const placeholders = table.columns.map(() => "?").join(", ");
  return `INSERT OR IGNORE INTO ${table.name} (${cols}) VALUES (${placeholders})`;
}

function sourceColumnSet(
  source: DatabaseSync,
  table: string,
): ReadonlySet<string> {
  const rows = source
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Run the migration. Source must already exist; target must already
 * have brain-orchestrator's migrations applied (run before calling
 * this).
 */
export function migrateBrainDb(deps: {
  readonly source: DatabaseSync;
  readonly target: DatabaseSync;
}): MigrateReport {
  const results: TableResult[] = [];
  for (const table of TABLE_PLAN) {
    const sourceCols = sourceColumnSet(deps.source, table.name);
    if (sourceCols.size === 0) {
      // Table missing in source — skip with a zero result.
      results.push({
        table: table.name,
        sourceCount: 0,
        inserted: 0,
        skipped: 0,
      });
      continue;
    }
    const select = buildSelect(sourceCols, table);
    const insert = deps.target.prepare(buildInsert(table));
    const sourceRows = deps.source.prepare(select).all() as Array<
      Record<string, unknown>
    >;
    let inserted = 0;
    let skipped = 0;
    deps.target.exec("BEGIN");
    try {
      for (const row of sourceRows) {
        const values = table.columns.map((c) => row[c] ?? null);
        const result = insert.run(...(values as (string | number | null)[]));
        if (Number(result.changes) > 0) {
          inserted++;
        } else {
          skipped++;
        }
      }
      deps.target.exec("COMMIT");
    } catch (err) {
      deps.target.exec("ROLLBACK");
      throw err;
    }
    results.push({
      table: table.name,
      sourceCount: sourceRows.length,
      inserted,
      skipped,
    });
  }
  const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
  const totalSkipped = results.reduce((s, r) => s + r.skipped, 0);
  return { tables: results, totalInserted, totalSkipped };
}

export function formatReport(report: MigrateReport): string {
  const lines: string[] = ["", "Migration report:"];
  for (const t of report.tables) {
    lines.push(
      `  ${t.table.padEnd(28)} source=${String(t.sourceCount).padStart(5)} inserted=${String(t.inserted).padStart(5)} skipped=${String(t.skipped).padStart(5)}`,
    );
  }
  lines.push("");
  lines.push(
    `Totals: inserted=${report.totalInserted} skipped=${report.totalSkipped}`,
  );
  return lines.join("\n");
}

// Exported for tests + advanced callers that want to seed a custom
// table list (e.g. to migrate ONLY learnings + traces).
export { TABLE_PLAN };
