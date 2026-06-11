import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  TASKS_MIGRATIONS,
  createTasksStore,
  type OrchestratorTaskRecord,
  type TaskAttemptRecord,
  type TaskCheckpointRecord,
  type TaskOutputRecord,
} from "./tasks.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "./migrations.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of TASKS_MIGRATIONS) registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function baseTask(overrides: Partial<OrchestratorTaskRecord> = {}): OrchestratorTaskRecord {
  return {
    id: "t-1",
    goalId: "g-1",
    name: "do thing",
    task: "Do the thing carefully",
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

describe("create + get", () => {
  it("round-trips a minimal task", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    const t = store.get("t-1");
    expect(t).toBeDefined();
    expect(t!.id).toBe("t-1");
    expect(t!.goalId).toBe("g-1");
    expect(t!.status).toBe("pending");
    expect(t!.dispatch).toEqual({ mode: "manual" });
    expect(t!.blockedBy).toEqual([]);
    expect(t!.attempts).toEqual([]);
    expect(t!.tags).toEqual([]);
  });

  it("returns undefined for an unknown id", () => {
    const store = createTasksStore({ db });
    expect(store.get("missing")).toBeUndefined();
  });

  it("round-trips every optional field", () => {
    const checkpoint: TaskCheckpointRecord = {
      checkpointAt: 1000,
      phase: "validation",
      summary: "halfway",
      artifactPaths: ["/x"],
      blocker: "auth issue",
      progressPercent: 50,
      recommendedNextStep: "retry login",
    };
    const output: TaskOutputRecord = {
      deliverableState: "complete",
      summary: "done",
      artifactPaths: ["/a"],
      symptom: "s",
      rootCause: "r",
      fixScope: "f",
      systemImpact: "i",
      fixCategory: "surgical",
    };
    const store = createTasksStore({ db });
    store.create(
      baseTask({
        activeRunId: "run-1",
        activeSessionKey: "agent:host:session-1",
        attemptCount: 3,
        failedDispatchCount: 1,
        latestCheckpoint: checkpoint,
        latestOutput: output,
        priority: "high",
        startedAt: 100,
        readyAt: 50,
        completedAt: 200,
        failureReason: "transient timeout",
        retryPolicy: "auto_once",
        guidance: ["agents/foo.md"],
        tags: ["validation", "ops"],
        timeoutMs: 60_000,
        originator: { channel: "discord", accountId: "u-1" },
        dispatch: { mode: "spawn", agentId: "worker", model: "sonnet" },
        blockedBy: ["t-0"],
      }),
    );
    const t = store.get("t-1")!;
    expect(t.activeRunId).toBe("run-1");
    expect(t.activeSessionKey).toBe("agent:host:session-1");
    expect(t.attemptCount).toBe(3);
    expect(t.failedDispatchCount).toBe(1);
    expect(t.latestCheckpoint).toEqual(checkpoint);
    expect(t.latestOutput).toEqual(output);
    expect(t.priority).toBe("high");
    expect(t.startedAt).toBe(100);
    expect(t.readyAt).toBe(50);
    expect(t.completedAt).toBe(200);
    expect(t.failureReason).toBe("transient timeout");
    expect(t.retryPolicy).toBe("auto_once");
    expect(t.guidance).toEqual(["agents/foo.md"]);
    expect(t.tags).toEqual(["validation", "ops"]);
    expect(t.timeoutMs).toBe(60_000);
    expect(t.originator).toEqual({ channel: "discord", accountId: "u-1" });
    expect(t.dispatch).toEqual({ mode: "spawn", agentId: "worker", model: "sonnet" });
    expect(t.blockedBy).toEqual(["t-0"]);
  });

  it("handles every dispatch mode shape", () => {
    const store = createTasksStore({ db });
    let n = 0;
    const cases = [
      { mode: "spawn" as const, agentId: "a" },
      {
        mode: "exec" as const,
        command: ["echo", "hi"],
        cwd: "/tmp",
        timeoutMs: 5000,
      },
      { mode: "manual" as const },
      { mode: "approval" as const },
      { mode: "notify" as const, targetAgentId: "x", channel: "discord" },
      { mode: "wake" as const, targetAgentId: "y", reason: "scheduled" },
    ];
    for (const dispatch of cases) {
      store.create(baseTask({ id: `t-${++n}`, dispatch }));
      const t = store.get(`t-${n}`)!;
      expect(t.dispatch).toEqual(dispatch);
    }
  });
});

describe("update", () => {
  it("replaces every column on the row", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    const updated: OrchestratorTaskRecord = {
      ...baseTask(),
      name: "renamed",
      task: "rewritten body",
      status: "running",
      activeRunId: "run-99",
      attemptCount: 5,
      startedAt: 999,
    };
    store.update(updated);
    const t = store.get("t-1")!;
    expect(t.name).toBe("renamed");
    expect(t.task).toBe("rewritten body");
    expect(t.status).toBe("running");
    expect(t.activeRunId).toBe("run-99");
    expect(t.attemptCount).toBe(5);
    expect(t.startedAt).toBe(999);
  });

  it("preserves complex JSON optionals (checkpoint / output / guidance) on update", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    const cp: TaskCheckpointRecord = {
      checkpointAt: 100,
      phase: "p",
      summary: "s",
    };
    const out: TaskOutputRecord = { deliverableState: "complete", summary: "done" };
    store.update(
      baseTask({
        latestCheckpoint: cp,
        latestOutput: out,
        guidance: ["wiki/x.md"],
      }),
    );
    const t = store.get("t-1")!;
    expect(t.latestCheckpoint).toEqual(cp);
    expect(t.latestOutput).toEqual(out);
    expect(t.guidance).toEqual(["wiki/x.md"]);
  });

  it("clears optional fields when they are undefined in the update", () => {
    const store = createTasksStore({ db });
    // First create with optional fields populated:
    store.create(
      baseTask({
        activeRunId: "run-A",
        activeSessionKey: "session-A",
        latestCheckpoint: {
          checkpointAt: 1,
          phase: "p",
          summary: "s",
        },
        latestOutput: { deliverableState: "partial", summary: "p" },
        startedAt: 100,
        readyAt: 50,
        completedAt: 200,
        failureReason: "x",
        retryPolicy: "auto_once",
        guidance: ["a/b.md"],
        timeoutMs: 5000,
      }),
    );
    // Then update with all-undefined optionals (e.g., "clear stale state"):
    store.update(baseTask({ status: "pending" }));
    const t = store.get("t-1")!;
    expect(t.activeRunId).toBeUndefined();
    expect(t.activeSessionKey).toBeUndefined();
    expect(t.latestCheckpoint).toBeUndefined();
    expect(t.latestOutput).toBeUndefined();
    expect(t.startedAt).toBeUndefined();
    expect(t.readyAt).toBeUndefined();
    expect(t.completedAt).toBeUndefined();
    expect(t.failureReason).toBeUndefined();
    expect(t.retryPolicy).toBeUndefined();
    expect(t.guidance).toBeUndefined();
    expect(t.timeoutMs).toBeUndefined();
  });
});

