import { afterEach, describe, expect, it, vi } from "vitest";
import realNodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bucketKeyFor,
  createAppRateWriter,
  defaultLogPathForAgent,
  extractHitPaths,
  normaliseWikiPath,
  type AppRateFs,
} from "./app-rate-writer.js";
import type { CallToolResult } from "./gateway.js";

describe("bucketKeyFor", () => {
  it("partitions buckets per (agent, UTC day)", () => {
    const day1 = new Date("2026-05-26T10:00:00Z").getTime();
    const day2 = new Date("2026-05-27T01:00:00Z").getTime();
    expect(bucketKeyFor("coo", day1)).toBe("coo::2026-05-26");
    expect(bucketKeyFor("coo", day2)).toBe("coo::2026-05-27");
    expect(bucketKeyFor("hermes-discord", day1)).toBe(
      "hermes-discord::2026-05-26",
    );
  });
});

describe("extractHitPaths", () => {
  it("parses memory_search response payload into hit paths", () => {
    const result: CallToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              { path: "wiki/foo/bar.md", score: 0.9 },
              { path: "wiki/baz/qux.md", score: 0.7 },
              { path: "", score: 0.5 }, // empty path should be dropped
              { score: 0.4 }, // missing path should be dropped
            ],
          }),
        },
      ],
    };
    expect(extractHitPaths(result)).toEqual([
      "wiki/foo/bar.md",
      "wiki/baz/qux.md",
    ]);
  });

  it("returns empty array for non-JSON text", () => {
    expect(
      extractHitPaths({ content: [{ type: "text", text: "not json" }] }),
    ).toEqual([]);
  });

  it("returns empty array for empty content", () => {
    expect(extractHitPaths({ content: [] })).toEqual([]);
  });

  it("returns empty array when the text payload is not a string", () => {
    expect(
      extractHitPaths({
        content: [{ type: "text", text: 42 as unknown as string }],
      }),
    ).toEqual([]);
  });

  it("returns empty array when the JSON payload has no results array", () => {
    expect(
      extractHitPaths({
        content: [{ type: "text", text: JSON.stringify({ other: 1 }) }],
      }),
    ).toEqual([]);
  });
});

describe("normaliseWikiPath", () => {
  it("strips both the cwd-relative encoding AND the leading wiki/ for set-intersection", () => {
    // memory_search returns this form
    expect(
      normaliseWikiPath("../../../../home/test/digital-me/wiki/foo/bar.md"),
    ).toBe("foo/bar.md");
    // memory_get takes the bare form — both should normalise to the same key
    expect(normaliseWikiPath("foo/bar.md")).toBe("foo/bar.md");
  });
  it("strips a leading wiki/ from canonical paths so they intersect bare-form get args", () => {
    expect(normaliseWikiPath("wiki/foo/bar.md")).toBe("foo/bar.md");
  });
  it("keeps tastes/ (distinct tree)", () => {
    expect(normaliseWikiPath("tastes/foo/bar.md")).toBe("tastes/foo/bar.md");
  });
  it("filters memory/ paths (per-agent state, not corpus)", () => {
    expect(normaliseWikiPath("memory/abc/123.md")).toBeNull();
  });
  it("filters absolute paths it can't classify", () => {
    expect(normaliseWikiPath("/etc/passwd")).toBeNull();
  });
  it("returns null for empty input", () => {
    expect(normaliseWikiPath("")).toBeNull();
  });
  it("returns null when nothing follows the /wiki/ marker", () => {
    expect(normaliseWikiPath("/home/test/digital-me/wiki/")).toBeNull();
  });
  it("returns null for a bare wiki/ prefix with nothing after it", () => {
    expect(normaliseWikiPath("wiki/")).toBeNull();
  });
});

describe("defaultLogPathForAgent", () => {
  const paths = { openclawLog: "/oc.log", hermesLog: "/h.log" };
  it("routes hermes-* agents to the hermes log + surface=hermes", () => {
    expect(defaultLogPathForAgent("hermes-discord", paths)).toEqual({
      path: "/h.log",
      surface: "hermes",
    });
    expect(defaultLogPathForAgent("hermes", paths)).toEqual({
      path: "/h.log",
      surface: "hermes",
    });
  });
  it("skips claude-code agents (they have their own Stop-hook writer)", () => {
    expect(defaultLogPathForAgent("claude-code", paths)).toBeNull();
    expect(defaultLogPathForAgent("unknown:claude", paths)).toBeNull();
  });
  it("routes openclaw subagents (coo, youtube, main, podcast) to the openclaw log", () => {
    for (const agent of ["coo", "youtube", "main", "podcast"]) {
      expect(defaultLogPathForAgent(agent, paths)).toEqual({
        path: "/oc.log",
        surface: "openclaw",
      });
    }
  });
  it("routes empty/unknown agents to openclaw (best-effort)", () => {
    expect(defaultLogPathForAgent("", paths)).toEqual({
      path: "/oc.log",
      surface: "openclaw",
    });
  });
});

