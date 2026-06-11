/**
 * Drift Status — Live system health checks for Mechanism view
 *
 * Checks real system state:
 * - Skills: do referenced directories exist?
 * - Files/Artifacts: do referenced files exist?
 * - Cron outcomes: recent success/failure from SQLite
 * - DB tables: row counts for referenced tables
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
// TODO(brain-migration): better-sqlite3 is legacy here — checkCronJobs() and
// checkDbTables() read dashboard.db directly. Migrate once brain exposes
// cron_runs and table-health equivalents.
import Database from "better-sqlite3";
import { homedir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// OS-resolved home as fallback rather than a hardcoded user path.
const HOME = process.env.HOME || homedir();
// Match server.ts + db.ts source-of-truth: honor $DASHBOARD_DB, else
// ~/digital-me/.data/dashboard.db. (Previously this read a
// workspace-relative path that silently diverged from the server's
// HOME-rooted default.)
const DEFAULT_DB_PATH = path.join(HOME, "digital-me", ".data", "dashboard.db");
const DB_PATH = process.env["DASHBOARD_DB"] ?? DEFAULT_DB_PATH;

// ── Types ──

export interface SkillEntry {
  name: string;
  location: string;
  role: string;
}

interface SkillCheck {
  name: string;
  path: string;
  exists: boolean;
  role: string;
}

interface FileCheck {
  name: string;
  path: string;
  exists: boolean;
  lastModified: string | null;
}

interface CronJobCheck {
  name: string;
  lastRun: string | null;
  lastSuccess: boolean | null;
  recentSuccessRate: number | null;
  totalRuns: number;
}

interface DbTableCheck {
  name: string;
  exists: boolean;
  rowCount: number;
  lastEntry: string | null;
}

interface DriftIssue {
  type: string;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface SystemStatus {
  checkedAt: string;
  overallHealth: "healthy" | "degraded" | "unhealthy";
  skills: SkillCheck[];
  files: FileCheck[];
  cronJobs: CronJobCheck[];
  dbTables: DbTableCheck[];
  drift: DriftIssue[];
}

interface SkillsConfig {
  skills: SkillEntry[];
  liveChecks: {
    cronJobs: string[];
    files: string[];
    dbTables: string[];
  };
}

// ── Helpers ──

function resolvePath(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(HOME, p.slice(2));
  }
  return p;
}

function checkSkill(entry: SkillEntry): SkillCheck {
  const resolved = resolvePath(entry.location);
  return {
    name: entry.name,
    path: entry.location,
    exists: fs.existsSync(resolved),
    role: entry.role,
  };
}

function expandConfigPath(raw: string): string {
  // Expand both `~` and `${HOME}` / `${OPENCLAW_HOME}` / etc. so config
  // files in skills.json don't need hardcoded user paths.
  let out = raw;
  if (out.startsWith("~/")) out = path.join(HOME, out.slice(2));
  out = out.replace(/\$\{([A-Z_]+)\}/g, (_, key) => {
    if (key === "HOME") return HOME;
    return process.env[key] ?? "";
  });
  return out;
}

function checkFile(filePath: string): FileCheck {
  const resolved = expandConfigPath(filePath);
  const exists = fs.existsSync(resolved);
  let lastModified: string | null = null;
  if (exists) {
    try {
      lastModified = fs.statSync(resolved).mtime.toISOString();
    } catch { /* ignore */ }
  }
  return { name: path.basename(resolved), path: filePath, exists, lastModified };
}

function checkCronJobs(jobNames: string[]): CronJobCheck[] {
  if (jobNames.length === 0) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    return jobNames.map((name) => {
      const rows = db!.prepare(`
        SELECT date, status FROM cron_runs
        WHERE cron_name = ? AND status != 'skipped'
          AND date >= date('now', '-7 days')
        ORDER BY date DESC, scheduled_time DESC LIMIT 14
      `).all(name) as { date: string; status: string }[];
      if (rows.length === 0) return { name, lastRun: null, lastSuccess: null, recentSuccessRate: null, totalRuns: 0 };
      const successes = rows.filter((r) => r.status === "success").length;
      return {
        name,
        lastRun: rows[0].date,
        lastSuccess: rows[0].status === "success",
        recentSuccessRate: +(successes / rows.length * 100).toFixed(0),
        totalRuns: rows.length,
      };
    });
  } catch {
    return jobNames.map((name) => ({ name, lastRun: null, lastSuccess: null, recentSuccessRate: null, totalRuns: 0 }));
  } finally {
    if (db) db.close();
  }
}

