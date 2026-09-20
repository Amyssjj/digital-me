import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  createGoalsStore,
  createTasksStore,
  GOALS_MIGRATIONS,
  TASKS_MIGRATIONS,
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
  type ExecRunArgs,
  type ExecRunResult,
  type Migration,
  type OpenClawRuntime,
  type OrchestratorTaskRecord,
  type SubagentRunArgs,
  type VerifyStep,
} from "@digital-me/brain-orchestrator";
import {
  createOpenClawDispatcher,
  type OpenClawDispatcherDeps,
} from "./dispatcher.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of [...GOALS_MIGRATIONS, ...TASKS_MIGRATIONS] as Migration[]) {
    registerMigration(m);
  }
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

type RuntimeOverrides = {
  subagentRun?: (args: SubagentRunArgs) => Promise<{ runId: string }>;
  execRun?: ((args: ExecRunArgs) => Promise<ExecRunResult>) | null;
};

type RuntimeContext = {
  runtime: OpenClawRuntime;
  spawnCalls: SubagentRunArgs[];
  execCalls: ExecRunArgs[];
  logs: Array<{ level: string; message: string }>;
};

function makeRuntime(overrides: RuntimeOverrides = {}): RuntimeContext {
  const spawnCalls: SubagentRunArgs[] = [];
  const execCalls: ExecRunArgs[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const defaultSpawn = async (args: SubagentRunArgs) => {
    return { runId: `run-${spawnCalls.length}` };
  };
  const defaultExec = async (args: ExecRunArgs): Promise<ExecRunResult> => {
    return {
      success: true,
      timedOut: false,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    };
  };
  const subRun = overrides.subagentRun ?? defaultSpawn;
  const userExec = overrides.execRun;
  const runtime: OpenClawRuntime = {
    log(level, message) {
      logs.push({ level, message });
    },
    subagent: {
      run: async (args) => {
        spawnCalls.push(args);
        return subRun(args);
      },
    },
    execRun:
      userExec === null
        ? undefined
        : async (args) => {
            execCalls.push(args);
            return (userExec ?? defaultExec)(args);
          },
  };
  return { runtime, spawnCalls, execCalls, logs };
}

function makeDeps(rtCtx: RuntimeContext): OpenClawDispatcherDeps {
  let counter = 0;
  return {
    goals: createGoalsStore({ db }),
    tasks: createTasksStore({ db }),
    runtime: rtCtx.runtime,
    now: () => 1000,
    newId: () => `id-${++counter}`,
  };
}

function seedGoal(deps: OpenClawDispatcherDeps): void {
  deps.goals.create({
    id: "g-1",
    name: "G",
    description: "",
    status: "running",
    type: "project",
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "t",
  });
}

function seedTask(
  deps: OpenClawDispatcherDeps,
  overrides: Partial<OrchestratorTaskRecord> = {},
): OrchestratorTaskRecord {
  const t: OrchestratorTaskRecord = {
    id: "t-1",
    goalId: "g-1",
    name: "T",
    task: "do x",
    blockedBy: [],
    dispatch: { mode: "spawn", agentId: "agent-x" },
    status: "ready",
    attemptCount: 0,
    attempts: [],
    priority: "normal",
    onUpstreamFailure: "wait",
    ...overrides,
  };
  deps.tasks.create(t);
  return t;
}

// ── dispatchSpawnTask ──────────────────────────────────────────────────────

describe("dispatchSpawnTask", () => {
  it("spawns a ready task via the subagent.run runtime call", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps);
    const d = createOpenClawDispatcher(deps);
    const ok = await d.dispatchSpawnTask(task);
    expect(ok).toBe(true);
    expect(rt.spawnCalls).toHaveLength(1);
    expect(rt.spawnCalls[0]!.sessionKey).toBe("orch-t-1");
    expect(rt.spawnCalls[0]!.message).toBe("do x");
    expect(rt.spawnCalls[0]!.agentId).toBe("agent-x");
    const stored = deps.tasks.get("t-1")!;
    expect(stored.status).toBe("running");
    expect(stored.activeRunId).toBe("run-1");
    expect(stored.attemptCount).toBe(1);
  });

  it("forwards model + originator binding when present", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "spawn", agentId: "agent-y", model: "sonnet-4.6" },
      originator: {
        channel: "discord",
        accountId: "u-1",
        threadId: "thr-1",
      },
    });
    const d = createOpenClawDispatcher(deps);
    await d.dispatchSpawnTask(task);
    const call = rt.spawnCalls[0]!;
    expect(call.model).toBe("sonnet-4.6");
    expect(call.channel).toBe("discord");
    expect(call.accountId).toBe("u-1");
    expect(call.threadId).toBe("thr-1");
  });

  it("honors a caller-supplied sessionKeyFor override", async () => {
    const rt = makeRuntime();
    const deps: OpenClawDispatcherDeps = {
      ...makeDeps(rt),
      sessionKeyFor: (t) => `custom-${t.id}-${t.attemptCount + 1}`,
    };
    seedGoal(deps);
    const task = seedTask(deps);
    await createOpenClawDispatcher(deps).dispatchSpawnTask(task);
    expect(rt.spawnCalls[0]!.sessionKey).toBe("custom-t-1-1");
  });

  it("refuses non-ready tasks", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, { status: "running" });
    expect(
      await createOpenClawDispatcher(deps).dispatchSpawnTask(task),
    ).toBe(false);
    expect(rt.spawnCalls).toHaveLength(0);
  });

  it("refuses tasks with an existing activeRunId", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, { activeRunId: "stuck" });
    expect(
      await createOpenClawDispatcher(deps).dispatchSpawnTask(task),
    ).toBe(false);
  });

  it("refuses non-spawn-mode tasks", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["echo"] },
    });
    expect(
      await createOpenClawDispatcher(deps).dispatchSpawnTask(task),
    ).toBe(false);
  });

  it("propagates subagent.run errors with a log line", async () => {
    const rt = makeRuntime({
      subagentRun: async () => {
        throw new Error("gateway scope unbound");
      },
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps);
    await expect(
      createOpenClawDispatcher(deps).dispatchSpawnTask(task),
    ).rejects.toThrow(/gateway scope/);
    expect(rt.logs.some((l) => l.level === "error")).toBe(true);
  });

  it("uses default newId/clock when omitted", async () => {
    const rt = makeRuntime();
    const deps: OpenClawDispatcherDeps = {
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
      runtime: rt.runtime,
    };
    seedGoal(deps);
    const task = seedTask(deps);
    const before = Date.now();
    const ok = await createOpenClawDispatcher(deps).dispatchSpawnTask(task);
    expect(ok).toBe(true);
    const stored = deps.tasks.get("t-1")!;
    expect(stored.startedAt).toBeGreaterThanOrEqual(before);
    expect(stored.attempts[0]!.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
  });
});

