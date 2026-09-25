import { describe, expect, it } from "vitest";
import { resolveAgentId } from "./http-auth.js";

describe("resolveAgentId", () => {
  it("falls back when no value is provided", () => {
    expect(
      resolveAgentId({ headerValue: undefined, fallback: "default-agent" }),
    ).toEqual({ ok: true, source: "fallback", agentId: "default-agent" });
  });

  it("resolves to undefined when neither value nor fallback exist", () => {
    expect(resolveAgentId({ headerValue: undefined, fallback: undefined })).toEqual({
      ok: true,
      source: "fallback",
      agentId: undefined,
    });
  });

  it("rejects duplicated headers", () => {
    const result = resolveAgentId({
      headerValue: ["agent-a", "agent-b"],
      fallback: undefined,
    });
    expect(result.ok).toBe(false);
  });

  it("falls back on a whitespace-only value", () => {
    expect(resolveAgentId({ headerValue: "   ", fallback: "fb" })).toEqual({
      ok: true,
      source: "fallback",
      agentId: "fb",
    });
  });

  it("accepts and trims a well-formed agent id", () => {
    expect(
      resolveAgentId({ headerValue: " windows-codex.2 ", fallback: "fb" }),
    ).toEqual({ ok: true, source: "explicit", agentId: "windows-codex.2" });
  });

  it("accepts an id at the 64-char limit and rejects 65", () => {
    const max = "a".repeat(64);
    expect(resolveAgentId({ headerValue: max, fallback: undefined })).toEqual({
      ok: true,
      source: "explicit",
      agentId: max,
    });
    expect(
      resolveAgentId({ headerValue: max + "a", fallback: undefined }).ok,
    ).toBe(false);
  });

  it.each([
    ["spaces", "windows codex"],
    ["shell metacharacters", "agent;rm"],
    ["leading punctuation", "-agent"],
  ])("rejects an id with %s", (_label, value) => {
    const result = resolveAgentId({ headerValue: value, fallback: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid agent id/);
    }
  });
});