function checkDbTables(tableNames: string[]): DbTableCheck[] {
  if (tableNames.length === 0) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    return tableNames.map((tableName) => {
      try {
        const exists = db!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
        if (!exists) return { name: tableName, exists: false, rowCount: 0, lastEntry: null };
        const countRow = db!.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get() as { cnt: number };
        let lastEntry: string | null = null;
        try {
          const r = db!.prepare(`SELECT date FROM "${tableName}" ORDER BY date DESC LIMIT 1`).get() as { date: string } | undefined;
          lastEntry = r?.date ?? null;
        } catch {
          try {
            const r = db!.prepare(`SELECT created_at FROM "${tableName}" ORDER BY created_at DESC LIMIT 1`).get() as { created_at: string } | undefined;
            lastEntry = r?.created_at ?? null;
          } catch { /* no date col */ }
        }
        return { name: tableName, exists: true, rowCount: countRow.cnt, lastEntry };
      } catch {
        return { name: tableName, exists: false, rowCount: 0, lastEntry: null };
      }
    });
  } catch {
    return tableNames.map((name) => ({ name, exists: false, rowCount: 0, lastEntry: null }));
  } finally {
    if (db) db.close();
  }
}

function detectDrift(skills: SkillCheck[], files: FileCheck[], cronJobs: CronJobCheck[], dbTables: DbTableCheck[]): DriftIssue[] {
  const issues: DriftIssue[] = [];
  for (const s of skills) {
    if (!s.exists) issues.push({ type: "missing_skill", severity: "error", message: `Skill "${s.name}" not found at ${s.path}` });
  }
  for (const f of files) {
    if (!f.exists) issues.push({ type: "missing_file", severity: "warning", message: `File "${f.name}" not found at ${f.path}` });
  }
  for (const c of cronJobs) {
    if (c.totalRuns === 0) issues.push({ type: "no_recent_data", severity: "warning", message: `Cron "${c.name}" has no recorded runs` });
    else if (c.lastSuccess === false) issues.push({ type: "cron_failing", severity: "error", message: `Cron "${c.name}" last run failed (${c.recentSuccessRate}% over last ${c.totalRuns} runs in 7d)` });
    else if (c.recentSuccessRate !== null && c.recentSuccessRate < 80) {
      const successes = Math.round(c.recentSuccessRate * c.totalRuns / 100);
      issues.push({ type: "cron_failing", severity: "warning", message: `Cron "${c.name}" success rate: ${c.recentSuccessRate}% (${successes}/${c.totalRuns} runs in 7d rolling window)` });
    }
  }
  for (const t of dbTables) {
    if (!t.exists) issues.push({ type: "missing_table", severity: "error", message: `DB table "${t.name}" does not exist` });
    else if (t.rowCount === 0) issues.push({ type: "empty_table", severity: "warning", message: `DB table "${t.name}" is empty` });
  }
  return issues;
}

// ── Public API ──

export function loadSkillsConfig(): SkillsConfig {
  const jsonPath = path.join(__dirname, "skills.json");
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
}

export function getSystemStatus(): SystemStatus {
  const config = loadSkillsConfig();
  const skills = config.skills.map(checkSkill);
  const files = (config.liveChecks.files || []).map(checkFile);
  const cronJobs = checkCronJobs(config.liveChecks.cronJobs || []);
  const dbTables = checkDbTables(config.liveChecks.dbTables || []);
  const drift = detectDrift(skills, files, cronJobs, dbTables);
  const errors = drift.filter((d) => d.severity === "error").length;
  const warnings = drift.filter((d) => d.severity === "warning").length;

  return {
    checkedAt: new Date().toISOString(),
    overallHealth: errors > 0 ? "unhealthy" : warnings > 0 ? "degraded" : "healthy",
    skills,
    files,
    cronJobs,
    dbTables,
    drift,
  };
}
