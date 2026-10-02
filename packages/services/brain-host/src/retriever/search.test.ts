import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EmbedUnavailableError, HashEmbedder, type Embedder } from "./embedder.js";
import { buildIndex, ProvenanceMismatchError } from "./index-builder.js";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT, search, toFtsQuery, VectorCache } from "./search.js";
import { IndexStore } from "./store.js";
import { doc } from "./test-fixtures.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const roots = [{ dir: "/w", corpus: "wiki" as const }];

function corpus() {
  return [
    doc({
      path: "/w/kanban.md",
      relPath: "wiki/dashboard/kanban.md",
      title: "Kanban range filters by updated_at",
      entryText: "Kanban range filters by updated_at\nkanban board goals vanish from short windows use all time",
      fullText: "kanban board goals vanish from short windows use all time",
      sections: [
        { heading: "Rule", text: "kanban filters goals by updated_at", startLine: 3, endLine: 4 },
        { heading: "Apply when", text: "a goal vanished from the board window", startLine: 5, endLine: 6 },
      ],
    }),
    doc({
      path: "/w/pnpm.md",
      relPath: "wiki/dev/pnpm.md",
      title: "pnpm overrides live in workspace yaml",
      entryText: "pnpm overrides live in workspace yaml\nput overrides in pnpm-workspace.yaml not package.json",
      fullText: "put overrides in pnpm-workspace.yaml not package.json",
      sections: [{ heading: "Rule", text: "pnpm overrides go in pnpm-workspace.yaml", startLine: 3, endLine: 4 }],
    }),
    doc({
      path: "/t/leaf.md",
      relPath: "tastes/design/leaf.md",
      corpus: "tastes",
      title: "No italics",
      entryText: "No italics\nnever use italic eyebrows in decks",
      fullText: "never use italic eyebrows in decks",
      sections: [],
    }),
  ];
}

async function indexed() {
  const store = new IndexStore(new DatabaseSync(":memory:"));
  const embedder = new HashEmbedder(64);
  await buildIndex({ roots, store, embedder, scan: corpus });
  return { store, embedder, cache: new VectorCache(store) };
}

