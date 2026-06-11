/**
 * Dashboard DB migration — runs the NUX scope-down §B schema change.
 *
 * Drops the 7 legacy tables (goal_metrics, daily_metric_activity,
 * daily_agent_activity, issues, feedback, insights, cron_runs) and creates
 * the 7 new ones backing the 4-metric digital-me dashboard view + Delivery feed:
 *
 *   - daa                          (Metric #1)
 *   - knowledge_taste_changes      (Metric #2 left+right)
 *   - knowledge_taste_distribution (Metric #4 radar)
 *   - application_rate             (Metric #3 axes)
 *   - application_rate_by_domain   (Metric #3 tooltip per-domain)
 *   - application_rate_by_agent    (Metric #3 tooltip per-agent)
 *   - activity                     (Delivery feed — captured/applied/workflow)
 *
 * Idempotent: re-running drops then re-creates, so a fresh sqlite file
 * and one that already has the new schema both converge to the same state.
 *
 * NOTE: `dashboard_intake` Python modules read this DB via stdlib sqlite3.
 * Keep the schema definitions copyable between TS and Python (use only
 * standard SQL types, avoid better-sqlite3-specific syntax).
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Statements that drop the legacy schema. Run before CREATE TABLEs. */
const DROP_LEGACY: ReadonlyArray<string> = [
  "DROP TABLE IF EXISTS goal_metrics",
  "DROP TABLE IF EXISTS daily_metric_activity",
  "DROP TABLE IF EXISTS daily_agent_activity",
  "DROP TABLE IF EXISTS issues",
  "DROP TABLE IF EXISTS feedback",
  "DROP TABLE IF EXISTS insights",
  "DROP TABLE IF EXISTS cron_runs",
];

/** Tables superseded by a LATER schema revision (post-NUX-cutover). These are
 *  dropped in the same migration transaction but deliberately excluded from
 *  LEGACY_TABLE_NAMES: they don't represent a pre-NUX DB, so their presence
 *  must NOT trigger the destructive-cutover snapshot on every existing install.
 *
 *  - learning_capture → superseded by `activity` (the Delivery view moved from
 *    a single learning-capture stream to a unified captured/applied/workflow
 *    feed, populated by the stream_activity intake step). It was always empty
 *    (the old intake never worked), so dropping it loses nothing. */
const DROP_SUPERSEDED: ReadonlyArray<string> = [
  "DROP TABLE IF EXISTS learning_capture",
];

/** Bare table names the cutover drops — used to detect a real (destructive)
 *  cutover so we can snapshot the DB before dropping anything. */
const LEGACY_TABLE_NAMES: ReadonlyArray<string> = DROP_LEGACY.map((s) =>
  s.replace("DROP TABLE IF EXISTS ", ""),
);

/** DDL for the 7 new tables. Order matters only insofar as a future FK
 *  might reference a parent — currently there are none, so any order works. */