// exec dispatch is fire-and-forget (S3): dispatchExecTask resolves `true` once
// the running attempt is recorded, then finalizes from a detached promise.
// Drain that microtask chain before asserting the terminal state.
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ── dispatchExecTask ──────────────────────────────────────────────────────

describe("dispatchExecTask", () => {
  it("runs an exec task to completion via execRun (success path)", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: {
        mode: "exec",
        command: ["echo", "hi"],
        cwd: "/tmp",
        env: { X: "1" },
        timeoutMs: 1000,
      },
    });
    const ok = await createOpenClawDispatcher(deps).dispatchExecTask(task);
    expect(ok).toBe(true);
    await flush();
    expect(rt.execCalls).toHaveLength(1);
    expect(rt.execCalls[0]!.command).toEqual(["echo", "hi"]);
    expect(rt.execCalls[0]!.cwd).toBe("/tmp");
    expect(rt.execCalls[0]!.env).toEqual({ X: "1" });
    expect(rt.execCalls[0]!.timeoutMs).toBe(1000);
    const stored = deps.tasks.get("t-1")!;
    expect(stored.status).toBe("completed");
    expect(stored.completedAt).toBe(1000);
  });

  it("falls back to the task's timeoutMs when the dispatch has none", async () => {
    // A workflow step that declares `timeoutMs` lands it on the task row, not
    // inside the dispatch object — only alias resolution injects the latter.
    // Without this fallback the runtime silently applied its own 300s default,
    // so a step's declared budget never took effect.
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["echo", "hi"] },
      timeoutMs: 900_000,
    });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    expect(rt.execCalls[0]!.timeoutMs).toBe(900_000);
  });

  it("prefers the dispatch timeoutMs over the task's when both are set", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["echo", "hi"], timeoutMs: 1000 },
      timeoutMs: 900_000,
    });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    expect(rt.execCalls[0]!.timeoutMs).toBe(1000);
  });

  it("unblocks pending dependents after an exec task succeeds", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const upstream = seedTask(deps, {
      id: "upstream",
      dispatch: { mode: "exec", command: ["true"] },
    });
    seedTask(deps, {
      id: "downstream",
      name: "Downstream",
      blockedBy: ["upstream"],
      status: "pending",
      dispatch: { mode: "exec", command: ["next"] },
    });

    const ok = await createOpenClawDispatcher(deps).dispatchExecTask(upstream);
    await flush();

    expect(ok).toBe(true);
    const downstream = deps.tasks.get("downstream")!;
    expect(downstream.status).toBe("ready");
    expect(downstream.blockedBy).toEqual([]);
    expect(downstream.readyAt).toBe(1000);
  });

  it("marks the task failed when execRun reports !success", async () => {
    const rt = makeRuntime({
      execRun: async () => ({
        success: false,
        timedOut: false,
        exitCode: 2,
        stdout: "",
        stderr: "boom",
      }),
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["false"] },
    });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    const stored = deps.tasks.get("t-1")!;
    expect(stored.status).toBe("failed");
    expect(stored.failureReason).toMatch(/exit code 2/);
  });

  it("preserves stdout in the failed attempt's outputSummary", async () => {
    // Regression: pre-fix, failed exec tasks discarded stdout entirely —
    // dream-cycle's compile step (which logs progress via stdout, not
    // stderr) crashed silently on 2026-05-27 with `exit code 1; stderr: `
    // and zero diagnostic context. After the fix, the attempt should
    // carry stdout in outputSummary just like the success path does.
    const rt = makeRuntime({
      execRun: async () => ({
        success: false,
        timedOut: false,
        exitCode: 1,
        stdout: "running step 1...\nERROR: HTTP 429 from LLM\n",
        stderr: "",
      }),
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["dream-cycle"] },
    });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    const stored = deps.tasks.get("t-1")!;
    expect(stored.status).toBe("failed");
    expect(stored.failureReason).toMatch(/exit code 1/);
    // Attempt's outputSummary now carries the stdout so post-mortems can
    // see what the process printed before crashing.
    expect(stored.attempts[0]!.outputSummary).toContain("HTTP 429");
  });

  it("marks the task failed with 'error' message when execRun reports an error string", async () => {
    const rt = makeRuntime({
      execRun: async () => ({
        success: false,
        timedOut: false,
        stdout: "",
        stderr: "",
        error: "spawn ENOENT",
      }),
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["missing-bin"] },
    });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    expect(deps.tasks.get("t-1")!.failureReason).toBe("spawn ENOENT");
  });

  it("records the attempt as 'timeout' when execRun reports timedOut", async () => {
    const rt = makeRuntime({
      execRun: async () => ({
        success: false,
        timedOut: true,
        stdout: "",
        stderr: "",
      }),
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["sleep", "10"] },
    });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    const stored = deps.tasks.get("t-1")!;
    expect(stored.attempts[0]!.status).toBe("timeout");
    expect(stored.status).toBe("failed");
  });

  it("catches execRun throws in the detached promise and finalizes the attempt as failed", async () => {
    const rt = makeRuntime({
      execRun: async () => {
        throw new Error("pipe broke");
      },
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["bad"] },
    });
    // Fire-and-forget: the dispatch resolves true (the throw is handled inside
    // the detached promise, NOT propagated — that would be an unhandled
    // rejection that crashes the scheduler tick).
    const ok = await createOpenClawDispatcher(deps).dispatchExecTask(task);
    expect(ok).toBe(true);
    await flush();
    const stored = deps.tasks.get("t-1")!;
    expect(stored.status).toBe("failed");
    expect(stored.failureReason).toMatch(/pipe broke/);
  });

  it("does not block the dispatch on the child's lifetime (returns running, finalizes later)", async () => {
    // Regression (S3): exec dispatch used to `await execRun` before returning,
    // stalling the scheduler tick for the child's whole (up to ~65min) run.
    let settleExec!: (r: ExecRunResult) => void;
    const rt = makeRuntime({
      execRun: () => new Promise<ExecRunResult>((resolve) => {
        settleExec = resolve;
      }),
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["long-running"] },
    });

    // Resolves promptly to `true` with the task still RUNNING, before exec settles.
    const ok = await createOpenClawDispatcher(deps).dispatchExecTask(task);
    expect(ok).toBe(true);
    await flush();
    expect(deps.tasks.get("t-1")!.status).toBe("running");

    // Once the child settles, the detached promise finalizes the task.
    settleExec({ success: true, timedOut: false, exitCode: 0, stdout: "ok", stderr: "" });
    await flush();
    expect(deps.tasks.get("t-1")!.status).toBe("completed");
  });

  it("returns false when execRun is not available", async () => {
    const rt = makeRuntime({ execRun: null });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["echo"] },
    });
    const ok = await createOpenClawDispatcher(deps).dispatchExecTask(task);
    expect(ok).toBe(false);
    expect(rt.logs.some((l) => l.message.includes("execRun unavailable"))).toBe(
      true,
    );
  });

  it("refuses non-ready exec tasks", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      status: "completed",
      dispatch: { mode: "exec", command: ["echo"] },
    });
    expect(
      await createOpenClawDispatcher(deps).dispatchExecTask(task),
    ).toBe(false);
  });

  it("refuses exec tasks with an existing activeRunId", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      activeRunId: "stuck",
      dispatch: { mode: "exec", command: ["echo"] },
    });
    expect(
      await createOpenClawDispatcher(deps).dispatchExecTask(task),
    ).toBe(false);
  });

  it("refuses non-exec-mode tasks", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps); // spawn-mode default
    expect(
      await createOpenClawDispatcher(deps).dispatchExecTask(task),
    ).toBe(false);
  });

  it("truncates very long stdout when storing outputSummary", async () => {
    const longStdout = "x".repeat(5000);
    const rt = makeRuntime({
      execRun: async () => ({
        success: true,
        timedOut: false,
        exitCode: 0,
        stdout: longStdout,
        stderr: "",
      }),
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["echo"] },
    });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    const a = deps.tasks.get("t-1")!.attempts[0]!;
    expect(a.outputSummary!.endsWith("…[truncated]")).toBe(true);
  });

  it("ignores post-finalize errors when the task row was deleted mid-flight", async () => {
    const rt = makeRuntime({
      execRun: async () => {
        throw new Error("blip");
      },
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["x"] },
    });
    // Delete the task row before finalizeExecFailure runs.
    const origGet = deps.tasks.get.bind(deps.tasks);
    let callCount = 0;
    deps.tasks.get = (id: string) => {
      callCount++;
      // First call (inside finalizeExecFailure) returns undefined → simulates
      // the task being deleted mid-flight.
      if (callCount === 1) return undefined;
      return origGet(id);
    };
    // Detached: the throw is caught inside the promise; finalizeExecFailure
    // sees the deleted row and returns early. dispatchExecTask still resolves
    // true and nothing escapes as an unhandled rejection.
    const ok = await createOpenClawDispatcher(deps).dispatchExecTask(task);
    expect(ok).toBe(true);
    await flush();
    expect(callCount).toBeGreaterThan(0);
  });
});

  it("omits agentId from subagent.run when the dispatch carries an empty agentId", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "spawn", agentId: "" },
    });
    await createOpenClawDispatcher(deps).dispatchSpawnTask(task);
    expect(rt.spawnCalls[0]!.agentId).toBeUndefined();
  });

  it("uses default newId/clock in the exec success path when omitted", async () => {
    const rt = makeRuntime();
    const deps: OpenClawDispatcherDeps = {
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
      runtime: rt.runtime,
    };
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["echo"] },
    });
    const before = Date.now();
    const ok = await createOpenClawDispatcher(deps).dispatchExecTask(task);
    expect(ok).toBe(true);
    await flush();
    const stored = deps.tasks.get("t-1")!;
    expect(stored.completedAt).toBeGreaterThanOrEqual(before);
    expect(stored.attempts[0]!.attemptId).toMatch(/^[0-9a-f]{8}-/);
  });

  it("uses default clock in the exec failure path when omitted", async () => {
    const rt = makeRuntime({
      execRun: async () => ({
        success: false,
        timedOut: false,
        exitCode: 1,
        stdout: "",
        stderr: "boom",
      }),
    });
    const deps: OpenClawDispatcherDeps = {
      goals: createGoalsStore({ db }),
      tasks: createTasksStore({ db }),
      runtime: rt.runtime,
    };
    seedGoal(deps);
    const task = seedTask(deps, {
      dispatch: { mode: "exec", command: ["false"] },
    });
    const before = Date.now();
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    const stored = deps.tasks.get("t-1")!;
    expect(stored.status).toBe("failed");
    expect(stored.attempts[0]!.endedAt).toBeGreaterThanOrEqual(before);
  });

