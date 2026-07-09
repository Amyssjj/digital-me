import { describe, expect, it, vi } from "vitest";
import { createBrainClient } from "./brain-client.js";
import type { MinimalMcpClient } from "./brain-client.js";

function fakeClient(
  byTool: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
): MinimalMcpClient {
  return {
    callTool: vi.fn(async (req: { name: string; arguments: Record<string, unknown> }) => {
      const handler = byTool[req.name];
      if (!handler) throw new Error(`fake-client: no handler for tool ${req.name}`);
      const raw = await handler(req.arguments);
      // Wrap into MCP-shaped CallToolResult.
      return { content: [{ type: "text", text: JSON.stringify(raw) }] };
    }),
  };
}

describe("createBrainClient — connect / isConnected", () => {
  it("starts in not-connected state and never auto-connects", () => {
    const factory = vi.fn();
    const client = createBrainClient({ clientFactory: factory });
    expect(client.isConnected()).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it("connect() invokes the factory once and reuses on subsequent calls", async () => {
    const fake = fakeClient({});
    const factory = vi.fn(async () => fake);
    const client = createBrainClient({ clientFactory: factory });
    await client.connect();
    await client.connect();
    expect(factory).toHaveBeenCalledOnce();
    expect(client.isConnected()).toBe(true);
  });

  it("connect() coalesces concurrent callers", async () => {
    const fake = fakeClient({});
    let resolved = 0;
    const factory = vi.fn(async () => {
      // simulate async work
      await new Promise((r) => setTimeout(r, 5));
      resolved++;
      return fake;
    });
    const client = createBrainClient({ clientFactory: factory });
    await Promise.all([client.connect(), client.connect(), client.connect()]);
    expect(factory).toHaveBeenCalledOnce();
    expect(resolved).toBe(1);
  });

  it("connect() clears the in-flight promise on failure (next call retries)", async () => {
    let calls = 0;
    const fake = fakeClient({});
    const factory = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("first attempt fails");
      return fake;
    });
    const client = createBrainClient({ clientFactory: factory });
    await expect(client.connect()).rejects.toThrow("first attempt fails");
    expect(client.isConnected()).toBe(false);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe("createBrainClient — initBrain (boot-time)", () => {
  it("returns true on successful connect", async () => {
    const factory = vi.fn(async () => fakeClient({}));
    const client = createBrainClient({ clientFactory: factory });
    const result = await client.init();
    expect(result.ok).toBe(true);
  });

  it("returns false + error reason on failed connect; does not throw", async () => {
    const factory = vi.fn(async () => {
      throw new Error("boom");
    });
    const client = createBrainClient({ clientFactory: factory });
    const result = await client.init();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("boom");
  });

  it("init() handles non-Error throws", async () => {
    const factory = vi.fn(async () => {
      throw "string-thrown";
    });
    const client = createBrainClient({ clientFactory: factory });
    const result = await client.init();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("string-thrown");
  });
});

describe("createBrainClient — public tool wrappers", () => {
  it("brainBoard returns goals + stats from the gateway result", async () => {
    const fake = fakeClient({
      tasks: async () => ({
        goals: [{ id: "g1", name: "Goal one" }],
        stats: { running: 1 },
      }),
    });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.board();
    expect(out.goals).toEqual([{ id: "g1", name: "Goal one" }]);
    expect(out.stats).toEqual({ running: 1 });
  });

  it("brainBoard caches results (second call doesn't hit the gateway)", async () => {
    const handler = vi.fn(async () => ({ goals: [], stats: {} }));
    const fake = fakeClient({ tasks: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    await client.board();
    await client.board();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("brainBoard handles malformed result by defaulting to empty array", async () => {
    const fake = fakeClient({
      tasks: async () => ({ goals: "not-an-array" }),
    });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.board();
    expect(out.goals).toEqual([]);
    expect(out.stats).toBeUndefined();
  });

  it("brainTaskStatus returns the task object", async () => {
    const fake = fakeClient({
      tasks: async () => ({ task: { id: "t1", name: "T", status: "running" } }),
    });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.taskStatus("t1");
    expect(out).toEqual({ id: "t1", name: "T", status: "running" });
  });

  it("brainTaskStatus returns null when the gateway has no task", async () => {
    const fake = fakeClient({ tasks: async () => ({}) });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.taskStatus("missing");
    expect(out).toBeNull();
  });

  it("brainWorkflowList accepts a `templates` array", async () => {
    const fake = fakeClient({
      tasks: async () => ({ templates: [{ id: "wf1", name: "X" }] }),
    });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.workflowList();
    expect(out).toEqual([{ id: "wf1", name: "X" }]);
  });

  it("brainWorkflowList accepts a bare array as the result", async () => {
    const fake = fakeClient({
      tasks: async () => [{ id: "wf1", name: "X" }],
    });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.workflowList();
    expect(out).toEqual([{ id: "wf1", name: "X" }]);
  });

  it("brainWorkflowList defaults to [] for any other shape", async () => {
    const fake = fakeClient({ tasks: async () => ({ wat: 1 }) });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.workflowList();
    expect(out).toEqual([]);
  });

  it("brainScheduleList returns schedules array", async () => {
    const fake = fakeClient({
      tasks: async () => ({ schedules: [{ id: "s1" }] }),
    });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.scheduleList();
    expect(out).toEqual([{ id: "s1" }]);
  });

  it("brainScheduleList defaults to [] when schedules is missing", async () => {
    const fake = fakeClient({ tasks: async () => ({}) });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.scheduleList();
    expect(out).toEqual([]);
  });

  it("brainTracesQuery passes only defined options through as args", async () => {
    const handler = vi.fn(async () => ({ traces: [], total: 0 }));
    const fake = fakeClient({ traces_query: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    await client.tracesQuery({ agentId: "a", goalId: "g", limit: 10 });
    expect(handler).toHaveBeenCalledWith({
      agent_id: "a",
      goal_id: "g",
      limit: 10,
    });
  });

  it("brainTracesQuery omits options that are undefined", async () => {
    const handler = vi.fn(async () => ({ traces: [], total: 0 }));
    const fake = fakeClient({ traces_query: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    await client.tracesQuery({});
    expect(handler).toHaveBeenCalledWith({});
  });

  it("brainTracesQuery includes since=0 explicitly (not treated as missing)", async () => {
    const handler = vi.fn(async () => ({ traces: [] }));
    const fake = fakeClient({ traces_query: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    await client.tracesQuery({ since: 0 });
    expect(handler).toHaveBeenCalledWith({ since: 0 });
  });

  it("brainTracesQuery passes through all optional filters when set", async () => {
    const handler = vi.fn(async () => ({ traces: [] }));
    const fake = fakeClient({ traces_query: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    await client.tracesQuery({
      taskId: "t",
      kind: "tool_call",
      since: 1234,
    });
    expect(handler).toHaveBeenCalledWith({
      task_id: "t",
      kind: "tool_call",
      since: 1234,
    });
  });

  it("brainTracesQuery defaults missing fields in the result", async () => {
    const fake = fakeClient({ traces_query: async () => ({}) });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.tracesQuery({});
    expect(out.traces).toEqual([]);
    expect(out.total).toBeUndefined();
  });

  it("brainWikiStatus normalizes field aliases (totalEntries / totalConcepts)", async () => {
    const fake = fakeClient({
      wiki: async () => ({
        totalConcepts: 5,
        totalRaw: 10,
        byDomain: { foo: 3 },
        healthScore: 88,
      }),
    });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.wikiStatus();
    expect(out.totalEntries).toBe(5); // falls back from totalConcepts
    expect(out.totalConcepts).toBe(5);
    expect(out.totalRaw).toBe(10);
    expect(out.entriesByDomain).toEqual({ foo: 3 });
    expect(out.healthScore).toBe(88);
  });

  it("brainWikiStatus prefers totalEntries over totalConcepts when both present", async () => {
    const fake = fakeClient({
      wiki: async () => ({ totalEntries: 7, totalConcepts: 3 }),
    });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.wikiStatus();
    expect(out.totalEntries).toBe(7);
  });

  it("brainWikiStatus defaults missing fields to safe values", async () => {
    const fake = fakeClient({ wiki: async () => ({}) });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = await client.wikiStatus();
    expect(out.totalEntries).toBe(0);
    expect(out.totalConcepts).toBe(0);
    expect(out.totalRaw).toBe(0);
    expect(out.entriesByDomain).toEqual({});
    expect(out.healthScore).toBe(0);
    expect(out.freshness).toEqual({});
  });

  it("memorySearch forwards the query with corpus/limit defaults and returns the raw payload", async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => ({
      results: [{ path: "wiki/a.md", score: 0.9 }],
      echoed: args,
    }));
    const fake = fakeClient({ memory_search: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    const out = (await client.memorySearch("feed design")) as Record<string, unknown>;
    expect(handler).toHaveBeenCalledWith({ query: "feed design", corpus: "all", limit: 20 });
    expect(out.results).toEqual([{ path: "wiki/a.md", score: 0.9 }]);
  });

  it("memorySearch honors explicit corpus and limit", async () => {
    const handler = vi.fn(async () => ({ results: [] }));
    const fake = fakeClient({ memory_search: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    await client.memorySearch("q", { corpus: "wiki", limit: 3 });
    expect(handler).toHaveBeenCalledWith({ query: "q", corpus: "wiki", limit: 3 });
  });

  it("each wrapper auto-connects on first call", async () => {
    const factory = vi.fn(async () =>
      fakeClient({ tasks: async () => ({ goals: [], stats: {} }) }),
    );
    const client = createBrainClient({ clientFactory: factory });
    expect(client.isConnected()).toBe(false);
    await client.board();
    expect(factory).toHaveBeenCalledOnce();
    expect(client.isConnected()).toBe(true);
  });
});

describe("createBrainClient — cache TTLs", () => {
  it("uses the explicit TTL for workflowList (longer than default)", async () => {
    const handler = vi.fn(async () => ({ templates: [] }));
    const fake = fakeClient({ tasks: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    await client.workflowList();
    await client.workflowList();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("scheduleList caches its result", async () => {
    const handler = vi.fn(async () => ({ schedules: [{ id: "s1" }] }));
    const fake = fakeClient({ tasks: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    await client.scheduleList();
    await client.scheduleList();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("tracesQuery caches its result keyed by the option object", async () => {
    const handler = vi.fn(async () => ({ traces: [{ trace_id: "t" }] }));
    const fake = fakeClient({ traces_query: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    await client.tracesQuery({ agentId: "a" });
    await client.tracesQuery({ agentId: "a" });
    expect(handler).toHaveBeenCalledOnce();
    // Different options bypass the cache.
    await client.tracesQuery({ agentId: "b" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("wikiStatus caches its result", async () => {
    const handler = vi.fn(async () => ({
      totalEntries: 10,
      totalConcepts: 10,
      totalRaw: 5,
      entriesByDomain: { dev: 3 },
      freshness: {},
      healthScore: 80,
    }));
    const fake = fakeClient({ wiki: handler });
    const client = createBrainClient({ clientFactory: async () => fake });
    await client.wikiStatus();
    await client.wikiStatus();
    expect(handler).toHaveBeenCalledOnce();
  });
});
