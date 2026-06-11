import { describe, expect, it, vi } from "vitest";
import type { RouterResult } from "./router.js";
import { asMCPExecute, toMCPResult } from "./envelope.js";

describe("toMCPResult", () => {
  it("wraps ok=true with content array and empty details (no isError)", () => {
    const result: RouterResult = { ok: true, text: "hello" };
    const mcp = toMCPResult(result);
    expect(mcp.content).toEqual([{ type: "text", text: "hello" }]);
    expect(mcp.details).toEqual({});
    expect(mcp.isError).toBeUndefined();
  });

  it("sets isError=true for ok=false", () => {
    const result: RouterResult = { ok: false, text: "boom" };
    const mcp = toMCPResult(result);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]!.text).toBe("boom");
  });

  it("forwards a structured json payload via details.json", () => {
    const result: RouterResult = {
      ok: true,
      text: '{"goals":[]}',
      json: { goals: [] },
    };
    const mcp = toMCPResult(result);
    expect(mcp.details).toEqual({ json: { goals: [] } });
  });

  it("omits details.json when json is undefined", () => {
    const result: RouterResult = { ok: true, text: "raw" };
    const mcp = toMCPResult(result);
    expect("json" in mcp.details).toBe(false);
  });

  it("forwards details.json on the error path too", () => {
    const result: RouterResult = {
      ok: false,
      text: '{"error":"missing"}',
      json: { error: "missing" },
    };
    const mcp = toMCPResult(result);
    expect(mcp.isError).toBe(true);
    expect(mcp.details).toEqual({ json: { error: "missing" } });
  });
});

describe("asMCPExecute", () => {
  it("wraps a sync handler into an async MCP execute callback", async () => {
    const handler = vi.fn((params: { name: string }) => ({
      ok: true as const,
      text: `Hello, ${params.name}.`,
    }));
    const exec = asMCPExecute(handler);
    const result = await exec("call-1", { name: "world" });
    expect(handler).toHaveBeenCalledWith({ name: "world" });
    expect(result.content[0]!.text).toBe("Hello, world.");
  });

  it("awaits an async handler and translates its result", async () => {
    const handler = async () => ({
      ok: false as const,
      text: "deferred error",
    });
    const exec = asMCPExecute(handler);
    const result = await exec("call-2", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("deferred error");
  });

  it("propagates the json payload to details.json", async () => {
    const exec = asMCPExecute(async () => ({
      ok: true as const,
      text: "{}",
      json: { foo: 1 },
    }));
    const result = await exec("call-3", {});
    expect(result.details).toEqual({ json: { foo: 1 } });
  });

  it("ignores the toolCallId positional argument", async () => {
    const handler = vi.fn(() => ({ ok: true as const, text: "x" }));
    const exec = asMCPExecute(handler);
    await exec("ignored-id", { a: 1 });
    // Handler is called with params only, no toolCallId.
    expect(handler).toHaveBeenCalledWith({ a: 1 });
  });
});
