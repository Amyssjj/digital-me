import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  AGENTS_MIGRATIONS,
  GOALS_MIGRATIONS,
  LEARNINGS_MIGRATIONS,
  SCHEDULES_MIGRATIONS,
  TASKS_MIGRATIONS,
  TRACES_MIGRATIONS,
  WORKFLOWS_MIGRATIONS,
  createAgentsStore,
  createGoalsStore,
  createLearningsStore,
  createSchedulesStore,
  createTasksStore,
  createTracesStore,
  createWorkflowsStore,
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
  type BrainOrchestratorPluginDeps,
  type BrainTool,
  type Dispatcher,
  type Migration,
  type SchedulerRuntime,
} from "@digital-me/brain-orchestrator";
import { buildOpenClawBrainTools } from "./plugin-entry.js";

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
  };
}

describe("buildOpenClawBrainTools", () => {
  it("emits 5 openclaw-shaped tool descriptors with typebox parameters", () => {
    const tools = buildOpenClawBrainTools(makeDeps());
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "agent_identify",
      "learning_capture",
      "tasks",
      "traces_query",
      "traces_record",
    ]);
    for (const t of tools) {
      expect(t.parameters).toBeDefined();
      expect(typeof t.execute).toBe("function");
    }
  });

  it("'tasks' parameters schema has the canonical action property", () => {
    const tasksTool = buildOpenClawBrainTools(makeDeps()).find(
      (t) => t.name === "tasks",
    )!;
    const schema = tasksTool.parameters as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties).toBeDefined();
    expect(schema.properties.action).toBeDefined();
    expect(schema.properties.templateId).toBeDefined();
  });

  it("execute() routes the call through to the BrainTool with a record param", async () => {
    const tools = buildOpenClawBrainTools(makeDeps());
    const tasksTool = tools.find((t) => t.name === "tasks")!;
    const result = await tasksTool.execute("call-1", {
      action: "board",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("No active goals.");
  });

  it("execute() narrows non-object params to {} defensively", async () => {
    const tools = buildOpenClawBrainTools(makeDeps());
    const tasksTool = tools.find((t) => t.name === "tasks")!;
    // Passing an array or primitive — should still call into brain-orchestrator
    // with an empty record, which then reports the unknown action.
    const r1 = await tasksTool.execute("call-1", null);
    expect(r1.isError).toBe(true);
    const r2 = await tasksTool.execute("call-2", [1, 2, 3]);
    expect(r2.isError).toBe(true);
    const r3 = await tasksTool.execute("call-3", "plain-string");
    expect(r3.isError).toBe(true);
  });

  it("each tool's execute returns an MCP-shaped result", async () => {
    const deps = makeDeps();
    const tools = buildOpenClawBrainTools(deps);
    // agent_identify
    const agentTool = tools.find((t) => t.name === "agent_identify")!;
    const result = await agentTool.execute("call-a", {
      agent_id: "agent-x",
      runtime: "claude-code",
    });
    expect(result.content[0]!.type).toBe("text");
    const parsed = JSON.parse(result.content[0]!.text) as {
      ok: true;
      session_token: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.session_token).toBeDefined();
  });

  it("toOpenClawTool throws a descriptive error when no schema maps to the tool name", async () => {
    const { toOpenClawTool } = await import("./plugin-entry.js");
    const fakeTool: BrainTool = {
      name: "non_existent",
      description: "",
      async execute() {
        return { content: [{ type: "text", text: "" }], details: {} };
      },
    };
    expect(() => toOpenClawTool(fakeTool)).toThrow(
      /missing typebox schema for tool "non_existent"/,
    );
  });
});