function fakeFs(): {
  fs: AppRateFs;
  writes: { path: string; data: string }[];
  mkdirs: { path: string }[];
} {
  const writes: { path: string; data: string }[] = [];
  const mkdirs: { path: string }[] = [];
  return {
    fs: {
      mkdirSync: (p) => {
        mkdirs.push({ path: p });
      },
      appendFileSync: (p, data) => {
        writes.push({ path: p, data });
      },
    },
    writes,
    mkdirs,
  };
}

function memorySearchResult(paths: string[]): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          results: paths.map((p, i) => ({ path: p, score: 0.9 - i * 0.05 })),
        }),
      },
    ],
  };
}

describe("createAppRateWriter — recordSearch + flushAll integration", () => {
  it("writes a record after memory_search + memory_get + flush", () => {
    const { fs, writes } = fakeFs();
    const t0 = new Date("2026-05-26T10:00:00Z").getTime();
    const clock = t0;
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/openclaw.log", surface: "openclaw" }),
      flushIntervalMs: 0, // no automatic timer in tests
      fs,
      now: () => clock,
    });

    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md", "wiki/bar/b.md"]),
    });
    // memory_get takes bare paths (no "wiki/" prefix) — set-intersection
    // hinges on both call sites normalising to the same canonical form.
    writer.recordGet({
      agentId: "coo",
      toolName: "memory_get",
      args: { path: "foo/a.md" },
    });

    writer.flushAll("manual");
    expect(writes).toHaveLength(1);
    const rec = JSON.parse(writes[0].data);
    expect(rec.agent_id).toBe("coo");
    expect(rec.surface).toBe("openclaw");
    expect(rec.surfaced_unique).toBe(2);
    expect(rec.acted_unique).toBe(1);
    expect(rec.application_rate).toBeCloseTo(0.5);
    expect(rec.acted_paths).toEqual(["foo/a.md"]);
    expect(rec.ignored_paths).toEqual(["bar/b.md"]);
    expect(rec.flush_reason).toBe("manual");
    expect(rec.hook_injections).toBe(1);
    expect(rec.session_id).toBe("coo::2026-05-26");
  });

  it("skips a second flush if no new activity (no duplicate records)", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/openclaw.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => new Date("2026-05-26T10:00:00Z").getTime(),
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.flushAll("manual");
    writer.flushAll("manual"); // no-op
    expect(writes).toHaveLength(1);
  });

  it("emits a new record after additional activity following a flush", () => {
    const { fs, writes } = fakeFs();
    let clock = new Date("2026-05-26T10:00:00Z").getTime();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/openclaw.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => clock,
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.flushAll("manual");
    clock += 60_000;
    writer.recordGet({
      agentId: "coo",
      toolName: "memory_get",
      args: { path: "wiki/foo/a.md" },
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1].data).acted_unique).toBe(1);
  });

  it("skips logPath===null agents (e.g. claude-code)", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => null,
      flushIntervalMs: 0,
      fs,
      now: () => Date.now(),
    });
    writer.recordSearch({
      agentId: "claude-code",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(0);
  });

  it("routes hermes agents to the hermes log + sets surface=hermes", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: (a) =>
        defaultLogPathForAgent(a, {
          openclawLog: "/tmp/oc.log",
          hermesLog: "/tmp/h.log",
        }),
      flushIntervalMs: 0,
      fs,
      now: () => Date.now(),
    });
    writer.recordSearch({
      agentId: "hermes-discord",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/tmp/h.log");
    const rec = JSON.parse(writes[0].data);
    expect(rec.surface).toBe("hermes");
  });

  it("ignores non-memory tool calls", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => Date.now(),
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "tasks", // not memory_search → no-op
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.recordGet({
      agentId: "coo",
      toolName: "tasks", // not memory_get → no-op
      args: { path: "wiki/foo/a.md" },
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(0);
  });

  it("ignores error responses from memory_search", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => Date.now(),
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: { ...memorySearchResult(["wiki/foo/a.md"]), isError: true },
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(0);
  });

  it("stale-bucket GC drops state after inactivity window", () => {
    const { fs, writes } = fakeFs();
    let clock = new Date("2026-05-26T10:00:00Z").getTime();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      staleBucketMs: 60_000, // 1 min for the test
      fs,
      now: () => clock,
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(1);

    clock += 120_000; // skip past staleness threshold
    writer.flushAll("manual");
    // Stale-flush wrote one more record (final snapshot) then dropped state.
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1].data).flush_reason).toBe("stale");

    clock += 60_000;
    writer.flushAll("manual");
    // No state left → no more records.
    expect(writes).toHaveLength(2);
  });

  it("never throws when fs.appendFileSync fails (must not affect tool calls)", () => {
    const warn = vi.fn();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs: {
        mkdirSync: () => {},
        appendFileSync: () => {
          throw new Error("disk full");
        },
      },
      now: () => Date.now(),
      warn,
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    expect(() => writer.flushAll("manual")).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("app_rate write failed"),
    );
  });

  it("shutdown() flushes and is idempotent", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => Date.now(),
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.shutdown();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].data).flush_reason).toBe("exit");
    writer.shutdown(); // no-op
    expect(writes).toHaveLength(1);
  });
});

