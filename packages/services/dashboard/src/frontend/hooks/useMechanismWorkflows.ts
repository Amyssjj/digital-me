import { useCallback, useEffect, useState } from "react";

import type { WorkflowTemplate } from "./useWorkflows";

/**
 * NUX scope-down §D: fetcher for mechanism-eligible workflows.
 *
 * Hits /api/mechanism/workflows which applies the inclusion rule
 * server-side:
 *
 *   display.mechanism_view ?? (steps.length >= 3)
 *
 * The endpoint also returns each workflow's `mechanismVisibility` metadata
 * so the UI can render a small badge ("explicit" vs "auto"). The base shape
 * is compatible with WorkflowTemplate from useWorkflows.ts so existing
 * WorkflowFlowCard renders without modification.
 */

export interface MechanismVisibility {
  /** True iff the workflow JSON sets display.mechanism_view explicitly. */
  readonly explicit: boolean;
  /** The explicit value, or null when unset. */
  readonly enabled: boolean | null;
  /** True iff the workflow was auto-included by the ≥3-step fallback. */
  readonly autoIncluded: boolean;
}

export interface MechanismWorkflowTemplate
  extends Omit<WorkflowTemplate, "tags"> {
  readonly tags?: WorkflowTemplate["tags"];
  readonly mechanismVisibility: MechanismVisibility;
}

interface MechanismResponse {
  workflows: MechanismWorkflowTemplate[];
  rule: string;
}

export function useMechanismWorkflows(pollIntervalMs: number = 60_000) {
  const [data, setData] = useState<MechanismResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/mechanism/workflows");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as MechanismResponse;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, pollIntervalMs);
    return () => clearInterval(timer);
  }, [fetchData, pollIntervalMs]);

  return { data, error, isLoading, refetch: fetchData };
}
