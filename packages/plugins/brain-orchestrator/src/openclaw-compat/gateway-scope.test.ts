import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_SCOPE_SYMBOL_KEY,
  isGatewayScopeAvailable,
  resetGatewayScopeForTests,
  runInGatewayScope,
} from "./gateway-scope.js";

const KEY = Symbol.for(GATEWAY_SCOPE_SYMBOL_KEY);

beforeEach(() => {
  // Wipe any prior installation so tests start fresh.
  resetGatewayScopeForTests();
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

afterEach(() => {
  resetGatewayScopeForTests();
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

describe("isGatewayScopeAvailable", () => {
  it("returns false when the symbol slot is empty", () => {
    expect(isGatewayScopeAvailable()).toBe(false);
  });

  it("returns false when the slot exists but is not a usable store", () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {};
    expect(isGatewayScopeAvailable()).toBe(false);
  });

  it("returns true when the slot holds an AsyncLocalStorage-shaped object", () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      run: <T>(_store: unknown, fn: () => T): T => fn(),
    };
    expect(isGatewayScopeAvailable()).toBe(true);
  });
});

describe("runInGatewayScope", () => {
  it("invokes the function inside the upstream store's run() when the scope is available", () => {
    const calls: Array<unknown> = [];
    (globalThis as Record<symbol, unknown>)[KEY] = {
      run: <T>(store: unknown, fn: () => T): T => {
        calls.push(store);
        return fn();
      },
    };
    const result = runInGatewayScope(() => 42);
    expect(result).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      isWebchatConnect: expect.any(Function),
      pluginId: expect.any(String),
    });
  });

  it("the synthetic scope's isWebchatConnect() returns false (matches upstream contract)", () => {
    let captured: { isWebchatConnect: () => boolean } | null = null;
    (globalThis as Record<symbol, unknown>)[KEY] = {
      run: <T>(store: { isWebchatConnect: () => boolean }, fn: () => T): T => {
        captured = store;
        return fn();
      },
    };
    runInGatewayScope(() => 0);
    expect(captured).not.toBeNull();
    expect(captured!.isWebchatConnect()).toBe(false);
  });

  it("falls back to running the function directly when the scope is unavailable, and warns once", () => {
    const warn = vi.fn();
    const result = runInGatewayScope(() => "ok", { onDegraded: warn });
    expect(result).toBe("ok");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/gateway scope unavailable/i);
  });

  it("only warns on the first degraded call (idempotent warning)", () => {
    const warn = vi.fn();
    runInGatewayScope(() => 1, { onDegraded: warn });
    runInGatewayScope(() => 2, { onDegraded: warn });
    runInGatewayScope(() => 3, { onDegraded: warn });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("default pluginId is 'brain-orchestrator'; option override applies", () => {
    const seen: Array<{ pluginId?: string }> = [];
    (globalThis as Record<symbol, unknown>)[KEY] = {
      run: <T>(store: { pluginId?: string }, fn: () => T): T => {
        seen.push(store);
        return fn();
      },
    };
    runInGatewayScope(() => 0);
    expect(seen[0]?.pluginId).toBe("brain-orchestrator");

    runInGatewayScope(() => 0, { pluginId: "custom" });
    expect(seen[1]?.pluginId).toBe("custom");
  });

  it("propagates the return value", () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      run: <T>(_store: unknown, fn: () => T): T => fn(),
    };
    expect(runInGatewayScope(() => "hello")).toBe("hello");
    expect(runInGatewayScope(() => 123)).toBe(123);
    expect(runInGatewayScope(() => ({ a: 1 }))).toEqual({ a: 1 });
  });
});

describe("resetGatewayScopeForTests", () => {
  it("clears the once-warned flag so subsequent degraded calls re-warn", () => {
    const warn = vi.fn();
    runInGatewayScope(() => 0, { onDegraded: warn });
    expect(warn).toHaveBeenCalledOnce();
    resetGatewayScopeForTests();
    runInGatewayScope(() => 0, { onDegraded: warn });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
