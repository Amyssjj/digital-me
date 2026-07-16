import { describe, expect, it, vi } from "vitest";
import {
  attributionLabel,
  buildToolArgs,
  createCallToolHandler,
  DEFAULT_MAX_RESULT_BYTES,
  extractHitCount,
  inlineTopHitBody,
  resolveMaxResultBytes,
  resultContentBytes,
  type ToolCallTrace,
  type WikiBodyInliner,
} from "./handler.js";
import type { AppRateWriter } from "./app-rate-writer.js";
import type { CallToolResult } from "./gateway.js";

const makeInliner = (impl: WikiBodyInliner["readBody"]): WikiBodyInliner => ({
  readBody: impl,
});

describe("buildToolArgs", () => {
  it("injects defaultAgentId when args has no agent_id", () => {
    const out = buildToolArgs({ query: "x" }, "agent-default");
    expect(out).toEqual({ query: "x", agent_id: "agent-default" });
  });

  it("preserves the caller's explicit agent_id even if defaultAgentId is set", () => {
    const out = buildToolArgs(
      { query: "x", agent_id: "explicit" },
      "agent-default",
    );
    expect(out.agent_id).toBe("explicit");
  });

  it("treats an empty-string agent_id as missing and injects the default", () => {
    const out = buildToolArgs(
      { query: "x", agent_id: "" },
      "agent-default",
    );
    expect(out.agent_id).toBe("agent-default");
  });

  it("treats a non-string agent_id as missing and injects the default", () => {
    const out = buildToolArgs(
      { query: "x", agent_id: 42 as unknown as string },
      "agent-default",
    );
    expect(out.agent_id).toBe("agent-default");
  });

  it("leaves agent_id unset when defaultAgentId is undefined and caller didn't set it", () => {
    const out = buildToolArgs({ query: "x" }, undefined);
    expect(out.agent_id).toBeUndefined();
  });

  it("returns an empty object when args is null/undefined", () => {
    expect(buildToolArgs(undefined, undefined)).toEqual({});
    expect(buildToolArgs(undefined, "agent")).toEqual({ agent_id: "agent" });
  });

  it("does not mutate the input args object", () => {
    const input = { query: "x" };
    buildToolArgs(input, "agent");
    expect(input).toEqual({ query: "x" });
  });
});

describe("attributionLabel", () => {
  it("uses agent_id when present and a string", () => {
    expect(attributionLabel({ agent_id: "the-agent" })).toBe("the-agent");
  });

  it("falls back to unknown:<runtime> when agent_id is missing but runtime is", () => {
    expect(attributionLabel({ runtime: "codex" })).toBe("unknown:codex");
  });

  it("falls back to unknown:mcp when neither agent_id nor runtime is a string", () => {
    expect(attributionLabel({})).toBe("unknown:mcp");
    expect(attributionLabel({ agent_id: 42, runtime: false })).toBe(
      "unknown:mcp",
    );
  });

  it("does not fall back to runtime when agent_id is a non-empty string", () => {
    expect(
      attributionLabel({ agent_id: "real-agent", runtime: "claude-code" }),
    ).toBe("real-agent");
  });
});

describe("createCallToolHandler", () => {
  it("invokes the gateway with toolName and prepared args, returns its result", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const log = vi.fn();
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "default-agent",
      log,
    });
    const result = await handler({ name: "memory_search", arguments: { query: "x" } });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![0]).toMatchObject({
      toolName: "memory_search",
      args: { query: "x", agent_id: "default-agent" },
    });
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("emits an attribution log line per call", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const log = vi.fn();
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "default-agent",
      log,
    });
    await handler({ name: "tasks", arguments: { action: "board" } });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatch(/\[brain\] tasks called by default-agent/);
  });

  it("uses the caller agent_id in the attribution log when caller sets it explicitly", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const log = vi.fn();
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "default-agent",
      log,
    });
    await handler({
      name: "tasks",
      arguments: { agent_id: "caller-set", action: "board" },
    });
    expect(log.mock.calls[0]![0]).toMatch(/by caller-set/);
  });

  it("falls back to unknown:<runtime> in the attribution when no agent_id resolves", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const log = vi.fn();
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: undefined,
      log,
    });
    await handler({
      name: "tasks",
      arguments: { runtime: "codex", action: "board" },
    });
    expect(log.mock.calls[0]![0]).toMatch(/by unknown:codex/);
  });

  it("returns an isError result when invokeFn throws", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("boom"));
    const log = vi.fn();
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: undefined,
      log,
    });
    const result = await handler({ name: "tasks", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "MCP proxy error",
    );
    expect((result.content[0] as { text: string }).text).toContain("boom");
  });

  it("handles non-Error thrown values gracefully", async () => {
    const invoke = vi.fn().mockRejectedValue("string-thrown");
    const log = vi.fn();
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: undefined,
      log,
    });
    const result = await handler({ name: "tasks", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "string-thrown",
    );
  });

  it("accepts undefined arguments and passes empty args to the gateway", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const log = vi.fn();
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "default-agent",
      log,
    });
    await handler({ name: "memory_search", arguments: undefined });
    expect(invoke.mock.calls[0]![0].args).toEqual({ agent_id: "default-agent" });
  });
});

