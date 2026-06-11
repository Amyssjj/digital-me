import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  AGENTS_MIGRATIONS,
  createAgentsStore,
} from "../store/agents.js";
import {
  createGoalsStore,
  GOALS_MIGRATIONS,
} from "../store/goals.js";
import {
  createLearningsStore,
  LEARNINGS_MIGRATIONS,
} from "../store/learnings.js";
import {
  createSchedulesStore,
  SCHEDULES_MIGRATIONS,
} from "../store/schedules.js";
import {
  createTasksStore,
  TASKS_MIGRATIONS,
} from "../store/tasks.js";
import {
  createTracesStore,
  TRACES_MIGRATIONS,
} from "../store/traces.js";
import {
  createWorkflowsStore,
  WORKFLOWS_MIGRATIONS,
} from "../store/workflows.js";
import type { Migration } from "../store/migrations.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "../store/migrations.js";
import type {
  Dispatcher,
  SchedulerRuntime,
} from "../handlers/scheduler.js";
import {
  buildBrainOrchestratorTools,
  handleAgentIdentify,
  handleLearningCapture,
  handleTracesQuery,
  handleTracesRecord,
  type BrainOrchestratorPluginDeps,
} from "./entry.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of [
    ...GOALS_MIGRATIONS,
    ...TASKS_MIGRATIONS,
    ...WORKFLOWS_MIGRATIONS,
    ...SCHEDULES_MIGRATIONS,
    ...AGENTS_MIGRATIONS,
    ...LEARNINGS_MIGRATIONS,
    ...TRACES_MIGRATIONS,
  ] as Migration[]) {
    registerMigration(m);
  }
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function makeDeps(): BrainOrchestratorPluginDeps {
  const runtime: SchedulerRuntime = { log() {} };
  const dispatcher: Dispatcher = {
    async dispatchSpawnTask() {
      return true;
    },
    async dispatchExecTask() {
      return true;
    },
    async probeSessionLiveness() {
      return [];
    },
  };
  let counter = 0;
  return {
    db,
    goals: createGoalsStore({ db }),
    tasks: createTasksStore({ db }),
    workflows: createWorkflowsStore({ db }),
    schedules: createSchedulesStore({ db }),
    agents: createAgentsStore({ db }),
    learnings: createLearningsStore({ db }),
    traces: createTracesStore({ db }),
    runtime,
    dispatcher,
    now: () => 1000,
    newId: () => `id-${++counter}`,
  };
}

// ── buildBrainOrchestratorTools ────────────────────────────────────────────

