import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TtlCache", () => {
  it("returns null for an unknown key", () => {
    const c = new TtlCache(1_000);
    expect(c.get<string>("missing")).toBeNull();
  });

  it("returns a previously set value within the TTL", () => {
    const c = new TtlCache(1_000);
    c.set("k", { n: 42 });
    expect(c.get<{ n: number }>("k")).toEqual({ n: 42 });
  });

  it("returns null after the entry has expired", () => {
    const c = new TtlCache(1_000);
    c.set("k", "v");
    vi.advanceTimersByTime(1_500);
    expect(c.get<string>("k")).toBeNull();
  });

  it("honors a per-set TTL override", () => {
    const c = new TtlCache(10_000);
    c.set("k", "v", 200);
    vi.advanceTimersByTime(300);
    expect(c.get<string>("k")).toBeNull();
  });

  it("preserves separate values for different keys", () => {
    const c = new TtlCache(1_000);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get<number>("a")).toBe(1);
    expect(c.get<number>("b")).toBe(2);
  });

  it("overwrites a value when set with the same key", () => {
    const c = new TtlCache(1_000);
    c.set("k", "first");
    c.set("k", "second");
    expect(c.get<string>("k")).toBe("second");
  });

  it("deletes expired entry on access (returns null)", () => {
    const c = new TtlCache(100);
    c.set("k", "v");
    vi.advanceTimersByTime(150);
    expect(c.get<string>("k")).toBeNull();
    // After get returned null, a fresh set should work cleanly.
    c.set("k", "rest");
    expect(c.get<string>("k")).toBe("rest");
  });

  it("sweep() removes expired entries in bulk", () => {
    const c = new TtlCache(1_000);
    c.set("alive", "a", 10_000);
    c.set("dead", "d", 100);
    vi.advanceTimersByTime(200);
    c.sweep();
    // alive remains accessible, dead is gone.
    expect(c.get<string>("alive")).toBe("a");
    // After sweep, the entry is removed — get returns null without further check.
    expect(c.get<string>("dead")).toBeNull();
  });

  it("clear() empties the cache", () => {
    const c = new TtlCache(1_000);
    c.set("a", 1);
    c.set("b", 2);
    c.clear();
    expect(c.get("a")).toBeNull();
    expect(c.get("b")).toBeNull();
  });

  it("size() reports the current entry count (including expired-but-uncollected)", () => {
    const c = new TtlCache(1_000);
    expect(c.size()).toBe(0);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.size()).toBe(2);
    c.clear();
    expect(c.size()).toBe(0);
  });
});