describe("listForGoal", () => {
  it("returns tasks whose goal_id matches", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", goalId: "g-A" }));
    store.create(baseTask({ id: "t-2", goalId: "g-A" }));
    store.create(baseTask({ id: "t-3", goalId: "g-B" }));
    const a = store.listForGoal("g-A");
    expect(a.map((t) => t.id).sort()).toEqual(["t-1", "t-2"]);
    expect(store.listForGoal("g-B").map((t) => t.id)).toEqual(["t-3"]);
  });

  it("returns empty when goal has no tasks", () => {
    const store = createTasksStore({ db });
    expect(store.listForGoal("g-empty")).toEqual([]);
  });
});

describe("deleteByGoal", () => {
  it("deletes the goal's tasks plus their attempts and leaves other goals alone", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", goalId: "g-A" }));
    store.create(baseTask({ id: "t-2", goalId: "g-A" }));
    store.create(baseTask({ id: "t-3", goalId: "g-B" }));
    const attempt: TaskAttemptRecord & { taskId: string } = {
      taskId: "t-1",
      attemptId: "att-1",
      attemptNumber: 1,
      runId: "run-1",
      status: "completed",
      startedAt: 100,
    };
    store.createAttempt(attempt);
    store.createAttempt({ ...attempt, taskId: "t-3", attemptId: "att-2", runId: "run-2" });

    expect(store.deleteByGoal("g-A")).toBe(2);

    expect(store.listForGoal("g-A")).toEqual([]);
    expect(store.findAttemptByRunId("run-1")).toBeUndefined();
    // The other goal's task + attempt are untouched.
    expect(store.listForGoal("g-B").map((t) => t.id)).toEqual(["t-3"]);
    expect(store.findAttemptByRunId("run-2")).toBeDefined();
  });

  it("returns 0 when the goal has no tasks", () => {
    const store = createTasksStore({ db });
    expect(store.deleteByGoal("g-empty")).toBe(0);
  });
});

