/**
 * Drift Status — live system health checks for the Mechanism view.
 *
 * Sanitized rewrite of the original mission-control/server/drift-status.ts.
 * All file-system, database, and home-directory accesses are injected at
 * call time (no globals, no hardcoded paths). The pure decision functions
 * — `resolveHomePath`, `detectDrift`, `computeOverallHealth` — are exported
 * for testing and reuse.
 *
 * Public entry point is `buildSystemStatus`, which composes the individual
 * checks. Callers from the HTTP layer pass the resolved `homeDir`, `dbPath`,
 * and a clock function so the result is deterministic and testable.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

// Vite/vitest doesn't recognize experimental node:sqlite as a builtin
// (it's not in `module.builtinModules`); use createRequire so Node's loader
// resolves it at runtime instead of letting Vite try to bundle.
const require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = require("node:sqlite") as typeof import("node:sqlite");

// ── Types ───────────────────────────────────────────────────────────────────

export type SkillEntry = {
  readonly name: string;
  readonly location: string;
  readonly role: string;
};

export type SkillCheck = {
  readonly name: string;
  readonly path: string;
  readonly exists: boolean;
  readonly role: string;
};

export type FileCheck = {
  readonly name: string;
  readonly path: string;
  readonly exists: boolean;
  readonly lastModified: string | null;
};

export type CronJobCheck = {
  readonly name: string;
  readonly lastRun: string | null;
  readonly lastSuccess: boolean | null;
  readonly recentSuccessRate: number | null;
  readonly totalRuns: number;
};

export type DbTableCheck = {
  readonly name: string;
  readonly exists: boolean;
  readonly rowCount: number;
  readonly lastEntry: string | null;
};

export type DriftSeverity = "error" | "warning" | "info";

export type DriftIssue = {
  readonly type: string;
  readonly severity: DriftSeverity;
  readonly message: string;
};

export type OverallHealth = "healthy" | "degraded" | "unhealthy";

export type SkillsConfig = {
  readonly skills: readonly SkillEntry[];
  readonly liveChecks: {
    readonly cronJobs?: readonly string[];
    readonly files?: readonly string[];
    readonly dbTables?: readonly string[];
  };
};

export type SystemStatus = {
  readonly checkedAt: string;
  readonly overallHealth: OverallHealth;
  readonly skills: readonly SkillCheck[];
  readonly files: readonly FileCheck[];
  readonly cronJobs: readonly CronJobCheck[];
  readonly dbTables: readonly DbTableCheck[];
  readonly drift: readonly DriftIssue[];
};

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Expand a leading `~/` or `~\` to the provided home directory. Other paths
 * pass through unchanged. The bare `~` without a separator is not expanded
 * (matches the upstream behavior of preserving usernames like `~tilde-user`).
 */
export function resolveHomePath(p: string, homeDir: string): string {
  if (p.startsWith("~/")) return path.join(homeDir, p.slice(2));
  if (p.startsWith("~\\")) return path.join(homeDir, p.slice(2));
  return p;
}

// ── Filesystem checks ──────────────────────────────────────────────────────

export function checkFile(filePath: string): FileCheck {
  const exists = fs.existsSync(filePath);
  let lastModified: string | null = null;
  if (exists) {
    try {
      lastModified = fs.statSync(filePath).mtime.toISOString();
    } catch {
      lastModified = null;
    }
  }
  return {
    name: path.basename(filePath),
    path: filePath,
    exists,
    lastModified,
  };
}

export function checkSkill(entry: SkillEntry, homeDir: string): SkillCheck {
  const resolved = resolveHomePath(entry.location, homeDir);
  return {
    name: entry.name,
    path: entry.location,
    exists: fs.existsSync(resolved),
    role: entry.role,
  };
}

// ── SQLite checks ──────────────────────────────────────────────────────────

const NULL_CRON_RESULT = (name: string): CronJobCheck => ({
  name,
  lastRun: null,
  lastSuccess: null,
  recentSuccessRate: null,
  totalRuns: 0,
});

