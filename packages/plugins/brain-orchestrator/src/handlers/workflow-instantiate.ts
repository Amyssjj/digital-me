/**
 * Workflow instantiation — turn a workflow template into a live Goal with
 * tasks. Port of upstream task-orchestrator `handleRunWorkflow`.
 *
 * Decomposed from upstream's god-function into a pure handler that:
 *   1. Reads the template + step rows.
 *   2. Validates required variables (fills defaults).
 *   3. Honors the workflow mutex (refuses if another active goal exists,
 *      unless `force=true`).
 *   4. Interpolates `{{var}}` placeholders into description + step prompts.
 *   5. Maps step rows into TaskPlanItems and delegates to createGoalFromPlan.
 *
 * Branching, atomic creation, orphan cleanup — all inherited from
 * createGoalFromPlan. We don't re-implement them here.
 *
 * Open-source delta from upstream: removed `isCliExecAlias` and
 * `materializeCliExecDispatch` (owner-specific CLI shortcuts). Step
 * templates carry their own dispatch verbatim.
 */

import type { GoalsStore, Originator } from "../store/goals.js";
import type { TasksStore } from "../store/tasks.js";
import type { WorkflowsStore } from "../store/workflows.js";
import type { DatabaseSync } from "node:sqlite";
import {
  createGoalFromPlan,
  type AliasResolver,
  type CreateGoalFromPlanResult,
  type TaskPlanItem,
} from "./goal-create.js";

export type InstantiateWorkflowDeps = {
  readonly db: DatabaseSync;
  readonly goals: GoalsStore;
  readonly tasks: TasksStore;
  readonly workflows: WorkflowsStore;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Optional alias resolver — forwarded to `createGoalFromPlan`. */
  readonly aliasResolver?: AliasResolver;
};

export type InstantiateWorkflowParams = {
  readonly templateId: string;
  readonly variables?: Readonly<Record<string, string>>;
  /** If true, skip the workflow mutex (multi-instance refusal). */
  readonly force?: boolean;
  /** Caller's originator (e.g. the user who triggered via MCP). Beats the
   *  template's notifyTarget when both are present. */
  readonly originator?: Originator;
  /** Who triggered the instantiation. "schedule" marks the goal as
   *  scheduler-created (`created_by = 'scheduler'`) so the retention sweep
   *  treats it as cron exhaust; "manual" (default) runs are never swept. */
  readonly origin?: "schedule" | "manual";
};

export type InstantiateWorkflowResult =
  | (CreateGoalFromPlanResult & { ok: true })
  | { readonly ok: false; readonly errorCode: string; readonly error: string };

/**
 * Substitute `{{var}}` occurrences in `template`. Unknown variables are
 * left as-is (the `{{x}}` literal is preserved), matching upstream.
 */
export function interpolateVariables(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    return vars[name] ?? match;
  });
}

/**
 * Recursively interpolate `{{var}}` inside every string in an arbitrary
 * JSON-shaped value. Used for dispatch payloads (exec command arrays,
 * spawn prompts, notify text, etc.) so workflow variables flow all the
 * way through to runtime, not just into `promptTemplate`.
 *
 * Idempotent and non-mutating: returns a new value, leaves the input
 * untouched. Non-string, non-object, non-array values are returned as-is.
 */
export function interpolateDeep<T>(
  value: T,
  vars: Readonly<Record<string, string>>,
): T {
  if (typeof value === "string") {
    return interpolateVariables(value, vars) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateDeep(v, vars)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateDeep(v, vars);
    }
    return out as unknown as T;
  }
  return value;
}

export async function instantiateWorkflow(
  deps: InstantiateWorkflowDeps,
  params: InstantiateWorkflowParams,
): Promise<InstantiateWorkflowResult> {
  const template = deps.workflows.get(params.templateId);
  if (!template) {
    return {
      ok: false,
      errorCode: "workflow_not_found",
      error: `Workflow template "${params.templateId}" not found.`,
    };
  }

  const steps = deps.workflows.listSteps(params.templateId);
  if (steps.length === 0) {
    return {
      ok: false,
      errorCode: "workflow_has_no_steps",
      error: `Workflow "${params.templateId}" has no steps.`,
    };
  }

  // Validate required variables, fill in defaults.
  const vars: Record<string, string> = { ...(params.variables ?? {}) };
  for (const v of template.variables) {
    if (v.required && !vars[v.name] && !v.defaultValue) {
      return {
        ok: false,
        errorCode: "missing_required_variable",
        error: `Missing required variable: ${v.name} (${v.description})`,
      };
    }
    if (!vars[v.name] && v.defaultValue) {
      vars[v.name] = v.defaultValue;
    }
  }

  // Workflow-level mutex.
  if (!params.force) {
    const inFlight = deps.goals.findActiveByWorkflow(params.templateId);
    if (inFlight.length > 0) {
      const existing = inFlight[0]!;
      const now = (deps.now ?? Date.now)();
      const ageMin = Math.round((now - existing.createdAt) / 60_000);
      return {
        ok: false,
        errorCode: "workflow_in_flight",
        error:
          `Workflow "${params.templateId}" already has an active goal "${existing.id}" ` +
          `(status: ${existing.status}, started ${ageMin}min ago). ` +
          `Pass force=true to dispatch anyway, or wait for it to terminate.`,
      };
    }
  }

  // Caller originator beats the template's static notifyTarget.
  const effectiveOriginator = params.originator ?? template.notifyTarget;

  // Map steps → task plans. Step blockedByKeys map to plan blockedByNames
  // (using stepKey as the name).
  const taskPlans: TaskPlanItem[] = steps.map((s) => ({
    name: s.stepKey,
    displayName: s.name,
    task: interpolateVariables(s.promptTemplate, vars),
    blockedByNames: s.blockedByKeys,
    dispatch: interpolateDeep(s.dispatch, vars),
    priority: s.priority,
    retryPolicy: s.retryPolicy,
    onUpstreamFailure: s.onUpstreamFailure,
    guidance: s.guidance,
    timeoutMs: s.timeoutMs,
  }));

  // Use the interpolated description as the goal description; the goal
  // name will be derived (truncated to 80 chars) by createGoalFromPlan.
  const description = interpolateVariables(template.description, vars);
  const result = await createGoalFromPlan(deps, description, taskPlans, {
    sourceWorkflowId: params.templateId,
    sourceWorkflowVersion: template.version,
    branching: template.branching,
    originator: effectiveOriginator,
    createdBy: params.origin === "schedule" ? "scheduler" : undefined,
  });

  return result;
}
