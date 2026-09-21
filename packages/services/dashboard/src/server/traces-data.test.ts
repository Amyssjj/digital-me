import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the brain client so the traces adapters read from a controllable
// traces_query result.
const tracesQueryMock = vi.fn();
vi.mock("./brain-client.mc.js", () => ({
  brainBoard: vi.fn(),
  brainTracesQuery: (opts: unknown) => tracesQueryMock(opts),
  brainWorkflowList: vi.fn(),
  brainWikiStatus: vi.fn(),
}));

import { getRecentTraces, getTraceById } from "./db.js";

// The row shape traces_query actually returns — from brain-host AND from the
// openclaw gateway alike. Neither carries trace_id/start_time; the proxy's
// trace-writer stores {id, agent_id, kind, payload, duration_ms, t} and the
// tool serialises it camelCased.
const T = 1_789_924_489_267;
function brainHostRow(id: string, agentId = "codex") {
  return {
    id,
    agentId,
    kind: "mcp_tool_call",
    payload: { toolName: "memory_search", query: "q", hitCount: 6, isError: false },
    durationMs: 1372,
    t: T,
  };
}

describe("traces adapters over brain-host row shape", () => {
  beforeEach(() => tracesQueryMock.mockReset());

  it("getRecentTraces produces one TraceGroup per {id, agentId, kind, payload, t, durationMs} row", async () => {
    tracesQueryMock.mockResolvedValue({ traces: [brainHostRow("trc-1")] });

    const groups = await getRecentTraces(7, 50);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.trace_id).toBe("trc-1");
    expect(g.service).toBe("codex");
    expect(g.root_name).toBe("mcp_tool_call");
    expect(g.start_time).toBe(new Date(T).toISOString());
    expect(g.total_duration_ms).toBe(1372);
    expect(g.total_spans).toBe(1);
    expect(g.spans[0].span_id).toBe("trc-1");
    expect(g.spans[0].attributes).toBe(
      JSON.stringify({ toolName: "memory_search", query: "q", hitCount: 6, isError: false }),
    );
    // Window + bounded limit are forwarded to traces_query.
    const args = tracesQueryMock.mock.calls[0][0] as { since: number; limit: number };
    expect(args.limit).toBe(500);
    expect(args.since).toBeGreaterThan(0);
  });

  it("getRecentTraces still accepts the legacy trace_id / start_time span shape", async () => {
    tracesQueryMock.mockResolvedValue({
      traces: [
        {
          trace_id: "legacy",
          span_id: "s1",
          name: "root",
          service: "coo",
          status: "ok",
          start_time: "2026-09-20T00:00:00.000Z",
          duration_ms: 5,
          attributes: "{}",
        },
      ],
    });
    const groups = await getRecentTraces();
    expect(groups.map((g) => g.trace_id)).toEqual(["legacy"]);
    expect(groups[0].root_name).toBe("root");
    expect(groups[0].status).toBe("ok");
  });

  it("getRecentTraces drops rows with no usable id", async () => {
    tracesQueryMock.mockResolvedValue({ traces: [{ agentId: "x", kind: "k", t: T }] });
    expect(await getRecentTraces()).toEqual([]);
  });

  it("getTraceById matches a brain-host row on its id", async () => {
    tracesQueryMock.mockResolvedValue({
      traces: [brainHostRow("trc-1"), brainHostRow("trc-2", "hermes")],
    });
    const g = await getTraceById("trc-2");
    expect(g).not.toBeNull();
    expect(g!.trace_id).toBe("trc-2");
    expect(g!.service).toBe("hermes");
    expect(g!.spans).toHaveLength(1);
  });

  it("getTraceById returns null when nothing matches", async () => {
    tracesQueryMock.mockResolvedValue({ traces: [brainHostRow("trc-1")] });
    expect(await getTraceById("nope")).toBeNull();
  });
});
