import { describe, expect, it } from "vitest";
import {
  LEARNING_KINDS,
  M1_EVENT_TYPES,
  TASKS_ACTIONS,
  TRACE_KINDS,
} from "@digital-me/contracts";
import { TOOL_SCHEMAS } from "./tool-schemas.js";

type Prop = { type?: string; enum?: readonly string[]; description?: string };

function prop(tool: keyof typeof TOOL_SCHEMAS, name: string): Prop {
  return (TOOL_SCHEMAS[tool] as unknown as { properties: Record<string, Prop> })
    .properties[name]!;
}

describe("TOOL_SCHEMAS enums come from the shared brain-tool vocabulary", () => {
  it.each([
    ["tasks", "action", TASKS_ACTIONS],
    ["learning_capture", "kind", LEARNING_KINDS],
    ["traces_record", "kind", TRACE_KINDS],
    ["traces_query", "kind", TRACE_KINDS],
    ["m1_event_record", "event_type", M1_EVENT_TYPES],
  ] as const)("%s.%s", (tool, name, expected) => {
    const p = prop(tool, name);
    expect(p.type).toBe("string");
    expect(p.enum).toEqual([...expected]);
    expect(p.description?.length).toBeGreaterThan(0);
  });
});
