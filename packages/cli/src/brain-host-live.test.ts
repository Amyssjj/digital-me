import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_LOG_TAIL_BYTES,
  GATEWAY_PLUGIN_LOAD_MARKER,
  GATEWAY_TICK_DISABLED_MARKER,
  LIVE_PROBE_TIMEOUT_MS,
  OPENCLAW_GATEWAY_DEFAULT_PORT,
  brainHostHealthUrl,
  collectOpenclawGatewayEvidence,
  errorText,
  gatewayBrainPluginPaths,
  openclawGatewayHealthUrl,
  parseGatewayTickDecision,
  probeBrainHostHealth,
  readFileTail,
  resolveBrainHostHealthTarget,
  type GatewayEvidenceDeps,
  type HealthFetch,
  type HealthResponse,
  type TailFs,
} from "./brain-host-live.js";

const CFG = { host: "127.0.0.1", port: 18791, tokenFile: "/w/.data/brain-host.token" };

/** Node's fetch rejects with `TypeError("fetch failed")` and the errno in `cause`. */
function refused(): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
}

function answer(body: unknown, init: { ok?: boolean; status?: number; badJson?: boolean } = {}): HealthResponse {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => {
      if (init.badJson) throw new SyntaxError("Unexpected token <");
      return body;
    },
  };
}

describe("errorText", () => {
  it("surfaces the errno Node's fetch hides in cause.code, and stringifies non-Errors", () => {
    expect(errorText(refused())).toBe("fetch failed (ECONNREFUSED)");
    expect(errorText(new Error("plain"))).toBe("plain");
    expect(errorText(new Error("odd cause", { cause: { code: 42 } }))).toBe("odd cause");
    expect(errorText("a string")).toBe("a string");
  });
});

describe("brainHostHealthUrl", () => {
  it("puts /health beside the /tools/invoke endpoint", () => {
    expect(brainHostHealthUrl("http://127.0.0.1:18791/tools/invoke")).toBe("http://127.0.0.1:18791/health");
    expect(brainHostHealthUrl("https://brain.example:9/x/tools/invoke")).toBe("https://brain.example:9/health");
    expect(() => brainHostHealthUrl("not a url")).toThrow();
  });
});

describe("resolveBrainHostHealthTarget", () => {
  const files = (map: Record<string, string>) => (f: string) => map[f];

  it("uses the always-on service URL and its token file (trimmed) — the installers' resolution", () => {
    expect(resolveBrainHostHealthTarget({}, CFG, files({ [CFG.tokenFile]: "secret\n" }))).toEqual({
      url: "http://127.0.0.1:18791/health",
      token: "secret",
      tokenFile: CFG.tokenFile,
    });
  });

  it("honours DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN_FILE", () => {
    const env = { DIGITAL_ME_BRAIN_URL: "http://10.0.0.5:9999/tools/invoke", DIGITAL_ME_BRAIN_TOKEN_FILE: "/t" };
    expect(resolveBrainHostHealthTarget(env, CFG, files({ "/t": "tok" }))).toEqual({
      url: "http://10.0.0.5:9999/health",
      token: "tok",
      tokenFile: "/t",
    });
  });

  it("skips (never throws) with no token on the machine, a URL without a token file, or a malformed URL", () => {
    const none = resolveBrainHostHealthTarget({}, CFG, files({}));
    expect(none).toEqual({ skip: expect.stringContaining(`no brain-host token at ${CFG.tokenFile}`) });
    const noFile = resolveBrainHostHealthTarget({ DIGITAL_ME_BRAIN_URL: "http://h:1/tools/invoke" }, CFG, files({}));
    expect(noFile).toEqual({ skip: expect.stringContaining("DIGITAL_ME_BRAIN_URL is set but no readable token file") });
    const bad = resolveBrainHostHealthTarget({ DIGITAL_ME_BRAIN_URL: "not a url" }, CFG, files({ [CFG.tokenFile]: "t" }));
    expect(bad).toEqual({ skip: expect.stringMatching(/Invalid URL/) });
  });

  it("skips when the token file empties between the two reads", () => {
    const reads = ["tok", undefined];
    const target = resolveBrainHostHealthTarget({}, CFG, () => reads.shift());
    expect(target).toEqual({ skip: `the token file ${CFG.tokenFile} is empty or unreadable` });
  });
});

