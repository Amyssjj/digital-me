/**
 * Migration runner with `PRAGMA user_version` tracking.
 *
 * Replaces the upstream task-orchestrator pattern of "call migrate() in the
 * store constructor; have it run 10+ inline `addColumnIfMissing()` calls
 * whose order is implicit". This module makes migrations explicit:
 *
 *   - Each schema change is a `Migration` object with a `version`, a
 *     `description`, and an `up(db)` callback.
 *   - Modules register their migrations at module load via `registerMigration`.
 *   - `runMigrations(db)` reads `PRAGMA user_version`, applies every
 *     un-applied migration in ascending version order, and advances the
 *     pragma after each successful migration so a mid-batch failure leaves
 *     the DB on the last applied version (resumable).
 *
 * Discipline:
 *   - Versions are positive integers; gaps are allowed (e.g., 100-199 for
 *     core entities, 200-299 for the operational-telemetry families).
 *   - `up()` should be idempotent where possible (`CREATE TABLE IF NOT
 *     EXISTS`) since the runner won't re-invoke an applied migration, but
 *     defensive idempotency makes recovery from a partially-applied state
 *     cheaper.
 *   - No `down()` migrations — additive only. SQLite makes column drops
 *     painful; we avoid them by convention.
 */

import type { DatabaseSync } from "node:sqlite";

export type Migration = {
  /** Monotonically increasing positive integer. Sorts apply order. */
  readonly version: number;
  /** Human-readable short summary, surfaces in failure messages and logs. */
  readonly description: string;
  /** Idempotent DDL operation. Receives the live DB connection. */
  readonly up: (db: DatabaseSync) => void;
};

const REGISTRY: Map<number, Migration> = new Map();

/**
 * Register a migration. Idempotent under duplicate registration only
 * via `resetMigrationRegistryForTests` — at runtime, two migrations with
 * the same version are a programming error.
 */
export function registerMigration(m: Migration): void {
  if (
    !Number.isInteger(m.version) ||
    m.version <= 0
  ) {
    throw new Error(
      `migration.version must be a positive integer, got ${m.version}`,
    );
  }
  if (REGISTRY.has(m.version)) {
    throw new Error(
      `duplicate migration for version ${m.version} (existing: "${REGISTRY.get(m.version)!.description}", new: "${m.description}")`,
    );
  }
  REGISTRY.set(m.version, m);
}

/**
 * Apply every registered migration whose version exceeds the DB's current
 * `PRAGMA user_version`. After each successful migration, advance the
 * pragma so a later failure doesn't roll the DB back to an earlier state.
 *
 * Throws on the first migration that throws; the DB's user_version reflects
 * the last successful migration.
 */
export function runMigrations(db: DatabaseSync): void {
  const currentRow = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  const current = currentRow.user_version;
  const sorted = [...REGISTRY.values()].sort((a, b) => a.version - b.version);
  for (const m of sorted) {
    if (m.version <= current) continue;
    m.up(db);
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
}

/**
 * Test-only helper: wipe the in-memory migration registry. Production code
 * should never call this — registrations happen once at module load.
 */
export function resetMigrationRegistryForTests(): void {
  REGISTRY.clear();
}