// ── dispatchExecTask: verify step ──────────────────────────────────────────

describe("dispatchExecTask verify step", () => {
  const WORKER = ["/abs/node", "/abs/worker.mjs", "/abs/spec.json"];
  const okRun: ExecRunResult = { success: true, timedOut: false, exitCode: 0, stdout: "worker said done", stderr: "" };

  function seedVerified(deps: OpenClawDispatcherDeps, verify: VerifyStep): OrchestratorTaskRecord {
    return seedTask(deps, { dispatch: { mode: "exec", command: WORKER, cwd: "/work", verify } });
  }

  it("runs dispatch.verify after a successful run, with its own cwd/timeout, and completes the task when it exits as expected", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedVerified(deps, { command: ["/bin/test", "-s", "/art/handoff.json"], cwd: "/art", timeoutMs: 30_000, expectedExitCode: 0 });
    expect(await createOpenClawDispatcher(deps).dispatchExecTask(task)).toBe(true);
    await flush();
    expect(rt.execCalls.map((c) => c.command)).toEqual([WORKER, ["/bin/test", "-s", "/art/handoff.json"]]);
    expect(rt.execCalls[1]).toEqual({ command: ["/bin/test", "-s", "/art/handoff.json"], cwd: "/art", timeoutMs: 30_000 });
    const stored = deps.tasks.get("t-1")!;
    expect(stored.status).toBe("completed");
    expect(stored.attempts[0]!.status).toBe("completed");
  });

  // A runtime whose execRun models the real `/bin/test -s <file>` (exit 0 iff
  // the file is non-empty) and runs a handoff-gated task against `content`.
  async function runWithHandoff(content: string): Promise<{ rt: RuntimeContext; deps: OpenClawDispatcherDeps; handoff: string }> {
    const dir = mkdtempSync(path.join(tmpdir(), "dm-verify-"));
    const handoff = path.join(dir, "handoff.json");
    writeFileSync(handoff, content);
    const rt = makeRuntime({
      execRun: async (args) => {
        if (args.command[0] !== "/bin/test") return okRun;
        const nonEmpty = statSync(args.command[2]!).size > 0;
        return { success: nonEmpty, timedOut: false, exitCode: nonEmpty ? 0 : 1, stdout: "", stderr: "" };
      },
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedVerified(deps, { command: ["/bin/test", "-s", handoff] });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    rmSync(dir, { recursive: true, force: true });
    return { rt, deps, handoff };
  }

  it("fails the task when the worker exits 0 but handoff.json is empty (the gate the alias resolver implies)", async () => {
    const { rt, deps, handoff } = await runWithHandoff("");
    const stored = deps.tasks.get("t-1")!;
    expect(stored.status).toBe("failed");
    expect(stored.failureReason).toBe(`verify failed: /bin/test -s ${handoff} exited 1 (expected 0)`);
    expect(stored.attempts[0]!.status).toBe("failed");
    // The run's own stdout survives the verify failure.
    expect(stored.attempts[0]!.outputSummary).toBe("worker said done");
    expect(rt.logs.some((l) => l.level === "error" && l.message.includes("verify failed"))).toBe(true);
  });

  it("completes the task when handoff.json is non-empty", async () => {
    const { deps } = await runWithHandoff("{\"summary\":\"done\"}");
    expect(deps.tasks.get("t-1")!.status).toBe("completed");
  });

  it("honours a custom expectedExitCode", async () => {
    const rt = makeRuntime({
      execRun: async (args) =>
        args.command[0] === "/bin/sh" ? { success: false, timedOut: false, exitCode: 3, stdout: "", stderr: "" } : okRun,
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedVerified(deps, { command: ["/bin/sh", "-c", "exit 3"], expectedExitCode: 3 });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    expect(deps.tasks.get("t-1")!.status).toBe("completed");
  });

  it("appends the verify command's stderr to the failure reason", async () => {
    const rt = makeRuntime({
      execRun: async (args) =>
        args.command[0] === "/bin/test" ? { success: false, timedOut: false, exitCode: 2, stdout: "", stderr: "test: no such file\n" } : okRun,
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedVerified(deps, { command: ["/bin/test", "-s", "/art/handoff.json"] });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    expect(deps.tasks.get("t-1")!.failureReason).toBe(
      "verify failed: /bin/test -s /art/handoff.json exited 2 (expected 0); stderr: test: no such file\n",
    );
  });

  it("records a timed-out verify as a timeout attempt", async () => {
    const rt = makeRuntime({
      execRun: async (args) => (args.command[0] === "/bin/test" ? { success: false, timedOut: true, stdout: "", stderr: "" } : okRun),
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedVerified(deps, { command: ["/bin/test", "-s", "/art/handoff.json"], timeoutMs: 5 });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    const stored = deps.tasks.get("t-1")!;
    expect(stored.status).toBe("failed");
    expect(stored.attempts[0]!.status).toBe("timeout");
    expect(stored.failureReason).toBe("verify failed: /bin/test -s /art/handoff.json timed out");
  });

  it("treats a verify result without an exit code as 0 when it succeeded", async () => {
    const rt = makeRuntime({
      execRun: async (args) => (args.command[0] === "/bin/test" ? { success: true, timedOut: false, stdout: "", stderr: "" } : okRun),
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedVerified(deps, { command: ["/bin/test", "-s", "/art/handoff.json"] });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    expect(deps.tasks.get("t-1")!.status).toBe("completed");
  });

  it("does not run verify when the run itself failed", async () => {
    const rt = makeRuntime({
      execRun: async () => ({ success: false, timedOut: false, exitCode: 1, stdout: "", stderr: "crash" }),
    });
    const deps = makeDeps(rt);
    seedGoal(deps);
    const task = seedVerified(deps, { command: ["/bin/test", "-s", "/art/handoff.json"] });
    await createOpenClawDispatcher(deps).dispatchExecTask(task);
    await flush();
    expect(rt.execCalls).toHaveLength(1);
    expect(deps.tasks.get("t-1")!.failureReason).toMatch(/exit code 1/);
  });
});

// ── probeSessionLiveness ───────────────────────────────────────────────────

describe("probeSessionLiveness", () => {
  it("returns an empty list (minimum-viable: watchdog handles stalls)", async () => {
    const rt = makeRuntime();
    const deps = makeDeps(rt);
    const result = await createOpenClawDispatcher(deps).probeSessionLiveness();
    expect(result).toEqual([]);
  });
});
