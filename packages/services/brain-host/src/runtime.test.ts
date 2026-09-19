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
