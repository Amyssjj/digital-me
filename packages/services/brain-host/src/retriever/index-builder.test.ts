import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { HashEmbedder } from "./embedder.js";
import { buildIndex, ProvenanceMismatchError, provenanceLabel } from "./index-builder.js";
import { IndexStore } from "./store.js";
import { doc } from "./test-fixtures.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const roots = [{ dir: "/w", corpus: "wiki" as const }];

describe("buildIndex", () => {
  it("embeds new entries, skips unchanged, removes vanished, stamps provenance", async () => {
    const store = new IndexStore(new DatabaseSync(":memory:"));
    const embedder = new HashEmbedder(16);
    const lines: string[] = [];
    let docs = [doc({ path: "/w/a.md" }), doc({ path: "/w/b.md", hash: "hb" })];
    const r1 = await buildIndex({ roots, store, embedder, log: (l) => lines.push(l), scan: () => docs });
    expect(r1).toEqual({ scanned: 2, embedded: 2, unchanged: 0, removed: 0, vectors: 6, generation: 1 });
    expect(store.getMeta("index_generation")).toBe("1");
    expect(store.getProvenance()).toEqual({ provider: "hash", model: "bag-of-words-v1", dims: 16 });
    expect(store.getMeta("last_index_at")).toMatch(/^\d{4}-/);
    expect(lines.some((l) => l.includes("2 to embed"))).toBe(true);

    docs = [doc({ path: "/w/a.md" }), doc({ path: "/w/c.md", hash: "hc" })];
    const r2 = await buildIndex({ roots, store, embedder, scan: () => docs });
    expect(r2).toEqual({ scanned: 2, embedded: 1, unchanged: 1, removed: 1, vectors: 3, generation: 2 });
    expect([...store.hashes().keys()].sort()).toEqual(["/w/a.md", "/w/c.md"]);
  });

  it("refuses a provenance mismatch unless forced, and force clears first", async () => {
    const store = new IndexStore(new DatabaseSync(":memory:"));
    const docs = [doc({ path: "/w/a.md" })];
    await buildIndex({ roots, store, embedder: new HashEmbedder(8), scan: () => docs });
    await expect(buildIndex({ roots, store, embedder: new HashEmbedder(16), scan: () => docs })).rejects.toBeInstanceOf(ProvenanceMismatchError);

    const lines: string[] = [];
    const r = await buildIndex({ roots, store, embedder: new HashEmbedder(16), force: true, scan: () => docs, log: (l) => lines.push(l) });
    expect(r.embedded).toBe(1);
    expect(store.getProvenance()!.dims).toBe(16);
    expect(lines[0]).toMatch(/provenance changed/);

    // force with the same provenance also re-embeds everything
    const r2 = await buildIndex({ roots, store, embedder: new HashEmbedder(16), force: true, scan: () => docs });
    expect(r2.embedded).toBe(1);
  });

  it("uses the real scanner by default (empty roots → nothing indexed)", async () => {
    const store = new IndexStore(new DatabaseSync(":memory:"));
    const r = await buildIndex({ roots: [{ dir: "/nonexistent/bh", corpus: "wiki" }], store, embedder: new HashEmbedder(8) });
    expect(r.scanned).toBe(0);
  });

  it("labels provenance", () => {
    expect(provenanceLabel({ provider: "gemini", model: "m", dims: 768 })).toBe("gemini/m@768");
  });
});
