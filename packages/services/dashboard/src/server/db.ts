/**
 * Brain API Wrappers — dashboard-specific data adapters over brain MCP client.
 *
 * This file contains dashboard-facing API functions that wrap brain-client.mc.ts
 * primitives (brainBoard, brainTracesQuery, brainWorkflowList) and shape their
 * output for the dashboard's HTTP endpoints.
 *
 * §G cleanup: Removed the legacy SQLite layer (getGoals, getGoalMetrics,
 * getImprovements, getFeedback, getInsights, getCronRunsSummary, etc.) after
 * PR #90 deleted their last callers. All remaining functions here use the
 * brain MCP tools, not SQLite reads.
 */

import {
  brainBoard,
  brainTracesQuery,
  brainWorkflowList,
  type BrainGoal,
  type BrainTrace,
} from "./brain-client.mc.js";

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

// ── Traces — via brain API ──

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
  completedAt?: string | null;
  taskStatuses?: Record<string, string>;
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
