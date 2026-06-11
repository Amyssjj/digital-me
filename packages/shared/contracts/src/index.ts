/**
 * @digital-me/contracts
 *
 * Single source of truth for env-var configuration and config.yaml schemas
 * consumed by digital-me-os packages.
 */

export {
  loadConfig,
  describeEnv,
  allEnvKeys,
  MissingRequiredEnvError,
} from "./env.js";

export type { EnvKey } from "./env.js";

export type {
  InjectionRule,
  InjectionRulesConfig,
  WorkflowTemplate,
  WorkflowsConfig,
  DreamCycleSource,
  DreamCycleConfig,
  DashboardConfig,
  GoalDefinition,
  DigitalMeConfig,
  // Brain operational telemetry — see docs/BRAIN-OPERATIONAL-TELEMETRY-TOOLS.md
  HealthStatus,
  IssueStatus,
  IssueType,
  InsightStatus,
  CronRunStatus,
  // metric.*
  MetricRecordArgs,
  MetricQueryArgs,
  MetricPoint,
  MetricQueryResult,
  MetricSummaryArgs,
  GoalSummary,
  MetricSummaryResult,
  GoalConfigArgs,
  GoalConfigListResult,
  // issue.*
  IssueOpenArgs,
  IssueUpdateArgs,
  IssueListArgs,
  IssueRecord,
  IssueListResult,
  IssueSummaryResult,
  IssueTimeseriesArgs,
  IssueTimeseriesPoint,
  IssueTimeseriesResult,
  // feedback.*
  FeedbackSubmitArgs,
  FeedbackListArgs,
  FeedbackRecord,
  FeedbackListResult,
  // insight.*
  InsightCaptureArgs,
  InsightListArgs,
  InsightRecord,
  InsightListResult,
  // cron.*
  CronHistoryArgs,
  CronRunRecord,
  CronHistoryResult,
  CronSummaryPoint,
  CronSummaryResult,
  CronPerJobPoint,
  CronPerJobSummaryResult,
  // agent_activity.*
  PromptByteBreakdown,
  AgentActivityRecordArgs,
  AgentActivityQueryArgs,
  AgentActivityPoint,
  AgentActivityQueryResult,
  // Config additions
  GoalConfigDefinition,
  LabelMaps,
} from "./schemas.js";