describe("buildBrainOrchestratorTools", () => {
  it("returns the 5 expected tool descriptors", () => {
    const tools = buildBrainOrchestratorTools(makeDeps());
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "agent_identify",
      "learning_capture",
      "tasks",
      "traces_query",
      "traces_record",
    ]);
  });

  it("each tool descriptor has a description", () => {
    const tools = buildBrainOrchestratorTools(makeDeps());
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("'tasks' tool routes the action via dispatchAction (board)", async () => {
    const deps = makeDeps();
    const tools = buildBrainOrchestratorTools(deps);
    const tasksTool = tools.find((t) => t.name === "tasks")!;
    const result = await tasksTool.execute({ action: "board" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("No active goals.");
  });

  it("'tasks' tool marks unknown actions as isError", async () => {
    const tools = buildBrainOrchestratorTools(makeDeps());
    const tasksTool = tools.find((t) => t.name === "tasks")!;
    const result = await tasksTool.execute({ action: "nonsense" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Unknown action/);
  });

  it("'tasks' tool defaults action to '' (then dispatchAction reports Unknown)", async () => {
    const tools = buildBrainOrchestratorTools(makeDeps());
    const tasksTool = tools.find((t) => t.name === "tasks")!;
    const result = await tasksTool.execute({}); // no action
    expect(result.isError).toBe(true);
  });

  it("'agent_identify' end-to-end roundtrip via the tool execute", async () => {
    const deps = makeDeps();
    const tools = buildBrainOrchestratorTools(deps);
    const tool = tools.find((t) => t.name === "agent_identify")!;
    const result = await tool.execute({
      agent_id: "agent-x",
      runtime: "claude-code",
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text) as {
      ok: true;
      session_token: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.session_token).toBeDefined();
  });

  it("'learning_capture' end-to-end roundtrip", async () => {
    const deps = makeDeps();
    const tools = buildBrainOrchestratorTools(deps);
    const tool = tools.find((t) => t.name === "learning_capture")!;
    const result = await tool.execute({
      agent_id: "agent-x",
      kind: "feedback",
      text: "always use UTC",
    });
    expect(result.isError).toBeUndefined();
    expect(deps.learnings.listAll()).toHaveLength(1);
  });

  it("'traces_record' end-to-end roundtrip", async () => {
    const deps = makeDeps();
    const tools = buildBrainOrchestratorTools(deps);
    const tool = tools.find((t) => t.name === "traces_record")!;
    const result = await tool.execute({
      agent_id: "agent-x",
      kind: "tool_call",
      payload: JSON.stringify({ tool: "wiki_search" }),
    });
    expect(result.isError).toBeUndefined();
    expect(deps.traces.query({})).toHaveLength(1);
  });

  it("'traces_query' end-to-end roundtrip", async () => {
    const deps = makeDeps();
    deps.traces.create({
      id: "tr",
      agentId: "a",
      kind: "tool_call",
      payload: {},
      t: 0,
    });
    const tools = buildBrainOrchestratorTools(deps);
    const tool = tools.find((t) => t.name === "traces_query")!;
    const result = await tool.execute({});
    const parsed = JSON.parse(result.content[0]!.text) as {
      traces: unknown[];
    };
    expect(parsed.traces).toHaveLength(1);
  });
});

// ── handleAgentIdentify ────────────────────────────────────────────────────

describe("handleAgentIdentify", () => {
  it("succeeds with required fields + parses JSON capabilities", () => {
    const deps = makeDeps();
    const r = handleAgentIdentify(deps, {
      agent_id: "a",
      runtime: "r",
      version: "1.0",
      capabilities: JSON.stringify(["wiki", "tasks"]),
    });
    expect(r.ok).toBe(true);
    expect(deps.agents.get("a")!.capabilities).toEqual(["wiki", "tasks"]);
  });

  it("accepts capabilities as a plain array (no JSON parse needed)", () => {
    const deps = makeDeps();
    const r = handleAgentIdentify(deps, {
      agent_id: "a",
      runtime: "r",
      capabilities: ["x", "y", 42 /* filtered */],
    });
    expect(r.ok).toBe(true);
    expect(deps.agents.get("a")!.capabilities).toEqual(["x", "y"]);
  });

  it("returns ok=false when agent_id is missing", () => {
    const r = handleAgentIdentify(makeDeps(), { runtime: "r" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/requires agent_id and runtime/);
  });

  it("returns ok=false when runtime is missing", () => {
    const r = handleAgentIdentify(makeDeps(), { agent_id: "a" });
    expect(r.ok).toBe(false);
  });

  it("rejects malformed JSON capabilities", () => {
    const r = handleAgentIdentify(makeDeps(), {
      agent_id: "a",
      runtime: "r",
      capabilities: "{not json",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/valid JSON array/);
  });

  it("rejects capabilities JSON that's not an array", () => {
    const r = handleAgentIdentify(makeDeps(), {
      agent_id: "a",
      runtime: "r",
      capabilities: JSON.stringify({ not: "array" }),
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/JSON array/);
  });

  it("emits structured json payload + created flag", () => {
    const deps = makeDeps();
    const r = handleAgentIdentify(deps, { agent_id: "a", runtime: "r" });
    expect(r.json).toMatchObject({ created: true });
    const second = handleAgentIdentify(deps, { agent_id: "a", runtime: "r" });
    expect(second.json).toMatchObject({ created: false });
  });
});

// ── handleLearningCapture ──────────────────────────────────────────────────

describe("handleLearningCapture", () => {
  it("captures a feedback learning with required fields", () => {
    const deps = makeDeps();
    const r = handleLearningCapture(deps, {
      agent_id: "a",
      kind: "feedback",
      text: "always use UTC",
    });
    expect(r.ok).toBe(true);
    expect(deps.learnings.listAll()).toHaveLength(1);
  });

  it("forwards optional fields", () => {
    const deps = makeDeps();
    handleLearningCapture(deps, {
      agent_id: "a",
      kind: "project",
      text: "x",
      why: "y",
      apply_when: "z",
      source_context: "ctx",
      confidence: 0.7,
      proposed_wiki_path: "p/q.md",
    });
    const l = deps.learnings.listAll()[0]!;
    expect(l.why).toBe("y");
    expect(l.applyWhen).toBe("z");
    expect(l.sourceContext).toBe("ctx");
    expect(l.confidence).toBe(0.7);
    expect(l.proposedWikiPath).toBe("p/q.md");
  });

  it("returns ok=false when required fields are missing", () => {
    const r = handleLearningCapture(makeDeps(), { agent_id: "a", text: "x" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/requires agent_id, kind, and text/);
  });

  it("rejects an unknown kind", () => {
    const r = handleLearningCapture(makeDeps(), {
      agent_id: "a",
      kind: "totally-invented",
      text: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Invalid kind/);
  });
});

// ── handleTracesRecord ─────────────────────────────────────────────────────

describe("handleTracesRecord", () => {
  it("records with a JSON-string payload", () => {
    const deps = makeDeps();
    const r = handleTracesRecord(deps, {
      agent_id: "a",
      kind: "tool_call",
      payload: JSON.stringify({ tool: "x" }),
    });
    expect(r.ok).toBe(true);
    expect(deps.traces.query({})[0]!.payload).toEqual({ tool: "x" });
  });

  it("records with an object payload (no parse needed)", () => {
    const deps = makeDeps();
    handleTracesRecord(deps, {
      agent_id: "a",
      kind: "tool_call",
      payload: { tool: "x" },
    });
    expect(deps.traces.query({})[0]!.payload).toEqual({ tool: "x" });
  });

  it("defaults payload to {} when not provided", () => {
    const deps = makeDeps();
    handleTracesRecord(deps, { agent_id: "a", kind: "session_start" });
    expect(deps.traces.query({})[0]!.payload).toEqual({});
  });

  it("returns ok=false when required fields are missing", () => {
    const r = handleTracesRecord(makeDeps(), { agent_id: "a" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/requires agent_id and kind/);
  });

  it("rejects an unknown trace kind", () => {
    const r = handleTracesRecord(makeDeps(), {
      agent_id: "a",
      kind: "alien",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Invalid trace kind/);
  });

  it("rejects payload that is JSON but not an object", () => {
    const r = handleTracesRecord(makeDeps(), {
      agent_id: "a",
      kind: "tool_call",
      payload: JSON.stringify([1, 2, 3]),
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/payload must be a JSON object/);
  });

  it("rejects a directly-passed array payload (not just a stringified one)", () => {
    const deps = makeDeps();
    const r = handleTracesRecord(deps, {
      agent_id: "a",
      kind: "tool_call",
      payload: [1, 2, 3],
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/payload must be a JSON object/);
    expect(deps.traces.query({})).toHaveLength(0);
  });

  it("rejects malformed JSON payload", () => {
    const r = handleTracesRecord(makeDeps(), {
      agent_id: "a",
      kind: "tool_call",
      payload: "{not json",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/payload must be valid JSON/);
  });

  it("forwards taskId/goalId/durationMs/t when present", () => {
    const deps = makeDeps();
    handleTracesRecord(deps, {
      agent_id: "a",
      kind: "task_complete",
      payload: {},
      task_id: "t-1",
      goal_id: "g-1",
      duration_ms: 42,
      t: 5000,
    });
    const tr = deps.traces.query({})[0]!;
    expect(tr.taskId).toBe("t-1");
    expect(tr.goalId).toBe("g-1");
    expect(tr.durationMs).toBe(42);
    expect(tr.t).toBe(5000);
  });
});

// ── handleTracesQuery ──────────────────────────────────────────────────────

describe("handleTracesQuery", () => {
  it("returns all traces with no filters", () => {
    const deps = makeDeps();
    deps.traces.create({
      id: "1",
      agentId: "a",
      kind: "tool_call",
      payload: {},
      t: 0,
    });
    deps.traces.create({
      id: "2",
      agentId: "b",
      kind: "task_start",
      payload: {},
      t: 1,
    });
    const r = handleTracesQuery(deps, {});
    expect((r.json as { traces: unknown[] }).traces).toHaveLength(2);
  });

  it("forwards filters to the store (kind + agentId + since + limit)", () => {
    const deps = makeDeps();
    deps.traces.create({
      id: "1",
      agentId: "a",
      kind: "tool_call",
      payload: {},
      t: 100,
    });
    deps.traces.create({
      id: "2",
      agentId: "b",
      kind: "tool_call",
      payload: {},
      t: 200,
    });
    const r = handleTracesQuery(deps, {
      agent_id: "a",
      goal_id: "g",
      task_id: "t",
      kind: "tool_call",
      since: 50,
      limit: 10,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects an invalid kind filter", () => {
    const r = handleTracesQuery(makeDeps(), { kind: "totally-invented" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Invalid trace kind/);
  });
});
