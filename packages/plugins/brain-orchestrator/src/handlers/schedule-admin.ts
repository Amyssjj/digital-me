/**
 * Schedule admin handlers — port of upstream task-orchestrator's
 * `handleScheduleAdd/List/Remove/Toggle`.
 *
 * Pure CRUD over the schedules store with one piece of business logic:
 *   - `addSchedule` validates the cron expression by computing the next
 *     run before persisting, so a typo'd schedule never reaches the
 *     scheduler tick.
 *   - `setScheduleEnabled` recomputes nextRunAt on re-enable so a freshly
 *     enabled schedule doesn't fire immediately for its stale next_run_at.
 *
 * Open-source delta from upstream: defaults `timezone` to `'UTC'` (not
 * `'America/Los_Angeles'`). Callers pass an explicit timezone for
 * non-UTC schedules.
 */

import { randomUUID } from "node:crypto";
import { computeNextRun } from "../ops/cron.js";
import type {
  ScheduleRecord,
  SchedulesStore,
} from "../store/schedules.js";

export type ScheduleAdminDeps = {
  readonly schedules: SchedulesStore;
  readonly now?: () => number;
  readonly newId?: () => string;
};

export type AddScheduleInput = {
  readonly workflowId: string;
  readonly name?: string;
  readonly cronExpr: string;
  readonly timezone?: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly maxOverlap?: number;
};

export type AddScheduleResult =
  | {
      readonly ok: true;
      readonly scheduleId: string;
      readonly nextRunAt: number;
      readonly message: string;
    }
  | { readonly ok: false; readonly errorCode: string; readonly error: string };

export function addSchedule(
  deps: ScheduleAdminDeps,
  input: AddScheduleInput,
  /** Caller-supplied existence check for the workflow id. Lets the handler
   *  stay decoupled from the workflows store. */
  workflowExists: (workflowId: string) => boolean,
): AddScheduleResult {
  if (!workflowExists(input.workflowId)) {
    return {
      ok: false,
      errorCode: "workflow_not_found",
      error: `Workflow "${input.workflowId}" not found.`,
    };
  }

  const name = input.name ?? input.workflowId;
  if (deps.schedules.getByName(name)) {
    return {
      ok: false,
      errorCode: "schedule_name_exists",
      error: `Schedule "${name}" already exists.`,
    };
  }

  const timezone = input.timezone ?? "UTC";
  const now = (deps.now ?? Date.now)();
  let nextRunAt: number;
  try {
    nextRunAt = computeNextRun(input.cronExpr, timezone, now);
  } catch (err) {
    return {
      ok: false,
      errorCode: "invalid_cron",
      error: `Invalid cron expression "${input.cronExpr}": ${(err as Error).message}`,
    };
  }

  const schedule: ScheduleRecord = {
    id: (deps.newId ?? randomUUID)(),
    workflowId: input.workflowId,
    name,
    cronExpr: input.cronExpr,
    timezone,
    variables: input.variables ?? {},
    enabled: true,
    nextRunAt,
    maxOverlap: input.maxOverlap ?? 0,
    createdAt: now,
    updatedAt: now,
  };
  deps.schedules.create(schedule);
  return {
    ok: true,
    scheduleId: schedule.id,
    nextRunAt,
    message: `Schedule "${name}" created. Next run epoch: ${nextRunAt} (${timezone}).`,
  };
}

export type RemoveScheduleResult =
  | { readonly ok: true; readonly removed: string }
  | { readonly ok: false; readonly errorCode: string; readonly error: string };

export function removeSchedule(
  deps: ScheduleAdminDeps,
  idOrName: string,
): RemoveScheduleResult {
  const schedule =
    deps.schedules.get(idOrName) ?? deps.schedules.getByName(idOrName);
  if (!schedule) {
    return {
      ok: false,
      errorCode: "schedule_not_found",
      error: `Schedule "${idOrName}" not found.`,
    };
  }
  deps.schedules.delete(schedule.id);
  return { ok: true, removed: schedule.name };
}

export type ToggleScheduleResult =
  | {
      readonly ok: true;
      readonly enabled: boolean;
      readonly nextRunAt: number;
      readonly message: string;
    }
  | { readonly ok: false; readonly errorCode: string; readonly error: string };

/**
 * Enable or disable a schedule. When enabling, recomputes nextRunAt from
 * `now` so a long-disabled schedule doesn't fire immediately for its
 * stale stored value.
 */
export function setScheduleEnabled(
  deps: ScheduleAdminDeps,
  idOrName: string,
  enable: boolean,
): ToggleScheduleResult {
  const schedule =
    deps.schedules.get(idOrName) ?? deps.schedules.getByName(idOrName);
  if (!schedule) {
    return {
      ok: false,
      errorCode: "schedule_not_found",
      error: `Schedule "${idOrName}" not found.`,
    };
  }
  const now = (deps.now ?? Date.now)();
  let nextRunAt = schedule.nextRunAt;
  if (enable) {
    try {
      nextRunAt = computeNextRun(schedule.cronExpr, schedule.timezone, now);
    } catch {
      return {
        ok: false,
        errorCode: "invalid_cron",
        error: `Failed to compute next run for "${schedule.name}" — cron expression may be invalid.`,
      };
    }
  }
  deps.schedules.update({
    ...schedule,
    enabled: enable,
    nextRunAt,
    updatedAt: now,
  });
  return {
    ok: true,
    enabled: enable,
    nextRunAt,
    message: `Schedule "${schedule.name}" ${enable ? "enabled" : "disabled"}.`,
  };
}

/**
 * Format the schedules list for human-readable display (used by `tasks
 * schedule_list`). Pure formatter — no time-zone library dependency, ISO
 * timestamps only.
 */
export function formatSchedulesList(
  schedules: readonly ScheduleRecord[],
): string {
  if (schedules.length === 0) return "No schedules configured.";
  const lines = schedules.map((s) => {
    const status = s.enabled ? "enabled" : "disabled";
    const next = new Date(s.nextRunAt).toISOString();
    const last = s.lastRunAt ? new Date(s.lastRunAt).toISOString() : "never";
    const lastResult = s.lastStatus ?? "-";
    return `- **${s.name}** [${status}] | cron: \`${s.cronExpr}\` | next: ${next} | last: ${last} (${lastResult}) | workflow: ${s.workflowId}`;
  });
  return ["## Schedules", "", ...lines].join("\n");
}
