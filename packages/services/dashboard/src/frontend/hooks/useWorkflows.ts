import { useState, useEffect, useCallback } from "react";

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

interface WorkflowsResponse {
  templates: WorkflowTemplate[];
  totalTemplates: number;
  fetchedAt: string;
}

export function useWorkflows(pollIntervalMs: number = 60_000) {
  const [data, setData] = useState<WorkflowsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:3456/api/workflows-v2");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkflows();
    const timer = setInterval(fetchWorkflows, pollIntervalMs);
    return () => clearInterval(timer);
  }, [fetchWorkflows, pollIntervalMs]);

  return { data, error, isLoading, refetch: fetchWorkflows };
}
