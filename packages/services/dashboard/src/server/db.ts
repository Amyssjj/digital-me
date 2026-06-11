// @ts-nocheck
// TODO(§B): this entire 1999-line file is being replaced with a much smaller
// db.ts targeting the 7-table schema (daa, knowledge_taste_changes, …,
// activity). Suppressing typechecks here keeps the package buildable
// through the §A-§G migration window. Delete @ts-nocheck when §B lands.
//
// TODO(brain-migration): better-sqlite3 is legacy — remaining reads against
// dashboard.db should migrate to brain API endpoints once the brain
// exposes goal_metrics, issues, feedback, insights, cron_runs, and
// daily_agent_activity equivalents.
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
// Per §0 fold-in: brain client lives in .mc.ts during the §0-§F migration
// window. Once §F finishes and server.ts no longer references the legacy
// endpoints in this file, db.ts gets deleted entirely (§G final pass).
import {
  brainBoard,
  brainTracesQuery,
  brainWorkflowList,
  type BrainGoal,
  type BrainTrace,
} from "./brain-client.mc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TODO(brain-migration): direct sqlite reads below are legacy.
// Migrate to brain API once it exposes these tables.
//
// Path source-of-truth matches server.ts: honor $DASHBOARD_DB, else the
// canonical ~/digital-me/.data/dashboard.db path. (Previously this read
// a hardcoded workspace-relative path which silently diverged from
// server.ts's HOME-rooted path, creating a stray empty DB under
// packages/services/dashboard/data/.)
const DEFAULT_DB_PATH = path.join(
  process.env["HOME"] ?? os.homedir(),
  "digital-me", ".data", "dashboard.db",
);
const DB_PATH = process.env["DASHBOARD_DB"] ?? DEFAULT_DB_PATH;

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    // Readonly reader — journal_mode is owned by the write paths (migrate.ts
    // + the Python intake), which set WAL durably. Setting it here would
    // error on a non-WAL file (readonly connections can't switch modes).
    db = new Database(DB_PATH, { readonly: true });
  }
  return db;
}

// ── Brain-response helpers ──

function epochToIso(epoch: number | string | null | undefined): string | null {
  if (epoch == null) return null;
  if (typeof epoch === "string") return epoch; // already ISO
  return new Date(epoch).toISOString();
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch { return fallback; }
}

// ══════════════════════════════════════════════════════════════════
// TODO(brain-migration): LEGACY SQLITE READS BELOW
// All functions below that call getDb() still read from dashboard.db
// directly. These should be migrated to brain API endpoints once the
// brain exposes equivalents for: goal_metrics, issues, feedback,
// insights, cron_runs, daily_agent_activity, daily_metric_activity.
// ══════════════════════════════════════════════════════════════════

// ── Goal configuration ──

interface GoalConfig {
  id: string;
  name: string;
  icon: string;
  color: string;
  primaryMetric: string;
  unit: string;
  healthyThreshold: number;
  warningThreshold: number;
  invertHealth?: boolean; // true = lower is better (e.g., violation rate)
}

const GOAL_CONFIGS: GoalConfig[] = [
  // 4-layer consolidation. Legacy metrics from G1-G6 writers flow into the renamed panel via goal_metrics data migration.
  { id: "knowledge",  name: "Goal 1 · Knowledge",  icon: "\u{1F9E0}", color: "#22D3EE", primaryMetric: "preflight_rate",      unit: "%",     healthyThreshold: 80, warningThreshold: 50 },
  { id: "validation", name: "Goal 2 · Validation", icon: "\u{1F504}", color: "#F59E0B", primaryMetric: "completion_rate",     unit: "%",     healthyThreshold: 90, warningThreshold: 70 },
  { id: "operation",  name: "Goal 3 · Operation",  icon: "\u26A1",    color: "#60A5FA", primaryMetric: "success_rate",        unit: "%",     healthyThreshold: 95, warningThreshold: 80 },
  { id: "evaluation", name: "Goal 4 · Evaluation", icon: "\u{1F60A}", color: "#FB7185", primaryMetric: "quality_score", unit: "%",  healthyThreshold: 80, warningThreshold: 50 },
  { id: "team_health", name: "G3 · Team Health", icon: "\u{1F4CA}", color: "#FBBF24", primaryMetric: "active_agent_count", unit: "count", healthyThreshold: 4, warningThreshold: 2 },
  { id: "personal_learning", name: "G5 · Personal Learning", icon: "\u{1F4D6}", color: "#A78BFA", primaryMetric: "total_notes", unit: "count", healthyThreshold: 40, warningThreshold: 20 },
];

// ── API functions ──

function computeHealthStatus(value: number | null, config: GoalConfig): "healthy" | "warning" | "critical" {
  if (value === null) return "warning";
  if (config.invertHealth) {
    if (value <= config.healthyThreshold) return "healthy";
    if (value <= config.warningThreshold) return "warning";
    return "critical";
  }
  if (value >= config.healthyThreshold) return "healthy";
  if (value >= config.warningThreshold) return "warning";
  return "critical";
}

// Convert a goal's raw value to a 0-100 health score for overall calculation
function computeHealthScore(value: number | null, config: GoalConfig): number | null {
  if (value === null) return null;
  if (config.unit === "%" || config.unit === "percent") {
    if (config.invertHealth) return Math.max(0, 100 - value); // 0% violations = 100 score
    return Math.min(100, Math.max(0, value));
  }
  // Count-based: map to 0-100 using thresholds
  if (config.invertHealth) {
    if (value <= config.healthyThreshold) return 100;
    if (value >= config.warningThreshold) return 30;
    return 70;
  }
  if (value >= config.healthyThreshold) return 90;
  if (value >= config.warningThreshold) return 65;
  return 40;
}

export function getGoals() {
  const database = getDb();

  return GOAL_CONFIGS.map((config) => {
    // Get latest metric value
    const latestRow = database.prepare(`
      SELECT value, date FROM goal_metrics
      WHERE goal = ? AND metric = ?
      ORDER BY date DESC LIMIT 1
    `).get(config.id, config.primaryMetric) as { value: number; date: string } | undefined;

    // Get previous value for trend
    const prevRow = database.prepare(`
      SELECT value FROM goal_metrics
      WHERE goal = ? AND metric = ?
      ORDER BY date DESC LIMIT 1 OFFSET 1
    `).get(config.id, config.primaryMetric) as { value: number } | undefined;

    // Get sparkline data (last 56 days)
    const sparklineRows = database.prepare(`
      SELECT date, value FROM goal_metrics
      WHERE goal = ? AND metric = ?
      ORDER BY date ASC
    `).all(config.id, config.primaryMetric) as { date: string; value: number }[];

    // Get improvement count from issues table
    const impCount = database.prepare(`
      SELECT COUNT(*) as cnt FROM issues
      WHERE type = 'improvement' AND status IN ('open', 'in_progress', 'verify', 'closed')
      AND (goal = ? OR ? = 'self_improving')
    `).get(config.id, config.id) as { cnt: number };

    // Get all sub-metrics (latest value per metric, excluding primary)
    const subMetricRows = database.prepare(`
      SELECT gm.metric, gm.value, gm.unit, gm.breakdown
      FROM goal_metrics gm
      INNER JOIN (
        SELECT metric, MAX(date) as max_date
        FROM goal_metrics WHERE goal = ?
        GROUP BY metric
      ) latest ON gm.metric = latest.metric AND gm.date = latest.max_date
      WHERE gm.goal = ? AND gm.metric != ?
    `).all(config.id, config.id, config.primaryMetric) as {
      metric: string; value: number; unit: string; breakdown: string | null;
    }[];

    const subMetrics: Record<string, { value: number; unit: string; breakdown?: unknown }> = {};
    for (const row of subMetricRows) {
      subMetrics[row.metric] = {
        value: row.value,
        unit: row.unit,
        breakdown: row.breakdown ? JSON.parse(row.breakdown) : undefined,
      };
    }

    const currentValue = latestRow?.value ?? null;
    const trend = latestRow && prevRow ? +(currentValue! - prevRow.value).toFixed(1) : null;
    const healthScore = computeHealthScore(currentValue, config);

    return {
      id: config.id,
      name: config.name,
      icon: config.icon,
      color: config.color,
      currentValue,
      unit: config.unit,
      trend,
      healthStatus: computeHealthStatus(currentValue, config),
      healthScore,
      improvementCount: impCount.cnt,
      sparklineData: sparklineRows.map((r) => ({ date: r.date, value: r.value })),
      primaryMetric: config.primaryMetric,
      subMetrics,
    };
  });
}

