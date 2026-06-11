import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadGatewayConfig,
  resolveDefaultAgentId,
  GatewayConfigError,
} from "./config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-mcp-proxy-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadGatewayConfig", () => {
  it("uses env vars when host, port, and token are all set", () => {
    const cfg = loadGatewayConfig({
      env: {
        OPENCLAW_GATEWAY_HOST: "example.host",
        OPENCLAW_GATEWAY_PORT: "9000",
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      },
      openclawHome: tmpDir,
    });
    expect(cfg.host).toBe("example.host");
    expect(cfg.port).toBe(9000);
    expect(cfg.token).toBe("env-token");
    expect(cfg.url).toBe("http://example.host:9000/tools/invoke");
  });

  it("reads token from $OPENCLAW_HOME/openclaw.json when env token is unset", () => {
    fs.writeFileSync(
      path.join(tmpDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 12345, auth: { token: "from-file" } } }),
    );
    const cfg = loadGatewayConfig({ env: {}, openclawHome: tmpDir });
    expect(cfg.port).toBe(12345);
    expect(cfg.token).toBe("from-file");
  });

  it("accepts auth.password as a fallback to auth.token", () => {
    fs.writeFileSync(
      path.join(tmpDir, "openclaw.json"),
      JSON.stringify({
        gateway: { port: 4242, auth: { password: "pw-style" } },
      }),
    );
    const cfg = loadGatewayConfig({ env: {}, openclawHome: tmpDir });
    expect(cfg.token).toBe("pw-style");
  });

  it("uses default host and port when env and file omit them", () => {
    fs.writeFileSync(
      path.join(tmpDir, "openclaw.json"),
      JSON.stringify({ gateway: { auth: { token: "tok" } } }),
    );
    const cfg = loadGatewayConfig({ env: {}, openclawHome: tmpDir });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(18789);
  });

  it("treats empty-string env values as unset and falls through to file", () => {
    fs.writeFileSync(
      path.join(tmpDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 7777, auth: { token: "tok" } } }),
    );
    const cfg = loadGatewayConfig({
      env: { OPENCLAW_GATEWAY_PORT: "", OPENCLAW_GATEWAY_TOKEN: "" },
      openclawHome: tmpDir,
    });
    expect(cfg.port).toBe(7777);
    expect(cfg.token).toBe("tok");
  });

  it("throws GatewayConfigError when token cannot be resolved", () => {
    fs.writeFileSync(
      path.join(tmpDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 1000 } }),
    );
    expect(() => loadGatewayConfig({ env: {}, openclawHome: tmpDir })).toThrow(
      GatewayConfigError,
    );
  });

  it("throws GatewayConfigError when openclaw.json is missing and env token is unset", () => {
    expect(() => loadGatewayConfig({ env: {}, openclawHome: tmpDir })).toThrow(
      GatewayConfigError,
    );
  });

  it("throws GatewayConfigError when openclaw.json is malformed JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "openclaw.json"), "{ not json");
    expect(() => loadGatewayConfig({ env: {}, openclawHome: tmpDir })).toThrow(
      GatewayConfigError,
    );
  });

  it("throws GatewayConfigError when openclaw.json exists but cannot be read (e.g. is a directory)", () => {
    // existsSync sees the entry; readFileSync rejects with EISDIR. Forces the
    // catch block in readGatewayFile that wraps non-JSON IO errors.
    fs.mkdirSync(path.join(tmpDir, "openclaw.json"));
    expect(() => loadGatewayConfig({ env: {}, openclawHome: tmpDir })).toThrow(
      GatewayConfigError,
    );
    try {
      loadGatewayConfig({ env: {}, openclawHome: tmpDir });
    } catch (e) {
      expect((e as Error).message).toContain("failed to read");
    }
  });

  it("env port takes precedence over file port", () => {
    fs.writeFileSync(
      path.join(tmpDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 1000, auth: { token: "from-file" } } }),
    );
    const cfg = loadGatewayConfig({
      env: { OPENCLAW_GATEWAY_PORT: "2000" },
      openclawHome: tmpDir,
    });
    expect(cfg.port).toBe(2000);
    expect(cfg.token).toBe("from-file");
  });

  it("rejects a non-numeric env port", () => {
    expect(() =>
      loadGatewayConfig({
        env: {
          OPENCLAW_GATEWAY_PORT: "not-a-number",
          OPENCLAW_GATEWAY_TOKEN: "tok",
        },
        openclawHome: tmpDir,
      }),
    ).toThrow(GatewayConfigError);
  });

  it("rejects invalid numeric ports from openclaw.json", () => {
    for (const port of [0, -1, 1.5, 65536]) {
      fs.writeFileSync(
        path.join(tmpDir, "openclaw.json"),
        JSON.stringify({ gateway: { port, auth: { token: "tok" } } }),
      );
      expect(() =>
        loadGatewayConfig({ env: {}, openclawHome: tmpDir }),
      ).toThrow(GatewayConfigError);
      try {
        loadGatewayConfig({ env: {}, openclawHome: tmpDir });
      } catch (e) {
        expect((e as Error).message).toContain("openclaw.json");
        expect((e as Error).message).toContain("gateway.port");
      }
    }
  });
});

describe("resolveDefaultAgentId", () => {
  it("returns the env value when OPENCLAW_AGENT_ID is set", () => {
    expect(
      resolveDefaultAgentId({
        env: { OPENCLAW_AGENT_ID: "claude-code-main" },
        argv: [],
      }),
    ).toBe("claude-code-main");
  });

  it("trims whitespace from the env value", () => {
    expect(
      resolveDefaultAgentId({
        env: { OPENCLAW_AGENT_ID: "  spaced  " },
        argv: [],
      }),
    ).toBe("spaced");
  });

  it("treats an empty-string env value as unset", () => {
    expect(
      resolveDefaultAgentId({
        env: { OPENCLAW_AGENT_ID: "" },
        argv: [],
      }),
    ).toBeUndefined();
  });

  it("treats a whitespace-only env value as unset", () => {
    expect(
      resolveDefaultAgentId({
        env: { OPENCLAW_AGENT_ID: "   " },
        argv: [],
      }),
    ).toBeUndefined();
  });

  it("falls back to --agent-id flag in argv when env is unset", () => {
    expect(
      resolveDefaultAgentId({
        env: {},
        argv: ["--agent-id=from-flag"],
      }),
    ).toBe("from-flag");
  });

  it("trims whitespace from the argv flag value", () => {
    expect(
      resolveDefaultAgentId({
        env: {},
        argv: ["--agent-id=  flag-value  "],
      }),
    ).toBe("flag-value");
  });

  it("ignores the argv flag if the value is empty", () => {
    expect(
      resolveDefaultAgentId({
        env: {},
        argv: ["--agent-id="],
      }),
    ).toBeUndefined();
  });

  it("returns undefined when neither env nor flag is present", () => {
    expect(resolveDefaultAgentId({ env: {}, argv: [] })).toBeUndefined();
  });

  it("env takes precedence over argv flag", () => {
    expect(
      resolveDefaultAgentId({
        env: { OPENCLAW_AGENT_ID: "from-env" },
        argv: ["--agent-id=from-flag"],
      }),
    ).toBe("from-env");
  });

  it("ignores unrelated argv entries", () => {
    expect(
      resolveDefaultAgentId({
        env: {},
        argv: ["--other-flag=value", "--agent-id=picked"],
      }),
    ).toBe("picked");
  });
});
