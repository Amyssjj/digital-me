/**
 * metric.* tool family for brain-orchestrator.
 *
 * Implements the operational-telemetry contract from
 * docs/BRAIN-OPERATIONAL-TELEMETRY-TOOLS.md.
 *
 * Storage: SQLite via node:sqlite (Node 22.5+ built-in). The schema is created on demand
 * (idempotent CREATE TABLE IF NOT EXISTS), so it composes with the rest
 * of brain-orchestrator's tables in the same store.
 *
 * Tools are pure functions over an injected `db` connection plus a clock
 * function — no module state, no module-level singletons. The plugin
 * entry point in index.ts owns the actual SQLite connection and supplies it.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  GoalConfigArgs,
  GoalConfigListResult,
  GoalSummary,
  HealthStatus,
  MetricPoint,
  MetricQueryArgs,
  MetricQueryResult,
  MetricRecordArgs,
  MetricSummaryArgs,
  MetricSummaryResult,
} from "@digital-me/contracts";

// ── Schema ──────────────────────────────────────────────────────────────────

export function initMetricSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_metrics (
      goal          TEXT NOT NULL,
      metric        TEXT NOT NULL,
      date          TEXT NOT NULL,
      value         REAL NOT NULL,
      unit          TEXT NOT NULL,
      source_agent  TEXT,
      numerator     REAL,
      denominator   REAL,
      breakdown     TEXT,
      PRIMARY KEY (goal, metric, date)
    );

    CREATE INDEX IF NOT EXISTS idx_goal_metrics_date
      ON goal_metrics(date);

    CREATE TABLE IF NOT EXISTS goal_configs (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      icon               TEXT NOT NULL,
      color              TEXT NOT NULL,
      primary_metric     TEXT NOT NULL,
      unit               TEXT NOT NULL,
      healthy_threshold  REAL NOT NULL,
      warning_threshold  REAL NOT NULL,
      invert_health      INTEGER NOT NULL DEFAULT 0,
      registered_at      INTEGER NOT NULL
    );
  `);
}

// ── Tool factory ────────────────────────────────────────────────────────────

export type MetricTools = {
  record(args: MetricRecordArgs): void;
  query(args: MetricQueryArgs): MetricQueryResult;
  goalConfig(args: GoalConfigArgs): void;
  goalConfigList(): GoalConfigListResult;
  summary(args: MetricSummaryArgs): MetricSummaryResult;
};

type GoalConfigRow = {
  id: string;
  name: string;
  icon: string;
  color: string;
  primary_metric: string;
  unit: string;
  healthy_threshold: number;
  warning_threshold: number;
  invert_health: number;
};

type MetricRow = {
  goal: string;
  metric: string;
  date: string;
  value: number;
  unit: string;
  breakdown: string | null;
};

function todayString(now: () => Date): string {
  return now().toISOString().slice(0, 10);
}

function dateFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function rowToMetricPoint(row: MetricRow): MetricPoint {
  return {
    goal: row.goal,
    metric: row.metric,
    date: row.date,
    value: row.value,
    unit: row.unit,
    breakdown: row.breakdown === null ? null : (JSON.parse(row.breakdown) as Record<string, unknown>),
  };
}

function rowToConfig(row: GoalConfigRow): GoalConfigArgs {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    primary_metric: row.primary_metric,
    unit: row.unit,
    healthy_threshold: row.healthy_threshold,
    warning_threshold: row.warning_threshold,
    invert_health: row.invert_health === 1,
  };
}

// Pure helpers — extracted so tests can exercise them via summary() with
// minimal seeding. Identical contract to the upstream computeHealthStatus /
// computeHealthScore so dashboard parity is preserved.

function computeHealthStatus(
  value: number | null,
  config: GoalConfigArgs,
): HealthStatus {
  if (value === null) return "warning";
  if (config.invert_health === true) {
    if (value <= config.healthy_threshold) return "healthy";
    if (value <= config.warning_threshold) return "warning";
    return "critical";
  }
  if (value >= config.healthy_threshold) return "healthy";
  if (value >= config.warning_threshold) return "warning";
  return "critical";
}

function computeHealthScore(
  value: number | null,
  config: GoalConfigArgs,
): number | null {
  if (value === null) return null;
  if (config.unit === "%" || config.unit === "percent") {
    if (config.invert_health === true) {
      return Math.max(0, Math.min(100, 100 - value));
    }
    return Math.min(100, Math.max(0, value));
  }
  // Count-based bucketing.
  if (config.invert_health === true) {
    if (value <= config.healthy_threshold) return 100;
    if (value >= config.warning_threshold) return 30;
    return 70;
  }
  if (value >= config.healthy_threshold) return 90;
  if (value >= config.warning_threshold) return 65;
  return 40;
}

export function createMetricTools(deps: {
  db: DatabaseSync;
  now: () => Date;
}): MetricTools {
  const { db, now } = deps;

  const insertMetric = db.prepare(`
    INSERT INTO goal_metrics
      (goal, metric, date, value, unit, source_agent, numerator, denominator, breakdown)
    VALUES
      (@goal, @metric, @date, @value, @unit, @source_agent, @numerator, @denominator, @breakdown)
    ON CONFLICT(goal, metric, date) DO UPDATE SET
      value = excluded.value,
      unit = excluded.unit,
      source_agent = excluded.source_agent,
      numerator = excluded.numerator,
      denominator = excluded.denominator,
      breakdown = excluded.breakdown
  `);

  const upsertConfig = db.prepare(`
    INSERT INTO goal_configs
      (id, name, icon, color, primary_metric, unit,
       healthy_threshold, warning_threshold, invert_health, registered_at)
    VALUES
      (@id, @name, @icon, @color, @primary_metric, @unit,
       @healthy_threshold, @warning_threshold, @invert_health, @registered_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      icon = excluded.icon,
      color = excluded.color,
      primary_metric = excluded.primary_metric,
      unit = excluded.unit,
      healthy_threshold = excluded.healthy_threshold,
      warning_threshold = excluded.warning_threshold,
      invert_health = excluded.invert_health
  `);

  function record(args: MetricRecordArgs): void {
    insertMetric.run({
      goal: args.goal,
      metric: args.metric,
      date: args.date ?? todayString(now),
      value: args.value,
      unit: args.unit,
      source_agent: args.source_agent ?? null,
      numerator: args.numerator ?? null,
      denominator: args.denominator ?? null,
      breakdown:
        args.breakdown === undefined ? null : JSON.stringify(args.breakdown),
    });
  }

  function query(args: MetricQueryArgs): MetricQueryResult {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (args.goal !== undefined) {
      clauses.push("goal = @goal");
      params.goal = args.goal;
    }
    if (args.metric !== undefined) {
      clauses.push("metric = @metric");
      params.metric = args.metric;
    }
    if (args.since !== undefined) {
      clauses.push("date >= @since");
      params.since = dateFromEpochMs(args.since);
    }
    if (args.until !== undefined) {
      clauses.push("date <= @until");
      params.until = dateFromEpochMs(args.until);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `
      SELECT goal, metric, date, value, unit, breakdown
      FROM goal_metrics
      ${where}
      ORDER BY date ASC
    `;
    const rows = db.prepare(sql).all(params) as MetricRow[];
    return { points: rows.map(rowToMetricPoint) };
  }

  function goalConfig(args: GoalConfigArgs): void {
    upsertConfig.run({
      id: args.id,
      name: args.name,
      icon: args.icon,
      color: args.color,
      primary_metric: args.primary_metric,
      unit: args.unit,
      healthy_threshold: args.healthy_threshold,
      warning_threshold: args.warning_threshold,
      invert_health: args.invert_health === true ? 1 : 0,
      registered_at: now().getTime(),
    });
  }

  function goalConfigList(): GoalConfigListResult {
    const rows = db
      .prepare(
        `SELECT * FROM goal_configs ORDER BY id ASC`,
      )
      .all() as GoalConfigRow[];
    return { configs: rows.map(rowToConfig) };
  }

  function buildGoalSummary(config: GoalConfigArgs): GoalSummary {
    // Latest + previous primary metric points.
    const primaryRows = db
      .prepare(
        `SELECT date, value FROM goal_metrics
         WHERE goal = @goal AND metric = @metric
         ORDER BY date DESC
         LIMIT 2`,
      )
      .all({ goal: config.id, metric: config.primary_metric }) as Array<{
      date: string;
      value: number;
    }>;
    const latest = primaryRows[0] ?? null;
    const previous = primaryRows[1] ?? null;

    // Full sparkline (ascending).
    const sparklineRows = db
      .prepare(
        `SELECT date, value FROM goal_metrics
         WHERE goal = @goal AND metric = @metric
         ORDER BY date ASC`,
      )
      .all({ goal: config.id, metric: config.primary_metric }) as Array<{
      date: string;
      value: number;
    }>;

    // Sub-metrics: latest non-primary metric values.
    const subRows = db
      .prepare(
        `
        SELECT gm.metric, gm.value, gm.unit, gm.breakdown
        FROM goal_metrics gm
        INNER JOIN (
          SELECT metric, MAX(date) AS max_date
          FROM goal_metrics WHERE goal = @goal
          GROUP BY metric
        ) latest ON gm.metric = latest.metric AND gm.date = latest.max_date
        WHERE gm.goal = @goal AND gm.metric != @primary
      `,
      )
      .all({ goal: config.id, primary: config.primary_metric }) as Array<{
      metric: string;
      value: number;
      unit: string;
      breakdown: string | null;
    }>;

    const sub_metrics: Record<string, {
      value: number;
      unit: string;
      breakdown?: unknown;
    }> = {};
    for (const row of subRows) {
      sub_metrics[row.metric] = {
        value: row.value,
        unit: row.unit,
        breakdown:
          row.breakdown === null
            ? undefined
            : (JSON.parse(row.breakdown) as unknown),
      };
    }

    const current_value = latest === null ? null : latest.value;
    const previous_value = previous === null ? null : previous.value;
    const trend =
      latest !== null && previous !== null
        ? Number((current_value! - previous_value!).toFixed(1))
        : null;

    return {
      id: config.id,
      name: config.name,
      icon: config.icon,
      color: config.color,
      current_value,
      previous_value,
      trend,
      unit: config.unit,
      health_status: computeHealthStatus(current_value, config),
      health_score: computeHealthScore(current_value, config),
      improvement_count: 0,
      sparkline: sparklineRows.map((r) => ({ date: r.date, value: r.value })),
      primary_metric: config.primary_metric,
      sub_metrics,
    };
  }

  function summary(args: MetricSummaryArgs): MetricSummaryResult {
    const all = goalConfigList().configs;
    const filter = args.goals;
    const selected =
      filter !== undefined ? all.filter((c) => filter.includes(c.id)) : all;
    return { goals: selected.map(buildGoalSummary) };
  }

  return { record, query, goalConfig, goalConfigList, summary };
}