export function getGoalMetrics(goalId: string, days: number = 56) {
  const database = getDb();
  const rows = database.prepare(`
    SELECT date, metric, value, unit, breakdown
    FROM goal_metrics
    WHERE goal = ? AND date >= date('now', ?)
    ORDER BY date ASC
  `).all(goalId, `-${days} days`) as { date: string; metric: string; value: number; unit: string; breakdown: string | null }[];

  return rows.map((r) => ({
    ...r,
    breakdown: r.breakdown ? JSON.parse(r.breakdown) : null,
  }));
}

/**
 * Knowledge panel: row-ready data for the 3-row layered layout.
 * - Growth: stacked (entries_created/updated) + cumulative total
 * - Quality: single-line median_age_days, p90_age_days, freshness_rate
 * - Usage: stacked hits_by_domain + per-source retrieval_rate lines
 */
export function getKnowledgeRows(days: number = 56) {
  const database = getDb();
  const aggRows = database.prepare(`
    SELECT date, metric, value, unit, breakdown
    FROM goal_metrics
    WHERE goal = 'knowledge' AND date >= date('now', ?)
    ORDER BY date ASC
  `).all(`-${days} days`) as Array<{
    date: string; metric: string; value: number; unit: string; breakdown: string | null;
  }>;

  const activityRows = database.prepare(`
    SELECT date, source_agent, metric, numerator, denominator, value, breakdown
    FROM daily_metric_activity
    WHERE goal = 'knowledge' AND date >= date('now', ?)
    ORDER BY date ASC
  `).all(`-${days} days`) as Array<{
    date: string; source_agent: string; metric: string;
    numerator: number | null; denominator: number | null; value: number | null;
    breakdown: string | null;
  }>;

  // Collect dates present in either table
  const dateSet = new Set<string>();
  for (const r of aggRows) dateSet.add(r.date);
  for (const r of activityRows) dateSet.add(r.date);
  const dates = Array.from(dateSet).sort();

  // Helper: find aggregated metric value for a date
  const aggGet = (d: string, metric: string): number | null => {
    const row = aggRows.find(r => r.date === d && r.metric === metric);
    return row ? row.value : null;
  };

  // Growth row — daily flow + true cumulative corpus size.
  // `entries_total` is wiki-scanner's COUNT(entries WHERE created <= date),
  // so it reflects pre-tracking substrate (not just new entries since backfill).
  const growth = dates.map((d) => {
    const created = aggGet(d, "entries_created") ?? 0;
    const updated = aggGet(d, "entries_updated") ?? 0;
    const total = aggGet(d, "entries_total") ?? 0;
    return { date: d, entries_created: created, entries_updated: updated, total_cumulative: total };
  });

  // Quality row — freshness snapshot + age percentiles
  const quality = dates.map((d) => ({
    date: d,
    freshness_rate: aggGet(d, "freshness_rate"),
    median_age_days: aggGet(d, "median_age_days"),
    p90_age_days: aggGet(d, "p90_age_days"),
    stale_orphans: aggGet(d, "stale_orphans"),
  }));

  // Usage row — hits stacked by wiki-entry domain + retrieval rate per agent.
  // For multi-subagent frameworks (e.g., openclaw), also carry subagent breakdown
  // so the tooltip can drill into which subagent retrieved.
  const allDomains = new Set<string>();
  const allAgents = new Set<string>();
  const usageByDate: Record<string, {
    hits_by_domain: Record<string, number>;
    retrieval_by_agent: Record<string, {
      num: number; denom: number; rate: number | null;
      by_subagent?: Record<string, { active: number; with_wiki: number }>;
    }>;
  }> = {};

  for (const d of dates) {
    usageByDate[d] = { hits_by_domain: {}, retrieval_by_agent: {} };
  }

  for (const r of activityRows) {
    if (r.metric === "knowledge_hits" && r.breakdown) {
      try {
        const bd = JSON.parse(r.breakdown) as { per_entry?: Record<string, number> };
        const perEntry = bd.per_entry || {};
        for (const [path, hits] of Object.entries(perEntry)) {
          const domain = path.split("/")[0] || "other";
          allDomains.add(domain);
          usageByDate[r.date].hits_by_domain[domain] =
            (usageByDate[r.date].hits_by_domain[domain] || 0) + hits;
        }
      } catch { /* skip malformed */ }
    }
    if (r.metric === "session_retrieval") {
      allAgents.add(r.source_agent);
      const num = r.numerator ?? 0;
      const denom = r.denominator ?? 0;
      const rate = denom > 0 ? (100 * num) / denom : null;
      let bySubagent: Record<string, { active: number; with_wiki: number }> | undefined;
      if (r.breakdown) {
        try {
          const bd = JSON.parse(r.breakdown) as { by_agent?: Record<string, { active: number; with_wiki: number }> };
          if (bd.by_agent && Object.keys(bd.by_agent).length > 0) bySubagent = bd.by_agent;
        } catch { /* skip */ }
      }
      usageByDate[r.date].retrieval_by_agent[r.source_agent] = {
        num, denom, rate,
        ...(bySubagent ? { by_subagent: bySubagent } : {}),
      };
    }
  }

  const usage = dates.map((d) => ({ date: d, ...usageByDate[d] }));

  // Snapshot: today's per-domain entry count (for the left-card pie chart).
  // Pulled from the most recent entries_total row's breakdown.
  const todayTotal = activityRows
    .filter(r => r.metric === "entries_total" && r.breakdown)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  let entriesByDomain: Record<string, number> = {};
  let totalEntries = 0;
  if (todayTotal?.breakdown) {
    try {
      const bd = JSON.parse(todayTotal.breakdown) as { by_domain?: Record<string, number>; total?: number };
      entriesByDomain = bd.by_domain || {};
      totalEntries = bd.total ?? 0;
    } catch { /* skip */ }
  }

  // Per-agent LATEST retrieval snapshot for the left-card bar chart.
  // Iterate agents individually and pick each one's most-recent row with data,
  // so all agents show even if they weren't all active today.
  const latestRetrievalByAgent: Record<string, { num: number; denom: number; rate: number | null; by_subagent?: Record<string, { active: number; with_wiki: number }>; date: string }> = {};
  for (const agent of allAgents) {
    for (let i = usage.length - 1; i >= 0; i--) {
      const v = usage[i].retrieval_by_agent[agent];
      if (v && v.denom > 0) {
        latestRetrievalByAgent[agent] = { ...v, date: usage[i].date };
        break;
      }
    }
  }
  const latestQuality = quality.filter(q => q.freshness_rate != null).slice(-1)[0] ?? null;

  return {
    dates,
    growth,
    quality,
    usage,
    domains: Array.from(allDomains).sort(),
    agents: Array.from(allAgents).sort(),
    snapshot: {
      totalEntries,
      entriesByDomain,
      latestQuality,
      latestRetrievalByAgent,
    },
  };
}

