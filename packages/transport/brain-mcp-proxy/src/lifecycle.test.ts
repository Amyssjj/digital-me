import { afterEach, describe, expect, it, vi } from "vitest";
import { startParentPidWatcher } from "./lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startParentPidWatcher", () => {
  it("does nothing while the parent pid is unchanged", () => {
    vi.useFakeTimers();
    const onParentDied = vi.fn();
    const pid = 1234;
    const stop = startParentPidWatcher({
      initialPpid: 1234,
      readPpid: () => pid,
      pollMs: 1000,
      onParentDied,
    });
    vi.advanceTimersByTime(5000);
    expect(onParentDied).not.toHaveBeenCalled();
    stop();
  });

  it("calls onParentDied with the old and new ppid when ppid changes", () => {
    vi.useFakeTimers();
    const onParentDied = vi.fn();
    let pid = 1234;
    const stop = startParentPidWatcher({
      initialPpid: 1234,
      readPpid: () => pid,
      pollMs: 100,
      onParentDied,
    });
    pid = 1; // simulate reparent to init/launchd
    vi.advanceTimersByTime(150);
    expect(onParentDied).toHaveBeenCalledOnce();
    expect(onParentDied.mock.calls[0]![0]).toEqual({ initialPpid: 1234, currentPpid: 1 });
    stop();
  });

  it("clears its interval when onParentDied fires (no further polls)", () => {
    vi.useFakeTimers();
    const onParentDied = vi.fn();
    let pid = 1234;
    const stop = startParentPidWatcher({
      initialPpid: 1234,
      readPpid: () => pid,
      pollMs: 100,
      onParentDied,
    });
    pid = 1;
    vi.advanceTimersByTime(150);
    expect(onParentDied).toHaveBeenCalledOnce();
    // advance more — should still be exactly one call
    vi.advanceTimersByTime(500);
    expect(onParentDied).toHaveBeenCalledOnce();
    stop();
  });

  it("stop() halts polling before any tick fires", () => {
    vi.useFakeTimers();
    const onParentDied = vi.fn();
    const readPpid = vi.fn(() => 1234);
    const stop = startParentPidWatcher({
      initialPpid: 1234,
      readPpid,
      pollMs: 100,
      onParentDied,
    });
    stop();
    vi.advanceTimersByTime(1000);
    expect(readPpid).not.toHaveBeenCalled();
    expect(onParentDied).not.toHaveBeenCalled();
  });
});