describe("listRunning + findByStatus", () => {
  it("returns only tasks in status='running'", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", status: "running" }));
    store.create(baseTask({ id: "t-2", status: "pending" }));
    store.create(baseTask({ id: "t-3", status: "running" }));
    expect(store.listRunning().map((t) => t.id).sort()).toEqual(["t-1", "t-3"]);
  });

  it("findByStatus filters by exact status value", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", status: "failed" }));
    store.create(baseTask({ id: "t-2", status: "completed" }));
    expect(store.findByStatus("failed").map((t) => t.id)).toEqual(["t-1"]);
    expect(store.findByStatus("completed").map((t) => t.id)).toEqual(["t-2"]);
    expect(store.findByStatus("running")).toEqual([]);
  });
});

describe("findByRunId + findBySessionKey", () => {
  it("findByRunId returns the task whose active_run_id matches", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", activeRunId: "run-A" }));
    store.create(baseTask({ id: "t-2", activeRunId: "run-B" }));
    expect(store.findByRunId("run-A")!.id).toBe("t-1");
    expect(store.findByRunId("run-Z")).toBeUndefined();
  });

  it("findBySessionKey matches exact session key", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", activeSessionKey: "session-abc" }));
    expect(store.findBySessionKey("session-abc")!.id).toBe("t-1");
  });

  it("findBySessionKey matches by suffix when the runtime prepends a host prefix", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", activeSessionKey: "session-xyz" }));
    // Runtime may prepend "agent:host:" before the requested key.
    expect(store.findBySessionKey("agent:host:session-xyz")!.id).toBe("t-1");
  });

  it("findBySessionKey returns undefined when neither exact nor suffix matches", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", activeSessionKey: "session-xyz" }));
    expect(store.findBySessionKey("totally-different")).toBeUndefined();
  });
});

describe("findByName — status-prioritized", () => {
  it("returns the running task when multiple tasks share a name", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", name: "build", status: "completed" }));
    store.create(baseTask({ id: "t-2", name: "build", status: "running" }));
    store.create(baseTask({ id: "t-3", name: "build", status: "pending" }));
    expect(store.findByName("build")!.id).toBe("t-2");
  });

  it("falls through the priority ladder when no running task exists", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", name: "x", status: "failed" }));
    store.create(baseTask({ id: "t-2", name: "x", status: "ready" }));
    expect(store.findByName("x")!.id).toBe("t-2"); // ready ranks above failed
  });

  it("returns undefined when no task has the name", () => {
    const store = createTasksStore({ db });
    expect(store.findByName("nope")).toBeUndefined();
  });
});

describe("findBlockedBy", () => {
  it("returns tasks whose blocked_by JSON array contains the given id", () => {
    const store = createTasksStore({ db });
    store.create(baseTask({ id: "t-1", blockedBy: ["t-parent"] }));
    store.create(baseTask({ id: "t-2", blockedBy: ["t-parent", "t-other"] }));
    store.create(baseTask({ id: "t-3", blockedBy: [] }));
    const ids = store.findBlockedBy("t-parent").map((t) => t.id).sort();
    expect(ids).toEqual(["t-1", "t-2"]);
  });

  it("returns empty when nothing is blocked by the id", () => {
    const store = createTasksStore({ db });
    expect(store.findBlockedBy("ghost")).toEqual([]);
  });
});

