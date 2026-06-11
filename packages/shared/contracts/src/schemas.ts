/**
 * Schemas for the parts of `config.yaml` (in the user's digital-me-data repo)
 * that public packages consume.
 *
 * These are TypeScript types only — packages that need runtime validation
 * should layer a validator (zod, typebox) on top using these as the source
 * of truth. We avoid pinning a validator here so each consumer can pick the
 * one that fits its environment.
 *
 * Anything user-specific (injection rules, agent IDs, schedule times, source
 * paths, wiki taxonomy) lives in these schemas and is loaded from
 * `$DIGITAL_ME_HOME/config.yaml`, not from package source.
 */

// ---------------------------------------------------------------------------
// Injection rules — consumed by runtime adapters
//
// A rule says: when an agent with `agent` ID issues a prompt containing any
// of `keywords`, inject wiki content from the listed `domains` into the
// system prompt or context window.
// ---------------------------------------------------------------------------

export type InjectionRule = {
  /** Agent ID to match. Use "*" to apply to all agents. */
  readonly agent: string;
  /** Keywords (lowercased substring match) that trigger this rule. Optional — empty array means "always match this agent." */
  readonly keywords?: readonly string[];
  /** Wiki domain directories (relative to $DIGITAL_ME_WIKI_DIR) to draw from. */
  readonly domains: readonly string[];
  /** Optional cap on injected character count. */
  readonly maxChars?: number;
};

export type InjectionRulesConfig = {
  readonly rules: readonly InjectionRule[];
  /** Domains always considered relevant regardless of keyword match. */
  readonly alwaysInclude?: readonly string[];
};

// ---------------------------------------------------------------------------
// Workflow templates — consumed by brain-orchestrator
// ---------------------------------------------------------------------------

export type WorkflowTemplate = {
  readonly id: string;
  readonly description: string;
  /** Cron expression (UTC unless `tz` set). */
  readonly cron?: string;
  readonly tz?: string;
  /** Exec command or subagent prompt to invoke. */
  readonly exec?: string;
  readonly prompt?: string;
  /** If true, the workflow loads a minimal context (no workspace bootstrap). */
  readonly lightContext?: boolean;
};

export type WorkflowsConfig = {
  readonly templates: readonly WorkflowTemplate[];
};

// ---------------------------------------------------------------------------
// Dream-cycle sources — consumed by services/dream-cycle
// ---------------------------------------------------------------------------

export type DreamCycleSource = {
  readonly name: string;
  /** Absolute or `$DIGITAL_ME_HOME`-relative path to ingest from. */
  readonly path: string;
  /** Source format: transcript-jsonl, transcript-json, learning-md, skill-md, etc. */
  readonly format: string;
  /** Optional filters (e.g., min user_turns) — interpreted by the pipeline. */
  readonly filters?: Readonly<Record<string, unknown>>;
};

export type DreamCycleConfig = {
  readonly sources: readonly DreamCycleSource[];
  /** Where compiled wiki entries land. Defaults to $DIGITAL_ME_WIKI_DIR. */
  readonly wikiOutputDir?: string;
  /** Optional integration sync targets. */
  readonly integrations?: Readonly<Record<string, unknown>>;
};

// ---------------------------------------------------------------------------
// Dashboard config — consumed by services/dashboard
// ---------------------------------------------------------------------------

export type GoalDefinition = {
  readonly id: string;
  readonly name: string;
  readonly metrics?: readonly string[];
};

export type DashboardConfig = {
  /** Goals/metric definitions surfaced on the dashboard's mechanism view. */
  readonly goals?: readonly GoalDefinition[];
  /** Optional team workspace integration. */
  readonly team?: {
    readonly workspaceRoot?: string;
    readonly learningSourceDir?: string;
    readonly learningDestDir?: string;
  };
};

// ---------------------------------------------------------------------------
// Brain operational telemetry tool surface
//
// These types describe the MCP tool inputs/outputs that brain-orchestrator
// exposes for metrics, issues, feedback, insights, cron history, and agent
// activity. See docs/BRAIN-OPERATIONAL-TELEMETRY-TOOLS.md for the full
// specification.
//
// Consumers (the dashboard, future plugins) import these types and validate
// at the tool boundary. No `as Array<{...}>` casts on raw tool results.
// ---------------------------------------------------------------------------

