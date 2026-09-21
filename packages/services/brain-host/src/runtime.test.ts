import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { GeminiEmbedder, HashEmbedder } from "./retriever/embedder.js";
import { BrainHostRuntime, selectEmbedder, VERSION } from "./runtime.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixture() {
  dir = mkdtempSync(join(tmpdir(), "bh-rt-"));
  mkdirSync(join(dir, "wiki", "a"), { recursive: true });
  writeFileSync(join(dir, "wiki", "a", "one.md"), "---\ntitle: One thing\n---\n## Rule\nalpha beta\n## Apply when\ngamma\n");
  return loadConfig({ DIGITAL_ME_WIKI_ROOT: dir }, "/h");
}

describe("BrainHostRuntime", () => {
  it("creates the db directory, indexes, searches, and reports health", async () => {
    const config = fixture();
    const logs: string[] = [];
    const rt = new BrainHostRuntime({ config, offline: true, openDb: (p) => new DatabaseSync(p), log: (l) => logs.push(l) });
    expect(existsSync(join(dir, ".data"))).toBe(true);
    const r = await rt.index(false);
    expect(r).toMatchObject({ scanned: 1, embedded: 1, vectors: 3 });
    expect(logs.length).toBeGreaterThan(0);
    const env = await rt.invoke("memory_search", { query: "alpha beta" });
    expect(env.ok && env.result.details.count).toBe(1);
    expect(rt.health()).toMatchObject({ version: VERSION, entries: 1, sections: 2, dbPath: join(dir, ".data", "retrieval.db"), wikiRoot: dir });
    expect(rt.health().provenance).toEqual({ provider: "hash", model: "bag-of-words-v1", dims: 256 });
    // incremental: nothing to embed the second time, cache still valid
    expect((await rt.index(false)).embedded).toBe(0);
    expect((await rt.invoke("wiki", {})).ok).toBe(true);
  });

  it("accepts an injected embedder and works without a log", async () => {
    const config = fixture();
    const rt = new BrainHostRuntime({ config, offline: false, openDb: () => new DatabaseSync(":memory:"), embedder: new HashEmbedder(8) });
    await rt.index(true);
    expect(rt.embedder.dims).toBe(8);
  });
});

