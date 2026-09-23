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
 * brain MCP tools, not SQLite reads. The Kanban board moved to direct
 * read-only SQL over brain.db (brain-kanban.ts): the brain's board JSON was
 * too large to poll.
 */

import {
  brainBoard,
  brainTracesQuery,
  brainWorkflowList,
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

/** The id a traces_query row is grouped by: span-style trace_id/traceId when
 *  a producer emits one, else the flat row id the proxy's trace-writer assigns. */
function traceIdOf(t: BrainTrace): string {
  return t.trace_id ?? t.traceId ?? t.id ?? "";
}

function adaptBrainTrace(t: BrainTrace): TraceSpan {
  // traces_query rows (brain-host and the openclaw gateway alike) are flat
  // {id, agentId, kind, payload, t, durationMs} records, not spans: the row
  // id serves as both trace and span id, `t` (epoch ms) as start_time,
  // `kind` as the span name and `payload` as attributes. Span-shaped fields
  // still win when a producer emits them.
  const epoch = t.timestamp ?? t.t;
  const attributes = t.attributes ?? t.payload ?? null;
  return {
    span_id: t.span_id ?? t.spanId ?? t.id ?? "",
    trace_id: traceIdOf(t),
    parent_span_id: t.parent_span_id ?? t.parentSpanId ?? null,
    name: t.name ?? t.kind ?? "",
    service: t.service ?? t.agent_id ?? t.agentId ?? "",
    status: t.status ?? "unknown",
    start_time: t.start_time ?? t.startTime ?? (epoch ? new Date(epoch).toISOString() : ""),
    end_time: t.end_time ?? t.endTime ?? null,
    duration_ms: t.duration_ms ?? t.durationMs ?? null,
    attributes: typeof attributes === "string" ? attributes : (attributes ? JSON.stringify(attributes) : null),
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
    .filter((t) => traceIdOf(t) === traceId)
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

// ── Layer Health — via brain API ──
// Evergreen goals + open project-goal counts.
export async function getLayerHealth() {
  // Only open goals matter here (evergreens + pending/running projects under
  // them), and the brain includes open goals regardless of the board window
  // — so ask for a zero-day window and skip the terminal-goal bulk (~10k
  // completed goals per 7 days) entirely.
  const board = await brainBoard({ days: 0 });
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

    // Latest run — normalize to ensure required fields have defaults
    let latestRun: WorkflowLatestRun | null = tmpl.latestRun
      ? {
          goalId: tmpl.latestRun.goalId,
          status: tmpl.latestRun.status,
          startedAt: tmpl.latestRun.startedAt,
          completedAt: tmpl.latestRun.completedAt ?? null,
          taskStatuses: tmpl.latestRun.taskStatuses ?? {},
        }
      : null;
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
        completedAt: epochToIso(latest.completed_at ?? latest.completedAt ?? null) ?? null,
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