describe("extractHitCount", () => {
  it("returns undefined for non-memory_search tools", () => {
    expect(
      extractHitCount("tasks", { content: [{ type: "text", text: "[]" }] }),
    ).toBeUndefined();
  });

  it("parses results.length from a memory_search JSON payload", () => {
    const payload = JSON.stringify({ results: [{}, {}, {}], debug: {} });
    expect(
      extractHitCount("memory_search", {
        content: [{ type: "text", text: payload }],
      }),
    ).toBe(3);
  });

  it("returns undefined when payload is malformed JSON", () => {
    expect(
      extractHitCount("memory_search", {
        content: [{ type: "text", text: "not-json" }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined when payload has no results array", () => {
    expect(
      extractHitCount("memory_search", {
        content: [{ type: "text", text: JSON.stringify({ other: 1 }) }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined when content is empty", () => {
    expect(extractHitCount("memory_search", { content: [] })).toBeUndefined();
  });

  it("returns undefined when the text payload is not a string", () => {
    expect(
      extractHitCount("memory_search", {
        content: [{ type: "text", text: 42 as unknown as string }],
      }),
    ).toBeUndefined();
  });
});

describe("createCallToolHandler — traceWriter", () => {
  it("invokes traceWriter once per call with timing + agent + outcome", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ results: [{}, {}] }) }],
    });
    const traces: ToolCallTrace[] = [];
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      traceWriter: (t) => traces.push(t),
    });
    await handler({
      name: "memory_search",
      arguments: { query: "hello world" },
    });
    expect(traces).toHaveLength(1);
    const t = traces[0]!;
    expect(t.toolName).toBe("memory_search");
    expect(t.agentId).toBe("codex");
    expect(t.query).toBe("hello world");
    expect(t.hitCount).toBe(2);
    expect(t.isError).toBe(false);
    expect(typeof t.durationMs).toBe("number");
    expect(t.completedAt).toBeGreaterThan(0);
  });

  it("records isError=true when the gateway result is an error", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "tool error" }],
      isError: true,
    });
    const traces: ToolCallTrace[] = [];
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      traceWriter: (t) => traces.push(t),
    });
    await handler({ name: "tasks", arguments: {} });
    expect(traces[0]!.isError).toBe(true);
  });

  it("records isError=true when invokeFn throws", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("network failure"));
    const traces: ToolCallTrace[] = [];
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      traceWriter: (t) => traces.push(t),
    });
    await handler({ name: "tasks", arguments: {} });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.isError).toBe(true);
  });

  it("never affects the tool response when traceWriter throws", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      traceWriter: () => {
        throw new Error("trace storage broken");
      },
    });
    const result = await handler({ name: "tasks", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe("ok");
  });

  it("omits query from trace when args has no query", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const traces: ToolCallTrace[] = [];
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      traceWriter: (t) => traces.push(t),
    });
    await handler({ name: "tasks", arguments: { action: "board" } });
    expect(traces[0]!.query).toBeUndefined();
  });

  it("works without traceWriter (backward-compatible)", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
    });
    await expect(
      handler({ name: "tasks", arguments: {} }),
    ).resolves.toBeTruthy();
  });
});

// ─── Top-hit body inliner (M1, 2026-05-22) ─────────────────────────────────