describe("BrainHostRuntime index refresh", () => {
  it("re-indexes on a timer, logs only when something changed, and reports in health", async () => {
    const config = fixture();
    const logs: string[] = [];
    const rt = new BrainHostRuntime({ config, offline: true, openDb: () => new DatabaseSync(":memory:"), log: (l) => logs.push(l) });
    await rt.index(false);
    let cb: (() => void) | null = null;
    const fakeSet = ((fn: () => void) => {
      cb = fn;
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    rt.startIndexRefresh(fakeSet);
    rt.startIndexRefresh(fakeSet); // idempotent
    expect(logs.some((l) => l.includes("index refresh every"))).toBe(true);
    const h1 = rt.health() as { indexRefresh: { active: boolean; last: unknown }; indexGeneration: string };
    expect(h1.indexRefresh.active).toBe(true);
    expect(h1.indexGeneration).toBe("1");

    // nothing changed → refresh runs silently
    cb!();
    await new Promise((r) => setTimeout(r, 20));
    expect(logs.filter((l) => l.startsWith("index refresh:")).length).toBe(0);
    expect((rt.health() as { indexGeneration: string }).indexGeneration).toBe("2");

    // a new wiki entry → refresh embeds it and logs once
    writeFileSync(join(dir, "wiki", "a", "two.md"), "---\ntitle: Two\n---\n## Rule\ndelta\n");
    await rt.refreshIndex();
    expect(logs.some((l) => l.startsWith("index refresh: 1 embedded, 0 removed, 2 total"))).toBe(true);
    const last = (rt.health() as { indexRefresh: { last: { result?: { embedded: number } } } }).indexRefresh.last;
    expect(last.result?.embedded).toBe(1);

    let cleared = 0;
    rt.close((() => { cleared++; }) as unknown as typeof clearInterval);
    rt.close((() => { cleared++; }) as unknown as typeof clearInterval);
    expect(cleared).toBe(1);
    expect((rt.health() as { indexRefresh: { active: boolean } }).indexRefresh.active).toBe(false);
  });

  it("does not start when disabled, never overlaps itself, and records errors", async () => {
    const config = { ...fixture(), indexRefreshMs: 0 };
    const rt = new BrainHostRuntime({ config, offline: true, openDb: () => new DatabaseSync(":memory:") });
    rt.startIndexRefresh();
    expect((rt.health() as { indexRefresh: { active: boolean } }).indexRefresh.active).toBe(false);

    // overlapping: the second call returns immediately while the first is in flight
    let release: (() => void) | null = null;
    const slow = {
      provider: "hash", model: "bag-of-words-v1", dims: 8,
      embed: () => new Promise<Float32Array[]>((res) => { release = () => res([]); }),
    };
    const logs: string[] = [];
    const rt2 = new BrainHostRuntime({ config, offline: true, openDb: () => new DatabaseSync(":memory:"), embedder: slow, log: (l) => logs.push(l) });
    const p1 = rt2.refreshIndex();
    await rt2.refreshIndex(); // returns early: refreshing
    release!();
    await p1;
    // an empty embed result → buildIndex throws (vecs[cursor] undefined) → recorded, not thrown
    expect(logs.some((l) => l.startsWith("index refresh failed:"))).toBe(true);
    expect((rt2.health() as { indexRefresh: { last: { error?: string } } }).indexRefresh.last.error).toBeTruthy();
  });

  it("uses real timers by default and starts when configured", () => {
    const rt = new BrainHostRuntime({ config: fixture(), offline: true, openDb: () => new DatabaseSync(":memory:") });
    rt.startIndexRefresh();
    expect((rt.health() as { indexRefresh: { active: boolean } }).indexRefresh.active).toBe(true);
    rt.close();
  });
});

describe("BrainHostRuntime with orchestrator", () => {
  it("mounts orchestrator tools, serves them, reports them in health, and honours the scheduler flag", async () => {
    const config = { ...fixture(), brainDbPath: join(dir, ".data", "brain.db"), schedulerEnabled: true, tickIntervalMs: 60_000 };
    const rt = new BrainHostRuntime({ config, offline: true, openDb: (p) => new DatabaseSync(p), orchestrator: true, execRun: async () => ({ success: true, timedOut: false, stdout: "", stderr: "" }) });
    expect(rt.orchestrator).not.toBeNull();
    const board = await rt.invoke("tasks", { action: "board" });
    expect(board.ok).toBe(true);
    const h = rt.health() as { orchestrator: { scheduler: string; tools: string[]; brainDb: string } };
    expect(h.orchestrator.scheduler).toBe("on");
    expect(h.orchestrator.tools).toContain("tasks");
    expect(h.orchestrator.brainDb).toBe(config.brainDbPath);
    rt.close();
    rt.close();
    expect((rt.health() as { orchestrator: { scheduler: string } }).orchestrator.scheduler).toBe("off");
  });

  it("does not mount the orchestrator by default and close() is a no-op", () => {
    const rt = new BrainHostRuntime({ config: fixture(), offline: true, openDb: () => new DatabaseSync(":memory:") });
    expect(rt.orchestrator).toBeNull();
    expect(rt.health().orchestrator).toBeNull();
    rt.close();
  });

  it("mounts with the default exec runner and scheduler off", () => {
    const config = { ...fixture(), brainDbPath: join(dir, "brain.db") };
    const rt = new BrainHostRuntime({ config, offline: true, openDb: (p) => new DatabaseSync(p), orchestrator: true });
    expect((rt.health() as { orchestrator: { scheduler: string } }).orchestrator.scheduler).toBe("off");
  });

  it("warns once at mount when brain.db still sits at the legacy openclaw location, and reports the source on /health", () => {
    const logs: string[] = [];
    const config = { ...fixture(), brainDbPath: join(dir, "brain.db"), brainDbSource: "legacy-openclaw" as const };
    const rt = new BrainHostRuntime({ config, offline: true, openDb: (p) => new DatabaseSync(p), orchestrator: true, log: (l) => logs.push(l) });
    expect(logs.filter((l) => l.includes("legacy openclaw location"))).toHaveLength(1);
    expect((rt.health() as { orchestrator: { brainDbSource: string } }).orchestrator.brainDbSource).toBe("legacy-openclaw");
    rt.close();
  });
});

describe("selectEmbedder", () => {
  it("picks hash offline, gemini with a key, and errors without one", () => {
    const base = loadConfig({}, "/h");
    expect(selectEmbedder(base, true)).toBeInstanceOf(HashEmbedder);
    expect(() => selectEmbedder(base, false)).toThrow(/GEMINI_API_KEY/);
    const g = selectEmbedder(loadConfig({ GEMINI_API_KEY: "k", DIGITAL_ME_EMBED_DIMS: "1536" }, "/h"), false);
    expect(g).toBeInstanceOf(GeminiEmbedder);
    expect(g.dims).toBe(1536);
  });
});
