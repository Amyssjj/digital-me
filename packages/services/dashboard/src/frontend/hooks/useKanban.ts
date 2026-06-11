import { useState, useEffect, useCallback, useRef } from "react";

// ── Kanban API Types ──

export type GoalStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type AttemptStatus = "running" | "completed" | "failed";

export interface TaskCheckpoint {
  phase: string;
  summary: string;
  progressPercent: number;
  artifactPaths: string[];
  blocker: string | null;
  timestamp: string;
}

export interface KanbanAttempt {
  attemptId: string;
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  endedAt: string | null;
  outputSummary: string | null;
  failureReason: string | null;
  artifactPaths: string[];
}

export interface KanbanTask {
  id: string;
  name: string;
  task: string;
  status: TaskStatus;
  priority: "low" | "normal" | "high" | "critical";
  blockedBy: string[];
  attemptCount: number;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  onUpstreamFailure: "wait" | "skip" | "cancel";
  latestCheckpoint: TaskCheckpoint | null;
  latestOutput: string | null;
  activeAttempt: KanbanAttempt | null;
  attempts: KanbanAttempt[];
}

export interface KanbanGoal {
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

export interface AgentGoalCount {
  agentId: string;
  goalCount: number;
}

export interface KanbanStats {
  goals: { total: number; byStatus: Record<GoalStatus, number> };
  tasks: { total: number; byStatus: Record<TaskStatus, number> };
  agents: AgentGoalCount[];
}

export interface KanbanPagination {
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

// ── Hook ──

export function useKanban(intervalMs = 10_000, days?: number) {
  const [data, setData] = useState<KanbanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useRef(true);

  const fetchKanban = useCallback(async () => {
    // Fan out per status so running/pending/failed goals are never buried by recent
    // completions. A single global query sorted by updated_at desc would push
    // stuck-in-running goals (e.g. zombie cron workflows) past the limit.
    try {
      // Apply the dashboard's shared date range. Each status query carries the
      // same window so the server scopes both the columns and the stats overview.
      const dayParam = days != null ? `&days=${days}` : "";
      const urls = [
        `/api/kanban?status=running&limit=100&sort=updated_at&order=desc${dayParam}`,
        `/api/kanban?status=pending&limit=100&sort=updated_at&order=desc${dayParam}`,
        `/api/kanban?status=failed&limit=50&sort=updated_at&order=desc${dayParam}`,
        `/api/kanban?status=completed&limit=100&sort=updated_at&order=desc${dayParam}`,
      ];
      // NUX scope-down §E: fetch the eligibility list in parallel so we can
      // filter goals to mechanism-eligible workflows only. The kanban shows
      // the SAME workflow set as the Mechanism view — both views align with
      // `display.mechanism_view ?? (steps.length >= 3)`.
      const allRequests = [
        ...urls.map((u) => fetch(u)),
        fetch("/api/mechanism/workflows"),
      ];
      const responses = await Promise.all(allRequests);
      for (const res of responses) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      const payloads = (await Promise.all(
        responses.slice(0, urls.length).map((r) => r.json())
      )) as KanbanResponse[];
      const mechanismResp = (await responses[urls.length].json()) as {
        workflows: Array<{ id: string }>;
      };
      const eligibleIds = new Set(mechanismResp.workflows.map((w) => w.id));

      const seen = new Set<string>();
      const goals: KanbanGoal[] = [];
      for (const p of payloads) {
        for (const g of p.goals) {
          if (seen.has(g.id)) continue;
          // Skip goals whose source workflow isn't mechanism-eligible. Goals
          // with no sourceWorkflowId (ad-hoc, manually created) pass through
          // — eligibility only filters workflow-spawned goals.
          if (g.sourceWorkflowId && !eligibleIds.has(g.sourceWorkflowId)) continue;
          seen.add(g.id);
          goals.push(g);
        }
      }
      // Stats are global and identical across the 4 responses; take the first.
      const stats = payloads[0].stats;
      const totalReturned = goals.length;
      const merged: KanbanResponse = {
        goals,
        stats,
        pagination: {
          limit: totalReturned,
          offset: 0,
          total: stats.goals.total,
          hasMore: false,
        },
      };

      if (mountedRef.current) {
        setData(merged);
        setError(null);
        setIsLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setIsLoading(false);
      }
    }
  }, [days]);

  useEffect(() => {
    mountedRef.current = true;
    fetchKanban();
    const id = setInterval(fetchKanban, intervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [fetchKanban, intervalMs]);

  return { data, error, isLoading, refetch: fetchKanban };
}