describe("inlineTopHitBody", () => {
  const memorySearchResult = (results: unknown[]) => ({
    content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
  });

  it("passes through non-memory_search tool responses unchanged", () => {
    const result = memorySearchResult([
      { path: "infra/x.md", score: 0.9 },
    ]);
    const out = inlineTopHitBody({
      toolName: "tasks",
      result,
      inliner: makeInliner(() => "should never be called"),
    });
    expect(out).toBe(result);
  });

  it("inlines top-1 full body when score >= minScore and reader returns text", () => {
    const result = memorySearchResult([
      { path: "infra/clawsweeper-self-hosted.md", score: 0.6, snippet: "..." },
      { path: "infra/other.md", score: 0.5, snippet: "..." },
    ]);
    const reader = vi.fn().mockReturnValue("## Rule\nUse a self-hosted fork.");
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: reader },
    });
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith(
      "infra/clawsweeper-self-hosted.md",
      2000,
    );
    const parsed = JSON.parse(
      (out.content[0] as { text: string }).text,
    ) as { results: Array<Record<string, unknown>> };
    expect(parsed.results[0]!.full_body).toBe(
      "## Rule\nUse a self-hosted fork.",
    );
    // results[1] is untouched
    expect(parsed.results[1]!.full_body).toBeUndefined();
  });

  it("skips inlining when top score is below minScore", () => {
    const result = memorySearchResult([
      { path: "x.md", score: 0.3 },
    ]);
    const reader = vi.fn().mockReturnValue("body");
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: reader },
    });
    expect(reader).not.toHaveBeenCalled();
    expect(out).toBe(result);
  });

  it("skips inlining when reader returns null (file missing)", () => {
    const result = memorySearchResult([
      { path: "x.md", score: 0.9 },
    ]);
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: () => null },
    });
    expect(out).toBe(result);
  });

  it("returns input unchanged on malformed JSON payload", () => {
    const result = {
      content: [{ type: "text" as const, text: "not json" }],
    };
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: () => "body" },
    });
    expect(out).toBe(result);
  });

  it("returns input unchanged when results is empty", () => {
    const result = memorySearchResult([]);
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: () => "body" },
    });
    expect(out).toBe(result);
  });

  it("returns input unchanged when content is empty", () => {
    const result = { content: [] };
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: () => "body" },
    });
    expect(out).toBe(result);
  });

  it("returns input unchanged when the text payload is not a string", () => {
    const result = {
      content: [{ type: "text" as const, text: 42 as unknown as string }],
    };
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: () => "body" },
    });
    expect(out).toBe(result);
  });

  it("returns input unchanged when the top hit is not an object", () => {
    const result = memorySearchResult([null]);
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: () => "body" },
    });
    expect(out).toBe(result);
  });

  it("returns input unchanged when the top hit has no path", () => {
    const result = memorySearchResult([{ score: 0.9 }]);
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: () => "body" },
    });
    expect(out).toBe(result);
  });

  it("treats a missing score as 0 (below minScore → no inline)", () => {
    const result = memorySearchResult([{ path: "x.md" }]);
    const reader = vi.fn().mockReturnValue("body");
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: reader },
    });
    expect(reader).not.toHaveBeenCalled();
    expect(out).toBe(result);
  });

  it("falls back to an empty tail when content reads back nullish while building the response", () => {
    // Defensive path: results[0] is read from content before the augmented
    // response re-reads content to copy the tail. An exotic result object
    // whose content getter goes nullish must not crash the inliner.
    const payload = JSON.stringify({ results: [{ path: "x.md", score: 0.9 }] });
    let reads = 0;
    const result = {
      get content() {
        reads += 1;
        return reads === 1
          ? [{ type: "text" as const, text: payload }]
          : undefined;
      },
    } as unknown as CallToolResult;
    const out = inlineTopHitBody({
      toolName: "memory_search",
      result,
      inliner: { readBody: () => "BODY" },
    });
    expect(out.content).toHaveLength(1);
    const parsed = JSON.parse((out.content[0] as { text: string }).text) as {
      results: Array<Record<string, unknown>>;
    };
    expect(parsed.results[0]!.full_body).toBe("BODY");
  });
});

// ─── appRateWriter wiring (M1 chokepoint, 2026-05-26) ──────────────────────

function makeAppRateWriter() {
  return {
    recordSearch: vi.fn<AppRateWriter["recordSearch"]>(),
    recordGet: vi.fn<AppRateWriter["recordGet"]>(),
    flushAll: vi.fn<AppRateWriter["flushAll"]>(),
    shutdown: vi.fn<AppRateWriter["shutdown"]>(),
  };
}