describe("attempts — createAttempt / updateAttempt / aggregation", () => {
  function attempt(
    overrides: Partial<TaskAttemptRecord & { taskId: string }> = {},
  ): TaskAttemptRecord & { taskId: string } {
    return {
      attemptId: "a-1",
      taskId: "t-1",
      attemptNumber: 1,
      status: "running",
      startedAt: 100,
      ...overrides,
    };
  }

  it("createAttempt persists every field; get() aggregates attempts on the task", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    store.createAttempt(
      attempt({
        runId: "run-1",
        sessionKey: "session-1",
        artifactPaths: ["/x", "/y"],
      }),
    );
    const t = store.get("t-1")!;
    expect(t.attempts).toHaveLength(1);
    expect(t.attempts[0]).toMatchObject({
      attemptId: "a-1",
      attemptNumber: 1,
      runId: "run-1",
      sessionKey: "session-1",
      status: "running",
      startedAt: 100,
    });
    expect(t.attempts[0]!.artifactPaths).toEqual(["/x", "/y"]);
  });

  it("attempts return in attempt_number ascending order", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    store.createAttempt(attempt({ attemptId: "a-2", attemptNumber: 2 }));
    store.createAttempt(attempt({ attemptId: "a-1", attemptNumber: 1 }));
    store.createAttempt(attempt({ attemptId: "a-3", attemptNumber: 3 }));
    const t = store.get("t-1")!;
    expect(t.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
  });

  it("updateAttempt applies partial updates and ignores unchanged fields", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    store.createAttempt(attempt());
    store.updateAttempt("a-1", {
      status: "completed",
      endedAt: 500,
      outputSummary: "ok",
    });
    const t = store.get("t-1")!;
    expect(t.attempts[0]!.status).toBe("completed");
    expect(t.attempts[0]!.endedAt).toBe(500);
    expect(t.attempts[0]!.outputSummary).toBe("ok");
    expect(t.attempts[0]!.failureReason).toBeUndefined();
  });

  it("updateAttempt with all-empty updates is a no-op (returns without throwing)", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    store.createAttempt(attempt());
    expect(() => store.updateAttempt("a-1", {})).not.toThrow();
    expect(store.get("t-1")!.attempts[0]!.status).toBe("running");
  });

  it("updateAttempt with failureReason persists it", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    store.createAttempt(attempt());
    store.updateAttempt("a-1", { failureReason: "timeout" });
    expect(store.get("t-1")!.attempts[0]!.failureReason).toBe("timeout");
  });

  it("findAttemptByRunId returns attempt + taskId or undefined", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    store.createAttempt(attempt({ runId: "run-X" }));
    const hit = store.findAttemptByRunId("run-X");
    expect(hit).toBeDefined();
    expect(hit!.taskId).toBe("t-1");
    expect(hit!.attemptId).toBe("a-1");
    expect(store.findAttemptByRunId("never")).toBeUndefined();
  });
});

describe("defensive JSON parsing", () => {
  it("malformed blocked_by JSON yields empty array (recovery)", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    db.prepare(
      "UPDATE tasks SET blocked_by = 'not-json' WHERE id = 't-1'",
    ).run();
    expect(store.get("t-1")!.blockedBy).toEqual([]);
  });

  it("malformed dispatch JSON falls back to manual mode", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    db.prepare(
      "UPDATE tasks SET dispatch = 'not-json' WHERE id = 't-1'",
    ).run();
    expect(store.get("t-1")!.dispatch).toEqual({ mode: "manual" });
  });

  it("malformed latest_checkpoint JSON yields undefined", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    db.prepare(
      "UPDATE tasks SET latest_checkpoint = 'oops' WHERE id = 't-1'",
    ).run();
    expect(store.get("t-1")!.latestCheckpoint).toBeUndefined();
  });

  it("malformed latest_output JSON yields undefined", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    db.prepare(
      "UPDATE tasks SET latest_output = 'oops' WHERE id = 't-1'",
    ).run();
    expect(store.get("t-1")!.latestOutput).toBeUndefined();
  });

  it("malformed guidance JSON yields undefined", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    db.prepare("UPDATE tasks SET guidance = 'oops' WHERE id = 't-1'").run();
    expect(store.get("t-1")!.guidance).toBeUndefined();
  });

  it("malformed tags JSON yields empty array (default fallback)", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    db.prepare("UPDATE tasks SET tags = 'oops' WHERE id = 't-1'").run();
    expect(store.get("t-1")!.tags).toEqual([]);
  });

  it("malformed originator JSON yields undefined", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    db.prepare("UPDATE tasks SET originator = 'oops' WHERE id = 't-1'").run();
    expect(store.get("t-1")!.originator).toBeUndefined();
  });

  it("malformed artifact_paths on an attempt yields undefined", () => {
    const store = createTasksStore({ db });
    store.create(baseTask());
    store.createAttempt({
      attemptId: "a-1",
      taskId: "t-1",
      attemptNumber: 1,
      status: "running",
      startedAt: 100,
    });
    db.prepare(
      "UPDATE attempts SET artifact_paths = 'oops' WHERE attempt_id = 'a-1'",
    ).run();
    expect(store.get("t-1")!.attempts[0]!.artifactPaths).toBeUndefined();
  });
});

describe("TASKS_MIGRATIONS shape", () => {
  it("produces both tasks and attempts tables on a fresh DB", () => {
    const fresh = new DatabaseSync(":memory:");
    for (const m of TASKS_MIGRATIONS) m.up(fresh);
    const tables = fresh
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("tasks");
    expect(names).toContain("attempts");
    fresh.close();
  });
});