/**
 * Validation panel: row-ready data for 3-row layered layout.
 * Growth: defects_flagged/day (stacked by reporter) + cumulative
 * Quality: open/closed/verify state + completion rate line
 * Usage:   opportunities pipeline (stacked by status) + conversion_rate line
 */
export function getValidationRows(days: number = 56) {
  const database = getDb();
  const since = `-${days} days`;

  // Defects per day, grouped by reporter (coarse categorization).
  const reporterRows = database.prepare(`
    SELECT date, reported_by, COUNT(*) AS n
      FROM issues
     WHERE date >= date('now', ?)
     GROUP BY date, reported_by
     ORDER BY date ASC
  `).all(since) as Array<{ date: string; reported_by: string; n: number }>;

  // Status distribution per day — based on `date` (creation) for a time-series
  // view of "what's the shape of the backlog each day?"
  const statusRows = database.prepare(`
    SELECT date, status, COUNT(*) AS n
      FROM issues
     WHERE date >= date('now', ?)
     GROUP BY date, status
     ORDER BY date ASC
  `).all(since) as Array<{ date: string; status: string; n: number }>;

  // Completion rate (legacy metric) — one row per day.
  const completionRows = database.prepare(`
    SELECT date, value FROM goal_metrics
     WHERE goal='validation' AND metric='completion_rate' AND date >= date('now', ?)
     ORDER BY date ASC
  `).all(since) as Array<{ date: string; value: number }>;

  // Protocol defects per day (cross-agent) — no_preflight + no_capture
  // from CC/OpenClaw/Codex session scanners.
  const defectRows = database.prepare(`
    SELECT date, source_agent, value, breakdown
      FROM daily_metric_activity
     WHERE goal='validation' AND metric='protocol_defects' AND date >= date('now', ?)
     ORDER BY date ASC
  `).all(since) as Array<{ date: string; source_agent: string; value: number; breakdown: string | null }>;

  const defectsByDate: Record<string, {
    total: number;
    by_agent: Record<string, number>;
    by_class: Record<string, number>;
  }> = {};
  for (const r of defectRows) {
    const bucket = (defectsByDate[r.date] ||= { total: 0, by_agent: {}, by_class: {} });
    bucket.total += r.value;
    bucket.by_agent[r.source_agent] = (bucket.by_agent[r.source_agent] || 0) + r.value;
    if (r.breakdown) {
      try {
        const bd = JSON.parse(r.breakdown) as { by_class?: Record<string, number> };
        for (const [cls, n] of Object.entries(bd.by_class || {})) {
          bucket.by_class[cls] = (bucket.by_class[cls] || 0) + n;
        }
      } catch { /* skip */ }
    }
  }

  // Repeat-failure count per day — # of distinct issue titles with >=2
  // occurrences in the trailing 30-day window ending that day.
  // Single-pass computation: pull all issues in the wider window, bucket by title.
  const repeatLookbackDays = 30;
  const expandedSince = `-${days + repeatLookbackDays} days`;
  const allIssueTitles = database.prepare(`
    SELECT date, title FROM issues WHERE date >= date('now', ?) AND title IS NOT NULL
  `).all(expandedSince) as Array<{ date: string; title: string }>;
  const titlesByDate: Record<string, string[]> = {};
  for (const r of allIssueTitles) {
    (titlesByDate[r.date] ||= []).push(r.title);
  }
  const repeatByDate: Record<string, number> = {};
  // Iterate only dates in the visible range
  for (const d of database.prepare(`
    SELECT DISTINCT date FROM issues WHERE date >= date('now', ?) ORDER BY date
  `).all(since) as Array<{ date: string }>) {
    const endD = new Date(d.date);
    const counts = new Map<string, number>();
    for (let back = 0; back < repeatLookbackDays; back++) {
      const walk = new Date(endD);
      walk.setDate(walk.getDate() - back);
      const iso = walk.toISOString().slice(0, 10);
      const titles = titlesByDate[iso] || [];
      for (const t of titles) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let repeating = 0;
    for (const v of counts.values()) if (v >= 2) repeating++;
    repeatByDate[d.date] = repeating;
  }

  // Opportunities pipeline (legacy — kept in validation after the rename).
  const oppRows = database.prepare(`
    SELECT date, metric, value FROM goal_metrics
     WHERE goal='validation'
       AND metric IN ('opportunities_pending','opportunities_awaiting_review','opportunities_resolved_total','opportunities_conversion_rate','opportunities_detected_today')
       AND date >= date('now', ?)
     ORDER BY date ASC
  `).all(since) as Array<{ date: string; metric: string; value: number }>;

  // Build the date spine
  const dateSet = new Set<string>();
  for (const r of reporterRows) dateSet.add(r.date);
  for (const r of statusRows) dateSet.add(r.date);
  for (const r of completionRows) dateSet.add(r.date);
  for (const r of oppRows) dateSet.add(r.date);
  const dates = Array.from(dateSet).sort();

  // Normalize reporter categories to avoid 30+ distinct colors.
  const categorizeReporter = (r: string): string => {
    if (!r) return "other";
    if (r.startsWith("jing")) return "jing";
    if (r.includes("auto_optimizing") || r.includes("automation")) return "auto-optimizing";
    if (r.includes("heartbeat")) return "heartbeat";
    if (r.includes("cron_failure")) return "cron-failure";
    if (r.includes("coo") || r.includes("ops")) return "coo";
    if (r.includes("context")) return "context-audit";
    if (r.includes("after_tool_call")) return "after-tool";
    return "other";
  };

  const allReporters = new Set<string>();
  const growthByDate: Record<string, Record<string, number>> = {};
  for (const d of dates) growthByDate[d] = {};
  for (const r of reporterRows) {
    const cat = categorizeReporter(r.reported_by);
    allReporters.add(cat);
    growthByDate[r.date][cat] = (growthByDate[r.date][cat] || 0) + r.n;
  }

  // Running cumulative defects (sum across categories)
  let cumulative = 0;
  const growth = dates.map((d) => {
    const byReporter = growthByDate[d] || {};
    const dayTotal = Object.values(byReporter).reduce((s, v) => s + v, 0);
    cumulative += dayTotal;
    const pd = defectsByDate[d];
    return {
      date: d,
      by_reporter: byReporter,
      daily_total: dayTotal,
      cumulative,
      protocol_defects: pd?.total ?? 0,
      protocol_by_agent: pd?.by_agent ?? {},
      protocol_by_class: pd?.by_class ?? {},
    };
  });

  // Quality row: status stack + completion_rate line
  const allStatuses = new Set<string>();
  const statusByDate: Record<string, Record<string, number>> = {};
  for (const d of dates) statusByDate[d] = {};
  for (const r of statusRows) {
    allStatuses.add(r.status);
    statusByDate[r.date][r.status] = (statusByDate[r.date][r.status] || 0) + r.n;
  }
  const completionByDate: Record<string, number> = {};
  for (const r of completionRows) completionByDate[r.date] = r.value;

  const quality = dates.map((d) => ({
    date: d,
    by_status: statusByDate[d] || {},
    completion_rate: completionByDate[d] ?? null,
    repeat_failure_count: repeatByDate[d] ?? null,
  }));

  // Usage row: opportunities stack + conversion_rate line
  const oppByDate: Record<string, Record<string, number>> = {};
  for (const d of dates) oppByDate[d] = {};
  for (const r of oppRows) {
    oppByDate[r.date][r.metric] = r.value;
  }

  const usage = dates.map((d) => ({
    date: d,
    pending: oppByDate[d]?.opportunities_pending ?? 0,
    awaiting_review: oppByDate[d]?.opportunities_awaiting_review ?? 0,
    resolved_total: oppByDate[d]?.opportunities_resolved_total ?? 0,
    detected_today: oppByDate[d]?.opportunities_detected_today ?? 0,
    conversion_rate: oppByDate[d]?.opportunities_conversion_rate ?? null,
  }));

  // Snapshot for left card: latest totals by type/reporter + current open count
  const latestByType = database.prepare(`
    SELECT type, COUNT(*) AS n FROM issues
     WHERE date >= date('now', ?)
     GROUP BY type ORDER BY n DESC
  `).all(since) as Array<{ type: string; n: number }>;

  const openCountRow = database.prepare(`
    SELECT COUNT(*) AS n FROM issues WHERE status='open'
  `).get() as { n: number };

  const latestCompletion = completionRows.slice(-1)[0]?.value ?? null;

  // Today's recurring failure classes (snapshot for left card)
  const recurringToday = database.prepare(`
    SELECT title, COUNT(*) AS n FROM issues
     WHERE date >= date('now', '-30 days')
     GROUP BY title HAVING COUNT(*) >= 2
     ORDER BY n DESC LIMIT 5
  `).all() as Array<{ title: string; n: number }>;
  const recurringCount = database.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT title FROM issues
       WHERE date >= date('now', '-30 days')
       GROUP BY title HAVING COUNT(*) >= 2
    )
  `).get() as { n: number };

  // Per-category reporter totals (last N days) for left bars
  const totalByReporter: Record<string, number> = {};
  for (const r of reporterRows) {
    const cat = categorizeReporter(r.reported_by);
    totalByReporter[cat] = (totalByReporter[cat] || 0) + r.n;
  }

  return {
    dates,
    growth,
    quality,
    usage,
    reporters: Array.from(allReporters).sort(),
    statuses: Array.from(allStatuses).sort(),
    snapshot: {
      countByType: latestByType,
      totalIssuesInRange: latestByType.reduce((s, r) => s + r.n, 0),
      openCount: openCountRow.n,
      latestCompletionRate: latestCompletion,
      repeatFailureCount: recurringCount.n,
      topRepeatFailures: recurringToday,
      totalByReporter,
      protocolDefectsInRange: Object.values(defectsByDate).reduce((s, v) => s + v.total, 0),
      protocolDefectsByAgent: Object.values(defectsByDate).reduce<Record<string, number>>((acc, v) => {
        for (const [a, n] of Object.entries(v.by_agent)) acc[a] = (acc[a] || 0) + n;
        return acc;
      }, {}),
      protocolDefectsByClass: Object.values(defectsByDate).reduce<Record<string, number>>((acc, v) => {
        for (const [c, n] of Object.entries(v.by_class)) acc[c] = (acc[c] || 0) + n;
        return acc;
      }, {}),
    },
  };
}

export function getImprovements() {
  const database = getDb();
  const rows = database.prepare(`
    SELECT id, goal, date, category, title, description, status
    FROM issues
    WHERE type = 'improvement'
    ORDER BY date DESC
  `).all() as Array<{
    id: string; goal: string; date: string; category: string;
    title: string; description: string | null; status: string;
  }>;

  // Group by goal — pass `status` through verbatim. The frontend bucketing
  // owns the lifecycle vocabulary mapping (issues.status: open / in_progress
  // / verify / closed / completed → active vs completed buckets).
  const grouped: Record<string, typeof rows> = {};
  for (const row of rows) {
    const key = row.goal || "validation";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  }
  return grouped;
}

export function getFeedback() {
  const database = getDb();
  return database.prepare(`
    SELECT id, date, type, agent, description, severity, source, related_goal, resolved
    FROM feedback
    ORDER BY date DESC
    LIMIT 50
  `).all() as Array<{
    id: number; date: string; type: string; agent: string;
    description: string; severity: string | null; source: string;
    related_goal: string | null; resolved: number;
  }>;
}

export function getAllGoalMetrics(days: number = 56) {
  const database = getDb();
  const rows = database.prepare(`
    SELECT goal, date, metric, value, unit, breakdown
    FROM goal_metrics
    WHERE date >= date('now', ?)
    ORDER BY goal, date ASC
  `).all(`-${days} days`) as Array<{
    goal: string; date: string; metric: string; value: number; unit: string; breakdown: string | null;
  }>;

  const grouped: Record<string, Array<{ date: string; metric: string; value: number; unit: string; breakdown: unknown }>> = {};
  for (const r of rows) {
    if (!grouped[r.goal]) grouped[r.goal] = [];
    grouped[r.goal].push({
      date: r.date,
      metric: r.metric,
      value: r.value,
      unit: r.unit,
      breakdown: r.breakdown ? JSON.parse(r.breakdown) : null,
    });
  }
  return grouped;
}

export function getCronRunsSummary(days: number = 30) {
  const database = getDb();
  return database.prepare(`
    SELECT
      date,
      COUNT(*) as total_scheduled,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped_count,
      SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) as missed_count,
      ROUND(
        CASE WHEN (COUNT(*) - SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END)) > 0
        THEN 100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)
             / (COUNT(*) - SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END))
        ELSE 100 END,
      1) as success_rate
    FROM cron_runs
    WHERE date >= date('now', ?)
    GROUP BY date
    ORDER BY date ASC
  `).all(`-${days} days`) as Array<{
    date: string; total_scheduled: number; success_count: number;
    failed_count: number; skipped_count: number; missed_count: number;
    success_rate: number;
  }>;
}

// TODO(brain-migration): cron_runs query still reads dashboard.db directly.
export async function getCronRunsPerJob(days: number = 30) {
  const database = getDb();
  const rows = database.prepare(`
    SELECT
      date,
      cron_name,
      COUNT(*) as total_slots,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) as missed_count,
      ROUND(
        CASE WHEN (COUNT(*) - SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END)) > 0
        THEN 100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)
             / (COUNT(*) - SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END))
        ELSE 100 END,
      1) as success_rate
    FROM cron_runs
    WHERE date >= date('now', ?)
    GROUP BY date, cron_name
    ORDER BY date ASC, cron_name ASC
  `).all(`-${days} days`) as Array<{
    date: string; cron_name: string; total_slots: number;
    success_count: number; failed_count: number; missed_count: number;
    success_rate: number;
  }>;

  // Relabel cron_name to workflow_template.id via brain workflow list.
  const nameToId: Record<string, string> = {};
  try {
    const wfTemplates = await brainWorkflowList();
    for (const w of wfTemplates) {
      nameToId[w.name] = w.id;
    }
  } catch {
    // brain not available — fall back to raw cron_name
  }

  return rows.map((r) => ({
    ...r,
    cron_name: nameToId[r.cron_name] || r.cron_name,
  }));
}

// ── Traces ──

export interface TraceSpan {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  service: string;
  status: string;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  attributes: string | null;
  events: string | null;
}

export interface TraceGroup {
  trace_id: string;
  service: string;
  root_name: string;
  start_time: string;
  total_spans: number;
  total_duration_ms: number | null;
  status: string;
  spans: TraceSpan[];
}

// ── Traces — via brain API ──

function adaptBrainTrace(t: BrainTrace): TraceSpan {
  return {
    span_id: t.span_id ?? t.spanId ?? "",
    trace_id: t.trace_id ?? t.traceId ?? "",
    parent_span_id: t.parent_span_id ?? t.parentSpanId ?? null,
    name: t.name ?? "",
    service: t.service ?? t.agent_id ?? t.agentId ?? "",
    status: t.status ?? "unknown",
    start_time: t.start_time ?? t.startTime ?? (t.timestamp ? new Date(t.timestamp).toISOString() : ""),
    end_time: t.end_time ?? t.endTime ?? null,
    duration_ms: t.duration_ms ?? t.durationMs ?? null,
    attributes: typeof t.attributes === "string" ? t.attributes : (t.attributes ? JSON.stringify(t.attributes) : null),
    events: typeof t.events === "string" ? t.events : (t.events ? JSON.stringify(t.events) : null),
  };
}

export async function getRecentTraces(days: number = 7, limit: number = 50): Promise<TraceGroup[]> {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await brainTracesQuery({ since, limit: Math.min(limit * 10, 1000) });

  // Group raw traces by trace_id
  const spansByTrace = new Map<string, TraceSpan[]>();
  for (const raw of result.traces) {
    const span = adaptBrainTrace(raw);
    const tid = span.trace_id;
    if (!tid) continue;
    if (!spansByTrace.has(tid)) spansByTrace.set(tid, []);
    spansByTrace.get(tid)!.push(span);
  }

  // Dedup by goal prefix (service like 'g1_...', 'g2_...' → keep latest per g-prefix)
  const traceGroups: TraceGroup[] = [];
  for (const [traceId, spans] of spansByTrace) {
    spans.sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
    const root = spans.find((s) => !s.parent_span_id) || spans[0];
    traceGroups.push({
      trace_id: traceId,
      service: root.service,
      root_name: root.name,
      start_time: root.start_time,
      total_spans: spans.length,
      total_duration_ms: root.duration_ms,
      status: root.status,
      spans,
    });
  }

  // Dedup by goal prefix — keep only latest trace per g-prefix
  const byPrefix = new Map<string, TraceGroup>();
  for (const tg of traceGroups) {
    if (!tg.service.startsWith("g")) continue;
    const prefix = tg.service.substring(0, 2);
    const existing = byPrefix.get(prefix);
    if (!existing || tg.start_time > existing.start_time) {
      byPrefix.set(prefix, tg);
    }
  }

  // Also include non-goal traces
  const nonGoalTraces = traceGroups.filter((tg) => !tg.service.startsWith("g"));

  const combined = [...byPrefix.values(), ...nonGoalTraces]
    .sort((a, b) => a.service.localeCompare(b.service))
    .slice(0, limit);

  return combined;
}

export async function getTraceById(traceId: string): Promise<TraceGroup | null> {
  // Query brain for traces matching this trace_id
  const result = await brainTracesQuery({ limit: 500 });

  const spans: TraceSpan[] = result.traces
    .filter((t) => (t.trace_id ?? t.traceId) === traceId)
    .map(adaptBrainTrace);

  if (spans.length === 0) return null;

  spans.sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
  const root = spans.find((s) => !s.parent_span_id) || spans[0];

  return {
    trace_id: traceId,
    service: root.service,
    root_name: root.name,
    start_time: root.start_time,
    total_spans: spans.length,
    total_duration_ms: root.duration_ms,
    status: root.status,
    spans,
  };
}

export function getInsights() {
  const database = getDb();
  return database.prepare(`
    SELECT id, date, type, observation, why_it_matters, question_for_jing,
           proposed_action, related_goal, status
    FROM insights
    WHERE status IN ('surfaced', 'discussed')
    ORDER BY date DESC
    LIMIT 20
  `).all() as Array<{
    id: string; date: string; type: string; observation: string;
    why_it_matters: string | null; question_for_jing: string | null;
    proposed_action: string | null; related_goal: string | null; status: string;
  }>;
}

// ── G3: Team Health (daily agent activity) ──

const AGENT_LABELS: Record<string, string> = {
  cto: "CTO",
  youtube: "YouTube",
  writer: "Writer",
  cpo: "CPO",
  podcast: "Podcast",
  coo: "COO",
};

export function getTeamHealthTimeSeries(days: number = 45) {
  const database = getDb();

  const rows = database.prepare(`
    SELECT agent_id, date, status, sessions_count, memory_logged,
           agents_md_bytes, memory_md_bytes, soul_md_bytes, user_md_bytes,
           tools_md_bytes, heartbeat_md_bytes, total_prompt_bytes
    FROM daily_agent_activity
    WHERE date >= date('now', ?)
    ORDER BY date ASC, agent_id ASC
  `).all(`-${days} days`) as {
    agent_id: string; date: string; status: string;
    sessions_count: number; memory_logged: number;
    agents_md_bytes: number; memory_md_bytes: number; soul_md_bytes: number;
    user_md_bytes: number; tools_md_bytes: number; heartbeat_md_bytes: number;
    total_prompt_bytes: number;
  }[];

  // Build per-date heatmap data
  const agents = [...new Set(rows.map(r => r.agent_id))].sort();
  const dates = [...new Set(rows.map(r => r.date))].sort();

  const heatmap: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    if (!heatmap[r.date]) heatmap[r.date] = {};
    heatmap[r.date][r.agent_id] = r.status;
  }

  // Per-date active count
  const dailyActive = dates.map(date => {
    const active = agents.filter(a => heatmap[date]?.[a] === "active").length;
    return { date, active, total: agents.length };
  });

  // Per-date time series for right chart
  const dateSessionMap = new Map<string, number>();
  for (const r of rows) {
    dateSessionMap.set(r.date, (dateSessionMap.get(r.date) || 0) + r.sessions_count);
  }

  // Per-agent summary
  const agentSummary = agents.map(a => {
    const agentRows = rows.filter(r => r.agent_id === a);
    const activeDays = agentRows.filter(r => r.status === "active").length;
    const latest = agentRows[agentRows.length - 1];
    return {
      agent: a,
      label: AGENT_LABELS[a] || a,
      activeDays,
      totalDays: agentRows.length,
      activeRate: agentRows.length > 0 ? Math.round((activeDays / agentRows.length) * 100) : 0,
      currentStatus: latest?.status || "unknown",
      promptBytes: latest?.total_prompt_bytes || 0,
      promptBreakdown: latest ? {
        "AGENTS.md": latest.agents_md_bytes || 0,
        "MEMORY.md": latest.memory_md_bytes || 0,
        "SOUL.md": latest.soul_md_bytes || 0,
        "USER.md": latest.user_md_bytes || 0,
        "TOOLS.md": latest.tools_md_bytes || 0,
        "HEARTBEAT.md": latest.heartbeat_md_bytes || 0,
      } : {},
    };
  });

  // Per-agent per-date session counts for tooltip
  const agentDateSessions = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const label = AGENT_LABELS[r.agent_id] || r.agent_id;
    if (!agentDateSessions.has(r.date)) agentDateSessions.set(r.date, new Map());
    agentDateSessions.get(r.date)!.set(label, r.sessions_count);
  }

  // Time series with per-agent active status + total sessions + per-agent sessions
  const timeSeries = dates.map(date => {
    const dayAgents: Record<string, number> = {};
    const daySessions: Record<string, number> = {};
    for (const a of agents) {
      const label = AGENT_LABELS[a] || a;
      dayAgents[label] = heatmap[date]?.[a] === "active" ? 1 : 0;
      daySessions[label] = agentDateSessions.get(date)?.get(label) || 0;
    }
    const daaCount = Object.values(dayAgents).filter(v => v === 1).length;
    const agentsWithSessions = Object.values(daySessions).filter(v => v > 0).length;
    return {
      date,
      ...dayAgents,
      daaCount,
      agentsWithSessions,
      sessions: dateSessionMap.get(date) || 0,
      sessionBreakdown: daySessions,
    };
  });

  // All-time per-agent: DAA days, days with sessions, total sessions
  const agentBars = agents.map(a => {
    const agentRows = rows.filter(r => r.agent_id === a);
    const daaDays = agentRows.filter(r => r.status === "active").length;
    const sessionDays = agentRows.filter(r => r.sessions_count > 0).length;
    const totalSessions = agentRows.reduce((sum, r) => sum + r.sessions_count, 0);
    return { agent: AGENT_LABELS[a] || a, daaDays, sessionDays, totalDays: agentRows.length, totalSessions };
  });

  return {
    agents: agents.map(a => ({ id: a, label: AGENT_LABELS[a] || a })),
    dates,
    heatmap,
    dailyActive,
    agentSummary,
    timeSeries,
    agentBars,
  };
}

// ── G2: Issues time-series for dual chart ──

// Reporter display names
const REPORTER_LABELS: Record<string, string> = {
  jing_modal: "Owner",
  jing_slash_command: "Owner",
  heartbeat_detect: "Heartbeat-Detect",
  auto_detected: "Heartbeat-Detect",
  trend_review_cron: "Trend-Review",
  issue_fixer: "Issue-Fixer",
  heartbeat_fix: "Issue-Fixer",
  coo: "COO",
};

export function getIssuesSummary() {
  const database = getDb();

  const byReporter = database.prepare(`
    SELECT reported_by, COUNT(*) as count
    FROM issues
    GROUP BY reported_by
  `).all() as { reported_by: string; count: number }[];

  const totals = database.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed
    FROM issues
  `).get() as { total: number; closed: number };

  const reporters = byReporter.map(r => ({
    reporter: REPORTER_LABELS[r.reported_by] || r.reported_by,
    count: r.count,
  }));

  // Merge duplicates (e.g. jing_modal + jing_slash_command → Owner)
  const merged: Record<string, number> = {};
  for (const r of reporters) {
    merged[r.reporter] = (merged[r.reporter] || 0) + r.count;
  }

  return {
    byReporter: Object.entries(merged).map(([reporter, count]) => ({ reporter, count })).sort((a, b) => b.count - a.count),
    total: totals.total,
    closed: totals.closed,
    fixRate: totals.total > 0 ? Math.round((totals.closed / totals.total) * 100 * 10) / 10 : 0,
  };
}