const CREATE_NEW: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS daa (
     agent_id   TEXT NOT NULL,
     date       TEXT NOT NULL,
     sessions   INTEGER NOT NULL DEFAULT 0,
     is_active  INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (agent_id, date)
   )`,
  `CREATE TABLE IF NOT EXISTS knowledge_taste_changes (
     date     TEXT NOT NULL,
     tree     TEXT NOT NULL,
     domain   TEXT NOT NULL,
     created  INTEGER NOT NULL DEFAULT 0,
     updated  INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (date, tree, domain)
   )`,
  `CREATE TABLE IF NOT EXISTS knowledge_taste_distribution (
     tree     TEXT NOT NULL,
     domain   TEXT NOT NULL,
     total    INTEGER NOT NULL DEFAULT 0,
     as_of    TEXT NOT NULL,
     PRIMARY KEY (tree, domain)
   )`,
  `CREATE TABLE IF NOT EXISTS application_rate (
     date              TEXT NOT NULL,
     tree              TEXT NOT NULL,
     surfaced_unique   INTEGER NOT NULL DEFAULT 0,
     acted_unique      INTEGER NOT NULL DEFAULT 0,
     rate              REAL,
     PRIMARY KEY (date, tree)
   )`,
  `CREATE TABLE IF NOT EXISTS application_rate_by_domain (
     date              TEXT NOT NULL,
     tree              TEXT NOT NULL,
     domain            TEXT NOT NULL,
     surfaced_unique   INTEGER NOT NULL DEFAULT 0,
     acted_unique      INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (date, tree, domain)
   )`,
  `CREATE TABLE IF NOT EXISTS application_rate_by_agent (
     date              TEXT NOT NULL,
     tree              TEXT NOT NULL,
     agent_id          TEXT NOT NULL,
     surfaced_unique   INTEGER NOT NULL DEFAULT 0,
     acted_unique      INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (date, tree, agent_id)
   )`,
  // Delivery view — unified agent-activity feed. One row per source event
  // (learning_captured trace / knowledge_surfaced m1 event / started goal).
  // `id` is the source-event id so the stream_activity intake can UPSERT
  // idempotently. `activity` ∈ {captured, applied, workflow, taste}.
  //
  // `attachments` is a JSON array of the learnings carried by this event:
  // `[{title, path, markdown}]`. An applied event that recalled N learnings
  // gets N entries (separately previewable in the Feed); a captured event gets
  // one. `markdown` is the snapshotted `.md` content the preview panel renders,
  // so the feed stays offline-resilient (no live wiki read on the request path).
  `CREATE TABLE IF NOT EXISTS activity (
     id           TEXT PRIMARY KEY,
     ts           TEXT NOT NULL,
     agent_id     TEXT NOT NULL,
     activity     TEXT NOT NULL,
     title        TEXT NOT NULL,
     description  TEXT,
     meta         TEXT,
     attachments  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS activity_kind_ts ON activity(activity, ts DESC)`,
];

/** Add `col` to `table` if it isn't already present. SQLite lacks
 *  `ADD COLUMN IF NOT EXISTS`, so we probe `PRAGMA table_info` first; this
 *  keeps `migrate()` idempotent across schema revisions. */
function ensureColumn(
  db: Database.Database,
  table: string,
  col: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

export type MigrateResult = {
  dbPath: string;
  droppedLegacy: number;
  createdNew: number;
  /** Absolute path of the pre-cutover snapshot, if one was taken (only when a
   *  populated legacy DB is being migrated destructively). Restore with
   *  `cp <backupPath> <dbPath>` after stopping the dashboard. */
  backupPath?: string;
};

/**
 * Run the migration. Creates parent dirs if needed.
 *
 * @param dbPath absolute path to the sqlite file (e.g.
 *   `~/digital-me/.data/dashboard.db`).
 * @param opts.keepLegacy if true, skips the DROP step (use for staging
 *   environments where the old tables still feed something). Default false.
 */
export function migrate(
  dbPath: string,
  opts: { readonly keepLegacy?: boolean } = {},
): MigrateResult {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Rollback safety: if this is a real cutover (the DB still carries legacy
  // tables we're about to DROP), snapshot the whole DB first via VACUUM INTO
  // (a consistent copy that folds in any WAL content). A fresh/already-migrated
  // DB has no legacy tables, so this is a no-op on the common path.
  let backupPath: string | undefined;
  if (!opts.keepLegacy) {
    const placeholders = LEGACY_TABLE_NAMES.map(() => "?").join(",");
    const present = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`,
      )
      .all(...LEGACY_TABLE_NAMES) as Array<{ name: string }>;
    if (present.length > 0) {
      const candidate = `${dbPath}.pre-cutover.bak`;
      if (!existsSync(candidate)) {
        db.exec(`VACUUM INTO '${candidate.replace(/'/g, "''")}'`);
        backupPath = candidate;
      } else {
        backupPath = candidate; // earlier snapshot already preserved
      }
    }
  }

  const tx = db.transaction(() => {
    let dropped = 0;
    if (!opts.keepLegacy) {
      for (const sql of DROP_LEGACY) {
        db.exec(sql);
        dropped++;
      }
    }
    // Superseded-table drops run unconditionally (not gated on keepLegacy):
    // they aren't part of the staged-cutover set, just stale schema to retire.
    for (const sql of DROP_SUPERSEDED) {
      db.exec(sql);
      dropped++;
    }
    let created = 0;
    for (const sql of CREATE_NEW) {
      db.exec(sql);
      created++;
    }
    // Additive column migrations for DBs created before a column existed.
    // CREATE TABLE IF NOT EXISTS above is a no-op on an existing table, so new
    // columns must be added with a guarded ALTER (SQLite has no ADD COLUMN IF
    // NOT EXISTS). Idempotent: skipped once the column is present.
    ensureColumn(db, "activity", "attachments", "TEXT");
    return { dropped, created };
  });

  const { dropped, created } = tx();
  db.close();
  return { dbPath, droppedLegacy: dropped, createdNew: created, backupPath };
}

/** CLI entry: `tsx migrate.ts <dbPath>` */
async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("usage: tsx migrate.ts <db-path>");
    process.exit(2);
  }
  const result = migrate(dbPath);
  console.log(`migrate: ${result.dbPath}`);
  if (result.backupPath) {
    console.log(`  backup:  ${result.backupPath} (pre-cutover snapshot — restore with 'cp' to roll back)`);
  }
  console.log(`  dropped: ${result.droppedLegacy} legacy table(s)`);
  console.log(`  created: ${result.createdNew} statement(s) ` +
              `(7 tables + 2 indexes)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
