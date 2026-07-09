import { describe, expect, it } from "vitest";
import { TRANSCRIPT_SOURCE } from "./manifest.js";

describe("TRANSCRIPT_SOURCE", () => {
  it("identifies the openclaw agent transcript store", () => {
    expect(TRANSCRIPT_SOURCE.id).toBe("openclaw-agent-transcripts");
    expect(TRANSCRIPT_SOURCE.format).toBe("openclaw-agent-jsonl");
  });

  it("points at the per-agent dir under the openclaw state home", () => {
    // $HOME is expanded by the consumer at read time, not here.
    expect(TRANSCRIPT_SOURCE.path).toBe("$HOME/.openclaw/agents");
    expect(TRANSCRIPT_SOURCE.path.startsWith("$HOME/")).toBe(true);
  });
});
