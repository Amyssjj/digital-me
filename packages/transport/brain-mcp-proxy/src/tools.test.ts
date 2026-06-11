import { describe, expect, it } from "vitest";
import { TOOLS, PROXY_TRACE_KIND } from "./tools.js";

describe("TOOLS schema", () => {
  it("exposes the ten expected tool names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "agent_identify",
      "tasks",
      "wiki",
      "learning_capture",
      "traces_record",
      "traces_query",
      "memory_search",
      "memory_get",
      "m1_event_record",
      "m1_score",
    ]);
  });

  it("every tool has a non-empty name, description, and object-typed inputSchema", () => {
    for (const tool of TOOLS) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeTypeOf("object");
    }
  });

  it("every required field on every tool is declared in properties", () => {
    for (const tool of TOOLS) {
      const required = (tool.inputSchema as { required?: readonly string[] }).required ?? [];
      const props = tool.inputSchema.properties as Record<string, unknown>;
      for (const r of required) {
        expect(
          props[r],
          `tool ${tool.name} requires '${r}' but does not declare it in properties`,
        ).toBeDefined();
      }
    }
  });

  it("memory_search requires `query`", () => {
    const t = TOOLS.find((t) => t.name === "memory_search")!;
    expect((t.inputSchema as { required?: readonly string[] }).required).toContain(
      "query",
    );
  });

  it("learning_capture requires agent_id, kind, and text", () => {
    const t = TOOLS.find((t) => t.name === "learning_capture")!;
    const req = (t.inputSchema as { required?: readonly string[] }).required ?? [];
    expect(req).toContain("agent_id");
    expect(req).toContain("kind");
    expect(req).toContain("text");
  });

  it("traces_query has no required fields (all filters optional)", () => {
    const t = TOOLS.find((t) => t.name === "traces_query")!;
    expect((t.inputSchema as { required?: readonly string[] }).required).toBeUndefined();
  });

  it("traces_query's kind enum includes the proxy's own trace kind", () => {
    // Regression: the proxy writes kind='mcp_tool_call' (trace-writer.ts) but
    // it was missing from the queryable enum, so a client couldn't filter for
    // the rows the proxy itself records.
    const t = TOOLS.find((t) => t.name === "traces_query")!;
    const kindEnum = (
      t.inputSchema as {
        properties: { kind: { enum: readonly string[] } };
      }
    ).properties.kind.enum;
    expect(kindEnum).toContain(PROXY_TRACE_KIND);
  });
});
