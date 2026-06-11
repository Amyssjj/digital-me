import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
// Vite/vitest doesn't recognize experimental node:sqlite as a builtin
// (`module.builtinModules` excludes it); use createRequire so Node's loader
// resolves it at runtime instead of letting Vite try to bundle.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  createMetricTools,
  initMetricSchema,
} from "./metrics.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initMetricSchema(db);
});

afterEach(() => {
  db.close();
});

describe("initMetricSchema", () => {
  it("creates goal_metrics and goal_configs tables idempotently", () => {
    // Second call should not throw (CREATE TABLE IF NOT EXISTS).
    initMetricSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("goal_metrics");
    expect(names).toContain("goal_configs");
  });
});

describe("metric.record", () => {
  it("inserts a row with all fields populated", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.record({
      goal: "knowledge",
      metric: "preflight_rate",
      value: 87.5,
      unit: "%",
      date: "2026-05-15",
      source_agent: "coo",
      numerator: 35,
      denominator: 40,
      breakdown: { by_source: { transcript: 20, log: 15 } },
    });
    const row = db
      .prepare("SELECT * FROM goal_metrics WHERE goal = 'knowledge'")
      .get() as {
      goal: string;
      metric: string;
      value: number;
      unit: string;
      date: string;
      source_agent: string | null;
      numerator: number | null;
      denominator: number | null;
      breakdown: string | null;
    };
    expect(row.goal).toBe("knowledge");
    expect(row.metric).toBe("preflight_rate");
    expect(row.value).toBe(87.5);
    expect(row.unit).toBe("%");
    expect(row.date).toBe("2026-05-15");
    expect(row.source_agent).toBe("coo");
    expect(row.numerator).toBe(35);
    expect(row.denominator).toBe(40);
    expect(JSON.parse(row.breakdown!)).toEqual({
      by_source: { transcript: 20, log: 15 },
    });
  });

  it("defaults date to today (from injected clock) when omitted", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.record({ goal: "g", metric: "m", value: 1, unit: "n" });
    const row = db.prepare("SELECT date FROM goal_metrics").get() as { date: string };
    expect(row.date).toBe("2026-05-15");
  });

  it("stores null for optional fields when omitted", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.record({ goal: "g", metric: "m", value: 1, unit: "n" });
    const row = db.prepare("SELECT * FROM goal_metrics").get() as {
      source_agent: string | null;
      numerator: number | null;
      denominator: number | null;
      breakdown: string | null;
    };
    expect(row.source_agent).toBeNull();
    expect(row.numerator).toBeNull();
    expect(row.denominator).toBeNull();
    expect(row.breakdown).toBeNull();
  });

  it("overwrites an existing (goal, metric, date) tuple instead of duplicating", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.record({ goal: "g", metric: "m", value: 1, unit: "n", date: "2026-05-15" });
    tools.record({ goal: "g", metric: "m", value: 9, unit: "n", date: "2026-05-15" });
    const rows = db.prepare("SELECT value FROM goal_metrics").all() as { value: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(9);
  });
});

