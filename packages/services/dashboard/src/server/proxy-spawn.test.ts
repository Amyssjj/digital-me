import { describe, expect, it, vi } from "vitest";
import { MAX_RESULT_BYTES_ENV } from "@digital-me/brain-mcp-proxy";
import { proxyTransportParams, resolveProxyPath } from "./proxy-spawn.js";

const RESOLVED = "/workspace/node_modules/@digital-me/brain-mcp-proxy/bin/brain-mcp-proxy.mjs";

function resolver(ok = true) {
  return vi.fn((spec: string) => {
    if (!ok) throw new Error(`Cannot find module '${spec}'`);
    return RESOLVED;
  });
}

describe("resolveProxyPath", () => {
  it("prefers $BRAIN_PROXY_PATH over module resolution", () => {
    const resolve = resolver();
    const out = resolveProxyPath({ env: { BRAIN_PROXY_PATH: "/forks/proxy.mjs" }, resolve });
    expect(out).toBe("/forks/proxy.mjs");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("ignores an empty $BRAIN_PROXY_PATH and resolves the workspace bin", () => {
    const resolve = resolver();
    const out = resolveProxyPath({ env: { BRAIN_PROXY_PATH: "" }, resolve });
    expect(out).toBe(RESOLVED);
    expect(resolve).toHaveBeenCalledWith("@digital-me/brain-mcp-proxy/bin/brain-mcp-proxy.mjs");
  });

  it("falls back to the bare script name on $PATH when resolution fails", () => {
    const out = resolveProxyPath({ env: {}, resolve: resolver(false) });
    expect(out).toBe("brain-mcp-proxy.mjs");
  });
});

describe("proxyTransportParams", () => {
  it("raises the stdio read-buffer cap above the SDK's 10 MB default", () => {
    const params = proxyTransportParams({ env: {}, resolve: resolver() });
    // SDK 1.30 closes the transport when one message exceeds maxBufferSize
    // (default 10 MB); the 7-day board JSON is ~55 MB.
    expect(params.maxBufferSize).toBe(256 * 1024 * 1024);
    expect(params.maxBufferSize).toBeGreaterThan(10 * 1024 * 1024);
  });

  it("spawns node with the resolved proxy script", () => {
    const params = proxyTransportParams({ env: {}, resolve: resolver() });
    expect(params.command).toBe("node");
    expect(params.args).toEqual([RESOLVED]);
  });

  it("honours $NODE_BIN for the interpreter and ignores an empty value", () => {
    expect(
      proxyTransportParams({ env: { NODE_BIN: "/opt/node/bin/node" }, resolve: resolver() }).command,
    ).toBe("/opt/node/bin/node");
    expect(proxyTransportParams({ env: { NODE_BIN: "" }, resolve: resolver() }).command).toBe("node");
  });

  it("inherits the caller env and disables the proxy's oversize guard for this spawn", () => {
    const params = proxyTransportParams({
      env: {
        DIGITAL_ME_BRAIN_URL: "http://127.0.0.1:18791/tools/invoke",
        DIGITAL_ME_BRAIN_TOKEN: "secret",
        [MAX_RESULT_BYTES_ENV]: "4194304",
      },
      resolve: resolver(),
    });
    // The brain-backend precedence is applied by the child proxy itself, so
    // the brain-host pair must reach it untouched.
    expect(params.env?.DIGITAL_ME_BRAIN_URL).toBe("http://127.0.0.1:18791/tools/invoke");
    expect(params.env?.DIGITAL_ME_BRAIN_TOKEN).toBe("secret");
    // ...while the dashboard always overrides the result cap to "disabled".
    expect(params.env?.[MAX_RESULT_BYTES_ENV]).toBe("0");
  });
});
