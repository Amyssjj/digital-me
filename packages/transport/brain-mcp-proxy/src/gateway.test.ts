import { describe, expect, it, vi } from "vitest";
import { invokeGatewayTool } from "./gateway.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

const fixedGateway = {
  url: "http://gw.test/tools/invoke",
  token: "test-token",
};

describe("invokeGatewayTool — request shaping", () => {
  it("POSTs the tool name and args as JSON to the gateway URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: { content: [{ type: "text", text: "ok" }] } }),
    );
    await invokeGatewayTool({
      toolName: "memory_search",
      args: { query: "ping" },
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(fixedGateway.url);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      tool: "memory_search",
      args: { query: "ping" },
    });
  });
});

describe("invokeGatewayTool — successful responses", () => {
  it("returns result.content verbatim when gateway returns a content-shaped result", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: {
          content: [{ type: "text", text: "hello" }],
          details: { irrelevant: true },
        },
      }),
    );
    const out = await invokeGatewayTool({
      toolName: "tasks",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(out).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("preserves isError when present on the gateway result", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: {
          content: [{ type: "text", text: "soft-error" }],
          isError: true,
        },
      }),
    );
    const out = await invokeGatewayTool({
      toolName: "tasks",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(out.isError).toBe(true);
    expect(out.content).toEqual([{ type: "text", text: "soft-error" }]);
  });

  it("JSON-stringifies a result lacking the content shape", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: { foo: "bar", n: 42 } }),
    );
    const out = await invokeGatewayTool({
      toolName: "memory_get",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(out.content).toHaveLength(1);
    expect(out.content[0]).toMatchObject({
      type: "text",
    });
    const parsed = JSON.parse((out.content[0] as { text: string }).text);
    expect(parsed).toEqual({ foo: "bar", n: 42 });
  });

  it("JSON-stringifies null result without crashing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: null }),
    );
    const out = await invokeGatewayTool({
      toolName: "tasks",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(out.content[0]).toMatchObject({ type: "text", text: "null" });
  });
});

describe("invokeGatewayTool — gateway error responses", () => {
  it("returns an isError result with the gateway's error.message when ok=false", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        error: { message: "plugin not loaded" },
      }),
    );
    const out = await invokeGatewayTool({
      toolName: "tasks",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]).toMatchObject({
      type: "text",
      text: "Error: plugin not loaded",
    });
  });

  it("falls back to JSON.stringify(error) when error.message is absent", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error: { code: "X42" } }),
    );
    const out = await invokeGatewayTool({
      toolName: "tasks",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]).toMatchObject({
      text: `Error: ${JSON.stringify({ code: "X42" })}`,
    });
  });

  it("returns 'Unknown gateway error' when ok=false and error is missing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false }),
    );
    const out = await invokeGatewayTool({
      toolName: "tasks",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]).toMatchObject({
      text: "Error: Unknown gateway error",
    });
  });
});

describe("invokeGatewayTool — network errors", () => {
  it("returns an isError result when fetch rejects with a normal error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const out = await invokeGatewayTool({
      toolName: "tasks",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain(
      "Gateway call 'tasks' failed",
    );
    expect((out.content[0] as { text: string }).text).toContain("ECONNREFUSED");
  });

  it("returns a timeout message when fetch aborts (AbortError)", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchFn = vi.fn().mockRejectedValue(abortError);
    const out = await invokeGatewayTool({
      toolName: "memory_search",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 100,
    });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain(
      "timed out after 100ms",
    );
    expect((out.content[0] as { text: string }).text).toContain("memory_search");
  });

  it("handles a thrown non-Error value (string)", async () => {
    const fetchFn = vi.fn().mockRejectedValue("string-thrown");
    const out = await invokeGatewayTool({
      toolName: "tasks",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 1_000,
    });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("string-thrown");
  });
});

describe("invokeGatewayTool — timeout firing in real time", () => {
  it("aborts the in-flight request when timeoutMs elapses", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
      receivedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (receivedSignal) {
          receivedSignal.addEventListener("abort", () => {
            const e = Object.assign(new Error("aborted"), { name: "AbortError" });
            reject(e);
          });
        }
      });
    });
    const out = await invokeGatewayTool({
      toolName: "memory_search",
      args: {},
      gateway: fixedGateway,
      fetchFn,
      timeoutMs: 20,
    });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("timed out");
    expect(receivedSignal?.aborted).toBe(true);
  });
});

describe("invokeGatewayTool — agentId in the invoke envelope", () => {
  const gateway = { url: "http://127.0.0.1:18789/tools/invoke", token: "t" };
  const okResponse = () =>
    Promise.resolve({
      json: () => Promise.resolve({ ok: true, result: { content: [] } }),
    } as unknown as Response);

  it("sends agentId at the TOP level, alongside (not inside) args", async () => {
    // openclaw >= 2026.8.1 rejects a multi-agent invocation with no owner:
    // 'Multiple agents are configured, but session key "main" has no explicit
    // owner.' The owner belongs on the envelope; args.agent_id is separate
    // attribution metadata the brain tools read.
    let body: Record<string, unknown> = {};
    await invokeGatewayTool({
      toolName: "memory_search",
      args: { query: "q", agent_id: "hermes" },
      gateway,
      fetchFn: ((_u: string, init: { body: string }) => {
        body = JSON.parse(init.body) as Record<string, unknown>;
        return okResponse();
      }) as never,
      timeoutMs: 1000,
      agentId: "main",
    });
    expect(body.agentId).toBe("main");
    expect(body.tool).toBe("memory_search");
    // attribution is preserved and NOT overwritten by the owner
    expect((body.args as Record<string, unknown>).agent_id).toBe("hermes");
  });

  it("omits agentId entirely when none is given (single-agent hosts need no owner)", async () => {
    let body: Record<string, unknown> = {};
    await invokeGatewayTool({
      toolName: "tasks",
      args: {},
      gateway,
      fetchFn: ((_u: string, init: { body: string }) => {
        body = JSON.parse(init.body) as Record<string, unknown>;
        return okResponse();
      }) as never,
      timeoutMs: 1000,
    });
    expect("agentId" in body).toBe(false);
  });

  it("omits agentId when it is blank rather than sending an empty owner", async () => {
    let body: Record<string, unknown> = {};
    await invokeGatewayTool({
      toolName: "tasks",
      args: {},
      gateway,
      fetchFn: ((_u: string, init: { body: string }) => {
        body = JSON.parse(init.body) as Record<string, unknown>;
        return okResponse();
      }) as never,
      timeoutMs: 1000,
      agentId: "",
    });
    expect("agentId" in body).toBe(false);
  });
});