describe("metric.query", () => {
  function seed(): void {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.record({ goal: "knowledge", metric: "preflight_rate", value: 80, unit: "%", date: "2026-05-10" });
    tools.record({ goal: "knowledge", metric: "preflight_rate", value: 85, unit: "%", date: "2026-05-12" });
    tools.record({ goal: "knowledge", metric: "preflight_rate", value: 87, unit: "%", date: "2026-05-15" });
    tools.record({ goal: "knowledge", metric: "entries_created", value: 12, unit: "count", date: "2026-05-15" });
    tools.record({ goal: "validation", metric: "completion_rate", value: 92, unit: "%", date: "2026-05-15" });
  }

  it("returns all points when no filters set", () => {
    seed();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const result = tools.query({});
    expect(result.points).toHaveLength(5);
  });

  it("filters by goal", () => {
    seed();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const result = tools.query({ goal: "knowledge" });
    expect(result.points).toHaveLength(4);
    expect(result.points.every((p) => p.goal === "knowledge")).toBe(true);
  });

  it("filters by metric", () => {
    seed();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const result = tools.query({ metric: "preflight_rate" });
    expect(result.points).toHaveLength(3);
  });

  it("filters by goal AND metric together", () => {
    seed();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const result = tools.query({ goal: "knowledge", metric: "preflight_rate" });
    expect(result.points).toHaveLength(3);
  });

  it("filters by since (epoch ms)", () => {
    seed();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const since = new Date("2026-05-12T00:00:00Z").getTime();
    const result = tools.query({ since });
    expect(result.points.every((p) => p.date >= "2026-05-12")).toBe(true);
  });

  it("filters by until (epoch ms)", () => {
    seed();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const until = new Date("2026-05-12T23:59:59Z").getTime();
    const result = tools.query({ until });
    expect(result.points.every((p) => p.date <= "2026-05-12")).toBe(true);
  });

  it("parses breakdown JSON in returned points", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.record({
      goal: "g",
      metric: "m",
      value: 1,
      unit: "n",
      date: "2026-05-15",
      breakdown: { foo: 42 },
    });
    const result = tools.query({ goal: "g" });
    expect(result.points[0]!.breakdown).toEqual({ foo: 42 });
  });

  it("returns null breakdown when not set", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.record({ goal: "g", metric: "m", value: 1, unit: "n", date: "2026-05-15" });
    const result = tools.query({ goal: "g" });
    expect(result.points[0]!.breakdown).toBeNull();
  });

  it("returns points sorted by date ascending", () => {
    seed();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const result = tools.query({ goal: "knowledge", metric: "preflight_rate" });
    const dates = result.points.map((p) => p.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe("metric.goal_config + goal_config_list", () => {
  it("stores a goal config and retrieves it", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.goalConfig({
      id: "knowledge",
      name: "Knowledge",
      icon: "🧠",
      color: "#22D3EE",
      primary_metric: "preflight_rate",
      unit: "%",
      healthy_threshold: 80,
      warning_threshold: 50,
    });
    const result = tools.goalConfigList();
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]).toMatchObject({
      id: "knowledge",
      name: "Knowledge",
      primary_metric: "preflight_rate",
      healthy_threshold: 80,
      warning_threshold: 50,
    });
  });

  it("preserves invert_health=false default when omitted (no flag stored)", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.goalConfig({
      id: "g",
      name: "G",
      icon: "x",
      color: "#000",
      primary_metric: "m",
      unit: "%",
      healthy_threshold: 1,
      warning_threshold: 0,
    });
    const result = tools.goalConfigList();
    expect(result.configs[0]!.invert_health).toBe(false);
  });

  it("preserves invert_health=true when explicitly set", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.goalConfig({
      id: "violations",
      name: "Violations",
      icon: "x",
      color: "#000",
      primary_metric: "rate",
      unit: "%",
      healthy_threshold: 1,
      warning_threshold: 5,
      invert_health: true,
    });
    const result = tools.goalConfigList();
    expect(result.configs[0]!.invert_health).toBe(true);
  });

  it("upserts a config by id (re-registering replaces)", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const base = {
      id: "g",
      name: "First",
      icon: "x",
      color: "#000",
      primary_metric: "m",
      unit: "%",
      healthy_threshold: 80,
      warning_threshold: 50,
    };
    tools.goalConfig(base);
    tools.goalConfig({ ...base, name: "Second", healthy_threshold: 90 });
    const result = tools.goalConfigList();
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.name).toBe("Second");
    expect(result.configs[0]!.healthy_threshold).toBe(90);
  });

  it("returns empty list when no configs are registered", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    expect(tools.goalConfigList().configs).toEqual([]);
  });

  it("returns configs ordered by registration order (id ASC)", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    for (const id of ["zebra", "alpha", "mango"]) {
      tools.goalConfig({
        id,
        name: id,
        icon: "x",
        color: "#000",
        primary_metric: "m",
        unit: "%",
        healthy_threshold: 1,
        warning_threshold: 0,
      });
    }
    const result = tools.goalConfigList();
    expect(result.configs.map((c) => c.id)).toEqual(["alpha", "mango", "zebra"]);
  });
});

