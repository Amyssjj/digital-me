import { describe, expect, it } from "vitest";
import type { GoalRecord } from "../store/goals.js";
import type {
  OrchestratorTaskRecord,
  TasksStore,
} from "../store/tasks.js";
import { formatBoard, formatTaskDetail } from "./board.js";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: "g-1",
    name: "Test goal",
    description: "",
    status: "pending",
    type: "project",
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "t",
    ...overrides,
  };
}

function task(
  overrides: Partial<OrchestratorTaskRecord> = {},
): OrchestratorTaskRecord {
  return {
    id: "t-1",
    goalId: "g-1",
    name: "Test task",
    task: "do x",
    blockedBy: [],
    dispatch: { mode: "manual" },
    status: "pending",
    attemptCount: 0,
    attempts: [],
    priority: "normal",
    onUpstreamFailure: "wait",
    ...overrides,
  };
}

function tasksOf(rows: OrchestratorTaskRecord[]): Pick<TasksStore, "listForGoal"> {
  return {
    listForGoal: () => rows,
  };
}

describe("formatBoard", () => {
  it("returns 'No active goals.' for an empty input", () => {
    expect(formatBoard({ tasks: tasksOf([]) }, [])).toBe("No active goals.");
  });

  it("renders a top-level goal header and 'No tasks.' when the goal has none", () => {
    const out = formatBoard(
      { tasks: tasksOf([]), now: () => 0 },
      [goal({ name: "Goal A", status: "pending" })],
    );
    expect(out).toContain("## Active Goals");
    expect(out).toContain("### Goal: Goal A (pending)");
    expect(out).toContain("No tasks.");
  });

  it("renders a markdown table of tasks under their goal", () => {
    const tasks = [
      task({ id: "t1", name: "First", status: "completed" }),
      task({
        id: "t2",
        name: "Second",
        status: "running",
        dispatch: { mode: "spawn", agentId: "claude-code" },
      }),
    ];
    const out = formatBoard(
      { tasks: tasksOf(tasks), now: () => 0 },
      [goal({ name: "G", status: "running" })],
    );
    expect(out).toContain("| Status | Task | Owner | Phase | Last Activity |");
    expect(out).toContain("| DONE | First | manual | -");
    expect(out).toContain("| RUNNING | Second | claude-code | -");
  });

  it("renders subgoals nested under their parent", () => {
    const parent = goal({ id: "p", name: "Parent", status: "running" });
    const child = goal({
      id: "c",
      name: "Child",
      status: "pending",
      parentGoalId: "p",
    });
    const out = formatBoard({ tasks: tasksOf([]) }, [parent, child]);
    expect(out).toContain("### Goal: Parent");
    expect(out).toContain("  ### ↳ Subgoal: Child");
  });

  it("renders orphan subgoals at depth=0 when the parent isn't in the active list", () => {
    const orphan = goal({
      id: "c",
      name: "Orphan",
      status: "pending",
      parentGoalId: "missing-parent",
    });
    const out = formatBoard({ tasks: tasksOf([]) }, [orphan]);
    // No top-level goals rendered, but orphan appears at depth 0.
    expect(out).toContain("### Goal: Orphan");
    expect(out).not.toContain("↳ Subgoal: Orphan");
  });

  it("shows 'blocked by:' when a pending task has blockers", () => {
    const t = task({ status: "pending", blockedBy: ["alpha", "beta"] });
    const out = formatBoard(
      { tasks: tasksOf([t]), now: () => 0 },
      [goal()],
    );
    expect(out).toContain("blocked by: alpha, beta");
  });

  it("shows 'needs approval' phase when awaiting_approval", () => {
    const t = task({ status: "awaiting_approval" });
    const out = formatBoard({ tasks: tasksOf([t]), now: () => 0 }, [goal()]);
    expect(out).toContain("needs approval");
  });

  it("renders the checkpoint phase when present", () => {
    const t = task({
      latestCheckpoint: {
        checkpointAt: 100,
        phase: "validation",
        summary: "half done",
      },
    });
    const out = formatBoard({ tasks: tasksOf([t]), now: () => 1000 }, [goal()]);
    expect(out).toContain("| validation |");
  });

  it("renders last-activity from completedAt when present", () => {
    const t = task({ completedAt: 1000 });
    const out = formatBoard({ tasks: tasksOf([t]), now: () => 4000 }, [goal()]);
    expect(out).toContain("3s ago");
  });

  it("renders last-activity from checkpoint when no completion timestamp", () => {
    const t = task({
      latestCheckpoint: {
        checkpointAt: 500,
        phase: "x",
        summary: "x",
      },
    });
    const out = formatBoard({ tasks: tasksOf([t]), now: () => 65_500 }, [goal()]);
    expect(out).toContain("1m ago");
  });

  it("renders last-activity from startedAt when no completion or checkpoint", () => {
    const t = task({ startedAt: 1000 });
    const out = formatBoard(
      { tasks: tasksOf([t]), now: () => 1_000 + 3_660_000 }, // 1h 1m
      [goal()],
    );
    expect(out).toContain("1h 1m ago");
  });

  it("renders 'just now' for negative deltas (clock skew)", () => {
    const t = task({ completedAt: 1000 });
    const out = formatBoard({ tasks: tasksOf([t]), now: () => 500 }, [goal()]);
    expect(out).toContain("just now");
  });

  it("renders 'Xh ago' (no minutes) when minutes==0", () => {
    const t = task({ startedAt: 1000 });
    const out = formatBoard(
      { tasks: tasksOf([t]), now: () => 1_000 + 7_200_000 }, // exactly 2h later
      [goal()],
    );
    expect(out).toContain("2h ago");
  });

  it("returns an empty last-activity column when no timestamps are present", () => {
    const t = task({ status: "pending" });
    const out = formatBoard({ tasks: tasksOf([t]), now: () => 0 }, [goal()]);
    // The trailing pipe is followed by " |" with empty activity.
    expect(out).toMatch(/\|\s*-\s*\|\s*\|/);
  });

  it("uppercases an unknown status as a fallback", () => {
    const t = task({ status: "magic_state" as OrchestratorTaskRecord["status"] });
    const out = formatBoard({ tasks: tasksOf([t]), now: () => 0 }, [goal()]);
    expect(out).toContain("| MAGIC_STATE |");
  });

  it("defaults the clock to Date.now when no `now` is provided", () => {
    const t = task({ completedAt: Date.now() });
    const out = formatBoard({ tasks: tasksOf([t]) }, [goal()]);
    // Should render a "Xs ago" or "just now" pattern using the real clock.
    expect(out).toMatch(/(just now|\d+s ago)/);
  });
});