describe("probeBrainHostHealth", () => {
  const target = { url: "http://127.0.0.1:18791/health", token: "tok", tokenFile: CFG.tokenFile };

  it("passes a skip through without touching the network", async () => {
    const fetchFn = vi.fn<HealthFetch>();
    expect(await probeBrainHostHealth({ skip: "why" }, fetchFn)).toEqual({ status: "skipped", reason: "why" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends the bearer token with a bounded timeout and returns the authenticated report", async () => {
    const body = { ok: true, version: "0.1.0", orchestrator: { scheduler: "on" } };
    const fetchFn = vi.fn<HealthFetch>(async () => answer(body));
    expect(await probeBrainHostHealth(target, fetchFn)).toEqual({ status: "ok", url: target.url, body });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(target.url);
    expect(init.headers).toEqual({ Authorization: "Bearer tok" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(LIVE_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("an answer with only {ok, version} means the token was rejected (liveness-only)", async () => {
    const r = await probeBrainHostHealth(target, async () => answer({ ok: true, version: "0.1.0" }), 50);
    expect(r).toEqual({ status: "liveness-only", url: target.url, tokenFile: CFG.tokenFile });
  });

  it("refused → unreachable; HTTP error, non-JSON or non-object → error", async () => {
    expect(await probeBrainHostHealth(target, async () => Promise.reject(refused()))).toEqual({
      status: "unreachable",
      url: target.url,
      reason: "fetch failed (ECONNREFUSED)",
    });
    expect(await probeBrainHostHealth(target, async () => answer({}, { ok: false, status: 503 }))).toEqual({
      status: "error",
      url: target.url,
      reason: "HTTP 503",
    });
    const notJson = await probeBrainHostHealth(target, async () => answer(null, { badJson: true }));
    expect(notJson).toMatchObject({ status: "error", reason: expect.stringContaining("not JSON (Unexpected token") });
    for (const body of [null, [1], "text"]) {
      expect(await probeBrainHostHealth(target, async () => answer(body))).toEqual({
        status: "error",
        url: target.url,
        reason: "the answer is not a JSON object",
      });
    }
  });
});

describe("parseGatewayTickDecision", () => {
  const load = `2026-10-11T03:00:31.579-07:00 [plugins] ${GATEWAY_PLUGIN_LOAD_MARKER}8 tools (incl. brain_memory_search, default agent main)`;
  const disabled = `2026-10-11T03:00:31.580-07:00 [plugins] ${GATEWAY_TICK_DISABLED_MARKER} (config.scheduler=false or DIGITAL_ME_OPENCLAW_SCHEDULER=off); another host owns the tick`;

  it("reads the decision of the LAST load (stdout log format)", () => {
    expect(parseGatewayTickDecision([load, disabled, "noise"].join("\n"))).toEqual({
      ticking: false,
      at: "2026-10-11T03:00:31.579-07:00",
    });
    // An earlier load disabled its tick, the latest one did not.
    const later = load.replace("03:00:31.579", "09:12:00.000");
    expect(parseGatewayTickDecision([load, disabled, later, "digital-me-brain: scheduler: scanned 1 due"].join("\n"))).toEqual({
      ticking: true,
      at: "2026-10-11T09:12:00.000-07:00",
    });
  });

  it("reads the debug log's JSON lines (timestamp from _meta.date)", () => {
    const json = (msg: string) =>
      JSON.stringify({ 0: '{"subsystem":"plugins"}', 1: msg, _meta: { date: "2026-10-11T10:00:31.579Z", logLevelName: "INFO" } });
    const text = [json(`${GATEWAY_PLUGIN_LOAD_MARKER}8 tools`), json(`${GATEWAY_TICK_DISABLED_MARKER} — brain-host is installed`)].join("\n");
    expect(parseGatewayTickDecision(text)).toEqual({ ticking: false, at: "2026-10-11T10:00:31.579Z" });
  });

  it("no load line → undefined; an undated load line has no `at`", () => {
    expect(parseGatewayTickDecision(`${disabled}\nother`)).toBeUndefined();
    expect(parseGatewayTickDecision("")).toBeUndefined();
    expect(parseGatewayTickDecision(`[plugins] ${GATEWAY_PLUGIN_LOAD_MARKER}8 tools`)).toEqual({ ticking: true });
  });

  it("the markers are the plugin template's own log lines (a wording change must break here, not blind the doctor)", () => {
    const template = readFileSync(
      fileURLToPath(new URL("../../runtimes/openclaw/templates/brain/index.mjs", import.meta.url)),
      "utf-8",
    );
    expect(template).toContain("`" + GATEWAY_PLUGIN_LOAD_MARKER + "${tools.length");
    expect(template).toContain(`${GATEWAY_TICK_DISABLED_MARKER} — brain-host is installed`);
    expect(template).toContain(`"${GATEWAY_TICK_DISABLED_MARKER} (config.scheduler=false`);
  });
});

describe("readFileTail", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dm-tail-"));

  it("returns a small file whole, and only whole lines of a large one", () => {
    const f = path.join(dir, "g.log");
    writeFileSync(f, "line-one\nline-two\nline-three\n");
    expect(readFileTail(f, 1024)).toBe("line-one\nline-two\nline-three\n");
    // 12 bytes reach back into "line-two": that partial line is dropped.
    expect(readFileTail(f, 12)).toBe("line-three\n");
    // No newline inside the window: the window is returned as-is.
    const g = path.join(dir, "h.log");
    writeFileSync(g, "abc\ndefghij");
    expect(readFileTail(g, 5)).toBe("fghij");
  });

  it("always closes the descriptor, and throws like openSync on a missing file", () => {
    const closeSync = vi.fn();
    const fs: TailFs = {
      openSync: () => 7,
      fstatSync: () => ({ size: 10 }),
      readSync: () => {
        throw new Error("EIO");
      },
      closeSync,
    };
    expect(() => readFileTail("/x", 5, fs)).toThrow("EIO");
    expect(closeSync).toHaveBeenCalledWith(7);
    expect(() => readFileTail(path.join(dir, "missing.log"), 10)).toThrow(/ENOENT/);
    expect(GATEWAY_LOG_TAIL_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe("openclawGatewayHealthUrl", () => {
  it("env host/port, else openclaw.json gateway.port, else 127.0.0.1:18789", () => {
    expect(openclawGatewayHealthUrl({})).toBe(`http://127.0.0.1:${OPENCLAW_GATEWAY_DEFAULT_PORT}/health`);
    expect(openclawGatewayHealthUrl({}, null)).toBe("http://127.0.0.1:18789/health");
    expect(openclawGatewayHealthUrl({}, { gateway: { port: 18800 } })).toBe("http://127.0.0.1:18800/health");
    expect(openclawGatewayHealthUrl({ OPENCLAW_GATEWAY_PORT: "18900", OPENCLAW_GATEWAY_HOST: " 10.0.0.2 " }, { gateway: { port: 18800 } })).toBe(
      "http://10.0.0.2:18900/health",
    );
    // Invalid values fall through to the next source.
    expect(openclawGatewayHealthUrl({ OPENCLAW_GATEWAY_PORT: "nope", OPENCLAW_GATEWAY_HOST: " " }, { gateway: { port: "18800" } })).toBe(
      "http://127.0.0.1:18789/health",
    );
    expect(openclawGatewayHealthUrl({ OPENCLAW_GATEWAY_PORT: "70000" }, { gateway: { port: 1.5 } })).toBe("http://127.0.0.1:18789/health");
  });
});

describe("gatewayBrainPluginPaths", () => {
  it("the canonical state-dir install plus the two shadow locations", () => {
    expect(gatewayBrainPluginPaths("/h", {})).toEqual([
      "/h/.openclaw/extensions/digital-me-brain/index.mjs",
      "/h/openclaw/dist/extensions/digital-me-brain/index.js",
      "/h/openclaw/extensions/digital-me-brain/index.mjs",
    ]);
    expect(gatewayBrainPluginPaths("/h", { OPENCLAW_HOME: "/oc" })[0]).toBe("/oc/extensions/digital-me-brain/index.mjs");
  });
});

describe("collectOpenclawGatewayEvidence", () => {
  const PLUGIN = "/h/.openclaw/extensions/digital-me-brain/index.mjs";
  const LOAD = `2026-10-11T03:00:31.579-07:00 [plugins] ${GATEWAY_PLUGIN_LOAD_MARKER}8 tools`;
  const OFF = `2026-10-11T03:00:31.580-07:00 [plugins] ${GATEWAY_TICK_DISABLED_MARKER} (config.scheduler=false …)`;

  function deps(overrides: Partial<GatewayEvidenceDeps> = {}): GatewayEvidenceDeps {
    return {
      pluginPaths: [PLUGIN],
      fileExists: (p) => p === PLUGIN,
      fetch: async () => answer({ ok: true, status: "live" }),
      healthUrl: "http://127.0.0.1:18789/health",
      logPaths: ["/logs/a.log"],
      readTail: () => `${LOAD}\n${OFF}\n`,
      timeoutMs: 50,
      ...overrides,
    };
  }

  it("absent when no digital-me-brain plugin is installed (nothing probed)", async () => {
    const fetchFn = vi.fn<HealthFetch>();
    expect(await collectOpenclawGatewayEvidence(deps({ fileExists: () => false, fetch: fetchFn }))).toEqual({ state: "absent" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("not-running when the gateway port refuses the connection", async () => {
    expect(await collectOpenclawGatewayEvidence(deps({ fetch: async () => Promise.reject(refused()) }))).toEqual({
      state: "not-running",
      url: "http://127.0.0.1:18789/health",
      reason: "fetch failed (ECONNREFUSED)",
    });
  });

  it("disabled / ticking from the plugin's last logged decision, with the gateway's liveness", async () => {
    const { timeoutMs: _t, ...noTimeout } = deps();
    expect(await collectOpenclawGatewayEvidence(noTimeout)).toEqual({
      state: "disabled",
      decision: { ticking: false, at: "2026-10-11T03:00:31.579-07:00", logPath: "/logs/a.log" },
      answering: true,
      liveness: "gateway answering at http://127.0.0.1:18789/health",
    });
    const ticking = await collectOpenclawGatewayEvidence(
      deps({ fetch: async () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), readTail: () => LOAD }),
    );
    expect(ticking).toMatchObject({
      state: "ticking",
      decision: { ticking: true, logPath: "/logs/a.log" },
      answering: false,
      liveness: expect.stringContaining("gateway liveness unknown: http://127.0.0.1:18789/health The operation was aborted"),
    });
  });

  it("walks to an older log when the newest one does not reach back to the last load", async () => {
    const tails: Record<string, string> = { "/logs/today.log": "no plugin lines today\n", "/logs/gateway.log": `${LOAD}\n${OFF}` };
    const r = await collectOpenclawGatewayEvidence(
      deps({ logPaths: ["/logs/today.log", "/logs/gateway.log"], readTail: (p) => tails[p]! }),
    );
    expect(r).toMatchObject({ state: "disabled", decision: { logPath: "/logs/gateway.log" } });
  });

  it("unknown (with the reason) when no log exists, none is readable, or none holds a load line", async () => {
    expect(await collectOpenclawGatewayEvidence(deps({ logPaths: [] }))).toEqual({
      state: "unknown",
      reason: "no openclaw gateway log found (set OPENCLAW_GATEWAY_LOG if it lives elsewhere)",
    });
    const r = await collectOpenclawGatewayEvidence(
      deps({
        logPaths: ["/logs/locked.log", "/logs/quiet.log"],
        readTail: (p) => {
          if (p === "/logs/locked.log") throw new Error("EACCES");
          return "quiet\n";
        },
      }),
    );
    expect(r).toEqual({
      state: "unknown",
      reason: "no digital-me-brain load line in the scanned tail of /logs/quiet.log; unreadable: /logs/locked.log: EACCES",
    });
    const onlyLocked = await collectOpenclawGatewayEvidence(
      deps({
        readTail: () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(onlyLocked).toEqual({ state: "unknown", reason: "unreadable: /logs/a.log: EACCES" });
    expect(await collectOpenclawGatewayEvidence(deps({ readTail: () => "quiet\n" }))).toEqual({
      state: "unknown",
      reason: "no digital-me-brain load line in the scanned tail of /logs/a.log",
    });
  });
});