export function getIssuesTimeSeries(days: number = 30) {
  const database = getDb();

  // Use March 1st of current year as the fixed start date
  const now = new Date();
  const marchStart = `${now.getFullYear()}-03-01`;

  // Issues created per date per reporter
  const rows = database.prepare(`
    SELECT date, reported_by, COUNT(*) as count
    FROM issues
    WHERE date >= ?
    GROUP BY date, reported_by
    ORDER BY date ASC
  `).all(marchStart) as { date: string; reported_by: string; count: number }[];

  // Issues closed per date (by updated_at date, not created date)
  const closedRows = database.prepare(`
    SELECT date(updated_at) as close_date, COUNT(*) as closed_count
    FROM issues
    WHERE status = 'closed' AND date(updated_at) >= ?
    GROUP BY date(updated_at)
    ORDER BY close_date ASC
  `).all(marchStart) as { close_date: string; closed_count: number }[];

  // Discover all reporters
  const allReporters = new Set<string>();
  for (const r of rows) {
    const label = REPORTER_LABELS[r.reported_by] || r.reported_by;
    allReporters.add(label);
  }

  // Build per-date records
  const dateMap = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const label = REPORTER_LABELS[r.reported_by] || r.reported_by;
    if (!dateMap.has(r.date)) dateMap.set(r.date, {});
    const entry = dateMap.get(r.date)!;
    entry[label] = (entry[label] || 0) + r.count;
  }

  // Merge with closed-per-day
  const closedMap = new Map<string, number>();
  for (const r of closedRows) {
    closedMap.set(r.close_date, r.closed_count);
  }

  // Build continuous date range from March 1st to today
  const allDates: string[] = [];
  const startDate = new Date(`${now.getFullYear()}-03-01T00:00:00`);
  const endDate = new Date();
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    allDates.push(d.toISOString().slice(0, 10));
  }
  const data = allDates.map(date => ({
    date,
    ...Object.fromEntries([...allReporters].map(r => [r, dateMap.get(date)?.[r] || 0])),
    closed: closedMap.get(date) ?? 0,
  }));

  return {
    reporters: [...allReporters].sort(),
    data,
  };
}

