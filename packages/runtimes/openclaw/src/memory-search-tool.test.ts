import { describe, expect, it, vi } from "vitest";
import {
  BRAIN_MEMORY_SEARCH_DEFAULT_RESULTS,
  BRAIN_MEMORY_SEARCH_MAX_RESULTS,
  BRAIN_MEMORY_SEARCH_TOOL_NAME,
  BrainMemorySearchToolSchema,
  buildBrainMemorySearchTool,
  normalizeMemoryHit,
  resolveMaxResults,
} from "./memory-search-tool.js";

function parse(result: { content: readonly { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("normalizeMemoryHit", () => {
  it("keeps path/title/score/snippet/source and drops unknown-typed fields", () => {
    expect(
      normalizeMemoryHit({ path: "a.md", title: "A", score: 0.9, snippet: "s", source: "memory", body: "b" }),
    ).toEqual({ path: "a.md", title: "A", score: 0.9, snippet: "s", source: "memory" });
    expect(normalizeMemoryHit({ path: "a.md", title: 3, score: "x", source: 1 })).toEqual({ path: "a.md" });
  });

  it("falls back to a bounded body excerpt when there is no snippet", () => {
    const hit = normalizeMemoryHit({ path: "a.md", snippet: "", body: "x".repeat(1000) });
    expect(hit?.snippet).toHaveLength(400);
  });

  it("rejects hits without a usable path", () => {
    expect(normalizeMemoryHit({ path: "" })).toBeNull();
    expect(normalizeMemoryHit({ title: "no path" })).toBeNull();
  });

  it("ignores a non-finite score", () => {
    expect(normalizeMemoryHit({ path: "a.md", score: Number.NaN })).toEqual({ path: "a.md" });
  });
});

describe("resolveMaxResults", () => {
  it("defaults, floors, and clamps", () => {
    expect(resolveMaxResults(undefined)).toBe(BRAIN_MEMORY_SEARCH_DEFAULT_RESULTS);
    expect(resolveMaxResults("7")).toBe(BRAIN_MEMORY_SEARCH_DEFAULT_RESULTS);
    expect(resolveMaxResults(Number.POSITIVE_INFINITY)).toBe(BRAIN_MEMORY_SEARCH_DEFAULT_RESULTS);
    expect(resolveMaxResults(0)).toBe(1);
    expect(resolveMaxResults(3.9)).toBe(3);
    expect(resolveMaxResults(999)).toBe(BRAIN_MEMORY_SEARCH_MAX_RESULTS);
  });
});

describe("buildBrainMemorySearchTool", () => {
  it("is openclaw-shaped and named brain_memory_search with the typebox schema", () => {
    const tool = buildBrainMemorySearchTool({ search: vi.fn(), defaultAgentId: "main" });
    expect(tool.name).toBe(BRAIN_MEMORY_SEARCH_TOOL_NAME);
    expect(tool.parameters).toBe(BrainMemorySearchToolSchema);
    expect(tool.description).toMatch(/warm/);
  });

  it("searches the default agent, normalizes hits, and reports count", async () => {
    const search = vi.fn().mockResolvedValue([
      { path: "MEMORY.md", title: "M", score: 0.8, snippet: "s" },
      { title: "no path" },
    ]);
    const tool = buildBrainMemorySearchTool({ search, defaultAgentId: "main" });
    const result = await tool.execute("id", { query: "  COO " });
    expect(search).toHaveBeenCalledWith({ agentId: "main", query: "COO", maxResults: 6 });
    const payload = parse(result);
    expect(result.isError).toBeUndefined();
    expect(payload).toMatchObject({ agent: "main", query: "COO", count: 1, path: "gateway-warm-manager" });
    expect(payload.results).toEqual([{ path: "MEMORY.md", title: "M", score: 0.8, snippet: "s" }]);
    expect(typeof payload.durationMs).toBe("number");
    expect(result.details).toEqual(payload);
  });

  it("honours agent and maxResults, and truncates over-long result sets", async () => {
    const search = vi.fn().mockResolvedValue([{ path: "a" }, { path: "b" }, { path: "c" }]);
    const tool = buildBrainMemorySearchTool({ search, defaultAgentId: "main" });
    const result = await tool.execute("id", { query: "x", agent: " coo ", maxResults: 2 });
    expect(search).toHaveBeenCalledWith({ agentId: "coo", query: "x", maxResults: 2 });
    expect(parse(result).count).toBe(2);
  });

  it("treats a null/undefined search result as zero hits", async () => {
    const tool = buildBrainMemorySearchTool({ search: vi.fn().mockResolvedValue(null), defaultAgentId: "main" });
    const result = await tool.execute("id", { query: "x" });
    expect(parse(result)).toMatchObject({ count: 0, results: [] });
  });

  it("rejects a missing/empty query and non-object params without searching", async () => {
    const search = vi.fn();
    const tool = buildBrainMemorySearchTool({ search, defaultAgentId: "main" });
    for (const params of [{ query: "   " }, {}, null, "str", [1]]) {
      const result = await tool.execute("id", params);
      expect(result.isError).toBe(true);
      expect(parse(result)).toEqual({ error: "query required", agent: "main" });
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("surfaces a search failure as an isError result (Error and non-Error throws)", async () => {
    const tool1 = buildBrainMemorySearchTool({
      search: vi.fn().mockRejectedValue(new Error("memory search unavailable for agent \"coo\"")),
      defaultAgentId: "main",
    });
    const r1 = await tool1.execute("id", { query: "x", agent: "coo" });
    expect(r1.isError).toBe(true);
    expect(parse(r1)).toMatchObject({ error: 'memory search unavailable for agent "coo"', agent: "coo", query: "x" });

    const tool2 = buildBrainMemorySearchTool({ search: vi.fn().mockRejectedValue("boom"), defaultAgentId: "main" });
    const r2 = await tool2.execute("id", { query: "x" });
    expect(parse(r2).error).toBe("boom");
  });
});
