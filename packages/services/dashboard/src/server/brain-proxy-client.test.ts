import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_RESULT_BYTES_ENV } from "@digital-me/brain-mcp-proxy";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { connectBrainProxy } from "./brain-proxy-client.js";
import { createBrainClient } from "./brain-client.js";

// A minimal newline-delimited JSON-RPC MCP server. It stands in for the node
// binary ($NODE_BIN), so it receives the resolved proxy script as argv[2] and
// echoes what it was spawned with back through a tool result.
const FAKE_SERVER = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake-brain", version: "0.0.0" },
    } });
  } else if (msg.method === "tools/call") {
    const text = JSON.stringify({
      tool: msg.params.name,
      args: msg.params.arguments,
      script: process.argv[2],
      maxResultBytes: process.env[${JSON.stringify(MAX_RESULT_BYTES_ENV)}],
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } });
  }
});
`;

let dir: string;
let fakeNode: string;
let client: Client | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-proxy-"));
  fakeNode = path.join(dir, "fake-node.cjs");
  fs.writeFileSync(fakeNode, FAKE_SERVER, { mode: 0o755 });
});

afterEach(async () => {
  await client?.close();
  client = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("connectBrainProxy", () => {
  it("spawns the workspace-resolved proxy over stdio and completes the MCP handshake", async () => {
    const env = { ...process.env, NODE_BIN: fakeNode };
    delete env["BRAIN_PROXY_PATH"];
    const brain = createBrainClient({
      clientFactory: async () => {
        client = await connectBrainProxy(env);
        return client;
      },
    });

    const result = (await brain.memorySearch("hello", { corpus: "wiki", limit: 3 })) as {
      tool: string;
      args: Record<string, unknown>;
      script: string;
      maxResultBytes: string;
    };

    expect(result.tool).toBe("memory_search");
    expect(result.args).toEqual({ query: "hello", corpus: "wiki", limit: 3 });
    // Resolved through the @digital-me/brain-mcp-proxy workspace dependency.
    expect(path.basename(result.script)).toBe("brain-mcp-proxy.mjs");
    expect(fs.existsSync(result.script)).toBe(true);
    // The dashboard spawn lifts the proxy's oversize-result guard.
    expect(result.maxResultBytes).toBe("0");
    expect(brain.isConnected()).toBe(true);
  });
});
