import { describe, expect, it } from "vitest";
import type {
  LearningKind,
  LearningRecord,
  LearningsStore,
} from "../store/learnings.js";
import type {
  TraceQueryFilters,
  TraceRecord,
  TracesStore,
} from "../store/traces.js";
import {
  captureLearning,
  VALID_LEARNING_KINDS,
} from "./learnings.js";

function stubStores(): {
  learnings: LearningsStore;
  traces: TracesStore;
  created: LearningRecord[];
  traced: TraceRecord[];
} {
  const created: LearningRecord[] = [];
  const traced: TraceRecord[] = [];
  const learnings: LearningsStore = {
    create(l: LearningRecord) {
      created.push(l);
    },
    get(_id: string): LearningRecord | undefined {
      return undefined;
    },
    listByAgent(_agentId: string): LearningRecord[] {
      return [];
    },
    listByKind(_kind: LearningKind): LearningRecord[] {
      return [];
    },
    listAll(): LearningRecord[] {
      return [];
    },
  };
  const traces: TracesStore = {
    create(t: TraceRecord) {
      traced.push(t);
    },
    query(_filters: TraceQueryFilters): TraceRecord[] {
      return [];
    },
  };
  return { learnings, traces, created, traced };
}

describe("captureLearning", () => {
  it("persists the learning and pairs it with a learning_captured trace", () => {
    const s = stubStores();
    const result = captureLearning(
      {
        learnings: s.learnings,
        traces: s.traces,
        now: () => 1000,
        newLearningId: () => "lrn-abc",
        newTraceId: () => "trc-xyz",
      },
      {
        agentId: "agent-x",
        kind: "feedback",
        text: "always use UTC",
        why: "DST is a footgun",
      },
    );
    expect(result.learningId).toBe("lrn-abc");
    expect(s.created).toHaveLength(1);
    expect(s.created[0]).toEqual({
      id: "lrn-abc",
      agentId: "agent-x",
      kind: "feedback",
      text: "always use UTC",
      why: "DST is a footgun",
      applyWhen: undefined,
      sourceContext: undefined,
      confidence: undefined,
      proposedWikiPath: undefined,
      createdAt: 1000,
    });
    expect(s.traced).toHaveLength(1);
    expect(s.traced[0]).toEqual({
      id: "trc-xyz",
      agentId: "agent-x",
      kind: "learning_captured",
      payload: { learning_id: "lrn-abc", learning_kind: "feedback" },
      t: 1000,
    });
  });

  it("passes every optional field through to the store", () => {
    const s = stubStores();
    captureLearning(
      {
        learnings: s.learnings,
        traces: s.traces,
        now: () => 0,
        newLearningId: () => "l",
        newTraceId: () => "t",
      },
      {
        agentId: "a",
        kind: "project",
        text: "milestone X is shipping Friday",
        why: "promised to stakeholders",
        applyWhen: "PR descriptions for milestone X",
        sourceContext: "thread #42",
        confidence: 0.9,
        proposedWikiPath: "projects/milestone-x.md",
      },
    );
    expect(s.created[0]).toMatchObject({
      applyWhen: "PR descriptions for milestone X",
      sourceContext: "thread #42",
      confidence: 0.9,
      proposedWikiPath: "projects/milestone-x.md",
    });
  });

  it("defaults clock + id generators when none are provided", () => {
    const s = stubStores();
    const before = Date.now();
    const result = captureLearning(
      { learnings: s.learnings, traces: s.traces },
      { agentId: "a", kind: "feedback", text: "x" },
    );
    expect(result.learningId).toMatch(/^lrn-/);
    expect(s.traced[0]!.id).toMatch(/^trc-/);
    expect(s.created[0]!.createdAt).toBeGreaterThanOrEqual(before);
    expect(s.traced[0]!.t).toBeGreaterThanOrEqual(before);
  });

  it("exposes VALID_LEARNING_KINDS as a closed vocabulary", () => {
    expect(VALID_LEARNING_KINDS.size).toBe(4);
    expect(VALID_LEARNING_KINDS.has("feedback")).toBe(true);
    expect(VALID_LEARNING_KINDS.has("project")).toBe(true);
    expect(VALID_LEARNING_KINDS.has("reference")).toBe(true);
    expect(VALID_LEARNING_KINDS.has("rejection")).toBe(true);
  });
});