describe("createCallToolHandler — appRateWriter wiring", () => {
  it("routes memory_search responses to recordSearch (not recordGet)", async () => {
    const searchResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ results: [{ path: "wiki/x.md", score: 0.9 }] }),
        },
      ],
    };
    const invoke = vi.fn().mockResolvedValue(searchResult);
    const appRateWriter = makeAppRateWriter();
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      appRateWriter,
    });
    await handler({ name: "memory_search", arguments: { query: "x" } });
    expect(appRateWriter.recordSearch).toHaveBeenCalledOnce();
    expect(appRateWriter.recordSearch.mock.calls[0]![0]).toMatchObject({
      agentId: "codex",
      toolName: "memory_search",
      result: searchResult,
    });
    expect(appRateWriter.recordGet).not.toHaveBeenCalled();
  });

  it("routes memory_get calls to recordGet with the prepared args", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "entry body" }],
    });
    const appRateWriter = makeAppRateWriter();
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      appRateWriter,
    });
    await handler({ name: "memory_get", arguments: { path: "foo/a.md" } });
    expect(appRateWriter.recordGet).toHaveBeenCalledOnce();
    expect(appRateWriter.recordGet.mock.calls[0]![0]).toMatchObject({
      agentId: "codex",
      toolName: "memory_get",
      args: { path: "foo/a.md", agent_id: "codex" },
    });
    expect(appRateWriter.recordSearch).not.toHaveBeenCalled();
  });

  it("does not observe non-memory tools", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const appRateWriter = makeAppRateWriter();
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      appRateWriter,
    });
    await handler({ name: "tasks", arguments: { action: "board" } });
    expect(appRateWriter.recordSearch).not.toHaveBeenCalled();
    expect(appRateWriter.recordGet).not.toHaveBeenCalled();
  });

  it("never affects the tool response when the writer throws", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const appRateWriter = makeAppRateWriter();
    appRateWriter.recordSearch.mockImplementation(() => {
      throw new Error("writer disk broken");
    });
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      appRateWriter,
    });
    const result = await handler({
      name: "memory_search",
      arguments: { query: "x" },
    });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe("ok");
  });
});

describe("createCallToolHandler — wikiBodyInliner wiring", () => {
  it("inlines memory_search top hit when inliner is provided", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              { path: "infra/foo.md", score: 0.7, snippet: "snip" },
            ],
          }),
        },
      ],
    });
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      wikiBodyInliner: makeInliner((_p, _max) => "FULL_BODY_CONTENT"),
    });
    const out = await handler({ name: "memory_search", arguments: { query: "x" } });
    const parsed = JSON.parse((out.content[0] as { text: string }).text) as {
      results: Array<Record<string, unknown>>;
    };
    expect(parsed.results[0]!.full_body).toBe("FULL_BODY_CONTENT");
  });

  it("leaves non-memory_search responses untouched even with inliner provided", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "tasks-output" }],
    });
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      wikiBodyInliner: makeInliner(() => "BODY"),
    });
    const out = await handler({ name: "tasks", arguments: { action: "board" } });
    expect((out.content[0] as { text: string }).text).toBe("tasks-output");
  });

  it("falls through (returns original result) if inliner throws", async () => {
    const invoke = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [{ path: "x.md", score: 0.9 }],
          }),
        },
      ],
    });
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      wikiBodyInliner: {
        readBody: () => {
          throw new Error("disk broken");
        },
      },
    });
    const out = await handler({
      name: "memory_search",
      arguments: { query: "x" },
    });
    // Result still parseable, just without full_body
    const parsed = JSON.parse((out.content[0] as { text: string }).text) as {
      results: Array<Record<string, unknown>>;
    };
    expect(parsed.results[0]!.full_body).toBeUndefined();
  });
});

describe("resolveMaxResultBytes", () => {
  it("returns the default when the env var is unset or empty", () => {
    expect(resolveMaxResultBytes({})).toBe(DEFAULT_MAX_RESULT_BYTES);
    expect(resolveMaxResultBytes({ BRAIN_MCP_MAX_RESULT_BYTES: "" })).toBe(
      DEFAULT_MAX_RESULT_BYTES,
    );
  });

  it("parses a non-negative integer byte count", () => {
    expect(resolveMaxResultBytes({ BRAIN_MCP_MAX_RESULT_BYTES: "1024" })).toBe(
      1024,
    );
  });

  it("returns 0 (guard disabled) for '0'", () => {
    expect(resolveMaxResultBytes({ BRAIN_MCP_MAX_RESULT_BYTES: "0" })).toBe(0);
  });

  it("falls back to the default on invalid values so a typo can't disable the guard", () => {
    expect(
      resolveMaxResultBytes({ BRAIN_MCP_MAX_RESULT_BYTES: "unlimited" }),
    ).toBe(DEFAULT_MAX_RESULT_BYTES);
    expect(resolveMaxResultBytes({ BRAIN_MCP_MAX_RESULT_BYTES: "-1" })).toBe(
      DEFAULT_MAX_RESULT_BYTES,
    );
    expect(resolveMaxResultBytes({ BRAIN_MCP_MAX_RESULT_BYTES: "1.5" })).toBe(
      DEFAULT_MAX_RESULT_BYTES,
    );
  });
});