describe("formatTaskDetail", () => {
  it("renders a minimal task with the core header", () => {
    const out = formatTaskDetail(task());
    expect(out).toContain("## Task: Test task");
    expect(out).toContain("**Status:** PENDING");
    expect(out).toContain("**Goal:** g-1");
    expect(out).toContain("**Priority:** normal");
  });

  it("renders failure reason when present", () => {
    const out = formatTaskDetail(task({ failureReason: "syntax error" }));
    expect(out).toContain("**Failure:** syntax error");
  });

  it("renders blocked-by list when non-empty", () => {
    const out = formatTaskDetail(task({ blockedBy: ["a", "b"] }));
    expect(out).toContain("**Blocked by:** a, b");
  });

  it("renders a checkpoint section with all fields", () => {
    const out = formatTaskDetail(
      task({
        latestCheckpoint: {
          checkpointAt: 0,
          phase: "validation",
          summary: "halfway",
          progressPercent: 50,
          blocker: "waiting on review",
          artifactPaths: ["/x", "/y"],
        },
      }),
    );
    expect(out).toContain("### Latest Checkpoint");
    expect(out).toContain("**Phase:** validation");
    expect(out).toContain("**Progress:** 50%");
    expect(out).toContain("**Blocker:** waiting on review");
    expect(out).toContain("**Artifacts:** /x, /y");
  });

  it("omits checkpoint optional rows when their fields are absent", () => {
    const out = formatTaskDetail(
      task({
        latestCheckpoint: { checkpointAt: 0, phase: "x", summary: "x" },
      }),
    );
    expect(out).toContain("### Latest Checkpoint");
    expect(out).not.toContain("**Progress:**");
    expect(out).not.toContain("**Blocker:**");
    expect(out).not.toContain("**Artifacts:**");
  });

  it("renders an output section with all fields", () => {
    const out = formatTaskDetail(
      task({
        latestOutput: {
          deliverableState: "complete",
          summary: "done",
          recommendedNextStep: "ship it",
          artifactPaths: ["/out"],
          producedAt: 0,
        },
      }),
    );
    expect(out).toContain("### Latest Output");
    expect(out).toContain("**State:** complete");
    expect(out).toContain("**Next step:** ship it");
    expect(out).toContain("**Artifacts:** /out");
  });

  it("omits output optional rows when fields are absent", () => {
    const out = formatTaskDetail(
      task({
        latestOutput: {
          deliverableState: "partial",
          summary: "midway",
          producedAt: 0,
        },
      }),
    );
    expect(out).toContain("### Latest Output");
    expect(out).not.toContain("**Next step:**");
    expect(out).not.toContain("**Artifacts:**");
  });

  it("renders attempt history with duration and failure reason", () => {
    const out = formatTaskDetail(
      task({
        attempts: [
          {
            attemptId: "a1",
            attemptNumber: 1,
            status: "completed",
            startedAt: 0,
            endedAt: 5000,
          },
          {
            attemptId: "a2",
            attemptNumber: 2,
            status: "failed",
            startedAt: 6000,
            endedAt: 7000,
            failureReason: "timeout",
          },
          {
            attemptId: "a3",
            attemptNumber: 3,
            status: "running",
            startedAt: 8000,
          },
        ],
      }),
    );
    expect(out).toContain("### Attempt History");
    expect(out).toContain("#1: completed (5s)");
    expect(out).toContain("#2: failed (1s) — timeout");
    expect(out).toContain("#3: running (ongoing)");
  });
});