// ── G2: Automation Opportunities (auto-optimizing pipeline) ──

export function getAutomationOpportunitiesTimeSeries(days: number = 60) {
  const database = getDb();

  // Daily counts by status from issues where type = 'automation_opportunity'
  const rows = database.prepare(`
    SELECT date,
      SUM(CASE WHEN status = 'open' OR status = 'in_progress' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'verify' THEN 1 ELSE 0 END) as awaiting_review,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as resolved,
      COUNT(*) as detected
    FROM issues
    WHERE type = 'automation_opportunity'
      AND date >= date('now', ?)
    GROUP BY date
    ORDER BY date ASC
  `).all(`-${days} days`) as {
    date: string; pending: number; awaiting_review: number; resolved: number; detected: number;
  }[];

  // Running totals for conversion rate
  const totals = database.prepare(`
    SELECT
      COUNT(*) as total_detected,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as total_resolved,
      SUM(CASE WHEN status IN ('open', 'in_progress') THEN 1 ELSE 0 END) as total_pending,
      SUM(CASE WHEN status = 'verify' THEN 1 ELSE 0 END) as total_awaiting_review
    FROM issues
    WHERE type = 'automation_opportunity'
  `).get() as {
    total_detected: number; total_resolved: number;
    total_pending: number; total_awaiting_review: number;
  };

  const conversionRate = totals.total_detected > 0
    ? Math.round(totals.total_resolved / totals.total_detected * 100 * 10) / 10
    : 0;

  // Build cumulative conversion rate per day
  let cumulativeDetected = 0;
  let cumulativeResolved = 0;
  const timeSeriesWithRate = rows.map(r => {
    cumulativeDetected += r.detected;
    cumulativeResolved += r.resolved;
    const rate = cumulativeDetected > 0
      ? Math.round(cumulativeResolved / cumulativeDetected * 100 * 10) / 10
      : 0;
    return { ...r, conversionRate: rate };
  });

  return {
    timeSeries: timeSeriesWithRate,
    totals: {
      detected: totals.total_detected,
      resolved: totals.total_resolved,
      pending: totals.total_pending,
      awaitingReview: totals.total_awaiting_review,
      conversionRate,
    },
  };
}

