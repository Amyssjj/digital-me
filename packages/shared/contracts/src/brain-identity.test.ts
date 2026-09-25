import { describe, expect, it } from "vitest";
import {
  BRAIN_MCP_SERVER_NAME,
  LEGACY_BRAIN_MCP_SERVER_NAMES,
  brainMcpToolNames,
  migrateLegacyBrainServerRefs,
} from "./brain-identity.js";

describe("brain identity", () => {
  it("names the MCP server digital-me-brain and keeps openclaw-brain as legacy", () => {
    expect(BRAIN_MCP_SERVER_NAME).toBe("digital-me-brain");
    expect(LEGACY_BRAIN_MCP_SERVER_NAMES).toEqual(["openclaw-brain"]);
  });

  it("lists the current and legacy spellings in both hyphen and underscore form", () => {
    expect(brainMcpToolNames("tasks")).toEqual([
      "mcp__digital-me-brain__tasks",
      "mcp__digital_me_brain__tasks",
      "mcp__openclaw-brain__tasks",
      "mcp__openclaw_brain__tasks",
    ]);
  });

  it("rewrites legacy server references in saved CLI alias args", () => {
    expect(
      migrateLegacyBrainServerRefs(
        "mcp__openclaw-brain__memory_search,mcp__openclaw-brain__tasks,Bash",
      ),
    ).toBe("mcp__digital-me-brain__memory_search,mcp__digital-me-brain__tasks,Bash");
    expect(migrateLegacyBrainServerRefs("mcp__openclaw_brain__tasks")).toBe(
      "mcp__digital_me_brain__tasks",
    );
    expect(
      migrateLegacyBrainServerRefs(
        'mcp_servers.openclaw-brain.tools.memory_search.approval_mode="approve"',
      ),
    ).toBe('mcp_servers.digital-me-brain.tools.memory_search.approval_mode="approve"');
  });

  it("leaves args without a legacy reference untouched", () => {
    expect(migrateLegacyBrainServerRefs("{{prompt}}")).toBe("{{prompt}}");
    expect(migrateLegacyBrainServerRefs("mcp__digital-me-brain__tasks")).toBe(
      "mcp__digital-me-brain__tasks",
    );
  });
});
