/**
 * HTTP transport entry point — wires the tested modules to node:http and the
 * host process (signals, long-lived service lifecycle). Like server.ts, this
 * file is the integration layer; its branches are exercised only end-to-end
 * and are excluded from unit coverage by vitest.config.ts.
 *
 * Contrast with the stdio entry (server.ts):
 *   - long-lived service (launchd/systemd), NOT spawned per client session —
 *     so no stdin-EOF or parent-pid watchers here;
 *   - one shared trace writer + app-rate writer across all remote clients;
 *   - per-request agent-id attribution (X-Agent-Id header / agent_id query)
 *     instead of one process-wide OPENCLAW_AGENT_ID.
 */

import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfig } from "@digital-me/contracts";
import {
  createAppRateWriter,
  defaultLogPathForAgent,
} from "./app-rate-writer.js";
import { loadGatewayConfig } from "./config.js";
import { invokeGatewayTool } from "./gateway.js";
import { createCallToolHandler } from "./handler.js";
import { createRequestListener, MCP_PATH } from "./http-app.js";
import { isLoopbackHost, loadHttpConfig } from "./http-config.js";
import {
  createSqliteTraceWriter,
  defaultBrainDbPath,
} from "./trace-writer.js";

// Same cap as the stdio transport — long enough for legitimate
// tasks.run_workflow / tasks.run_goal dispatches, short enough to bound
// genuinely stuck calls.
const GATEWAY_TIMEOUT_MS = 60 * 60_000;

function emitStderr(line: string): void {
  process.stderr.write(line + "\n");
}

export async function mainHttp(): Promise<void> {
  const contracts = loadConfig(process.env, {
    requireOverride: ["OPENCLAW_HOME"],
  });
  const gateway = loadGatewayConfig({
    env: process.env,
    openclawHome: contracts.OPENCLAW_HOME,
  });
  const httpConfig = loadHttpConfig({ env: process.env });

  const brainDbPath =
    process.env.BRAIN_DB_PATH ?? defaultBrainDbPath(homedir());
  const traceWriter = createSqliteTraceWriter({
    brainDbPath,
    warn: emitStderr,
  });

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

  const listener = createRequestListener({
    token: httpConfig.token,
    maxBodyBytes: httpConfig.maxBodyBytes,
    defaultAgentId: httpConfig.defaultAgentId,
    log: emitStderr,
    createToolHandler: (agentId) =>
      createCallToolHandler({
        invokeFn: (input) =>
          invokeGatewayTool({
            toolName: input.toolName,
            args: input.args,
            gateway: { url: gateway.url, token: gateway.token },
            fetchFn: globalThis.fetch,
            timeoutMs: GATEWAY_TIMEOUT_MS,
          }),
        defaultAgentId: agentId,
        log: emitStderr,
        traceWriter,
        appRateWriter,
      }),
  });

  const server = http.createServer(listener);

  const shutdown = (reason: string): void => {
    emitStderr(`openclaw-brain MCP HTTP transport: ${reason}, shutting down`);
    server.close();
    try {
      appRateWriter.shutdown();
    } catch {
      // best-effort
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("received SIGINT"));
  process.on("SIGTERM", () => shutdown("received SIGTERM"));
  process.on("SIGHUP", () => shutdown("received SIGHUP"));

  server.listen(httpConfig.port, httpConfig.host, () => {
    emitStderr(
      `openclaw-brain MCP HTTP transport listening on ` +
        `http://${httpConfig.host}:${httpConfig.port}${MCP_PATH} ` +
        `(gateway: ${gateway.host}:${gateway.port}, default agent_id: ` +
        `${httpConfig.defaultAgentId ?? "(unset — clients should send X-Agent-Id)"})`,
    );
    if (!isLoopbackHost(httpConfig.host)) {
      emitStderr(
        "WARNING: bound to a non-loopback interface. The full brain tool " +
          "surface (including task dispatch, which can execute work on this " +
          "machine) is reachable from the network with the bearer token. " +
          "Prefer a private overlay network (WireGuard/Tailscale) over raw " +
          "LAN exposure, and never port-forward this endpoint.",
      );
    }
  });
}