// ── Kanban Board (Task Orchestrator) ──

type GoalStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
type AttemptStatus = 'running' | 'completed' | 'failed';

interface KanbanAttempt {
  attemptId: string;
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  endedAt: string | null;
  outputSummary: string | null;
  failureReason: string | null;
  artifactPaths: string[];
}

interface TaskCheckpoint {
  phase: string;
  summary: string;
  progressPercent: number;
  artifactPaths: string[];
  blocker: string | null;
  timestamp: string;
}

interface KanbanTask {
  id: string;
  name: string;
  task: string;
  status: TaskStatus;
  priority: string;
  blockedBy: string[];
  attemptCount: number;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  onUpstreamFailure: string;
  latestCheckpoint: TaskCheckpoint | null;
  latestOutput: string | null;
  activeAttempt: KanbanAttempt | null;
  attempts: KanbanAttempt[];
}

interface KanbanGoal {
  id: string;
  name: string;
  description: string;
  status: GoalStatus;
  parentGoalId: string | null;
  sourceWorkflowId: string | null;
  sourceWorkflowVersion: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  createdBy: string;
  agentId: string | null;
  tasks: KanbanTask[];
}

interface AgentGoalCount {
  agentId: string;
  goalCount: number;
}

interface KanbanStats {
  goals: { total: number; byStatus: Record<string, number> };
  tasks: { total: number; byStatus: Record<string, number> };
  agents: AgentGoalCount[];
}