describe("metric.summary — composes record + config + query", () => {
  function setupGoalAndMetrics(): void {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.goalConfig({
      id: "knowledge",
      name: "Knowledge",
      icon: "🧠",
      color: "#22D3EE",
      primary_metric: "preflight_rate",
      unit: "%",
      healthy_threshold: 80,
      warning_threshold: 50,
    });
    tools.record({ goal: "knowledge", metric: "preflight_rate", value: 70, unit: "%", date: "2026-05-13" });
    tools.record({ goal: "knowledge", metric: "preflight_rate", value: 75, unit: "%", date: "2026-05-14" });
    tools.record({ goal: "knowledge", metric: "preflight_rate", value: 87, unit: "%", date: "2026-05-15" });
    tools.record({ goal: "knowledge", metric: "entries_created", value: 12, unit: "count", date: "2026-05-15" });
  }

  it("returns one summary per configured goal", () => {
    setupGoalAndMetrics();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const result = tools.summary({});
    expect(result.goals).toHaveLength(1);
    expect(result.goals[0]!.id).toBe("knowledge");
  });

  it("populates current_value from the latest primary metric reading", () => {
    setupGoalAndMetrics();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const out = tools.summary({});
    expect(out.goals[0]!.current_value).toBe(87);
  });

  it("computes trend as current - previous", () => {
    setupGoalAndMetrics();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const out = tools.summary({});
    expect(out.goals[0]!.previous_value).toBe(75);
    expect(out.goals[0]!.trend).toBe(12);
  });

  it("returns null trend when only one data point exists", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.goalConfig({
      id: "g",
      name: "G",
      icon: "x",
      color: "#000",
      primary_metric: "m",
      unit: "%",
      healthy_threshold: 80,
      warning_threshold: 50,
    });
    tools.record({ goal: "g", metric: "m", value: 50, unit: "%", date: "2026-05-15" });
    const out = tools.summary({});
    expect(out.goals[0]!.previous_value).toBeNull();
    expect(out.goals[0]!.trend).toBeNull();
  });

  it("returns null current_value when there are no readings", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.goalConfig({
      id: "g",
      name: "G",
      icon: "x",
      color: "#000",
      primary_metric: "m",
      unit: "%",
      healthy_threshold: 80,
      warning_threshold: 50,
    });
    const out = tools.summary({});
    expect(out.goals[0]!.current_value).toBeNull();
    expect(out.goals[0]!.trend).toBeNull();
    expect(out.goals[0]!.health_status).toBe("warning");
    expect(out.goals[0]!.health_score).toBeNull();
  });

  it("emits a sparkline of every recorded primary-metric value (ascending)", () => {
    setupGoalAndMetrics();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const out = tools.summary({});
    expect(out.goals[0]!.sparkline).toEqual([
      { date: "2026-05-13", value: 70 },
      { date: "2026-05-14", value: 75 },
      { date: "2026-05-15", value: 87 },
    ]);
  });

  it("populates sub_metrics with the latest non-primary metric values", () => {
    setupGoalAndMetrics();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    const out = tools.summary({});
    expect(out.goals[0]!.sub_metrics.entries_created).toEqual({
      value: 12,
      unit: "count",
      breakdown: undefined,
    });
  });

  it("parses sub_metric breakdown JSON", () => {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.goalConfig({
      id: "g",
      name: "G",
      icon: "x",
      color: "#000",
      primary_metric: "main",
      unit: "%",
      healthy_threshold: 80,
      warning_threshold: 50,
    });
    tools.record({ goal: "g", metric: "main", value: 50, unit: "%", date: "2026-05-15" });
    tools.record({
      goal: "g",
      metric: "sub",
      value: 10,
      unit: "n",
      date: "2026-05-15",
      breakdown: { a: 1 },
    });
    const out = tools.summary({});
    expect(out.goals[0]!.sub_metrics.sub!.breakdown).toEqual({ a: 1 });
  });

  it("filters summary to a subset of goal ids when `goals` is provided", () => {
    setupGoalAndMetrics();
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.goalConfig({
      id: "other",
      name: "Other",
      icon: "x",
      color: "#000",
      primary_metric: "m",
      unit: "%",
      healthy_threshold: 80,
      warning_threshold: 50,
    });
    const out = tools.summary({ goals: ["knowledge"] });
    expect(out.goals).toHaveLength(1);
    expect(out.goals[0]!.id).toBe("knowledge");
  });
});

