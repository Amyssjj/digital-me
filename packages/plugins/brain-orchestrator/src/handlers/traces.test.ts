import { describe, expect, it } from "vitest";
import type {
  TraceQueryFilters,
  TraceRecord,
  TracesStore,
} from "../store/traces.js";
import {
  queryTraces,
  recordTrace,
  VALID_TRACE_KINDS,
} from "./traces.js";

function stubTraces(): {
  store: TracesStore;
  written: TraceRecord[];
  queried: TraceQueryFilters[];
  fixture: TraceRecord[];
} {
  const written: TraceRecord[] = [];
  const queried: TraceQueryFilters[] = [];
  const fixture: TraceRecord[] = [];
  const store: TracesStore = {
    create(t: TraceRecord) {
      written.push(t);
    },
    query(f: TraceQueryFilters): TraceRecord[] {
      queried.push(f);
      return fixture.slice();
    },
  };
  return { store, written, queried, fixture };
}

describe("recordTrace", () => {
  it("writes a trace with the provided t when present", () => {
    const s = stubTraces();
    const r = recordTrace(
      { traces: s.store, now: () => 999, newTraceId: () => "trc-1" },
      {
        agentId: "a",
        kind: "tool_call",
        payload: { tool: "wiki_search" },
        t: 500,
      },
    );
    expect(r.traceId).toBe("trc-1");
    expect(s.written).toHaveLength(1);
    expect(s.written[0]!.t).toBe(500);
    expect(s.written[0]!.payload).toEqual({ tool: "wiki_search" });
  });

  it("defaults t to the injected clock when omitted", () => {
    const s = stubTraces();
    recordTrace(
      { traces: s.store, now: () => 777, newTraceId: () => "trc-x" },
      { agentId: "a", kind: "session_start", payload: {} },
    );
    expect(s.written[0]!.t).toBe(777);
  });

  it("defaults the clock to Date.now and id generator to randomUUID", () => {
    const s = stubTraces();
    const before = Date.now();
    const r1 = recordTrace(
      { traces: s.store },
      { agentId: "a", kind: "session_start", payload: {} },
    );
    const r2 = recordTrace(
      { traces: s.store },
      { agentId: "a", kind: "session_start", payload: {} },
    );
    expect(r1.traceId).toMatch(/^trc-/);
    expect(r1.traceId).not.toBe(r2.traceId);
    expect(s.written[0]!.t).toBeGreaterThanOrEqual(before);
  });

  it("forwards every optional field to the store row", () => {
    const s = stubTraces();
    recordTrace(
      { traces: s.store, now: () => 0, newTraceId: () => "t" },
      {
        agentId: "a",
        kind: "task_complete",
        payload: { ok: true },
        taskId: "task-1",
        goalId: "goal-1",
        durationMs: 1234,
      },
    );
    expect(s.written[0]).toMatchObject({
      taskId: "task-1",
      goalId: "goal-1",
      durationMs: 1234,
    });
  });
});

describe("queryTraces", () => {
  it("forwards filters to the store and returns the rows", () => {
    const s = stubTraces();
    s.fixture.push({
      id: "tr-1",
      agentId: "a",
      kind: "tool_call",
      payload: {},
      t: 100,
    });
    const out = queryTraces({ traces: s.store }, { agentId: "a", limit: 50 });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("tr-1");
    expect(s.queried[0]).toEqual({ agentId: "a", limit: 50 });
  });
});

describe("VALID_TRACE_KINDS", () => {
  it("exposes the closed seven-kind vocabulary", () => {
    expect(VALID_TRACE_KINDS.size).toBe(7);
    for (const k of [
      "tool_call",
      "task_start",
      "task_complete",
      "task_failed",
      "learning_captured",
      "session_start",
      "session_end",
    ] as const) {
      expect(VALID_TRACE_KINDS.has(k)).toBe(true);
    }
  });
});
