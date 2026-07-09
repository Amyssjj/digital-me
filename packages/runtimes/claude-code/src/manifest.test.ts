import { describe, expect, it } from "vitest";
import { TRANSCRIPT_SOURCE } from "./manifest.js";

describe("TRANSCRIPT_SOURCE", () => {
  it("self-describes the Claude Code transcript location for config.yaml sources", () => {
    // Consumers (digest, dashboard, dream-cycle) read this descriptor from
    // config.yaml rather than hardcoding paths — pin the exact shape.
    expect(TRANSCRIPT_SOURCE).toEqual({
      id: "claude-code-transcripts",
      path: "$HOME/.claude/projects",
      format: "claude-code-jsonl",
    });
  });
});
