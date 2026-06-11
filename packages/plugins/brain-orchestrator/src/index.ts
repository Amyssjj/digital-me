/**
 * @digital-me/brain-orchestrator
 *
 * Operational ledger plugin for openclaw. Owns the full operational data
 * surface: tasks, agent identity, traces, learnings (planned: ported from
 * upstream task-orchestrator) plus metric.* / issue.* / feedback.* /
 * insight.* / cron.* / agent_activity.* (the new tool families specified in
 * docs/BRAIN-OPERATIONAL-TELEMETRY-TOOLS.md).
 *
 * Per-domain store modules under `src/store/`. The openclaw SDK seam lives
 * in `src/openclaw-compat/` -- the rest of the plugin imports through
 * either of these, never from `openclaw/*` directly.
 */

// ── Tool families (per-domain stores) ──────────────────────────────────────
export { createMetricTools, initMetricSchema } from "./store/metrics.js";
export type { MetricTools } from "./store/metrics.js";

export { createIssueTools, initIssueSchema } from "./store/issues.js";
export type { IssueTools } from "./store/issues.js";

export { createFeedbackTools, initFeedbackSchema } from "./store/feedback.js";
export type { FeedbackTools } from "./store/feedback.js";

export { createInsightTools, initInsightSchema } from "./store/insights.js";
export type { InsightTools } from "./store/insights.js";

export { createCronTools, initCronSchema } from "./store/cron-runs.js";
export type { CronTools } from "./store/cron-runs.js";

export {
  createAgentActivityTools,
  initAgentActivitySchema,
} from "./store/agent-activity.js";
export type { AgentActivityTools } from "./store/agent-activity.js";

// ── Upstream-ported entities ──────────────────────────────────────────────
export { createGoalsStore, GOALS_MIGRATIONS } from "./store/goals.js";
export type {
  EvergreenGoalStatus,
  GoalRecord,
  GoalStatus,
  GoalsStore,
  GoalType,
  Originator,
  ProjectGoalStatus,
  WorkflowBranchingPolicy,
} from "./store/goals.js";

export { createTasksStore, TASKS_MIGRATIONS } from "./store/tasks.js";
export type {
  AttemptStatus,
  AttemptUpdate,
  FixCategory,
  OrchestratorTaskRecord,
  TaskAttemptRecord,
  TaskCheckpointRecord,
  TaskDispatch,
  TaskOutputRecord,
  TaskPriority,
  TaskStatus,
  TasksStore,
  UpstreamFailurePolicy,
  VerifyStep,
} from "./store/tasks.js";

export {
  createWorkflowsStore,
  WORKFLOWS_MIGRATIONS,
} from "./store/workflows.js";
export type {
  WorkflowBranchingPolicy as WorkflowTemplateBranchingPolicy,
  WorkflowStepTemplateRecord,
  WorkflowTemplateRecord,
  WorkflowVariable,
  WorkflowsStore,
} from "./store/workflows.js";

export {
  createSchedulesStore,
  SCHEDULES_MIGRATIONS,
} from "./store/schedules.js";
export type {
  ScheduleRecord,
  SchedulesStore,
} from "./store/schedules.js";

export { createAgentsStore, AGENTS_MIGRATIONS } from "./store/agents.js";
export type { AgentsStore, BrainAgentRecord } from "./store/agents.js";

export {
  createLearningsStore,
  LEARNINGS_MIGRATIONS,
} from "./store/learnings.js";
export type {
  LearningKind,
  LearningRecord,
  LearningsStore,
} from "./store/learnings.js";

export { createTracesStore, TRACES_MIGRATIONS } from "./store/traces.js";
export type {
  TraceKind,
  TraceQueryFilters,
  TraceRecord,
  TracesStore,
} from "./store/traces.js";

export {
  createM1EventsStore,
  M1_EVENTS_MIGRATIONS,
  M1_EVENT_TYPES_V1,
} from "./store/m1-events.js";
export type {
  M1EventType,
  M1AckSignal,
  M1Entry,
  M1EventRecord,
  M1EventQueryFilters,
  M1EventsStore,
} from "./store/m1-events.js";

export {
  deriveEventId,
  isV1EventType,
  recordM1Event,
  scoreM1,
} from "./handlers/m1.js";
export type {
  M1Rollup,
  RecordM1EventInput,
  RecordM1EventResult,
  ScoreM1Input,
} from "./handlers/m1.js";

// ── Ops (side-effectful operations) ────────────────────────────────────────
export {
  createWorkflowBranch,
  finalizeWorkflowFailure,
  finalizeWorkflowSuccess,
  removeWorkflowBranch,
  tagWorkflowOutcome,
} from "./ops/git.js";
export type {
  CreateWorkflowBranchInput,
  CreateWorkflowBranchResult,
} from "./ops/git.js";

export { computeNextRun, parseCron } from "./ops/cron.js";
export type { ParsedCron } from "./ops/cron.js";

