import { describe, expect, it, vi } from "vitest";
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
