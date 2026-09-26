/**
 * Contract test: every action / enum value in the shared brain-tool
 * vocabulary (@digital-me/contracts) — which the MCP proxy and the openclaw
 * schemas advertise verbatim — is accepted by the brain's router and
 * handlers, and values outside the vocabulary are rejected.
 *
 * If someone adds an action to TASKS_ACTIONS (or a kind to TRACE_KINDS, …)
 * without teaching the brain to serve it, this fails. The cross-package half
 * (the proxy's actual `TOOLS` enums vs. these handlers) lives in
 * packages/cli/src/brain-tool-contract.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import {
  LEARNING_KINDS,
  M1_EVENT_TYPES,
  PROXY_TRACE_KIND,
  TASKS_ACTIONS,
  TRACE_KINDS,
} from "@digital-me/contracts";
import { AGENTS_MIGRATIONS, createAgentsStore } from "../store/agents.js";
import { createGoalsStore, GOALS_MIGRATIONS } from "../store/goals.js";
import {
  createLearningsStore,
  LEARNINGS_MIGRATIONS,
} from "../store/learnings.js";
import {
  createM1EventsStore,
  M1_EVENT_TYPES_V1,
  M1_EVENTS_MIGRATIONS,
} from "../store/m1-events.js";
import {
  createSchedulesStore,
  SCHEDULES_MIGRATIONS,
} from "../store/schedules.js";
import { createTasksStore, TASKS_MIGRATIONS } from "../store/tasks.js";
import { createTracesStore, TRACES_MIGRATIONS } from "../store/traces.js";
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
import { VALID_LEARNING_KINDS } from "../handlers/learnings.js";
import { VALID_TRACE_KINDS } from "../handlers/traces.js";
import {
  buildBrainOrchestratorTools,
  type BrainOrchestratorPluginDeps,
  type BrainTool,
} from "./entry.js";
import { TASKS_ACTIONS as ROUTER_TASKS_ACTIONS } from "./router.js";

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

function tools(): Map<string, BrainTool> {
  let counter = 0;
  const deps: BrainOrchestratorPluginDeps = {
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
      async dispatchSpawnTask() {
        return true;
      },
      async dispatchExecTask() {
        return true;
      },
      async probeSessionLiveness() {
        return [];
      },
    },
    now: () => 1000,
    newId: () => `id-${++counter}`,
  };
  return new Map(buildBrainOrchestratorTools(deps).map((t) => [t.name, t]));
}

function text(r: { content: readonly { text: string }[] }): string {
  return r.content.map((c) => c.text).join("\n");
}

describe("tasks: shared TASKS_ACTIONS ⇔ router", () => {
  it("the router re-exports the shared vocabulary (same array)", () => {
    expect(ROUTER_TASKS_ACTIONS).toBe(TASKS_ACTIONS);
  });

  it.each([...TASKS_ACTIONS])("serves advertised action %s", async (action) => {
    const r = await tools().get("tasks")!.execute({ action });
    // A handler may reject missing params, but must never be unrouted.
    expect(text(r)).not.toMatch(/Unknown action/);
  });

  it.each(["plan_goal", "retry", "", "nope"])(
    "rejects unadvertised action %j",
    async (action) => {
      const r = await tools().get("tasks")!.execute({ action });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Unknown action/);
    },
  );
});

describe("traces: shared TRACE_KINDS ⇔ handlers", () => {
  it("VALID_TRACE_KINDS is exactly TRACE_KINDS", () => {
    expect([...VALID_TRACE_KINDS]).toEqual([...TRACE_KINDS]);
  });

  it.each([...TRACE_KINDS])("traces_record + traces_query accept %s", async (kind) => {
    const t = tools();
    const rec = await t.get("traces_record")!.execute({
      agent_id: "a",
      kind,
      payload: "{}",
    });
    expect(rec.isError).toBeUndefined();
    const q = await t.get("traces_query")!.execute({ kind });
    expect(q.isError).toBeUndefined();
    const rows = (q.details as { json: { traces: { kind: string }[] } }).json.traces;
    expect(rows.map((r) => r.kind)).toContain(kind);
  });

  it("the proxy's own trace kind is queryable", () => {
    expect(VALID_TRACE_KINDS.has(PROXY_TRACE_KIND)).toBe(true);
  });

  it("rejects an unknown kind", async () => {
    const q = await tools().get("traces_query")!.execute({ kind: "bogus" });
    expect(q.isError).toBe(true);
  });
});

describe("learning_capture: shared LEARNING_KINDS ⇔ handler", () => {
  it("VALID_LEARNING_KINDS is exactly LEARNING_KINDS", () => {
    expect([...VALID_LEARNING_KINDS]).toEqual([...LEARNING_KINDS]);
  });

  it.each([...LEARNING_KINDS])("accepts %s", async (kind) => {
    const r = await tools().get("learning_capture")!.execute({
      agent_id: "a",
      kind,
      text: "t",
    });
    expect(r.isError).toBeUndefined();
  });
});

describe("m1_event_record: shared M1_EVENT_TYPES ⇔ handler", () => {
  it("M1_EVENT_TYPES_V1 is exactly M1_EVENT_TYPES", () => {
    expect([...M1_EVENT_TYPES_V1]).toEqual([...M1_EVENT_TYPES]);
  });

  it.each([...M1_EVENT_TYPES])("accepts %s", async (event_type) => {
    const r = await tools().get("m1_event_record")!.execute({
      runtime: "claude-code",
      agent_id: "a",
      session_id: "s",
      turn_id: "1",
      event_type,
    });
    expect(r.isError).toBeUndefined();
  });

  it("rejects an unknown event_type", async () => {
    const r = await tools().get("m1_event_record")!.execute({
      runtime: "claude-code",
      agent_id: "a",
      session_id: "s",
      event_type: "bogus",
    });
    expect(r.isError).toBe(true);
  });
});
