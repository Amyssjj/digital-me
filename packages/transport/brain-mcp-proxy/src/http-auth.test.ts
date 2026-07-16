import { describe, expect, it } from "vitest";
import {
  extractBearerToken,
  resolveAgentId,
  timingSafeTokenEqual,
} from "./http-auth.js";

describe("extractBearerToken", () => {
  it("returns null when the header is absent", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(extractBearerToken("Basic dXNlcjpwdw==")).toBeNull();
  });

  it("returns null for a Bearer header without a token", () => {
    expect(extractBearerToken("Bearer")).toBeNull();
  });

  it("extracts the token from a Bearer header", () => {
    expect(extractBearerToken("Bearer sekrit-token")).toBe("sekrit-token");
  });

  it("is case-insensitive about the scheme and tolerant of padding", () => {
    expect(extractBearerToken("  bearer sekrit-token  ")).toBe("sekrit-token");
  });
});

describe("timingSafeTokenEqual", () => {
  it("accepts an exact match", () => {
    expect(timingSafeTokenEqual("abc123", "abc123")).toBe(true);
  });

  it("rejects a mismatch", () => {
    expect(timingSafeTokenEqual("abc123", "abc124")).toBe(false);
  });

  it("rejects tokens of different lengths without throwing", () => {
    expect(timingSafeTokenEqual("abc123", "abc")).toBe(false);
  });
});

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
