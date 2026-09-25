import { describe, expect, it } from "vitest";
import {
  isOneOf,
  LEARNING_KINDS,
  M1_EVENT_TYPES,
  MEMORY_CORPORA,
  PROXY_TRACE_KIND,
  TASKS_ACTIONS,
  TRACE_KINDS,
  WIKI_ACTIONS,
} from "./brain-tools.js";

describe("brain tool vocabulary", () => {
  it.each([
    ["TASKS_ACTIONS", TASKS_ACTIONS],
    ["TRACE_KINDS", TRACE_KINDS],
    ["LEARNING_KINDS", LEARNING_KINDS],
    ["M1_EVENT_TYPES", M1_EVENT_TYPES],
    ["WIKI_ACTIONS", WIKI_ACTIONS],
    ["MEMORY_CORPORA", MEMORY_CORPORA],
  ] as const)("%s is non-empty and duplicate-free", (_name, values) => {
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
  });

  it("TRACE_KINDS includes the proxy's own trace kind", () => {
    expect(TRACE_KINDS).toContain(PROXY_TRACE_KIND);
  });

  it("does not advertise actions the brain removed or never served", () => {
    expect(TASKS_ACTIONS).not.toContain("plan_goal");
    expect(TASKS_ACTIONS).not.toContain("retry");
    expect(WIKI_ACTIONS).toEqual(["status"]);
  });
});

describe("isOneOf", () => {
  it("accepts members and rejects non-members and non-strings", () => {
    expect(isOneOf(WIKI_ACTIONS, "status")).toBe(true);
    expect(isOneOf(WIKI_ACTIONS, "query")).toBe(false);
    expect(isOneOf(WIKI_ACTIONS, 1)).toBe(false);
    expect(isOneOf(WIKI_ACTIONS, undefined)).toBe(false);
  });
});