interface KanbanPagination {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface KanbanResponse {
  goals: KanbanGoal[];
  stats: KanbanStats;
  pagination: KanbanPagination;
}

// epochToIso and safeJsonParse moved to top of file

// ── Layer Health — via brain API ──
// Evergreen goals + open project-goal counts.
export async function getLayerHealth() {
  const board = await brainBoard();
  const evergreens = board.goals.filter(
    (g) => g.type === "evergreen" && g.status !== "retired",
  );

  const allGoals = board.goals;
  const layers = evergreens.map((g) => {
    const openProjects = allGoals.filter(
      (c) =>
        (c.parent_goal_id ?? c.parentGoalId) === g.id &&
        (c.type ?? "project") === "project" &&
        ["pending", "running"].includes(c.status),
    ).length;

    const tasks = g.tasks ?? [];
    const legacyOpenTasks = tasks.filter((t) =>
      ["ready", "pending", "running", "dispatched", "awaiting_approval", "stalled"].includes(t.status),
    ).length;

    return {
      id: g.id,
      name: g.name,
      description: g.description,
      status: g.status,
      updatedAt: g.updated_at ?? g.updatedAt ?? "",
      openProjects,
      legacyOpenTasks,
    };
  });

  return { layers };
}

export async function getKanbanData(opts: {
  status?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  order?: string;
  days?: number;
}): Promise<KanbanResponse> {
  const board = await brainBoard();

  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  // Project goals only (evergreen goals use a different status vocabulary and
  // are surfaced in the Layer Health strip).
  let projectGoals = board.goals.filter((g) => (g.type ?? "project") === "project");

  // Date-range scope — the dashboard's shared range selector flows in as
  // `days`. Applied before status filtering so both the stats overview and
  // the columns reflect the same window. A goal is in-range if it was last
  // updated within the window; "all time" maps to a large day count upstream.
  if (opts.days != null) {
    const cutoffIso = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString();
    projectGoals = projectGoals.filter((g) => {
      const updated = epochToIso(g.updated_at ?? g.updatedAt ?? null);
      return updated != null && updated >= cutoffIso;
    });
  }

  let filtered = projectGoals;

  if (opts.status) {
    const statuses = opts.status.split(",").map((s) => s.trim()).filter(Boolean);
    filtered = filtered.filter((g) => statuses.includes(g.status));
  } else {
    // Default: hide completed older than 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    filtered = filtered.filter((g) => {
      if (g.status !== "completed") return true;
      const completedAt = epochToIso(g.completed_at ?? g.completedAt ?? null);
      return completedAt != null && completedAt >= sevenDaysAgo;
    });
  }

  // Sort
  const asc = opts.order === "asc";
  const getSortVal = (g: BrainGoal): string => {
    if (opts.sort === "created_at") return String(g.created_at ?? g.createdAt ?? "");
    if (opts.sort === "name") return g.name;
    return String(g.updated_at ?? g.updatedAt ?? "");
  };
  filtered.sort((a, b) => {
    const va = getSortVal(a);
    const vb = getSortVal(b);
    return asc ? va.localeCompare(vb) : vb.localeCompare(va);
  });

  const totalGoals = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  // Adapt brain goals to KanbanGoal shape
  const goals: KanbanGoal[] = page.map((g) => {
    const brainTasks = g.tasks ?? [];
    const tasks: KanbanTask[] = brainTasks
      .filter((t) => t.status !== "cancelled")
      .map((t) => {
        const rawAttempts = t.attempts ?? [];
        const attempts: KanbanAttempt[] = rawAttempts.map((a) => ({
          attemptId: a.attempt_id ?? a.attemptId ?? "",
          attemptNumber: a.attempt_number ?? a.attemptNumber ?? 0,
          status: a.status as AttemptStatus,
          startedAt: epochToIso(a.started_at ?? a.startedAt ?? null) ?? "",
          endedAt: epochToIso(a.ended_at ?? a.endedAt ?? null),
          outputSummary: a.output_summary ?? a.outputSummary ?? null,
          failureReason: a.failure_reason ?? a.failureReason ?? null,
          artifactPaths: Array.isArray(a.artifact_paths)
            ? a.artifact_paths
            : Array.isArray(a.artifactPaths)
              ? a.artifactPaths
              : safeJsonParse(typeof a.artifact_paths === "string" ? a.artifact_paths : null, []),
        }));

        const activeAttempt = attempts.find((a) => a.status === "running") || null;

        return {
          id: t.id,
          name: t.name,
          task: t.task,
          status: t.status as TaskStatus,
          priority: t.priority || "normal",
          blockedBy: Array.isArray(t.blocked_by) ? t.blocked_by
            : Array.isArray(t.blockedBy) ? t.blockedBy
            : typeof t.blocked_by === "string" ? safeJsonParse(t.blocked_by, [])
            : [],
          attemptCount: t.attempt_count ?? t.attemptCount ?? 0,
          startedAt: epochToIso(t.started_at ?? t.startedAt ?? null),
          completedAt: epochToIso(t.completed_at ?? t.completedAt ?? null),
          failureReason: t.failure_reason ?? t.failureReason ?? null,
          onUpstreamFailure: t.on_upstream_failure ?? t.onUpstreamFailure ?? "wait",
          latestCheckpoint: (typeof t.latest_checkpoint === "string"
            ? safeJsonParse<TaskCheckpoint | null>(t.latest_checkpoint, null)
            : (t.latestCheckpoint as TaskCheckpoint | null) ?? null),
          latestOutput: t.latest_output ?? t.latestOutput ?? null,
          activeAttempt,
          attempts,
        };
      });

    // Extract agentId from first task's dispatch
    let agentId: string | null = g.agent_id ?? g.agentId ?? null;
    if (!agentId && brainTasks.length > 0) {
      const d = brainTasks[0].dispatch;
      if (typeof d === "string") {
        agentId = safeJsonParse<{ agentId?: string }>(d, {}).agentId ?? null;
      } else if (d && typeof d === "object") {
        agentId = d.agentId ?? null;
      }
    }

    return {
      id: g.id,
      name: g.name,
      description: g.description,
      status: g.status as GoalStatus,
      parentGoalId: g.parent_goal_id ?? g.parentGoalId ?? null,
      sourceWorkflowId: g.source_workflow_id ?? g.sourceWorkflowId ?? null,
      sourceWorkflowVersion: g.source_workflow_version ?? g.sourceWorkflowVersion ?? null,
      createdAt: epochToIso(g.created_at ?? g.createdAt ?? null) ?? "",
      updatedAt: epochToIso(g.updated_at ?? g.updatedAt ?? null) ?? "",
      completedAt: epochToIso(g.completed_at ?? g.completedAt ?? null),
      createdBy: g.created_by ?? g.createdBy ?? "",
      agentId,
      tasks,
    };
  });

  // Build stats. When a date window is applied, scope the overview to the
  // same date-filtered (but not status-filtered) goal set so the stats bar
  // and the board agree; otherwise use the brain's global board stats.
  const stats = opts.days != null
    ? buildKanbanStatsFromBoard({ goals: projectGoals })
    : buildKanbanStatsFromBoard(board);

  return {
    goals,
    stats,
    pagination: {
      limit,
      offset,
      total: totalGoals,
      hasMore: offset + limit < totalGoals,
    },
  };
}

