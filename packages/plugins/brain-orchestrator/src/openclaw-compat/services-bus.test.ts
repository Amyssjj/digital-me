import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearServicesBus,
  consumeService,
  publishService,
  readServicesBus,
} from "./services-bus.js";

beforeEach(() => {
  clearServicesBus();
});

afterEach(() => {
  clearServicesBus();
});

describe("publishService / consumeService", () => {
  it("returns undefined for an unpublished service", () => {
    expect(consumeService("missing")).toBeUndefined();
  });

  it("returns the published implementation when present", () => {
    const impl = { record: (): string => "hi" };
    publishService("recorder", impl);
    expect(consumeService("recorder")).toBe(impl);
  });

  it("preserves existing services when publishing a new one", () => {
    publishService("a", { value: 1 });
    publishService("b", { value: 2 });
    expect(consumeService<{ value: number }>("a")?.value).toBe(1);
    expect(consumeService<{ value: number }>("b")?.value).toBe(2);
  });

  it("overwrites a previously published service with the same name", () => {
    publishService("svc", { v: 1 });
    publishService("svc", { v: 2 });
    expect(consumeService<{ v: number }>("svc")?.v).toBe(2);
  });

  it("survives publishing into an empty bus (creates namespace on demand)", () => {
    // After clearServicesBus(), globalThis.__digitalMeServices is undefined.
    expect(readServicesBus()).toBeUndefined();
    publishService("svc", { ok: true });
    expect(readServicesBus()).toBeDefined();
    expect(consumeService<{ ok: boolean }>("svc")?.ok).toBe(true);
  });

  it("typed consumer can request a specific shape via generic", () => {
    type Recorder = { record: (n: number) => number };
    publishService<Recorder>("r", { record: (n) => n * 2 });
    const r = consumeService<Recorder>("r");
    expect(r?.record(21)).toBe(42);
  });
});

describe("clearServicesBus", () => {
  it("removes all services and the namespace itself", () => {
    publishService("a", 1);
    publishService("b", 2);
    expect(readServicesBus()).toBeDefined();
    clearServicesBus();
    expect(readServicesBus()).toBeUndefined();
    expect(consumeService("a")).toBeUndefined();
    expect(consumeService("b")).toBeUndefined();
  });

  it("is safe to call when bus is already empty", () => {
    expect(() => clearServicesBus()).not.toThrow();
    expect(() => clearServicesBus()).not.toThrow();
  });
});

describe("readServicesBus", () => {
  it("returns undefined when nothing has been published", () => {
    expect(readServicesBus()).toBeUndefined();
  });

  it("returns the live record after publishing", () => {
    publishService("a", "value-a");
    const bus = readServicesBus();
    expect(bus).toBeDefined();
    expect(bus?.a).toBe("value-a");
  });
});
