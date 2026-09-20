import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCliExecAliases, normalizeLevel, openBrainDb, Orchestrator, unsupportedSpawn, type Logger } from "./orchestrator.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function make(over: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
  dir = mkdtempSync(join(tmpdir(), "bh-orch-"));
  const logs: string[] = [];
  const log: Logger = (level, msg) => logs.push(`${level}: ${msg}`);
  const db = openBrainDb(join(dir, "nested", "brain.db"), (p) => new DatabaseSync(p));
  const orch = new Orchestrator({ db, wikiRoot: dir, log, stallThresholdMs: 60_000, exists: () => false, readFile: () => "", ...over });
  return { orch, logs, db };
}

const details = (r: Awaited<ReturnType<Orchestrator["execute"]>>) => (r!.details as { json?: unknown }).json;

describe("openBrainDb", () => {
  it("creates the directory, migrates, and is idempotent on reopen", () => {
    dir = mkdtempSync(join(tmpdir(), "bh-orch-"));
    const path = join(dir, "a", "b", "brain.db");
    const db1 = openBrainDb(path, (p) => new DatabaseSync(p));
    const v1 = (db1.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v1).toBeGreaterThan(0);
    db1.close();
    const db2 = openBrainDb(path, (p) => new DatabaseSync(p));
    expect((db2.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(v1);
    db2.close();
  });
});

describe("loadCliExecAliases", () => {
  it("returns {} when config.yaml is missing, parses aliases, tolerates a missing key, warns on bad yaml", () => {
    const logs: string[] = [];
    const log: Logger = (l, m) => logs.push(`${l}: ${m}`);
    expect(loadCliExecAliases("/w", log, { exists: () => false, readFile: () => "" })).toEqual({});
    const yaml = "cli_exec_aliases:\n  claude-code-cli:\n    binary: claude\n    args: ['-p']\n";
    expect(loadCliExecAliases("/w", log, { exists: () => true, readFile: () => yaml })).toEqual({
      "claude-code-cli": { binary: "claude", args: ["-p"] },
    });
    expect(loadCliExecAliases("/w", log, { exists: () => true, readFile: () => "other: 1\n" })).toEqual({});
    expect(loadCliExecAliases("/w", log, { exists: () => true, readFile: () => "" })).toEqual({});
    expect(loadCliExecAliases("/w", log, { exists: () => true, readFile: () => "a: [unclosed" })).toEqual({});
    expect(logs.some((l) => l.startsWith("warn: failed to read"))).toBe(true);
  });
});

describe("Orchestrator", () => {
  it("mounts the brain tools and serves them", async () => {
    const { orch } = make();
    expect([...orch.tools.keys()]).toEqual(
      expect.arrayContaining(["tasks", "agent_identify", "learning_capture", "traces_record", "traces_query", "m1_event_record", "m1_score"]),
    );
    expect(await orch.execute("nope", {})).toBeUndefined();

    const ident = await orch.execute("agent_identify", { agent_id: "bench", runtime: "test" });
    expect(ident!.isError).toBeUndefined();

    const rec = await orch.execute("traces_record", { agent_id: "bench", kind: "tool_call", payload: { x: 1 } });
    expect(rec!.isError).toBeUndefined();
    const q = await orch.execute("traces_query", { agent_id: "bench", format: "json" });
    expect(q!.content[0]!.text).toContain("tool_call");

    const board = await orch.execute("tasks", { action: "board", format: "json" });
    expect(details(board)).toMatchObject({ goals: [] });

    const bad = await orch.execute("tasks", { action: "not-an-action" });
    expect(bad!.isError).toBe(true);
  });

  it("runs a workflow through the scheduler tick with exec dispatch, leaving spawn tasks ready", async () => {
    const calls: { command: readonly string[] }[] = [];
    const { orch, logs } = make({
      now: () => 1_700_000_000_000,
      execRun: async (args) => {
        calls.push({ command: args.command });
        return { success: true, exitCode: 0, timedOut: false, stdout: "done", stderr: "" };
      },
    });
    const imported = await orch.execute("tasks", {
      action: "workflow_import",
      workflowJson: JSON.stringify({
        id: "wf_test",
        name: "test",
        description: "d",
        variables: [],
        steps: [
          { stepKey: "run", name: "run", promptTemplate: "echo", blockedByKeys: [], dispatch: { mode: "exec", command: ["true"] } },
          { stepKey: "agent", name: "agent", promptTemplate: "do it", blockedByKeys: [], dispatch: { mode: "spawn", agentId: "coo" } },
          { stepKey: "human", name: "human", promptTemplate: "sign off", blockedByKeys: [], dispatch: { mode: "manual" } },
        ],
      }),
    });
    expect(imported!.isError).toBeUndefined();
    const r = await orch.instantiateWorkflow("wf_test", {});
    expect(r).toMatchObject({ ok: true, taskCount: 3, dispatched: 1 });
    await new Promise((res) => setTimeout(res, 20)); // exec finalization is fire-and-forget
    expect(calls).toEqual([{ command: ["true"] }]);
    expect(logs.some((l) => l.includes('spawn task "agent" left ready'))).toBe(true);

    const missing = await orch.instantiateWorkflow("wf_missing", {});
    expect(missing.ok).toBe(false);

    const tick = await orch.tick();
    expect(tick.scanned).toBe(0);
    expect(orch.status()).toMatchObject({ scheduler: "off", ticks: 1, lastTickError: null });
    expect((orch.status().lastTick as { scanned: number }).scanned).toBe(0);
  });

  it("surfaces an exec runner that throws through the dispatcher log", async () => {
    const { orch, logs } = make({
      execRun: async () => {
        throw new Error("boom");
      },
    });
    await orch.execute("tasks", {
      action: "workflow_import",
      workflowJson: JSON.stringify({
        id: "wf_boom", name: "b", description: "d", variables: [],
        steps: [{ stepKey: "run", name: "run", promptTemplate: "x", blockedByKeys: [], dispatch: { mode: "exec", command: ["false"] } }],
      }),
    });
    const r = await orch.instantiateWorkflow("wf_boom", {});
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
  });

  it("maps debug to info for the three-level logger", () => {
    expect(normalizeLevel("debug")).toBe("info");
    expect(normalizeLevel("warn")).toBe("warn");
  });

  it("has no spawn engine yet", async () => {
    await expect(unsupportedSpawn()).rejects.toThrow(/spawn dispatch is not available/);
  });

  it("starts and stops the scheduler with injected timers, idempotently, and records tick errors", async () => {
    const { orch, logs } = make();
    let cb: (() => void) | null = null;
    let cleared = 0;
    const fakeSet = ((fn: () => void) => {
      cb = fn;
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    const fakeClear = (() => {
      cleared++;
    }) as unknown as typeof clearInterval;
    orch.startScheduler(1000, fakeSet);
    orch.startScheduler(1000, fakeSet); // no-op
    expect(orch.status().scheduler).toBe("on");
    expect(logs.some((l) => l.includes("single-ticker rule"))).toBe(true);
    cb!();
    await new Promise((res) => setTimeout(res, 20));
    expect(orch.status().ticks).toBe(1);

    // make the next tick fail
    (orch as unknown as { tick: () => Promise<never> }).tick = async () => {
      throw new Error("tick exploded");
    };
    cb!();
    await new Promise((res) => setTimeout(res, 20));
    expect(orch.status().lastTickError).toBe("tick exploded");
    expect(logs.some((l) => l.includes("tick failed: tick exploded"))).toBe(true);

    orch.stopScheduler(fakeClear);
    orch.stopScheduler(fakeClear); // no-op
    expect(cleared).toBe(1);
    expect(orch.status().scheduler).toBe("off");
  });

  it("uses real timers when none are injected", () => {
    const { orch } = make();
    orch.startScheduler(60_000);
    expect(orch.status().scheduler).toBe("on");
    orch.stopScheduler();
    expect(orch.status().scheduler).toBe("off");
  });

  it("wires the default execRun and the real filesystem when no seams are given", () => {
    dir = mkdtempSync(join(tmpdir(), "bh-orch-"));
    const db = openBrainDb(join(dir, "brain.db"), (p) => new DatabaseSync(p));
    const orch = new Orchestrator({ db, wikiRoot: dir, log: () => {}, stallThresholdMs: 1000 });
    expect(orch.tools.size).toBeGreaterThan(0);
  });

  it("lints enabled schedules with spawn steps: warns at startup, lists them on status, and the tick leaves their tasks ready", async () => {
    let now = 1_700_000_000_000;
    const { orch, logs, db } = make({
      now: () => now,
      execRun: async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "", stderr: "" }),
    });
    const importWf = (id: string, stepKey: string, dispatch: Record<string, unknown>) =>
      orch.execute("tasks", {
        action: "workflow_import",
        workflowJson: JSON.stringify({
          id, name: id, description: "d", variables: [],
          steps: [{ stepKey, name: stepKey, promptTemplate: "go", blockedByKeys: [], dispatch }],
        }),
      });
    expect((await importWf("wf_spawn", "agent", { mode: "spawn", agentId: "claude-code-cli" }))!.isError).toBeUndefined();
    expect((await importWf("wf_exec", "run", { mode: "exec", command: ["true"] }))!.isError).toBeUndefined();
    const add = (templateId: string, scheduleName: string) =>
      orch.execute("tasks", { action: "schedule_add", templateId, cronExpr: "0 4 * * *", scheduleName });
    expect((await add("wf_spawn", "roadmap"))!.isError).toBeUndefined();
    expect((await add("wf_exec", "exec-only"))!.isError).toBeUndefined();
    expect((await add("wf_spawn", "roadmap-off"))!.isError).toBeUndefined();
    const offId = (db.prepare("SELECT id FROM schedules WHERE name = ?").get("roadmap-off") as { id: string }).id;
    expect((await orch.execute("tasks", { action: "schedule_disable", scheduleId: offId }))!.isError).toBeUndefined();

    // The constructor linted an empty db; the explicit lint finds exactly the enabled spawn schedule.
    expect(logs.filter((l) => l.includes("has spawn step(s)"))).toHaveLength(0);
    const findings = orch.lintSpawnSchedules();
    expect(findings).toEqual([{ scheduleId: expect.any(String), scheduleName: "roadmap", workflowId: "wf_spawn", stepKeys: ["agent"] }]);
    expect(logs.filter((l) => l.startsWith('warn: schedule "roadmap"') && l.includes("schedule_disable"))).toHaveLength(1);
    expect(orch.status().spawnSchedules).toEqual(findings);

    // A fresh mount over the same brain.db warns at startup and exposes the finding on status (/health).
    const logs2: string[] = [];
    const orch2 = new Orchestrator({
      db, wikiRoot: dir, log: (l, m) => logs2.push(`${l}: ${m}`), stallThresholdMs: 60_000, exists: () => false, readFile: () => "", now: () => now,
    });
    expect(logs2.filter((l) => l.startsWith('warn: schedule "roadmap"') && l.includes("wf_spawn"))).toHaveLength(1);
    expect(orch2.status().spawnSchedules).toEqual(findings);

    // Past the next fire: both enabled schedules instantiate; the exec task completes, the spawn task is left ready.
    now += 2 * 86_400_000;
    const tick = await orch.tick();
    expect(tick.instantiated).toBe(2);
    await new Promise((res) => setTimeout(res, 20));
    const rows = db.prepare("SELECT name, status FROM tasks").all() as { name: string; status: string }[];
    expect(Object.fromEntries(rows.map((r) => [r.name, r.status]))).toEqual({ agent: "ready", run: "completed" });
    expect(logs.some((l) => l.includes('spawn task "agent" left ready'))).toBe(true);
    expect(orch.status().spawnSchedules).toEqual(findings);

    // Disabling the schedule clears the finding on the next tick without a restart.
    expect((await orch.execute("tasks", { action: "schedule_disable", scheduleId: findings[0]!.scheduleId }))!.isError).toBeUndefined();
    await orch.tick();
    expect(orch.status().spawnSchedules).toEqual([]);
  });
});