describe("createAppRateWriter — record edge cases", () => {
  it("ignores memory_search responses with zero hits (no bucket created)", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => Date.now(),
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult([]),
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(0);
  });

  it("records application_rate=null when every hit normalises away (injection still counted)", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => new Date("2026-05-26T10:00:00Z").getTime(),
    });
    // memory/ + absolute paths both normalise to null → surfaced stays empty.
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["memory/abc/1.md", "/etc/passwd"]),
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(1);
    const rec = JSON.parse(writes[0].data);
    expect(rec.hook_injections).toBe(1);
    expect(rec.surfaced_unique).toBe(0);
    expect(rec.application_rate).toBeNull();
  });

  it("a repeat search with no new paths keeps the bucket alive without re-flushing", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => new Date("2026-05-26T10:00:00Z").getTime(),
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.flushAll("manual");
    // Identical hit set → added=0, hookInjections=2 → keep-alive, no bump.
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(1);
  });

  it("never writes a record for a get-only bucket (no surfaced, no injections)", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => Date.now(),
    });
    writer.recordGet({
      agentId: "coo",
      toolName: "memory_get",
      args: { path: "foo/a.md" },
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(0);
  });

  it("stale GC drops a get-only bucket without ever writing", () => {
    const { fs, writes } = fakeFs();
    let clock = new Date("2026-05-26T10:00:00Z").getTime();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      staleBucketMs: 60_000,
      fs,
      now: () => clock,
    });
    writer.recordGet({
      agentId: "coo",
      toolName: "memory_get",
      args: { path: "foo/a.md" },
    });
    clock += 120_000;
    writer.flushAll("manual");
    expect(writes).toHaveLength(0);
    // Bucket was dropped — nothing left to flush on later passes either.
    writer.flushAll("manual");
    expect(writes).toHaveLength(0);
  });

  it("stale GC drops buckets of skipped runtimes (logPath=null) silently", () => {
    const { fs, writes } = fakeFs();
    let clock = new Date("2026-05-26T10:00:00Z").getTime();
    const writer = createAppRateWriter({
      logPathForAgent: () => null,
      flushIntervalMs: 0,
      staleBucketMs: 60_000,
      fs,
      now: () => clock,
    });
    writer.recordSearch({
      agentId: "claude-code",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    clock += 120_000;
    writer.flushAll("manual");
    expect(writes).toHaveLength(0);
  });

  it("flushAll warns and continues when logPathForAgent itself throws (non-Error)", () => {
    const { fs } = fakeFs();
    const warn = vi.fn();
    const writer = createAppRateWriter({
      logPathForAgent: () => {
        // Non-Error throwable — exercises the String(err) fallback too.
        throw "policy exploded";
      },
      flushIntervalMs: 0,
      fs,
      now: () => Date.now(),
      warn,
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    expect(() => writer.flushAll("manual")).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("app_rate flush failed"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("policy exploded"),
    );
  });

  it("uses a no-op warn by default (write failure still never throws)", () => {
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs: {
        mkdirSync: () => {},
        appendFileSync: () => {
          throw new Error("disk full");
        },
      },
      now: () => Date.now(),
      // no warn injected — default () => {} must absorb the failure
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    expect(() => writer.flushAll("manual")).not.toThrow();
  });

  it("recordSearch never throws when the clock is broken", () => {
    const { fs } = fakeFs();
    const warn = vi.fn();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => {
        throw new Error("clock broken");
      },
      warn,
    });
    expect(() =>
      writer.recordSearch({
        agentId: "coo",
        toolName: "memory_search",
        result: memorySearchResult(["wiki/foo/a.md"]),
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("recordSearch failed"),
    );
  });

  it("recordGet never throws when the clock is broken", () => {
    const { fs } = fakeFs();
    const warn = vi.fn();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => {
        throw new Error("clock broken");
      },
      warn,
    });
    expect(() =>
      writer.recordGet({
        agentId: "coo",
        toolName: "memory_get",
        args: { path: "foo/a.md" },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("recordGet failed"),
    );
  });

  it("recordGet accepts the file_path alias for path", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => new Date("2026-05-26T10:00:00Z").getTime(),
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.recordGet({
      agentId: "coo",
      toolName: "memory_get",
      args: { file_path: "foo/a.md" },
    });
    writer.flushAll("manual");
    expect(JSON.parse(writes[0].data).acted_paths).toEqual(["foo/a.md"]);
  });

  it("recordGet ignores missing, empty, and unmappable paths", () => {
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => Date.now(),
    });
    writer.recordGet({ agentId: "coo", toolName: "memory_get", args: {} });
    writer.recordGet({
      agentId: "coo",
      toolName: "memory_get",
      args: { path: "" },
    });
    writer.recordGet({
      agentId: "coo",
      toolName: "memory_get",
      args: { path: "memory/abc/1.md" }, // normalises to null
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(0);
  });

  it("mkdirs '.' when the log path has no directory component", () => {
    const { fs, writes, mkdirs } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => Date.now(),
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    writer.flushAll("manual");
    expect(writes).toHaveLength(1);
    expect(mkdirs[0].path).toBe(".");
  });
});

describe("createAppRateWriter — periodic flush timer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts an unref'd interval timer that flushes with reason=periodic", () => {
    let tick: (() => void) | undefined;
    const unref = vi.fn();
    vi.stubGlobal("setInterval", ((fn: () => void) => {
      tick = fn;
      return { unref } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval);
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 60_000,
      fs,
      now: () => new Date("2026-05-26T10:00:00Z").getTime(),
    });
    expect(unref).toHaveBeenCalledOnce();
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    tick!();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].data).flush_reason).toBe("periodic");
  });

  it("warns instead of throwing when a periodic flush crashes", () => {
    let tick: (() => void) | undefined;
    vi.stubGlobal("setInterval", ((fn: () => void) => {
      tick = fn;
      // Plain numeric handle — also exercises the "no unref" timer shape.
      return 42 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval);
    const warn = vi.fn();
    let broken = false;
    createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 60_000,
      fs: fakeFs().fs,
      now: () => {
        if (broken) throw new Error("clock broken");
        return Date.now();
      },
      warn,
    });
    broken = true;
    expect(() => tick!()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("periodic flush crashed"),
    );
  });

  it("shutdown still emits the exit flush when clearInterval throws", () => {
    vi.stubGlobal("setInterval", (() =>
      42 as unknown as NodeJS.Timeout) as unknown as typeof setInterval);
    vi.stubGlobal("clearInterval", (() => {
      throw new Error("timer subsystem gone");
    }) as unknown as typeof clearInterval);
    const { fs, writes } = fakeFs();
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 60_000,
      fs,
      now: () => new Date("2026-05-26T10:00:00Z").getTime(),
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    expect(() => writer.shutdown()).not.toThrow();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].data).flush_reason).toBe("exit");
  });

  it("shutdown swallows a crashing final flush", () => {
    const { fs, writes } = fakeFs();
    let broken = false;
    const writer = createAppRateWriter({
      logPathForAgent: () => ({ path: "/tmp/oc.log", surface: "openclaw" }),
      flushIntervalMs: 0,
      fs,
      now: () => {
        if (broken) throw new Error("clock broken");
        return Date.now();
      },
    });
    writer.recordSearch({
      agentId: "coo",
      toolName: "memory_search",
      result: memorySearchResult(["wiki/foo/a.md"]),
    });
    broken = true;
    expect(() => writer.shutdown()).not.toThrow();
    expect(writes).toHaveLength(0);
  });
});

describe("createAppRateWriter — real filesystem default", () => {
  it("writes JSONL to disk when no fs is injected", () => {
    const tmpDir = realNodeFs.mkdtempSync(
      path.join(os.tmpdir(), "app-rate-writer-test-"),
    );
    try {
      const logPath = path.join(tmpDir, "nested", "application_rate.log");
      const writer = createAppRateWriter({
        logPathForAgent: () => ({ path: logPath, surface: "openclaw" }),
        flushIntervalMs: 0,
        now: () => new Date("2026-05-26T10:00:00Z").getTime(),
      });
      writer.recordSearch({
        agentId: "coo",
        toolName: "memory_search",
        result: memorySearchResult(["wiki/foo/a.md"]),
      });
      writer.flushAll("manual");
      const lines = realNodeFs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).agent_id).toBe("coo");
    } finally {
      realNodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
