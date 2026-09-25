/**
 * Live MCP connection to the dashboard's private brain-mcp-proxy child.
 *
 * This is the `clientFactory` that brain-client.ts's `createBrainClient`
 * takes: it spawns the proxy over stdio (spawn contract in proxy-spawn.ts)
 * and completes the MCP handshake. Reconnect-on-close and caching live in
 * brain-client.ts; this module only opens one connection per call.
 */

import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { proxyTransportParams } from "./proxy-spawn.js";

const require = createRequire(import.meta.url);

/** Spawn brain-mcp-proxy with `env` (inherited by the child, which applies
 *  its own backend precedence) and return the connected SDK client. */
export async function connectBrainProxy(env: NodeJS.ProcessEnv): Promise<Client> {
  const transport = new StdioClientTransport(
    proxyTransportParams({ env, resolve: (spec) => require.resolve(spec) }),
  );
  const client = new Client({ name: "digital-me-dashboard", version: "2.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}