describe("resultContentBytes", () => {
  it("sums UTF-8 byte lengths of text content items", () => {
    expect(
      resultContentBytes({
        content: [
          { type: "text", text: "abc" },
          { type: "text", text: "héllo" }, // é is 2 bytes in UTF-8
        ],
      }),
    ).toBe(3 + 6);
  });

  it("measures non-text items by their JSON serialization", () => {
    const item = { type: "image", data: "ZZZZ" };
    expect(resultContentBytes({ content: [item] })).toBe(
      Buffer.byteLength(JSON.stringify(item), "utf8"),
    );
  });

  it("returns 0 for missing or empty content", () => {
    expect(resultContentBytes({ content: [] })).toBe(0);
    expect(
      resultContentBytes({ content: undefined as unknown as [] }),
    ).toBe(0);
  });
});

describe("createCallToolHandler — oversize-result guard", () => {
  const bigResult = (chars: number): CallToolResult => ({
    content: [{ type: "text", text: "x".repeat(chars) }],
  });

  it("replaces an oversized result with an isError explanation", async () => {
    const invoke = vi.fn().mockResolvedValue(bigResult(100));
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "claude-code",
      log: vi.fn(),
      maxResultBytes: 50,
    });
    const out = await handler({
      name: "tasks",
      arguments: { action: "board", format: "json" },
    });
    expect(out.isError).toBe(true);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain("'tasks' returned 100 bytes");
    expect(text).toContain("50-byte forwarding cap");
    expect(text).toContain("since");
    expect(text).toContain("BRAIN_MCP_MAX_RESULT_BYTES");
  });

  it("passes results at or under the cap through unchanged", async () => {
    const invoke = vi.fn().mockResolvedValue(bigResult(50));
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "claude-code",
      log: vi.fn(),
      maxResultBytes: 50,
    });
    const out = await handler({ name: "tasks", arguments: { action: "board" } });
    expect(out.isError).toBeUndefined();
    expect((out.content[0] as { text: string }).text).toHaveLength(50);
  });

  it("maxResultBytes: 0 disables the guard entirely", async () => {
    const invoke = vi.fn().mockResolvedValue(bigResult(10_000));
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "dashboard",
      log: vi.fn(),
      maxResultBytes: 0,
    });
    const out = await handler({
      name: "tasks",
      arguments: { action: "board", format: "json" },
    });
    expect(out.isError).toBeUndefined();
    expect((out.content[0] as { text: string }).text).toHaveLength(10_000);
  });

  it("applies the default cap when maxResultBytes is omitted", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue(bigResult(DEFAULT_MAX_RESULT_BYTES + 1));
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "claude-code",
      log: vi.fn(),
    });
    const out = await handler({
      name: "tasks",
      arguments: { action: "board", format: "json" },
    });
    expect(out.isError).toBe(true);
  });

  it("logs the replacement so operators can see what tripped the cap", async () => {
    const log = vi.fn();
    const invoke = vi.fn().mockResolvedValue(bigResult(100));
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "claude-code",
      log,
      maxResultBytes: 50,
    });
    await handler({ name: "tasks", arguments: { action: "board" } });
    expect(
      log.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("oversized") &&
          c[0].includes("tasks"),
      ),
    ).toBe(true);
  });

  it("records the trace against the replacement error result", async () => {
    const traces: ToolCallTrace[] = [];
    const invoke = vi.fn().mockResolvedValue(bigResult(100));
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "claude-code",
      log: vi.fn(),
      traceWriter: (t) => traces.push(t),
      maxResultBytes: 50,
    });
    await handler({ name: "tasks", arguments: { action: "board" } });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.isError).toBe(true);
  });

  it("measures after wiki-body inlining so the guarded size matches the wire size", async () => {
    // Search result is under the cap, but the inlined body pushes it over.
    const searchPayload = JSON.stringify({
      results: [{ path: "wiki/x.md", score: 0.9 }],
    });
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: searchPayload }],
    });
    const handler = createCallToolHandler({
      invokeFn: invoke,
      defaultAgentId: "codex",
      log: vi.fn(),
      wikiBodyInliner: makeInliner(() => "B".repeat(500)),
      maxResultBytes: searchPayload.length + 100,
    });
    const out = await handler({
      name: "memory_search",
      arguments: { query: "x" },
    });
    expect(out.isError).toBe(true);
  });
});
