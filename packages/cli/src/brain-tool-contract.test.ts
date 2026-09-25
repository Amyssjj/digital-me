/**
 * Cross-package contract test: every action / enum value the MCP proxy
 * actually advertises (`TOOLS` from @digital-me/brain-mcp-proxy) — and every
 * enum in the openclaw typebox schemas — is accepted by the real
 * brain-orchestrator tools. Lives in cli because cli is the one package that
 * already depends on the proxy, brain-orchestrator and runtime-openclaw, so
 * the test sees both sides without adding a dependency edge.
 *
 * This fails if anyone advertises an action or enum value without a handler,
 * whether by extending the shared @digital-me/contracts arrays or by
 * hand-writing a literal into a schema.
 */

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENTS_MIGRATIONS,
  buildBrainOrchestratorTools,
  createAgentsStore,
  createGoalsStore,
  createLearningsStore,
  createM1EventsStore,
  createSchedulesStore,
  createTasksStore,
  createTracesStore,
  createWorkflowsStore,
  GOALS_MIGRATIONS,
  LEARNINGS_MIGRATIONS,
  M1_EVENTS_MIGRATIONS,
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
  SCHEDULES_MIGRATIONS,
  TASKS_MIGRATIONS,
  TRACES_MIGRATIONS,
  WORKFLOWS_MIGRATIONS,
  type BrainTool,
  type Migration,
} from "@digital-me/brain-orchestrator";
import { TOOLS } from "@digital-me/brain-mcp-proxy";
import { TOOL_SCHEMAS } from "@digital-me/runtime-openclaw";

const require = createRequire(import.meta.url);
const { DatabaseSync: Db } = require("node:sqlite") as typeof import("node:sqlite");

let db: DatabaseSync;

beforeEach(() => {
  db = new Db(":memory:");
  resetMigrationRegistryForTests();
  for (const m of [
    ...GOALS_MIGRATIONS,
    ...TASKS_MIGRATIONS,
    ...WORKFLOWS_MIGRATIONS,
    ...SCHEDULES_MIGRATIONS,
    ...AGENTS_MIGRATIONS,
    ...LEARNINGS_MIGRATIONS,
    ...TRACES_MIGRATIONS,
    ...M1_EVENTS_MIGRATIONS,
  ] as Migration[]) {
    registerMigration(m);
  }
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function brainTools(): Map<string, BrainTool> {
  let n = 0;
  const tools = buildBrainOrchestratorTools({
    db,
    goals: createGoalsStore({ db }),
    tasks: createTasksStore({ db }),
    workflows: createWorkflowsStore({ db }),
    schedules: createSchedulesStore({ db }),
    agents: createAgentsStore({ db }),
    learnings: createLearningsStore({ db }),
    traces: createTracesStore({ db }),
    m1Events: createM1EventsStore({ db }),
    runtime: { log() {} },
    dispatcher: {
      dispatchSpawnTask: async () => true,
      dispatchExecTask: async () => true,
      probeSessionLiveness: async () => [],
    },
    now: () => 1000,
    newId: () => `id-${++n}`,
  });
  return new Map(tools.map((t) => [t.name, t]));
}

type EnumProp = { enum?: readonly string[] };

/**
 * For each brain-orchestrator tool: the enum-typed parameter to sweep, plus
 * the minimal other params the handler needs so that a rejection can only
 * mean "this enum value isn't served".
 */
const SWEEPS: Record<string, { param: string; base: Record<string, unknown> }> = {
  tasks: { param: "action", base: {} },
  traces_record: { param: "kind", base: { agent_id: "a", payload: "{}" } },
  traces_query: { param: "kind", base: {} },
  learning_capture: { param: "kind", base: { agent_id: "a", text: "t" } },
  m1_event_record: {
    param: "event_type",
    base: { runtime: "claude-code", agent_id: "a", session_id: "s", turn_id: "1" },
  },
};

/** Proxy tool name → its enum values for the swept param. */
function proxyEnum(tool: string, param: string): readonly string[] {
  const t = TOOLS.find((x) => x.name === tool);
  const values = (t?.inputSchema.properties as Record<string, EnumProp> | undefined)?.[param]?.enum;
  expect(values, `proxy ${tool}.${param} must declare an enum`).toBeDefined();
  return values!;
}

function openclawEnum(tool: string, param: string): readonly string[] {
  const schema = (TOOL_SCHEMAS as Record<string, unknown>)[tool] as {
    properties: Record<string, EnumProp>;
  };
  const values = schema.properties[param]?.enum;
  expect(values, `openclaw ${tool}.${param} must declare an enum`).toBeDefined();
  return values!;
}

async function accepted(tool: string, params: Record<string, unknown>): Promise<string | undefined> {
  const r = await brainTools().get(tool)!.execute(params);
  const text = r.content.map((c) => c.text).join("\n");
  // tasks handlers may reject missing params; only "Unknown action" means unrouted.
  if (tool === "tasks") return /Unknown action/.test(text) ? text : undefined;
  return r.isError ? text : undefined;
}

describe("proxy-advertised tools are all served by brain-orchestrator", () => {
  it("every brain-orchestrator tool is advertised by the proxy and the openclaw schemas", () => {
    const proxyNames = new Set(TOOLS.map((t) => t.name));
    for (const name of brainTools().keys()) {
      expect(proxyNames.has(name as never), `proxy missing ${name}`).toBe(true);
      expect(name in TOOL_SCHEMAS, `openclaw schema missing ${name}`).toBe(true);
    }
  });

  for (const [tool, { param, base }] of Object.entries(SWEEPS)) {
    it(`proxy ${tool}.${param}: every advertised value is accepted`, async () => {
      for (const value of proxyEnum(tool, param)) {
        expect(await accepted(tool, { ...base, [param]: value }), `${tool}.${param}=${value}`).toBeUndefined();
      }
    });

    it(`openclaw ${tool}.${param} matches the proxy exactly`, () => {
      expect(openclawEnum(tool, param)).toEqual(proxyEnum(tool, param));
    });

    it(`brain rejects a ${tool}.${param} value the proxy does not advertise`, async () => {
      expect(await accepted(tool, { ...base, [param]: "not_advertised" })).toBeDefined();
    });
  }
});
