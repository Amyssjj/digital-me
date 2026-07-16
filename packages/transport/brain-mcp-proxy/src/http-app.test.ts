import http from "node:http";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "./gateway.js";
import {
  createRequestListener,
  handleMcpRequest,
  readJsonBody,
  type RequestListenerDeps,
} from "./http-app.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

type RecordedCall = {
  agentId: string | undefined;
  name: string;
  args: Record<string, unknown> | undefined;
};

function makeDeps(overrides?: Partial<RequestListenerDeps>): {
  deps: RequestListenerDeps;
  calls: RecordedCall[];
  logs: string[];
} {
  const calls: RecordedCall[] = [];
  const logs: string[] = [];
  const deps: RequestListenerDeps = {
    token: TOKEN,
    maxBodyBytes: 1024 * 1024,
    defaultAgentId: "remote-default",
    createToolHandler: (agentId) => async (req) => {
      calls.push({ agentId, name: req.name, args: req.arguments });
      const result: CallToolResult = {
        content: [{ type: "text", text: `handled:${req.name}` }],
      };
      return result;
    },
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, calls, logs };
}

// ─── readJsonBody ───────────────────────────────────────────────────────────

describe("readJsonBody", () => {
  function streamWith(payload: string): IncomingMessage {
    const stream = new PassThrough();
    stream.end(payload);
    return stream as unknown as IncomingMessage;
  }

  it("parses a valid JSON body", async () => {
    const result = await readJsonBody(streamWith('{"a":1}'), 1024);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects an empty body", async () => {
    const result = await readJsonBody(streamWith(""), 1024);
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "empty request body",
    });
  });

  it("rejects malformed JSON", async () => {
    const result = await readJsonBody(streamWith("{nope"), 1024);
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a body over the byte cap with 413", async () => {
    const result = await readJsonBody(streamWith("x".repeat(64)), 10);
    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it("maps a stream error to 400", async () => {
    const stream = new PassThrough();
    const pending = readJsonBody(stream as unknown as IncomingMessage, 1024);
    stream.emit("error", new Error("boom"));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) {
      expect(result.message).toContain("boom");
    }
  });

  it("stringifies non-Error stream failures", async () => {
    const stream = new PassThrough();
    const pending = readJsonBody(stream as unknown as IncomingMessage, 1024);
    stream.emit("error", "raw-string-failure" as unknown as Error);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) {
      expect(result.message).toContain("raw-string-failure");
    }
  });
});

// ─── handleMcpRequest edge branches (fake req/res) ─────────────────────────

class FakeRes {
  statusCode: number | null = null;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;
  ended = false;
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers ?? {};
    this.headersSent = true;
    return this;
  }
  end(chunk?: string): this {
    if (chunk !== undefined) this.body = chunk;
    this.ended = true;
    return this;
  }
  on(): this {
    return this;
  }
}

function fakeReq(input: {
  url?: string | undefined;
  method: string;
  headers?: Record<string, string | string[]>;
  body?: string;
}): IncomingMessage {
  const stream = new PassThrough();
  if (input.body !== undefined) {
    stream.end(input.body);
  } else {
    stream.end();
  }
  const req = stream as unknown as IncomingMessage & {
    url: string | undefined;
    method: string;
    headers: Record<string, string | string[]>;
  };
  req.url = input.url;
  req.method = input.method;
  req.headers = input.headers ?? {};
  return req;
}

function parsedError(res: FakeRes): { code: number; message: string } {
  return (JSON.parse(res.body) as { error: { code: number; message: string } })
    .error;
}