/** Open a SQLite file read-only, returning null on any open-time failure. */
function openReadonly(dbPath: string): DatabaseSync | null {
  // node:sqlite has no `fileMustExist` option — readOnly=true throws on a
  // missing file, so the open-time check is implicit. The behavior matches
  // the previous better-sqlite3 path: returns null on any open-time failure.
  try {
    return new DatabaseSyncCtor(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

export function checkCronJobs(
  jobNames: readonly string[],
  dbPath: string,
): CronJobCheck[] {
  if (jobNames.length === 0) return [];
  const db = openReadonly(dbPath);
  if (db === null) return jobNames.map(NULL_CRON_RESULT);
  let result: CronJobCheck[];
  try {
    const stmt = db.prepare(`
      SELECT date, status FROM cron_runs
      WHERE cron_name = ? AND status != 'skipped'
        AND date >= date('now', '-7 days')
      ORDER BY date DESC, scheduled_time DESC LIMIT 14
    `);
    result = jobNames.map((name) => {
      const rows = stmt.all(name) as Array<{ date: string; status: string }>;
      if (rows.length === 0) return NULL_CRON_RESULT(name);
      const successes = rows.filter((r) => r.status === "success").length;
      return {
        name,
        lastRun: rows[0]!.date,
        lastSuccess: rows[0]!.status === "success",
        recentSuccessRate: Number(((successes / rows.length) * 100).toFixed(0)),
        totalRuns: rows.length,
      };
    });
  } catch {
    result = jobNames.map(NULL_CRON_RESULT);
  }
  db.close();
  return result;
}

const NULL_TABLE_RESULT = (name: string): DbTableCheck => ({
  name,
  exists: false,
  rowCount: 0,
  lastEntry: null,
});

export function checkDbTables(
  tableNames: readonly string[],
  dbPath: string,
): DbTableCheck[] {
  if (tableNames.length === 0) return [];
  const db = openReadonly(dbPath);
  if (db === null) return tableNames.map(NULL_TABLE_RESULT);
  // Each per-table block is wrapped in its own try/catch, so a single bad
  // table doesn't poison the whole batch. No outer catch needed — open-time
  // failure is already handled by `openReadonly` returning null above.
  const result = tableNames.map((tableName) => {
      try {
        const meta = db!
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(tableName);
        if (!meta) return NULL_TABLE_RESULT(tableName);
        const countRow = db!
          .prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`)
          .get() as { cnt: number };
        let lastEntry: string | null = null;
        try {
          const r = db!
            .prepare(`SELECT date FROM "${tableName}" ORDER BY date DESC LIMIT 1`)
            .get() as { date?: string } | undefined;
          lastEntry = r?.date ?? null;
        } catch {
          try {
            const r = db!
              .prepare(
                `SELECT created_at FROM "${tableName}" ORDER BY created_at DESC LIMIT 1`,
              )
              .get() as { created_at?: string } | undefined;
            lastEntry = r?.created_at ?? null;
          } catch {
            lastEntry = null;
          }
        }
        return {
          name: tableName,
          exists: true,
          rowCount: countRow.cnt,
          lastEntry,
        };
      } catch {
        return NULL_TABLE_RESULT(tableName);
      }
    });
  db.close();
  return result;
}

// ── Drift detection (pure) ─────────────────────────────────────────────────

export function detectDrift(input: {
  skills: readonly SkillCheck[];
  files: readonly FileCheck[];
  cronJobs: readonly CronJobCheck[];
  dbTables: readonly DbTableCheck[];
}): DriftIssue[] {
  const issues: DriftIssue[] = [];

  for (const s of input.skills) {
    if (!s.exists) {
      issues.push({
        type: "missing_skill",
        severity: "error",
        message: `Skill "${s.name}" not found at ${s.path}`,
      });
    }
  }
  for (const f of input.files) {
    if (!f.exists) {
      issues.push({
        type: "missing_file",
        severity: "warning",
        message: `File "${f.name}" not found at ${f.path}`,
      });
    }
  }
  for (const c of input.cronJobs) {
    if (c.totalRuns === 0) {
      issues.push({
        type: "no_recent_data",
        severity: "warning",
        message: `Cron "${c.name}" has no recorded runs`,
      });
    } else if (c.lastSuccess === false) {
      issues.push({
        type: "cron_failing",
        severity: "error",
        message: `Cron "${c.name}" last run failed (${c.recentSuccessRate}% over last ${c.totalRuns} runs in 7d)`,
      });
    } else if (c.recentSuccessRate !== null && c.recentSuccessRate < 80) {
      const successes = Math.round((c.recentSuccessRate * c.totalRuns) / 100);
      issues.push({
        type: "cron_failing",
        severity: "warning",
        message: `Cron "${c.name}" success rate: ${c.recentSuccessRate}% (${successes}/${c.totalRuns} runs in 7d rolling window)`,
      });
    }
  }
  for (const t of input.dbTables) {
    if (!t.exists) {
      issues.push({
        type: "missing_table",
        severity: "error",
        message: `DB table "${t.name}" does not exist`,
      });
    } else if (t.rowCount === 0) {
      issues.push({
        type: "empty_table",
        severity: "warning",
        message: `DB table "${t.name}" is empty`,
      });
    }
  }
  return issues;
}

export function computeOverallHealth(
  drift: readonly DriftIssue[],
): OverallHealth {
  let hasError = false;
  let hasWarning = false;
  for (const d of drift) {
    if (d.severity === "error") hasError = true;
    else if (d.severity === "warning") hasWarning = true;
  }
  if (hasError) return "unhealthy";
  if (hasWarning) return "degraded";
  return "healthy";
}

// ── Orchestration ──────────────────────────────────────────────────────────

export function buildSystemStatus(input: {
  config: SkillsConfig;
  homeDir: string;
  dbPath: string;
  now?: () => Date;
}): SystemStatus {
  const { config, homeDir, dbPath } = input;
  const clock = input.now ?? (() => new Date());

  const skills = config.skills.map((s) => checkSkill(s, homeDir));
  const files = (config.liveChecks.files ?? []).map((f) => checkFile(f));
  const cronJobs = checkCronJobs(config.liveChecks.cronJobs ?? [], dbPath);
  const dbTables = checkDbTables(config.liveChecks.dbTables ?? [], dbPath);
  const drift = detectDrift({ skills, files, cronJobs, dbTables });
  const overallHealth = computeOverallHealth(drift);

  return {
    checkedAt: clock().toISOString(),
    overallHealth,
    skills,
    files,
    cronJobs,
    dbTables,
    drift,
  };
}
