import { describe, expect, it } from "vitest";
import {
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_MAX_BODY_BYTES,
  HttpConfigError,
  MIN_TOKEN_LENGTH,
  isLoopbackHost,
  loadHttpConfig,
} from "./http-config.js";

const VALID_TOKEN = "0123456789abcdef0123456789abcdef";

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { BRAIN_MCP_HTTP_TOKEN: VALID_TOKEN, ...overrides };
}

describe("loadHttpConfig", () => {
  it("throws when the token is absent", () => {
    expect(() => loadHttpConfig({ env: {} })).toThrow(HttpConfigError);
    expect(() => loadHttpConfig({ env: {} })).toThrow(/BRAIN_MCP_HTTP_TOKEN is required/);
  });

  it("throws when the token is whitespace-only", () => {
    expect(() =>
      loadHttpConfig({ env: { BRAIN_MCP_HTTP_TOKEN: "   " } }),
    ).toThrow(/required/);
  });

  it("throws when the token is shorter than the minimum", () => {
    const short = "a".repeat(MIN_TOKEN_LENGTH - 1);
    expect(() =>
      loadHttpConfig({ env: { BRAIN_MCP_HTTP_TOKEN: short } }),
    ).toThrow(/too short/);
  });

  it("accepts a token exactly at the minimum length", () => {
    const minimal = "a".repeat(MIN_TOKEN_LENGTH);
    const config = loadHttpConfig({ env: { BRAIN_MCP_HTTP_TOKEN: minimal } });
    expect(config.token).toBe(minimal);
  });

  it("applies secure defaults: loopback host, family port, 2MiB body cap, no default agent", () => {
    const config = loadHttpConfig({ env: envWith({}) });
    expect(config).toEqual({
      host: DEFAULT_HTTP_HOST,
      port: DEFAULT_HTTP_PORT,
      token: VALID_TOKEN,
      defaultAgentId: undefined,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    });
  });

  it("trims and honors host, port, body-cap, and default-agent overrides", () => {
    const config = loadHttpConfig({
      env: envWith({
        BRAIN_MCP_HTTP_HOST: " 0.0.0.0 ",
        BRAIN_MCP_HTTP_PORT: "8787",
        BRAIN_MCP_HTTP_MAX_BODY_BYTES: "1024",
        BRAIN_MCP_HTTP_DEFAULT_AGENT_ID: " remote-mcp ",
      }),
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8787);
    expect(config.maxBodyBytes).toBe(1024);
    expect(config.defaultAgentId).toBe("remote-mcp");
  });

  it("treats an empty default agent id as unset", () => {
    const config = loadHttpConfig({
      env: envWith({ BRAIN_MCP_HTTP_DEFAULT_AGENT_ID: "  " }),
    });
    expect(config.defaultAgentId).toBeUndefined();
  });

  it.each([
    ["non-numeric", "abc"],
    ["fractional", "1.5"],
    ["zero", "0"],
    ["above the TCP range", "70000"],
  ])("rejects a %s port", (_label, value) => {
    expect(() =>
      loadHttpConfig({ env: envWith({ BRAIN_MCP_HTTP_PORT: value }) }),
    ).toThrow(/BRAIN_MCP_HTTP_PORT is not a valid value/);
  });

  it("rejects a non-positive body cap", () => {
    expect(() =>
      loadHttpConfig({ env: envWith({ BRAIN_MCP_HTTP_MAX_BODY_BYTES: "-5" }) }),
    ).toThrow(/BRAIN_MCP_HTTP_MAX_BODY_BYTES is not a valid value/);
  });

  it("names its error class for actionable stderr output", () => {
    try {
      loadHttpConfig({ env: {} });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).name).toBe("HttpConfigError");
    }
  });
});

describe("isLoopbackHost", () => {
  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["localhost", true],
    ["0.0.0.0", false],
    ["192.168.1.20", false],
  ])("classifies %s as loopback=%s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});