describe("handleMcpRequest routing, auth, and failure paths", () => {
  it("serves /healthz without auth", async () => {
    const { deps } = makeDeps();
    const res = new FakeRes();
    await handleMcpRequest(
      deps,
      fakeReq({ url: "/healthz", method: "GET" }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("rejects non-GET on /healthz", async () => {
    const { deps } = makeDeps();
    const res = new FakeRes();
    await handleMcpRequest(
      deps,
      fakeReq({ url: "/healthz", method: "POST" }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET");
  });

  it("404s unknown paths (including a missing url)", async () => {
    const { deps } = makeDeps();
    const resUnknown = new FakeRes();
    await handleMcpRequest(
      deps,
      fakeReq({ url: "/nope", method: "POST" }),
      resUnknown as unknown as ServerResponse,
    );
    expect(resUnknown.statusCode).toBe(404);

    const resNoUrl = new FakeRes();
    await handleMcpRequest(
      deps,
      fakeReq({ url: undefined, method: "POST" }),
      resNoUrl as unknown as ServerResponse,
    );
    expect(resNoUrl.statusCode).toBe(404);
  });

  it("405s non-POST methods on /mcp with an Allow header", async () => {
    const { deps } = makeDeps();
    for (const method of ["GET", "DELETE"]) {
      const res = new FakeRes();
      await handleMcpRequest(
        deps,
        fakeReq({ url: "/mcp", method }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers.Allow).toBe("POST");
    }
  });

  it("401s a missing bearer token with WWW-Authenticate", async () => {
    const { deps } = makeDeps();
    const res = new FakeRes();
    await handleMcpRequest(
      deps,
      fakeReq({ url: "/mcp", method: "POST" }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toBe("Bearer");
  });

  it("401s a wrong token", async () => {
    const { deps } = makeDeps();
    const res = new FakeRes();
    await handleMcpRequest(
      deps,
      fakeReq({
        url: "/mcp",
        method: "POST",
        headers: { authorization: "Bearer wrong-token-wrong-token" },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
  });

  it("400s an invalid agent id", async () => {
    const { deps } = makeDeps();
    const res = new FakeRes();
    await handleMcpRequest(
      deps,
      fakeReq({
        url: "/mcp",
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-agent-id": "bad agent!",
        },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    expect(parsedError(res).message).toMatch(/invalid agent id/);
  });

  it("400s malformed JSON and 413s an oversized body", async () => {
    const { deps } = makeDeps({ maxBodyBytes: 32 });
    const bad = new FakeRes();
    await handleMcpRequest(
      deps,
      fakeReq({
        url: "/mcp",
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "{nope",
      }),
      bad as unknown as ServerResponse,
    );
    expect(bad.statusCode).toBe(400);

    const big = new FakeRes();
    await handleMcpRequest(
      deps,
      fakeReq({
        url: "/mcp",
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "x".repeat(64),
      }),
      big as unknown as ServerResponse,
    );
    expect(big.statusCode).toBe(413);
  });

  it("500s and logs when the handler factory throws before headers are sent", async () => {
    const { deps, logs } = makeDeps({
      createToolHandler: () => {
        throw new Error("factory exploded");
      },
    });
    const res = new FakeRes();
    await handleMcpRequest(
      deps,
      fakeReq({
        url: "/mcp",
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(500);
    expect(logs.join("\n")).toContain("factory exploded");
  });

  it("ends the response without rewriting headers when they were already sent", async () => {
    const { deps, logs } = makeDeps({
      createToolHandler: () => {
        throw "string-failure";
      },
    });
    const res = new FakeRes();
    res.headersSent = true;
    await handleMcpRequest(
      deps,
      fakeReq({
        url: "/mcp",
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBeNull();
    expect(res.ended).toBe(true);
    expect(logs.join("\n")).toContain("string-failure");
  });
});

// ─── end-to-end over real HTTP with the SDK client ─────────────────────────

describe("streamable HTTP end-to-end", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function startServer(deps: RequestListenerDeps): Promise<number> {
    server = http.createServer(createRequestListener(deps));
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve()),
    );
    return (server!.address() as AddressInfo).port;
  }

  async function connectClient(
    port: number,
    options?: { headers?: Record<string, string>; query?: string },
  ): Promise<Client> {
    const client = new Client({ name: "e2e-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp${options?.query ?? ""}`),
      {
        requestInit: {
          headers: {
            authorization: `Bearer ${TOKEN}`,
            ...options?.headers,
          },
        },
      },
    );
    await client.connect(transport);
    return client;
  }

  it("initializes, lists tools, and attributes calls to the X-Agent-Id header", async () => {
    const { deps, calls } = makeDeps();
    const port = await startServer(deps);
    const client = await connectClient(port, {
      headers: { "x-agent-id": "windows-codex" },
    });

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("memory_search");

    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "remote access" },
    });
    expect(result.content).toEqual([
      { type: "text", text: "handled:memory_search" },
    ]);
    expect(calls).toEqual([
      {
        agentId: "windows-codex",
        name: "memory_search",
        args: { query: "remote access" },
      },
    ]);
    await client.close();
  });

  it("attributes via the agent_id query param when no header is set", async () => {
    const { deps, calls } = makeDeps();
    const port = await startServer(deps);
    const client = await connectClient(port, {
      query: "?agent_id=windows-claude",
    });
    await client.callTool({ name: "memory_get", arguments: { id: "x" } });
    expect(calls[0]?.agentId).toBe("windows-claude");
    await client.close();
  });

  it("falls back to the configured default agent id", async () => {
    const { deps, calls } = makeDeps();
    const port = await startServer(deps);
    const client = await connectClient(port);
    await client.callTool({ name: "memory_get", arguments: { id: "x" } });
    expect(calls[0]?.agentId).toBe("remote-default");
    await client.close();
  });

  it("supports concurrent clients with distinct identities (no session cross-talk)", async () => {
    const { deps, calls } = makeDeps();
    const port = await startServer(deps);
    const [codex, claude] = await Promise.all([
      connectClient(port, { headers: { "x-agent-id": "win-codex" } }),
      connectClient(port, { headers: { "x-agent-id": "win-claude" } }),
    ]);
    await Promise.all([
      codex.callTool({ name: "memory_get", arguments: { id: "a" } }),
      claude.callTool({ name: "memory_get", arguments: { id: "b" } }),
    ]);
    const byAgent = new Map(calls.map((c) => [c.args?.id, c.agentId]));
    expect(byAgent.get("a")).toBe("win-codex");
    expect(byAgent.get("b")).toBe("win-claude");
    await Promise.all([codex.close(), claude.close()]);
  });

  it("rejects unauthenticated and wrongly-authenticated raw requests", async () => {
    const { deps, calls } = makeDeps();
    const port = await startServer(deps);
    const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    });
    expect(noAuth.status).toBe(401);
    const wrongAuth = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-the-right-token",
      },
      body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    });
    expect(wrongAuth.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
