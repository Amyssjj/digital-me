import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCompatReport,
  GATEWAY_SCOPE_SYMBOL_KEY,
  resetGatewayScopeForTests,
} from "./openclaw-compat-internal.js";

const KEY = Symbol.for(GATEWAY_SCOPE_SYMBOL_KEY);

beforeEach(() => {
  resetGatewayScopeForTests();
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

afterEach(() => {
  resetGatewayScopeForTests();
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

function mkApi(
  overrides: Record<string, unknown> = {},
): Parameters<typeof buildCompatReport>[0] {
  return {
    runtime: {
      log: vi.fn(),
      subagent: {
        run: vi.fn(async () => ({ runId: "r" })),
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    resolvePath: (p: string): string => p,
    registerTool: vi.fn(),
    ...overrides,
  } as Parameters<typeof buildCompatReport>[0];
}

describe("buildCompatReport", () => {
  it("reports ok=true when all required features are present", () => {
    const r = buildCompatReport(mkApi());
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("reports a failure when api.runtime is absent", () => {
    const r = buildCompatReport(mkApi({ runtime: undefined }));
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("runtime"))).toBe(true);
  });

  it("reports a failure when api.runtime.subagent is absent", () => {
    const r = buildCompatReport(
      mkApi({ runtime: { log: () => {} } as unknown as Record<string, unknown> }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("subagent"))).toBe(true);
  });

  it("reports a failure when subagent is present but lacks a callable run()", () => {
    const r = buildCompatReport(
      mkApi({
        runtime: { log: () => {}, subagent: {} } as unknown as Record<
          string,
          unknown
        >,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("subagent.run"))).toBe(true);
  });

  it("reports a failure when subagent.run is present but not a function", () => {
    const r = buildCompatReport(
      mkApi({
        runtime: { log: () => {}, subagent: { run: "x" } } as unknown as Record<
          string,
          unknown
        >,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("subagent.run"))).toBe(true);
  });

  it("reports a failure when api.registerTool is absent", () => {
    const r = buildCompatReport(mkApi({ registerTool: undefined }));
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("registerTool"))).toBe(true);
  });

  it("reports a failure when api.resolvePath is absent", () => {
    const r = buildCompatReport(mkApi({ resolvePath: undefined }));
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("resolvePath"))).toBe(true);
  });

  it("warns when the gateway scope symbol is unavailable", () => {
    const r = buildCompatReport(mkApi());
    expect(r.warnings.some((w) => w.includes("gateway scope"))).toBe(true);
    expect(r.degradedFeatures).toContain("periodic-cron-tick");
  });

  it("does NOT warn when the gateway scope is installed", () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      run: <T>(_s: unknown, fn: () => T): T => fn(),
    };
    const r = buildCompatReport(mkApi());
    expect(r.warnings.every((w) => !w.includes("gateway scope"))).toBe(true);
    expect(r.degradedFeatures).not.toContain("periodic-cron-tick");
  });

  it("detects forward-compat features when openclaw advertises them", () => {
    const r = buildCompatReport(
      mkApi({
        publishService: () => {},
      } as Record<string, unknown>),
    );
    expect(r.forwardCompatFeatures).toContain("api.publishService");
  });

  it("detects api.consumeService when present", () => {
    const r = buildCompatReport(
      mkApi({ consumeService: () => undefined } as Record<string, unknown>),
    );
    expect(r.forwardCompatFeatures).toContain("api.consumeService");
  });

  it("detects api.runInGatewayScope when present (future SDK addition)", () => {
    const r = buildCompatReport(
      mkApi({ runInGatewayScope: <T>(fn: () => T): T => fn() } as Record<string, unknown>),
    );
    expect(r.forwardCompatFeatures).toContain("api.runInGatewayScope");
  });

  it("absence of forward-compat features is not a warning, just unreported", () => {
    const r = buildCompatReport(mkApi());
    expect(r.forwardCompatFeatures).toEqual([]);
  });

  it("is deterministic — same input produces the same report shape", () => {
    const a = buildCompatReport(mkApi());
    const b = buildCompatReport(mkApi());
    expect(a.failures).toEqual(b.failures);
    expect(a.warnings).toEqual(b.warnings);
    expect(a.degradedFeatures).toEqual(b.degradedFeatures);
  });
});

describe("buildCompatReport.format()", () => {
  it("produces a human-readable multiline summary", () => {
    const r = buildCompatReport(mkApi({ registerTool: undefined }));
    const text = r.format();
    expect(text).toContain("brain-orchestrator compatibility report");
    expect(text).toContain("FAIL");
    expect(text).toMatch(/registerTool/);
  });

  it("marks the report OK when no failures", () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      run: <T>(_s: unknown, fn: () => T): T => fn(),
    };
    const r = buildCompatReport(mkApi());
    expect(r.format()).toMatch(/all required features present/i);
  });

  it("renders 'OK with warnings' when required features pass but optional ones degrade", () => {
    // Gateway scope NOT installed → warnings exist but ok=true.
    const r = buildCompatReport(mkApi());
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    const text = r.format();
    expect(text).toMatch(/OK with warnings/);
  });

  it("includes forward-compat features in the rendered output", () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      run: <T>(_s: unknown, fn: () => T): T => fn(),
    };
    const r = buildCompatReport(
      mkApi({ publishService: () => {} } as Record<string, unknown>),
    );
    const text = r.format();
    expect(text).toContain("forward-compat features detected");
    expect(text).toContain("api.publishService");
  });
});
