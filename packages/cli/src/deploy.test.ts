import { describe, expect, it } from "vitest";
import {
  DEPLOYABLE_RUNTIMES,
  analyzeDeployPreflight,
  parseAheadBehind,
  parseRecallAckMode,
  planDeployRuntimes,
} from "./deploy.js";

describe("analyzeDeployPreflight", () => {
  it("OK when clean and not ahead (behind is fine — deploy fast-forwards)", () => {
    expect(analyzeDeployPreflight({ porcelain: "", ahead: 0, behind: 0 })).toEqual({ ok: true });
    expect(analyzeDeployPreflight({ porcelain: "", ahead: 0, behind: 19 })).toEqual({ ok: true });
  });

  it("blocks a dirty working tree (stale-shadow risk)", () => {
    const r = analyzeDeployPreflight({
      porcelain: " M packages/cli/src/x.ts\n?? scratch.txt",
      ahead: 0,
      behind: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/uncommitted change/);
  });

  it("blocks when local main is ahead of origin (unpushed commits)", () => {
    const r = analyzeDeployPreflight({ porcelain: "", ahead: 2, behind: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ahead of origin/);
  });
});

describe("parseAheadBehind", () => {
  it("parses the tab-separated left-right count", () => {
    expect(parseAheadBehind("0\t19\n")).toEqual({ ahead: 0, behind: 19 });
    expect(parseAheadBehind("2\t0")).toEqual({ ahead: 2, behind: 0 });
  });
  it("defaults to 0/0 on unexpected output", () => {
    expect(parseAheadBehind("")).toEqual({ ahead: 0, behind: 0 });
    expect(parseAheadBehind("garbage")).toEqual({ ahead: 0, behind: 0 });
  });
});

describe("parseRecallAckMode", () => {
  const line = (mode: string) =>
    `2026-06-03T08:42:43 [plugins] digital-me-recall: registered hooks (boot=on, m1_emitter=on, assistant_ack=${mode}, app_rate=on)`;

  it("extracts the assistant_ack mode from the LATEST registration line", () => {
    const log = [line("agent_end"), "noise", line("agent_end+before_message_write")].join("\n");
    expect(parseRecallAckMode(log)).toBe("agent_end+before_message_write");
  });

  it("returns null when no registration line is present", () => {
    expect(parseRecallAckMode("just some gateway noise\n")).toBeNull();
  });
});

describe("planDeployRuntimes", () => {
  it("uses the explicit --runtime set, filtered to deployable ones", () => {
    expect(planDeployRuntimes(["openclaw", "claude-code", "dashboard"], [])).toEqual([
      "openclaw",
      "dashboard",
    ]);
    // non-deployable only → empty
    expect(planDeployRuntimes(["claude-code", "hermes"], ["openclaw"])).toEqual([]);
  });

  it("falls back to detected-installed deployable runtimes when none requested", () => {
    expect(planDeployRuntimes([], ["openclaw", "dashboard", "codex"])).toEqual([
      "openclaw",
      "dashboard",
    ]);
    expect(planDeployRuntimes([], [])).toEqual([]);
  });

  it("only openclaw + dashboard are deployable", () => {
    expect([...DEPLOYABLE_RUNTIMES]).toEqual(["openclaw", "dashboard"]);
  });
});
