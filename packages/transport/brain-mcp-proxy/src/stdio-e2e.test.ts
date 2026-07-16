/**
 * End-to-end over the stdio-shaped MCP path with an in-process SDK client.
 *
 * server.ts wires the @modelcontextprotocol SDK Server to a StdioServer
 * transport in production; that integration layer is excluded from coverage.
 * This test reproduces the SAME wiring — ListTools → TOOLS, CallTool →
 * createCallToolHandler — but over an InMemoryTransport linked pair so a real
 * SDK Client drives it. It proves the widened memory_get schema reaches the
 * client and that a client's corpus:"wiki" arg forwards to the gateway
 * invoker unchanged, matching the HTTP e2e in http-app.test.ts.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "./gateway.js";
import { createCallToolHandler, type GatewayInvoker } from "./handler.js";
import { TOOLS } from "./tools.js";

// The ~789-char MEMORY.md body the agent workspace returns (abbreviated).
const AGENT_MEMORY_BODY = "# MEMORY\n- agent's own memory body\n";

/**
 * Stand-in for the openclaw HTTP gateway, matching its observed behavior:
 *   - memory_get with corpus:"wiki" → disabled:true (supplement empty on host)
 *   - memory_get for MEMORY.md (default corpus) → the agent memory body
 * Records every forwarded arg set for passthrough assertions.
 */
function fakeGateway(): { invoke: GatewayInvoker; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const invoke: GatewayInvoker = async ({ toolName, args }) => {
    calls.push({ toolName, ...args });
    if (toolName === "memory_get") {
      if (args.corpus === "wiki") {
        return jsonResult({
          path: args.path,
          text: "",
          disabled: true,
          error: "wiki corpus result not found",
        });
      }
      return jsonResult({ path: args.path, text: AGENT_MEMORY_BODY });
    }
    return { content: [{ type: "text", text: "ok" }] };
  };
  return { invoke, calls };
}

function jsonResult(obj: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

async function connect(invoke: GatewayInvoker): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = new Server(
    { name: "openclaw-brain", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  const handle = createCallToolHandler({
    invokeFn: invoke,
    defaultAgentId: "claude-code-windows",
    log: vi.fn(),
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handle({ name: req.params.name, arguments: req.params.arguments }),
  );

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "stdio-e2e", version: "0.0.0" });
  await client.connect(clientT);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("stdio transport end-to-end (in-process SDK client)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it("advertises memory_get with the widened corpus/from/lines schema", async () => {
    const { invoke } = fakeGateway();
    const { client, close } = await connect(invoke);
    cleanup = close;

    const tools = await client.listTools();
    const memoryGet = tools.tools.find((t) => t.name === "memory_get")!;
    const props = memoryGet.inputSchema.properties as Record<
      string,
      { enum?: string[]; type?: string }
    >;
    expect(memoryGet.inputSchema.required).toEqual(["path"]);
    expect(props.corpus?.enum).toEqual(["memory", "wiki", "all"]);
    expect(props.from?.type).toBe("number");
    expect(props.lines?.type).toBe("number");
  });

  it("lets a client send memory_get {path, corpus:\"wiki\"} — forwarded to the gateway unchanged", async () => {
    const { invoke, calls } = fakeGateway();
    const { client, close } = await connect(invoke);
    cleanup = close;

    const result = await client.callTool({
      name: "memory_get",
      arguments: { path: "wiki/x.md", corpus: "wiki" },
    });
    // The corpus arg reached the gateway (the whole point of the schema widen).
    expect(calls[0]).toMatchObject({
      toolName: "memory_get",
      path: "wiki/x.md",
      corpus: "wiki",
      agent_id: "claude-code-windows",
    });
    // Gateway's wiki-empty response is surfaced verbatim (a per-path miss, not
    // a transport-level failure).
    const parsed = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    ) as { disabled?: boolean; error?: string };
    expect(parsed.disabled).toBe(true);
    expect(parsed.error).toBe("wiki corpus result not found");
  });

  it("still returns the agent memory body for memory_get {path:\"MEMORY.md\"}", async () => {
    const { invoke, calls } = fakeGateway();
    const { client, close } = await connect(invoke);
    cleanup = close;

    const result = await client.callTool({
      name: "memory_get",
      arguments: { path: "MEMORY.md" },
    });
    expect(calls[0]).toMatchObject({ toolName: "memory_get", path: "MEMORY.md" });
    expect(calls[0]!.corpus).toBeUndefined();
    const parsed = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    ) as { text?: string; disabled?: boolean };
    expect(parsed.disabled).toBeUndefined();
    expect(parsed.text).toBe(AGENT_MEMORY_BODY);
  });
});