describe("search", () => {
  it("ranks the matching entry first with section-level line range and snippet", async () => {
    const { store, embedder, cache } = await indexed();
    const res = await search(store, cache, embedder, "kanban goals vanished from the board window", { limit: 3 });
    expect(res.count).toBe(3);
    expect(res.results[0]).toMatchObject({
      path: "/w/kanban.md",
      relPath: "wiki/dashboard/kanban.md",
      corpus: "wiki",
      startLine: 5,
      endLine: 6,
      source: "memory",
      citation: "wiki/dashboard/kanban.md#L5-L6",
    });
    expect(res.results[0]!.snippet).toMatch(/^Apply when: a goal vanished/);
    expect(res.results[0]!.textScore).toBeGreaterThan(0);
    expect(res.results[0]!.vectorScore).toBeGreaterThan(0);
    expect(res.provider).toBe("hash");
    expect(res.query).toBe("kanban goals vanished from the board window");
  });

  it("emits `score` on the 0..1 hook-gate scale and orders results by `fusedScore`", async () => {
    // Regression: `score` used to be the RRF fusion sum (~0.05 max), so every
    // recall hook (MIN_SCORE 0.4 on `score`) dropped every brain-host hit and
    // injected nothing. `score` must be the 0..1 relevance the openclaw
    // gateway emitted; the fusion sum is exposed separately as `fusedScore`.
    const { store, embedder, cache } = await indexed();
    const res = await search(store, cache, embedder, "kanban board goals vanish from short windows use all time", { limit: 3 });
    expect(res.count).toBe(3);
    const top = res.results[0]!;
    expect(top.path).toBe("/w/kanban.md");
    expect(top.score).toBeGreaterThanOrEqual(0.4);
    expect(top.score).toBeLessThanOrEqual(1);
    for (const hit of res.results) {
      expect(hit.score).toBe(hit.vectorScore);
      expect(hit.fusedScore).toBeGreaterThan(0);
      expect(hit.fusedScore).toBeLessThan(0.1);
    }
    const fused = res.results.map((r) => r.fusedScore);
    expect(fused).toEqual([...fused].sort((a, b) => b - a));
  });

  it("falls back to title snippet and line 1 for entries without sections, and filters by corpus", async () => {
    const { store, embedder, cache } = await indexed();
    const res = await search(store, cache, embedder, "italic eyebrows decks", { corpus: "tastes" });
    expect(res.results.map((r) => r.corpus)).toEqual(["tastes"]);
    expect(res.results[0]).toMatchObject({ startLine: 1, endLine: 1, snippet: "No italics" });
    const all = await search(store, cache, embedder, "italic eyebrows decks", { corpus: "all" });
    expect(all.count).toBe(3);
    const mem = await search(store, cache, embedder, "italic eyebrows decks", { corpus: "memory" });
    expect(mem.count).toBe(3);
  });

  it("applies the limit and default limit", async () => {
    const { store, embedder, cache } = await indexed();
    expect((await search(store, cache, embedder, "pnpm", { limit: 1 })).results.map((r) => r.path)).toEqual(["/w/pnpm.md"]);
    expect((await search(store, cache, embedder, "pnpm")).count).toBe(3);
  });

  it("survives a query with no lexical tokens and reuses the vector cache", async () => {
    const { store, embedder, cache } = await indexed();
    const res = await search(store, cache, embedder, "!!! ??? .", {});
    expect(res.count).toBe(3);
    expect(res.results.every((r) => r.textScore === 0)).toBe(true);
    cache.invalidate();
    expect((await search(store, cache, embedder, "pnpm")).count).toBe(3);
  });

  it("picks up a re-index done by another process (generation meta) without invalidate()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bh-gen-"));
    try {
      const file = join(dir, "retrieval.db");
      const serving = new IndexStore(new DatabaseSync(file));
      const embedder = new HashEmbedder(64);
      await buildIndex({ roots, store: serving, embedder, scan: corpus });
      const cache = new VectorCache(serving);
      expect((await search(serving, cache, embedder, "pnpm overrides workspace")).count).toBe(3);

      // A separate handle (as `brain-host index` from the CLI would be) adds an entry.
      const indexer = new IndexStore(new DatabaseSync(file));
      const extra = doc({
        path: "/w/new.md", relPath: "wiki/dev/new.md", title: "Brand new entry", hash: "hn",
        entryText: "Brand new entry\nzebra quokka platypus", fullText: "zebra quokka platypus",
        sections: [{ heading: "Rule", text: "zebra quokka platypus", startLine: 3, endLine: 4 }],
      });
      const r = await buildIndex({ roots, store: indexer, embedder, scan: () => [...corpus(), extra] });
      expect(r.generation).toBe(2);

      // Same cache object, no invalidate(): the next search sees the new entry.
      const res = await search(serving, cache, embedder, "zebra quokka platypus", { limit: 1 });
      expect(res.results[0]!.path).toBe("/w/new.md");
      // and a second search with an unchanged generation reuses the cache (no throw, same answer)
      expect((await search(serving, cache, embedder, "zebra quokka platypus", { limit: 1 })).results[0]!.path).toBe("/w/new.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips entries deleted between ranking and lookup", async () => {
    const { store, embedder, cache } = await indexed();
    cache.entryVecs(); // warm the cache
    cache.sectionVecs();
    store.deleteEntries(["/w/pnpm.md"]);
    const res = await search(store, cache, embedder, "pnpm overrides workspace");
    expect(res.results.map((r) => r.path)).not.toContain("/w/pnpm.md");
    expect(res.count).toBe(2);
  });

  it("answers lexical-only when the query embedding is unavailable, with no invented vector score", async () => {
    const { store, embedder, cache } = await indexed();
    const unavailable: Embedder = {
      provider: embedder.provider,
      model: embedder.model,
      dims: embedder.dims,
      embed: async () => {
        throw new EmbedUnavailableError("query embedding missed its 3500ms deadline");
      },
    };
    const res = await search(store, cache, unavailable, "pnpm overrides workspace yaml", { limit: 3 });
    expect(res.mode).toBe("lexical");
    expect(res.embedError).toBe("query embedding missed its 3500ms deadline");
    // FTS alone ranks: only entries that share a token with the query come back
    expect(res.results.map((r) => r.path)).toEqual(["/w/pnpm.md"]);
    expect(res.results[0]).toMatchObject({ score: 0, vectorScore: 0, textScore: 1, startLine: 3, endLine: 4, citation: "wiki/dev/pnpm.md#L3-L4" });
    expect(res.results[0]!.fusedScore).toBeGreaterThan(0);
    expect(res.results[0]!.snippet).toMatch(/^Rule: pnpm overrides/);
  });

  it("reports hybrid mode when the query was embedded", async () => {
    const { store, embedder, cache } = await indexed();
    const res = await search(store, cache, embedder, "pnpm");
    expect(res.mode).toBe("hybrid");
    expect(res).not.toHaveProperty("embedError");
  });

  it("still fails loudly on a permanent embedding error", async () => {
    const { store, embedder, cache } = await indexed();
    const broken: Embedder = {
      provider: embedder.provider,
      model: embedder.model,
      dims: embedder.dims,
      embed: async () => {
        throw new Error("gemini embed failed: HTTP 400 API key not valid");
      },
    };
    await expect(search(store, cache, broken, "pnpm")).rejects.toThrow(/HTTP 400 API key not valid/);
  });

  it("refuses an empty or mismatched index loudly", async () => {
    const store = new IndexStore(new DatabaseSync(":memory:"));
    const cache = new VectorCache(store);
    await expect(search(store, cache, new HashEmbedder(8), "x")).rejects.toThrow(/index is empty/);
    await buildIndex({ roots, store, embedder: new HashEmbedder(8), scan: corpus });
    await expect(search(store, cache, new HashEmbedder(16), "x")).rejects.toBeInstanceOf(ProvenanceMismatchError);
  });
});

describe("helpers", () => {
  it("toFtsQuery quotes and dedups tokens, caps at 24", () => {
    expect(toFtsQuery('kanban "range" kanban')).toBe('"kanban" OR "range"');
    expect(toFtsQuery("")).toBe("");
    const many = Array.from({ length: 30 }, (_, i) => `tok${i}`).join(" ");
    expect(toFtsQuery(many).split(" OR ")).toHaveLength(24);
  });
  it("clampLimit", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(3.7)).toBe(3);
    expect(clampLimit(10_000)).toBe(MAX_LIMIT);
  });
});
