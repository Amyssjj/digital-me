import { describe, expect, it } from "vitest";
import { TRANSCRIPT_SOURCE } from "./manifest.js";

describe("TRANSCRIPT_SOURCE", () => {
  it("self-describes the Codex transcript location for config.yaml sources", () => {
    // Consumers (digest, dashboard, dream-cycle) read this descriptor from
    // config.yaml rather than hardcoding paths — pin the exact shape.
    expect(TRANSCRIPT_SOURCE).toEqual({
      id: "codex-transcripts",
      path: "$HOME/.codex/sessions",
      format: "codex-jsonl",
    });
  });
});
