/**
 * Process entry point — wires the tested modules to the @modelcontextprotocol
 * SDK and the host process (stdio, signals, ppid watcher). This file is the
 * integration layer; its branches are exercised only end-to-end and are
 * excluded from unit coverage by vitest.config.ts.
 */

import { homedir } from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "@digital-me/contracts";
import { loadGatewayConfig, resolveDefaultAgentId } from "./config.js";
import { invokeGatewayTool } from "./gateway.js";
import { createCallToolHandler } from "./handler.js";
import { startParentPidWatcher } from "./lifecycle.js";
import { TOOLS } from "./tools.js";
import {
  createSqliteTraceWriter,
  defaultBrainDbPath,
} from "./trace-writer.js";
import {
  createAppRateWriter,
  defaultLogPathForAgent,
} from "./app-rate-writer.js";

// One hour. Long enough to cover legitimate `tasks.run_workflow` / `tasks.run_goal`
// dispatches that await multi-step exec sequences. Short enough to cap genuinely
// stuck calls. See the upstream proxy for the original motivation.
const GATEWAY_TIMEOUT_MS = 60 * 60_000;
// 5s poll for parent-PID death.
const PPID_POLL_MS = 5_000;

function emitStderr(line: string): void {
  process.stderr.write(line + "\n");
}

let appRateShutdownHook: (() => void) | null = null;

function exitProxy(reason: string, code = 0): never {
  emitStderr(`openclaw-brain MCP proxy: ${reason}, exiting (${code})`);
  try {
    appRateShutdownHook?.();
  } catch {
    // best-effort
  }
  process.exit(code);
}

export async function main(): Promise<void> {
  // brain-mcp-proxy only needs OPENCLAW_HOME (to find openclaw.json) plus
  // gateway env vars. It does NOT need DIGITAL_ME_HOME — that belongs to
  // wiki-touching packages. Override the required set accordingly.
  const contracts = loadConfig(process.env, {
    requireOverride: ["OPENCLAW_HOME"],
  });
  const gateway = loadGatewayConfig({
    env: process.env,
    openclawHome: contracts.OPENCLAW_HOME,
  });
  const defaultAgentId = resolveDefaultAgentId({
    env: process.env,
    argv: process.argv.slice(2),
  });

  const server = new Server(
    { name: "openclaw-brain", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Observability: write one trace row per tool call to brain.db.
  // Universal chokepoint for all MCP-routed openclaw-brain traffic
  // (Codex, Claude Code, Hermes). Override via BRAIN_DB_PATH env.
  const brainDbPath =
    process.env.BRAIN_DB_PATH ?? defaultBrainDbPath(homedir());
  const traceWriter = createSqliteTraceWriter({
    brainDbPath,
    warn: emitStderr,
  });

  // M1 application_rate: observe memory_search (surfaced) + memory_get
  // (accessed) at this chokepoint and flush JSONL records to the runtime
  // log files the dashboard intake reads. Self-contained fallback for the
  // openclaw + hermes runtimes where gateway-hook dispatch is unreliable.
  // See wiki: infrastructure/m1-application-rate-openclaw-hermes-hook-lifecycle.md
  const openclawLog = path.join(
    homedir(),
    ".openclaw",
    "data",
    "application_rate_openclaw.log",
  );
  const hermesLog = path.join(
    homedir(),
    ".openclaw",
    "data",
    "application_rate_hermes.log",
  );
  const appRateWriter = createAppRateWriter({
    logPathForAgent: (agentId) =>
      defaultLogPathForAgent(agentId, { openclawLog, hermesLog }),
    warn: emitStderr,
  });
  appRateShutdownHook = () => appRateWriter.shutdown();

  const handle = createCallToolHandler({
    invokeFn: (input) =>
      invokeGatewayTool({
        toolName: input.toolName,
        args: input.args,
        gateway: { url: gateway.url, token: gateway.token },
        fetchFn: globalThis.fetch,
        timeoutMs: GATEWAY_TIMEOUT_MS,
      }),
    defaultAgentId,
    log: emitStderr,
    traceWriter,
    appRateWriter,
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handle({ name: req.params.name, arguments: req.params.arguments }),
  );

  // Lifecycle: signals + stdin EOF + ppid watcher.
  process.on("SIGINT", () => exitProxy("received SIGINT"));
  process.on("SIGTERM", () => exitProxy("received SIGTERM"));
  process.on("SIGHUP", () => exitProxy("received SIGHUP"));
  process.stdin.on("end", () => exitProxy("stdin EOF"));
  process.stdin.on("close", () => exitProxy("stdin closed"));

  const initialPpid = process.ppid;
  startParentPidWatcher({
    initialPpid,
    readPpid: () => process.ppid,
    pollMs: PPID_POLL_MS,
    onParentDied: (info) =>
      exitProxy(
        `parent died (ppid was ${info.initialPpid}, now ${info.currentPpid})`,
      ),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  emitStderr(
    `openclaw-brain MCP proxy started (gateway: ${gateway.host}:${gateway.port}, parent pid: ${initialPpid}, agent_id default: ${defaultAgentId ?? "(unset)"})`,
  );

  // Silence the "value computed not used" lint by referencing for clarity.
  void path;
  void homedir;
}
