/**
 * Express router for the §D Mechanism view.
 *
 * Mounted at /api/mechanism/* by app.ts. The Kanban view (useKanban) filters
 * its goals client-side through this same endpoint, so both views show the
 * SAME set of "mechanism-eligible" workflows — a workflow either teaches the
 * user something about system logic (mechanism + its tasks on kanban) or
 * it's hidden from both.
 *
 * Inclusion rule (NUX scope-down §D):
 *
 *   display.mechanism_view ?? (steps.length >= 3)
 *
 * The explicit `display.mechanism_view` flag in the workflow JSON wins;
 * otherwise any workflow with ≥3 steps shows up by default. Short
 * intake/eval (1-2 step) workflows hide unless explicitly opted in.
 */

import { Router } from "express";

import type { BrainWorkflowTemplate } from "./brain-client.js";
import type { WorkflowRunStats } from "./brain-kanban.js";

/** The flag we look for inside a workflow's top-level `display` block.
 *  Permissive shape — workflows authored without it just rely on the
 *  step-count fallback. */
type WorkflowDisplay = {
  readonly mechanism_view?: boolean;
};

/** The fields this router reads from a brain workflow template. The brain
 *  serialises either naming convention, so both are accepted. */
type MechanismWorkflow = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version?: number;
  readonly steps?: ReadonlyArray<{
    readonly step_key?: string;
    readonly stepKey?: string;
    readonly name: string;
    readonly blocked_by_keys?: string | string[];
    readonly blockedByKeys?: string[];
    readonly sort_order?: number;
    readonly sortOrder?: number;
  }>;
  readonly latestRun?: unknown;
  readonly totalRuns?: number;
  readonly successRate?: number;
  readonly display?: WorkflowDisplay;
};

/** The single source of truth for "is this workflow mechanism-eligible?" */
function isMechanismEligible(w: MechanismWorkflow): boolean {
  const explicit = w.display?.mechanism_view;
  if (typeof explicit === "boolean") return explicit;
  const steps = w.steps ?? [];
  return steps.length >= 3;
}

/** Per-workflow run stats keyed by workflow id (brain-kanban.ts reads them
 *  from brain.db). The brain's `workflow_list` carries none, so without this
 *  every card showed "0 runs". */
export type RunStatsSource = () => ReadonlyMap<string, WorkflowRunStats>;

/** Workflow-template source — the brain client's `workflowList`, injected so
 *  the router holds no connection state of its own. */
export type WorkflowListSource = () => Promise<readonly BrainWorkflowTemplate[]>;

export function buildMechanismRouter(deps: {
  readonly workflowList: WorkflowListSource;
  readonly runStats?: RunStatsSource;
}): Router {
  const router = Router();

  router.get("/workflows", async (_req, res) => {
    try {
      const templates = (await deps.workflowList()) as readonly MechanismWorkflow[];
      const eligible = templates.filter(isMechanismEligible);
      // Stats are an enrichment: an unreadable brain.db degrades to whatever
      // the template carries rather than failing the whole view.
      let runStats: ReadonlyMap<string, WorkflowRunStats> = new Map();
      if (deps.runStats) {
        try {
          runStats = deps.runStats();
        } catch (err) {
          console.error("[/api/mechanism/workflows] run stats unavailable:", err);
        }
      }
      // Surface the rule so the UI can render a tooltip/badge explaining
      // why each workflow shows.
      const rows = eligible.map((w) => {
        const steps = w.steps ?? [];
        const stats = runStats.get(w.id);
        return {
          id: w.id,
          name: w.name,
          description: w.description ?? null,
          version: w.version ?? null,
          steps: steps.map((s, i) => ({
            stepKey: s.stepKey ?? s.step_key ?? `step-${i}`,
            name: s.name,
            blockedByKeys:
              Array.isArray(s.blockedByKeys) ? s.blockedByKeys
              : Array.isArray(s.blocked_by_keys) ? s.blocked_by_keys
              : typeof s.blocked_by_keys === "string" && s.blocked_by_keys.length > 0
                ? s.blocked_by_keys.split(",").map((k) => k.trim()).filter(Boolean)
                : [],
            sortOrder: s.sortOrder ?? s.sort_order ?? i,
          })),
          latestRun: stats?.latestRun ?? w.latestRun ?? null,
          totalRuns: stats?.totalRuns ?? w.totalRuns ?? 0,
          successRate: stats?.successRate ?? w.successRate ?? null,
          // Echo the inclusion reason — explicit flag vs auto-default.
          mechanismVisibility: {
            explicit: typeof w.display?.mechanism_view === "boolean",
            enabled: w.display?.mechanism_view ?? null,
            autoIncluded:
              typeof w.display?.mechanism_view !== "boolean" && steps.length >= 3,
          },
        };
      });
      res.json({ workflows: rows, rule: "display.mechanism_view ?? (steps.length >= 3)" });
    } catch (err) {
      console.error("[/api/mechanism/workflows]", err);
      res.status(500).json({ error: "Failed to fetch mechanism workflows" });
    }
  });

  return router;
}
