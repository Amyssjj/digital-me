/**
 * Board formatter — port of upstream task-orchestrator `src/board.ts`.
 *
 * Pure rendering: goals + tasks → markdown. The dashboard and CLI both
 * use this so users see the same view regardless of which surface they
 * came from.
 *
 * Decoupled from a god-object store: only depends on `tasks.listForGoal`,
 * injected via deps. `now` is also injectable for deterministic tests of
 * the "last activity" relative-time display.
 */

import type {
  GoalRecord,
  GoalStatus,
} from "../store/goals.js";
import type {
  OrchestratorTaskRecord,
  TasksStore,
} from "../store/tasks.js";

export type BoardDeps = {
  readonly tasks: Pick<TasksStore, "listForGoal">;
  readonly now?: () => number;
};

// ── Helpers ───────────────────────────────────────────────────────────────

function relativeTime(ms: number): string {
  if (ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m ago` : `${hours}h ago`;
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  completed: "DONE",
  running: "RUNNING",
  stalled: "STALLED",
  failed: "FAILED",
  pending: "PENDING",
  ready: "READY",
  dispatched: "DISPATCHED",
  awaiting_approval: "APPROVAL",
  skipped: "SKIPPED",
  cancelled: "CANCELLED",
  acknowledged: "ACK",
  healthy: "HEALTHY",
  degraded: "DEGRADED",
  paused: "PAUSED",
  retired: "RETIRED",
};

function statusBadge(status: string): string {
  return STATUS_LABELS[status] ?? status.toUpperCase();
}

function getPhaseDisplay(task: OrchestratorTaskRecord): string {
  if (task.latestCheckpoint?.phase) return task.latestCheckpoint.phase;
  if (task.status === "pending" && task.blockedBy.length > 0) {
    return `blocked by: ${task.blockedBy.join(", ")}`;
  }
  if (task.status === "awaiting_approval") return "needs approval";
  return "-";
}

function getLastActivityDisplay(
  task: OrchestratorTaskRecord,
  now: number,
): string {
  if (task.completedAt) return relativeTime(now - task.completedAt);
  if (task.latestCheckpoint?.checkpointAt) {
    return relativeTime(now - task.latestCheckpoint.checkpointAt);
  }
  if (task.startedAt) return relativeTime(now - task.startedAt);
  return "";
}

// ── Board rendering ───────────────────────────────────────────────────────

export function formatBoard(
  deps: BoardDeps,
  goals: readonly GoalRecord[],
): string {
  if (goals.length === 0) return "No active goals.";

  const topLevel = goals.filter((g) => !g.parentGoalId);
  const subgoalsByParent = new Map<string, GoalRecord[]>();
  for (const g of goals) {
    if (g.parentGoalId) {
      const list = subgoalsByParent.get(g.parentGoalId) ?? [];
      list.push(g);
      subgoalsByParent.set(g.parentGoalId, list);
    }
  }

  const lines: string[] = ["## Active Goals", ""];
  const now = (deps.now ?? Date.now)();
  for (const goal of topLevel) {
    renderGoal(goal, deps.tasks, lines, 0, subgoalsByParent, now);
  }
  // Orphan subgoals: parent not in active list — render at depth 0.
  const renderedParents = new Set(topLevel.map((g) => g.id));
  for (const [parentId, children] of subgoalsByParent) {
    if (!renderedParents.has(parentId)) {
      for (const child of children) {
        renderGoal(child, deps.tasks, lines, 0, subgoalsByParent, now);
      }
    }
  }
  return lines.join("\n");
}

function renderGoal(
  goal: GoalRecord,
  tasks: Pick<TasksStore, "listForGoal">,
  lines: string[],
  depth: number,
  subgoalsByParent: Map<string, GoalRecord[]>,
  now: number,
): void {
  const indent = depth > 0 ? "  ".repeat(depth) : "";
  const prefix = depth > 0 ? "↳ Subgoal" : "Goal";
  const status: GoalStatus = goal.status;
  lines.push(`${indent}### ${prefix}: ${goal.name} (${status})`);
  lines.push("");

  const taskRows = tasks.listForGoal(goal.id);
  if (taskRows.length > 0) {
    lines.push(`${indent}\`\`\``);
    lines.push(`${indent}| Status | Task | Owner | Phase | Last Activity |`);
    lines.push(`${indent}|--------|------|-------|-------|---------------|`);
    for (const task of taskRows) {
      const owner =
        task.dispatch.mode === "spawn"
          ? task.dispatch.agentId
          : task.dispatch.mode;
      lines.push(
        `${indent}| ${statusBadge(task.status)} | ${task.name} | ${owner} | ${getPhaseDisplay(task)} | ${getLastActivityDisplay(task, now)} |`,
      );
    }
    lines.push(`${indent}\`\`\``);
    lines.push("");
  } else {
    lines.push(`${indent}No tasks.`);
    lines.push("");
  }

  const children = subgoalsByParent.get(goal.id);
  if (children) {
    for (const child of children) {
      renderGoal(child, tasks, lines, depth + 1, subgoalsByParent, now);
    }
  }
}

// ── Task detail rendering ─────────────────────────────────────────────────

export function formatTaskDetail(task: OrchestratorTaskRecord): string {
  const lines: string[] = [
    `## Task: ${task.name}`,
    "",
    `**Status:** ${statusBadge(task.status)}`,
    `**Goal:** ${task.goalId}`,
    `**Priority:** ${task.priority}`,
    `**Attempts:** ${task.attemptCount}`,
    `**Dispatch:** ${JSON.stringify(task.dispatch)}`,
  ];

  if (task.failureReason) {
    lines.push(`**Failure:** ${task.failureReason}`);
  }
  if (task.blockedBy.length > 0) {
    lines.push(`**Blocked by:** ${task.blockedBy.join(", ")}`);
  }

  if (task.latestCheckpoint) {
    const cp = task.latestCheckpoint;
    lines.push("", "### Latest Checkpoint");
    lines.push(`- **Phase:** ${cp.phase}`);
    lines.push(`- **Summary:** ${cp.summary}`);
    if (cp.progressPercent !== undefined) {
      lines.push(`- **Progress:** ${cp.progressPercent}%`);
    }
    if (cp.blocker) lines.push(`- **Blocker:** ${cp.blocker}`);
    if (cp.artifactPaths?.length) {
      lines.push(`- **Artifacts:** ${cp.artifactPaths.join(", ")}`);
    }
  }

  if (task.latestOutput) {
    const out = task.latestOutput;
    lines.push("", "### Latest Output");
    lines.push(`- **State:** ${out.deliverableState}`);
    lines.push(`- **Summary:** ${out.summary}`);
    if (out.recommendedNextStep) {
      lines.push(`- **Next step:** ${out.recommendedNextStep}`);
    }
    if (out.artifactPaths?.length) {
      lines.push(`- **Artifacts:** ${out.artifactPaths.join(", ")}`);
    }
  }

  if (task.attempts.length > 0) {
    lines.push("", "### Attempt History");
    for (const a of task.attempts) {
      const duration = a.endedAt
        ? `${Math.round((a.endedAt - a.startedAt) / 1000)}s`
        : "ongoing";
      const failurePart = a.failureReason ? ` — ${a.failureReason}` : "";
      lines.push(
        `- #${a.attemptNumber}: ${a.status} (${duration})${failurePart}`,
      );
    }
  }

  return lines.join("\n");
}