describe("metric.summary — health classification", () => {
  function makeGoal(opts: { invert?: boolean; healthy: number; warning: number; unit?: string }): {
    record: (value: number) => void;
    summary: () => ReturnType<ReturnType<typeof createMetricTools>["summary"]>["goals"][number];
  } {
    const tools = createMetricTools({ db, now: () => new Date("2026-05-15T12:00:00Z") });
    tools.goalConfig({
      id: "g",
      name: "G",
      icon: "x",
      color: "#000",
      primary_metric: "m",
      unit: opts.unit ?? "%",
      healthy_threshold: opts.healthy,
      warning_threshold: opts.warning,
      invert_health: opts.invert ?? false,
    });
    return {
      record: (value: number) =>
        tools.record({
          goal: "g",
          metric: "m",
          value,
          unit: opts.unit ?? "%",
          date: "2026-05-15",
        }),
      summary: () => tools.summary({}).goals[0]!,
    };
  }

  it("higher-is-better: value >= healthy_threshold → healthy", () => {
    const g = makeGoal({ healthy: 80, warning: 50 });
    g.record(85);
    expect(g.summary().health_status).toBe("healthy");
  });

  it("higher-is-better: warning_threshold <= value < healthy_threshold → warning", () => {
    const g = makeGoal({ healthy: 80, warning: 50 });
    g.record(60);
    expect(g.summary().health_status).toBe("warning");
  });

  it("higher-is-better: value < warning_threshold → critical", () => {
    const g = makeGoal({ healthy: 80, warning: 50 });
    g.record(30);
    expect(g.summary().health_status).toBe("critical");
  });

  it("invert_health: value <= healthy_threshold → healthy", () => {
    const g = makeGoal({ invert: true, healthy: 5, warning: 10 });
    g.record(3);
    expect(g.summary().health_status).toBe("healthy");
  });

  it("invert_health: between thresholds → warning", () => {
    const g = makeGoal({ invert: true, healthy: 5, warning: 10 });
    g.record(7);
    expect(g.summary().health_status).toBe("warning");
  });

  it("invert_health: value > warning_threshold → critical", () => {
    const g = makeGoal({ invert: true, healthy: 5, warning: 10 });
    g.record(15);
    expect(g.summary().health_status).toBe("critical");
  });

  it("percent unit: health_score is value clamped 0..100", () => {
    const g = makeGoal({ healthy: 80, warning: 50, unit: "%" });
    g.record(72);
    expect(g.summary().health_score).toBe(72);
  });

  it("percent + invert: health_score is 100 - value (clamped)", () => {
    const g = makeGoal({ invert: true, healthy: 5, warning: 10, unit: "%" });
    g.record(15);
    expect(g.summary().health_score).toBe(85);
  });

  it("percent: health_score clamps negative values to 0", () => {
    const g = makeGoal({ healthy: 80, warning: 50, unit: "%" });
    g.record(-10);
    expect(g.summary().health_score).toBe(0);
  });

  it("percent: health_score clamps values >100 to 100", () => {
    const g = makeGoal({ healthy: 80, warning: 50, unit: "%" });
    g.record(150);
    expect(g.summary().health_score).toBe(100);
  });

  it("count unit: maps to 0-100 score buckets — healthy=90", () => {
    const g = makeGoal({ healthy: 5, warning: 2, unit: "count" });
    g.record(7);
    expect(g.summary().health_score).toBe(90);
  });

  it("count unit: warning band = 65", () => {
    const g = makeGoal({ healthy: 5, warning: 2, unit: "count" });
    g.record(3);
    expect(g.summary().health_score).toBe(65);
  });

  it("count unit: below warning = 40", () => {
    const g = makeGoal({ healthy: 5, warning: 2, unit: "count" });
    g.record(1);
    expect(g.summary().health_score).toBe(40);
  });

  it("count + invert: healthy (value <= healthy_threshold) = 100", () => {
    const g = makeGoal({ invert: true, healthy: 5, warning: 10, unit: "count" });
    g.record(3);
    expect(g.summary().health_score).toBe(100);
  });

  it("count + invert: between thresholds = 70", () => {
    const g = makeGoal({ invert: true, healthy: 5, warning: 10, unit: "count" });
    g.record(7);
    expect(g.summary().health_score).toBe(70);
  });

  it("count + invert: >= warning_threshold = 30", () => {
    const g = makeGoal({ invert: true, healthy: 5, warning: 10, unit: "count" });
    g.record(15);
    expect(g.summary().health_score).toBe(30);
  });
});
