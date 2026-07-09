import { describe, expect, it } from "vitest";
import { TRANSCRIPT_SOURCE } from "./manifest.js";

describe("TRANSCRIPT_SOURCE", () => {
  it("self-describes the Hermes transcript location for config.yaml sources", () => {
    // Consumers (digest, dashboard, dream-cycle) read this descriptor from
    // config.yaml rather than hardcoding paths — pin the exact shape,
    // including the glob (Hermes writes one session_*.json per session).
    expect(TRANSCRIPT_SOURCE).toEqual({
      id: "hermes-transcripts",
      path: "$HOME/.hermes/sessions",
      format: "hermes-session-json",
      glob: "session_*.json",
    });
  });
});