// Shared primitives ─────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "warning" | "critical";
export type IssueStatus =
  | "open"
  | "in_progress"
  | "verify"
  | "closed"
  | "completed";
export type IssueType = "bug" | "improvement" | "automation_opportunity";
export type InsightStatus = "surfaced" | "discussed" | "resolved" | "archived";
export type CronRunStatus = "success" | "failed" | "skipped" | "missed";

// metric.* ──────────────────────────────────────────────────────────────────

export type MetricRecordArgs = {
  readonly goal: string;
  readonly metric: string;
  readonly value: number;
  readonly unit: string;
  readonly date?: string;
  readonly source_agent?: string;
  readonly numerator?: number;
  readonly denominator?: number;
  readonly breakdown?: Record<string, unknown>;
};

export type MetricQueryArgs = {
  readonly goal?: string;
  readonly metric?: string;
  readonly since?: number;
  readonly until?: number;
};

export type MetricPoint = {
  readonly date: string;
  readonly goal: string;
  readonly metric: string;
  readonly value: number;
  readonly unit: string;
  readonly breakdown: Record<string, unknown> | null;
};

export type MetricQueryResult = {
  readonly points: readonly MetricPoint[];
};

export type MetricSummaryArgs = {
  readonly goals?: readonly string[];
};

export type GoalSummary = {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: string;
  readonly current_value: number | null;
  readonly previous_value: number | null;
  readonly trend: number | null;
  readonly unit: string;
  readonly health_status: HealthStatus;
  readonly health_score: number | null;
  readonly improvement_count: number;
  readonly sparkline: ReadonlyArray<{ date: string; value: number }>;
  readonly primary_metric: string;
  readonly sub_metrics: Readonly<Record<string, {
    value: number;
    unit: string;
    breakdown?: unknown;
  }>>;
};

export type MetricSummaryResult = {
  readonly goals: readonly GoalSummary[];
};

export type GoalConfigArgs = {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: string;
  readonly primary_metric: string;
  readonly unit: string;
  readonly healthy_threshold: number;
  readonly warning_threshold: number;
  readonly invert_health?: boolean;
};

export type GoalConfigListResult = {
  readonly configs: readonly GoalConfigArgs[];
};

// issue.* ───────────────────────────────────────────────────────────────────

export type IssueOpenArgs = {
  readonly type: IssueType;
  readonly title: string;
  readonly goal?: string;
  readonly description?: string;
  readonly category?: string;
  readonly severity?: string;
  readonly reported_by?: string;
};

export type IssueUpdateArgs = {
  readonly id: string;
  readonly status: IssueStatus;
  readonly resolution?: string;
};

export type IssueListArgs = {
  readonly type?: IssueType;
  readonly status?: IssueStatus;
  readonly goal?: string;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
};

export type IssueRecord = {
  readonly id: string;
  readonly date: string;
  readonly type: IssueType;
  readonly goal: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly severity: string | null;
  readonly status: IssueStatus;
  readonly reported_by: string | null;
};

export type IssueListResult = {
  readonly issues: readonly IssueRecord[];
};

export type IssueSummaryResult = {
  readonly by_reporter: ReadonlyArray<{ reporter: string; count: number }>;
  readonly total: number;
  readonly closed: number;
  readonly fix_rate: number;
};

export type IssueTimeseriesArgs = {
  readonly since?: number;
  readonly until?: number;
  readonly by: "reporter" | "type" | "goal";
};

export type IssueTimeseriesPoint = {
  readonly date: string;
  readonly dim: string;
  readonly opened: number;
  readonly closed: number;
};

export type IssueTimeseriesResult = {
  readonly points: readonly IssueTimeseriesPoint[];
};

// feedback.* ────────────────────────────────────────────────────────────────

export type FeedbackSubmitArgs = {
  readonly type: string;
  readonly agent: string;
  readonly description: string;
  readonly severity?: string;
  readonly source: string;
  readonly related_goal?: string;
};

export type FeedbackListArgs = {
  readonly since?: number;
  readonly limit?: number;
};