// ── Handlers (pure business logic — wire into MCP at plugin-entry time) ────
export {
  buildUnidentifiedCallWarning,
  identifyAgent,
  SESSION_TOKEN_TTL_MS,
  UNIDENTIFIED_SOFT_WARN_DEADLINE,
} from "./handlers/agents.js";
export type {
  IdentifyAgentDeps,
  IdentifyAgentInput,
  IdentifyAgentResult,
} from "./handlers/agents.js";

export {
  captureLearning,
  VALID_LEARNING_KINDS,
} from "./handlers/learnings.js";
export type {
  CaptureLearningDeps,
  CaptureLearningInput,
  CaptureLearningResult,
} from "./handlers/learnings.js";

export {
  queryTraces,
  recordTrace,
  VALID_TRACE_KINDS,
} from "./handlers/traces.js";
export type {
  QueryTracesDeps,
  RecordTraceDeps,
  RecordTraceInput,
  RecordTraceResult,
} from "./handlers/traces.js";

export {
  createWorkflowFromSteps,
  importWorkflowFromJson,
  saveGoalAsWorkflow,
} from "./handlers/workflow-builder.js";
export type {
  BuilderResult,
  StepInput,
  WorkflowBuilderDeps,
} from "./handlers/workflow-builder.js";

export { formatBoard, formatTaskDetail } from "./handlers/board.js";
export type { BoardDeps } from "./handlers/board.js";

export {
  approveTask,
  cancelGoal,
  claimTask,
  completeTask,
  deriveGoalStatus,
  recordCheckpoint,
  recordHandoff,
  refreshGoalStatus,
  rejectTask,
  resolveDependents,
} from "./handlers/resolver-status.js";
export type {
  ResolverDeps,
  TransitionResult,
} from "./handlers/resolver-status.js";

export {
  createGoalFromPlan,
  planWorkflowBranch,
} from "./handlers/goal-create.js";
export type {
  AliasResolver,
  CreateGoalFromPlanOptions,
  CreateGoalFromPlanResult,
  GoalCreateDeps,
  TaskPlanItem,
} from "./handlers/goal-create.js";

export {
  instantiateWorkflow,
  interpolateVariables,
  interpolateDeep,
} from "./handlers/workflow-instantiate.js";
export type {
  InstantiateWorkflowDeps,
  InstantiateWorkflowParams,
  InstantiateWorkflowResult,
} from "./handlers/workflow-instantiate.js";

export {
  addSchedule,
  formatSchedulesList,
  removeSchedule,
  setScheduleEnabled,
} from "./handlers/schedule-admin.js";

// ── Plugin: action router (used by openclaw plugin entry + dream-cycle) ────
export {
  dispatchAction,
  TASKS_ACTIONS,
} from "./plugin/router.js";
export type {
  RouterDeps,
  RouterResult,
  TasksAction,
} from "./plugin/router.js";

export { asMCPExecute, toMCPResult } from "./plugin/envelope.js";
export type { MCPContent, MCPToolResult } from "./plugin/envelope.js";

export {
  buildBrainOrchestratorTools,
  handleAgentIdentify,
  handleLearningCapture,
  handleTracesQuery,
  handleTracesRecord,
} from "./plugin/entry.js";
export type {
  BrainOrchestratorPluginDeps,
  BrainTool,
} from "./plugin/entry.js";
export type {
  AddScheduleInput,
  AddScheduleResult,
  RemoveScheduleResult,
  ScheduleAdminDeps,
  ToggleScheduleResult,
} from "./handlers/schedule-admin.js";

export {
  CRON_GOAL_RETENTION_MS,
  dispatchOrphanedReadyTasks,
  finalizeTerminalGoals,
  reconcileCompletedDependencies,
  reconcileStaleRuns,
  refreshScheduleStatuses,
  resetRetentionSweepForTests,
  RETENTION_SWEEP_INTERVAL_MS,
  scanSchedules,
  sweepCronGoalRetention,
  tick,
} from "./handlers/scheduler.js";
export type {
  Dispatcher,
  RetentionSweepResult,
  ScanResult,
  SchedulerDeps,
  SchedulerRuntime,
  TickResult,
  WorkflowInstantiateResult,
  WorkflowInstantiator,
} from "./handlers/scheduler.js";

// ── Migration runner ───────────────────────────────────────────────────────
export {
  registerMigration,
  runMigrations,
  resetMigrationRegistryForTests,
} from "./store/migrations.js";
export type { Migration } from "./store/migrations.js";

// ── openclaw SDK seam ──────────────────────────────────────────────────────
export {
  buildCompatReport,
  consumeService,
  GATEWAY_SCOPE_SYMBOL_KEY,
  isGatewayScopeAvailable,
  publishService,
  runInGatewayScope,
} from "./openclaw-compat/index.js";
export type {
  CompatReport,
  CommandHandler,
  ExecRunArgs,
  ExecRunResult,
  OpenClawApi,
  OpenClawRuntime,
  PluginEntryDefinition,
  RunInGatewayScopeOptions,
  SubagentRunArgs,
  ToolHandler,
} from "./openclaw-compat/index.js";
