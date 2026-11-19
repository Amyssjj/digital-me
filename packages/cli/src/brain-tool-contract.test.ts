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
 *
 * It also pins the headless exec worker's tool grants: the brain tools
 * `setup`'s default `cli_exec_aliases` allow, and the ones the worker's prompt
 * tells the model to call, must name the registered server and a tool the
 * proxy serves — a headless CLI denies every tool it wasn't granted.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAIN_MCP_SERVER_NAME } from "@digital-me/contracts";
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
import { DEFAULT_WORKER_SCRIPT, TOOL_SCHEMAS } from "@digital-me/runtime-openclaw";
import { buildDefaultAliases } from "./setup.js";

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

describe("default cli_exec_aliases grant brain tools under the registered server name", () => {
  const served = new Set<string>(TOOLS.map((t) => t.name));
  const aliases = buildDefaultAliases(["claude-code", "codex"]);
  const claudePrefix = `mcp__${BRAIN_MCP_SERVER_NAME}__`;

  /** Brain tools claude-code-cli's `--allowedTools` grants, as bare tool names. */
  function claudeBrainGrants(): string[] {
    const args = aliases["claude-code-cli"]!.args;
    const value = args[args.indexOf("--allowedTools") + 1]!;
    const mcp = value.split(/[\s,]+/).filter((t) => /^mcp_/.test(t));
    for (const t of mcp) expect(t.startsWith(claudePrefix), `${t} names another server`).toBe(true);
    return mcp.map((t) => t.slice(claudePrefix.length));
  }

  it("claude-code-cli allows tasks + memory_search, each a tool the proxy serves", () => {
    const grants = claudeBrainGrants();
    expect(grants).toEqual(expect.arrayContaining(["tasks", "memory_search"]));
    for (const tool of grants) expect(served.has(tool), `proxy does not serve ${tool}`).toBe(true);
  });

  it("claude-code-cli keeps {{prompt}} out of --allowedTools' variadic list", () => {
    // `claude --allowedTools <tools...>` consumes every bare arg after it, so a
    // trailing "{{prompt}}" becomes a tool name and `claude -p` gets no prompt.
    const args = aliases["claude-code-cli"]!.args;
    const next = args[args.indexOf("--allowedTools") + 2];
    expect(next === undefined || next.startsWith("-"), `arg after the allow-list: ${next}`).toBe(true);
  });

  it("codex-cli approves tasks + memory_search on the registered server", () => {
    const tools = aliases["codex-cli"]!.args
      .filter((a) => a.startsWith("mcp_servers."))
      .map((a) => {
        const m = /^mcp_servers\.([^.]+)\.tools\.([^.]+)\./.exec(a);
        expect(m?.[1], a).toBe(BRAIN_MCP_SERVER_NAME);
        return m![2]!;
      });
    expect(tools).toEqual(expect.arrayContaining(["tasks", "memory_search"]));
    for (const tool of tools) expect(served.has(tool), `proxy does not serve ${tool}`).toBe(true);
  });

  it("every brain tool the worker's default prompt asks for is granted", () => {
    // Run the real worker with node as the CLI: it prints the rendered default
    // prompt, which includes the completion marker, so the run passes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-tool-contract-"));
    try {
      const artifactDir = path.join(dir, "artifacts");
      const specPath = path.join(dir, "spec.json");
      fs.writeFileSync(
        specPath,
        JSON.stringify({
          alias: "claude-code-cli",
          taskId: "t-1",
          goalId: "g-1",
          taskName: "contract",
          task: "contract",
          cwd: dir,
          artifactDir,
          timeoutMs: 30_000,
          binary: process.execPath,
          args: ["-e", "console.log(process.argv[1])", "{{prompt}}"],
          env: {},
        }),
      );
      const run = spawnSync(process.execPath, [DEFAULT_WORKER_SCRIPT, specPath], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      const prompt = fs.readFileSync(path.join(artifactDir, "final-message.txt"), "utf8");

      expect(prompt).toContain(`Use the ${BRAIN_MCP_SERVER_NAME} MCP server.`);
      // A tool counts as asked for when the prompt calls it (`tasks.handoff`,
      // `memory_search with …`), not whenever its name appears as an English word.
      const asked = [...served].filter((tool) => new RegExp(`\\b${tool}(?:\\.\\w+| with\\b)`).test(prompt));
      expect(asked).toEqual(expect.arrayContaining(["tasks", "memory_search"]));
      expect(claudeBrainGrants()).toEqual(expect.arrayContaining(asked));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