// ── Workflow Templates for Mechanism View ──

export interface WorkflowStep {
  stepKey: string;
  name: string;
  blockedByKeys: string[];
  dispatch: { mode: string; agentId?: string };
  sortOrder: number;
}

export interface WorkflowLatestRun {
  goalId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  taskStatuses: Record<string, string>;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  tags: string[];
  steps: WorkflowStep[];
  latestRun: WorkflowLatestRun | null;
  totalRuns: number;
  successRate: number;
}

export interface WorkflowsForMechanismResponse {
  templates: WorkflowTemplate[];
  totalTemplates: number;
  fetchedAt: string;
}

export async function getWorkflowsForMechanism(): Promise<WorkflowsForMechanismResponse> {
  const [brainTemplates, board] = await Promise.all([
    brainWorkflowList(),
    brainBoard(),
  ]);

  const allGoals = board.goals;

  const result: WorkflowTemplate[] = brainTemplates.map((tmpl) => {
    // Steps
    const steps: WorkflowStep[] = (tmpl.steps ?? []).map((s, i) => ({
      stepKey: s.step_key ?? s.stepKey ?? `step-${i}`,
      name: s.name,
      blockedByKeys: Array.isArray(s.blocked_by_keys)
        ? s.blocked_by_keys
        : Array.isArray(s.blockedByKeys)
          ? s.blockedByKeys
          : safeJsonParse(typeof s.blocked_by_keys === "string" ? s.blocked_by_keys : null, []),
      dispatch: typeof s.dispatch === "string"
        ? safeJsonParse(s.dispatch, { mode: "spawn" })
        : s.dispatch ?? { mode: "spawn" },
      sortOrder: s.sort_order ?? s.sortOrder ?? i,
    }));

    // Run stats from board goals
    const linkedGoals = allGoals.filter(
      (g) => (g.source_workflow_id ?? g.sourceWorkflowId) === tmpl.id,
    );
    const totalRuns = tmpl.totalRuns ?? linkedGoals.length;
    const completedRuns = linkedGoals.filter((g) => g.status === "completed").length;

    // Latest run
    let latestRun: WorkflowLatestRun | null = tmpl.latestRun ?? null;
    if (!latestRun && linkedGoals.length > 0) {
      const sorted = [...linkedGoals].sort((a, b) => {
        const ta = String(a.created_at ?? a.createdAt ?? "");
        const tb = String(b.created_at ?? b.createdAt ?? "");
        return tb.localeCompare(ta);
      });
      const latest = sorted[0];
      const taskStatuses: Record<string, string> = {};
      for (const t of latest.tasks ?? []) {
        taskStatuses[t.name] = t.status;
      }
      latestRun = {
        goalId: latest.id,
        status: latest.status,
        startedAt: epochToIso(latest.created_at ?? latest.createdAt ?? null) ?? "",
        completedAt: epochToIso(latest.completed_at ?? latest.completedAt ?? null),
        taskStatuses,
      };
    }

    return {
      id: tmpl.id,
      name: tmpl.name,
      description: tmpl.description ?? "",
      version: tmpl.version ?? 1,
      tags: Array.isArray(tmpl.tags)
        ? tmpl.tags
        : safeJsonParse(typeof tmpl.tags === "string" ? tmpl.tags : null, []),
      steps,
      latestRun,
      totalRuns,
      successRate: tmpl.successRate ?? (totalRuns > 0
        ? Math.round((completedRuns / totalRuns) * 100 * 10) / 10
        : 0),
    };
  });

  return {
    templates: result,
    totalTemplates: result.length,
    fetchedAt: new Date().toISOString(),
  };
}

// Derive stats from brain board response (no SQLite)
function buildKanbanStatsFromBoard(
  board: { goals: BrainGoal[]; stats?: Record<string, unknown> },
): KanbanStats {
  // If brain already provides stats, use them
  if (board.stats) {
    const bs = board.stats as {
      goals?: { total?: number; byStatus?: Record<string, number> };
      tasks?: { total?: number; byStatus?: Record<string, number> };
      agents?: Array<{ agentId: string; goalCount: number }>;
    };
    if (bs.goals && bs.tasks) {
      return {
        goals: { total: bs.goals.total ?? 0, byStatus: bs.goals.byStatus ?? {} },
        tasks: { total: bs.tasks.total ?? 0, byStatus: bs.tasks.byStatus ?? {} },
        agents: bs.agents ?? [],
      };
    }
  }

  // Otherwise compute from goals list
  const goalsByStatus: Record<string, number> = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  const tasksByStatus: Record<string, number> = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  const agentCounts = new Map<string, number>();

  for (const g of board.goals) {
    goalsByStatus[g.status] = (goalsByStatus[g.status] ?? 0) + 1;
    for (const t of g.tasks ?? []) {
      tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
    }
    // Extract agent
    const agentId = g.agent_id ?? g.agentId ?? null;
    if (agentId) {
      agentCounts.set(agentId, (agentCounts.get(agentId) ?? 0) + 1);
    }
  }

  const goalTotal = Object.values(goalsByStatus).reduce((s, v) => s + v, 0);
  const taskTotal = Object.values(tasksByStatus).reduce((s, v) => s + v, 0);
  const agents: AgentGoalCount[] = [...agentCounts.entries()]
    .map(([agentId, goalCount]) => ({ agentId, goalCount }))
    .sort((a, b) => b.goalCount - a.goalCount);

  return {
    goals: { total: goalTotal, byStatus: goalsByStatus },
    tasks: { total: taskTotal, byStatus: tasksByStatus },
    agents,
  };
}
