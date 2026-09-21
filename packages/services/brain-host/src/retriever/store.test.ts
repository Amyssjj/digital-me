import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { doc } from "./test-fixtures.js";
import { IndexStore } from "./store.js";
import { normalize } from "./vec.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const v = (x: number) => normalize([x, 1, 0]);

describe("IndexStore", () => {
  it("stores provenance and meta", () => {
    const s = new IndexStore(new DatabaseSync(":memory:"));
    expect(s.getProvenance()).toBeNull();
    s.setProvenance({ provider: "hash", model: "m", dims: 3 });
    s.setProvenance({ provider: "hash", model: "m2", dims: 3 });
    expect(s.getProvenance()).toEqual({ provider: "hash", model: "m2", dims: 3 });
    expect(s.getMeta("k")).toBeNull();
    s.setMeta("k", "1");
    s.setMeta("k", "2");
    expect(s.getMeta("k")).toBe("2");
  });

  it("upserts entries with sections and fts, replaces on re-upsert, deletes, clears", () => {
    const s = new IndexStore(new DatabaseSync(":memory:"));
    s.upsertEntry(doc({ path: "/w/a.md" }), v(1), [v(2), v(3)]);
    s.upsertEntry(doc({ path: "/w/b.md", hash: "h2", corpus: "tastes" }), v(4), [v(5), v(6)]);
    expect(s.stats()).toEqual({ entries: 2, sections: 4, byCorpus: { wiki: 1, tastes: 1 } });
    expect(s.hashes()).toEqual(new Map([["/w/a.md", "h1"], ["/w/b.md", "h2"]]));

    s.upsertEntry(doc({ path: "/w/a.md", hash: "h9", fullText: "fresh body", sections: [{ heading: "Rule", text: "new", startLine: 1, endLine: 2 }] }), v(7), [v(8)]);
    expect(s.stats().sections).toBe(3);
    expect(s.getEntry("/w/a.md")).toMatchObject({ hash: "h9", relPath: "wiki/d/a.md", tags: "x" });
    expect(s.getEntry("/nope")).toBeNull();

    const secs = s.sectionVectors();
    expect(secs).toHaveLength(3);
    const first = s.firstSection("/w/a.md");
    expect(first).toMatchObject({ heading: "Rule", text: "new", startLine: 1, endLine: 2 });
    expect(s.getSection(first!.id)).toEqual(first);
    expect(s.getSection(9999)).toBeNull();
    expect(s.firstSection("/nope")).toBeNull();
    expect(s.entryVectors().map((r) => r.path).sort()).toEqual(["/w/a.md", "/w/b.md"]);
    expect(Array.from(s.entryVectors().find((r) => r.path === "/w/a.md")!.vec)).toEqual(Array.from(v(7)));

    expect(s.ftsSearch('"rule"', 10).map((h) => h.path)).toEqual(["/w/b.md"]);
    expect(s.ftsSearch("\"", 10)).toEqual([]); // invalid FTS syntax → empty, never throws

    s.deleteEntries(["/w/b.md", "/missing"]);
    expect(s.stats().entries).toBe(1);
    expect(s.ftsSearch('"rule"', 10)).toEqual([]);
    s.clear();
    expect(s.stats()).toEqual({ entries: 0, sections: 0, byCorpus: {} });
    expect(s.getProvenance()).toBeNull();
  });

  it("rolls back a failed upsert transaction", () => {
    const s = new IndexStore(new DatabaseSync(":memory:"));
    // Two sections but only one vector: the second insert throws inside the tx.
    expect(() => s.upsertEntry(doc({ path: "/w/a.md" }), v(1), [v(2)])).toThrow();
    expect(s.stats().entries).toBe(0);
  });
});
