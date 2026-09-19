import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { HashEmbedder } from "./embedder.js";
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

  it("skips entries deleted between ranking and lookup", async () => {
    const { store, embedder, cache } = await indexed();
    cache.entryVecs(); // warm the cache
    cache.sectionVecs();
    store.deleteEntries(["/w/pnpm.md"]);
    const res = await search(store, cache, embedder, "pnpm overrides workspace");
    expect(res.results.map((r) => r.path)).not.toContain("/w/pnpm.md");
    expect(res.count).toBe(2);
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