export type FeedbackRecord = {
  readonly id: number;
  readonly date: string;
  readonly type: string;
  readonly agent: string;
  readonly description: string;
  readonly severity: string | null;
  readonly source: string;
  readonly related_goal: string | null;
  readonly resolved: boolean;
};

export type FeedbackListResult = {
  readonly feedback: readonly FeedbackRecord[];
};

// insight.* ─────────────────────────────────────────────────────────────────

export type InsightCaptureArgs = {
  readonly type: string;
  readonly observation: string;
  readonly why_it_matters?: string;
  readonly question_for_jing?: string;
  readonly proposed_action?: string;
  readonly related_goal?: string;
};

export type InsightListArgs = {
  readonly status_filter?: readonly InsightStatus[];
  readonly since?: number;
  readonly limit?: number;
};

export type InsightRecord = {
  readonly id: string;
  readonly date: string;
  readonly type: string;
  readonly observation: string;
  readonly why_it_matters: string | null;
  readonly question_for_jing: string | null;
  readonly proposed_action: string | null;
  readonly related_goal: string | null;
  readonly status: InsightStatus;
};

export type InsightListResult = {
  readonly insights: readonly InsightRecord[];
};

// cron.* (read side) ────────────────────────────────────────────────────────

export type CronHistoryArgs = {
  readonly cron_name?: string;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
};

export type CronRunRecord = {
  readonly date: string;
  readonly cron_name: string;
  readonly scheduled_time: string;
  readonly run_time: string | null;
  readonly status: CronRunStatus;
  readonly duration_ms: number | null;
  readonly error: string | null;
};

export type CronHistoryResult = {
  readonly runs: readonly CronRunRecord[];
};

export type CronSummaryPoint = {
  readonly date: string;
  readonly total_scheduled: number;
  readonly success_count: number;
  readonly failed_count: number;
  readonly skipped_count: number;
  readonly missed_count: number;
  readonly success_rate: number;
};

export type CronSummaryResult = {
  readonly points: readonly CronSummaryPoint[];
};

export type CronPerJobPoint = {
  readonly date: string;
  readonly cron_name: string;
  readonly total_slots: number;
  readonly success_count: number;
  readonly failed_count: number;
  readonly missed_count: number;
  readonly success_rate: number;
};

export type CronPerJobSummaryResult = {
  readonly points: readonly CronPerJobPoint[];
};

// agent_activity.* ─────────────────────────────────────────────────────────

export type PromptByteBreakdown = {
  readonly agents_md: number;
  readonly memory_md: number;
  readonly soul_md: number;
  readonly user_md: number;
  readonly tools_md: number;
  readonly heartbeat_md: number;
  readonly total: number;
};

export type AgentActivityRecordArgs = {
  readonly agent_id: string;
  readonly date: string;
  readonly status: string;
  readonly sessions_count: number;
  readonly prompt_byte_breakdown: PromptByteBreakdown;
};

export type AgentActivityQueryArgs = {
  readonly since?: number;
  readonly until?: number;
  readonly agent_id?: string;
};

export type AgentActivityPoint = {
  readonly agent_id: string;
  readonly date: string;
  readonly status: string;
  readonly sessions_count: number;
  readonly prompt_byte_breakdown: PromptByteBreakdown;
};

export type AgentActivityQueryResult = {
  readonly activity: readonly AgentActivityPoint[];
};

// ---------------------------------------------------------------------------
// Top-level config.yaml shape
// ---------------------------------------------------------------------------

export type GoalConfigDefinition = GoalConfigArgs;

export type LabelMaps = {
  /** agent_id -> display label (e.g., "cto" -> "CTO"). User taxonomy, not public code. */
  readonly agents?: Readonly<Record<string, string>>;
  /** reporter id -> display label (e.g., "owner_modal" -> "Owner"). User taxonomy. */
  readonly reporters?: Readonly<Record<string, string>>;
};

export type DigitalMeConfig = {
  readonly injectionRules?: InjectionRulesConfig;
  readonly workflows?: WorkflowsConfig;
  readonly dreamCycle?: DreamCycleConfig;
  readonly dashboard?: DashboardConfig;
  readonly goalConfigs?: readonly GoalConfigDefinition[];
  readonly labels?: LabelMaps;
};
