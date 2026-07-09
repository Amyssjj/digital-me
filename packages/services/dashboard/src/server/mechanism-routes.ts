/**
 * Express router for the §D Mechanism view + §E Kanban view.
 *
 * Mounted at /api/mechanism/* and /api/kanban by server.ts. Both views
 * filter brain state to the SAME set of "mechanism-eligible" workflows so
 * they show a consistent picture — a workflow either teaches the user
 * something about system logic (mechanism + its tasks on kanban) or it's
 * hidden from both.
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

import {
  brainBoard,
  brainWorkflowList,
  type BrainGoal,
  type BrainWorkflowTemplate,
} from "./brain-client.mc.js";

/** The flag we look for inside a workflow's top-level `display` block.
 *  Permissive shape — workflows authored without it just rely on the
 *  step-count fallback. */
type WorkflowDisplay = {
  readonly mechanism_view?: boolean;
};

type MechanismWorkflow = BrainWorkflowTemplate & {
  readonly display?: WorkflowDisplay;
};

/** The single source of truth for "is this workflow mechanism-eligible?"
 *  Used by /api/mechanism/workflows AND /api/kanban so the two views stay
 *  consistent. */
function isMechanismEligible(w: MechanismWorkflow): boolean {
  const explicit = w.display?.mechanism_view;
  if (typeof explicit === "boolean") return explicit;
  const steps = w.steps ?? [];
  return steps.length >= 3;
}

export function buildMechanismRouter(): Router {
  const router = Router();

  router.get("/workflows", async (_req, res) => {
    try {
      const templates = (await brainWorkflowList()) as MechanismWorkflow[];
      const eligible = templates.filter(isMechanismEligible);
      // Surface the rule so the UI can render a tooltip/badge explaining
      // why each workflow shows.
      const rows = eligible.map((w) => {
        const steps = w.steps ?? [];
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
          latestRun: w.latestRun ?? null,
          totalRuns: w.totalRuns ?? 0,
          successRate: w.successRate ?? null,
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

// ── Kanban (§E) ───────────────────────────────────────────────────────────

type KanbanTask = {
  readonly id: string;
  readonly workflow_id: string;
  readonly workflow_name: string;
  readonly status: string;
  readonly name: string;
  readonly last_update_ts: string | null;
};

/**
 * Map brain.tasks.board() goals → flat task list, filtered to only tasks
 * whose parent workflow is mechanism-eligible (per the same rule above).
 * Kept in this module so the eligibility predicate is shared with §D.
 */
export function buildKanbanRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const [board, templates] = await Promise.all([
        brainBoard(),
        brainWorkflowList() as Promise<MechanismWorkflow[]>,
      ]);

      const eligibleIds = new Set(
        templates.filter(isMechanismEligible).map((w) => w.id),
      );

      const tasks: KanbanTask[] = [];
      for (const goal of board.goals ?? []) {
        const g = goal as BrainGoal & {
          sourceWorkflowId?: string;
          source_workflow_id?: string;
          name?: string;
          tasks?: Array<{
            id: string;
            name: string;
            status: string;
            updated_at?: string;
            updatedAt?: string;
          }>;
        };
        const wfId = g.sourceWorkflowId ?? g.source_workflow_id;
        if (!wfId || !eligibleIds.has(wfId)) continue;
        const wfName = templates.find((w) => w.id === wfId)?.name ?? wfId;
        for (const t of g.tasks ?? []) {
          tasks.push({
            id: t.id,
            workflow_id: wfId,
            workflow_name: wfName,
            status: t.status,
            name: t.name,
            last_update_ts: t.updated_at ?? t.updatedAt ?? null,
          });
        }
      }

      res.json({ tasks });
    } catch (err) {
      console.error("[/api/kanban]", err);
      res.status(500).json({ error: "Failed to fetch kanban tasks" });
    }
  });

  return router;
}
