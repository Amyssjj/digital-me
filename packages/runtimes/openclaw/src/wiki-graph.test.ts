import { describe, expect, it } from "vitest";
import {
  expandViaGraph,
  extractFrontmatterText,
  parseRelatedField,
  type WikiEntry,
} from "./wiki-graph.js";

describe("extractFrontmatterText", () => {
  it("pulls the body of a normal frontmatter block", () => {
    const out = extractFrontmatterText("---\ntitle: foo\nrelated: []\n---\n\nbody");
    expect(out).toBe("title: foo\nrelated: []");
  });

  it("returns null when no frontmatter present", () => {
    expect(extractFrontmatterText("plain markdown body")).toBeNull();
  });

  it("returns null when --- is mid-document, not leading", () => {
    expect(extractFrontmatterText("# title\n\n---\nfake\n---\n")).toBeNull();
  });
});

describe("parseRelatedField — inline form", () => {
  it("parses empty inline array", () => {
    expect(parseRelatedField("title: foo\nrelated: []")).toEqual([]);
  });

  it("parses inline array of unquoted paths", () => {
    expect(parseRelatedField("related: [a/b.md, c/d.md]")).toEqual([
      "a/b.md",
      "c/d.md",
    ]);
  });

  it("parses inline array of quoted paths", () => {
    expect(parseRelatedField('related: ["a/b.md", \'c/d.md\']')).toEqual([
      "a/b.md",
      "c/d.md",
    ]);
  });
});

describe("parseRelatedField — list form", () => {
  it("parses YAML list form", () => {
    const fm = "title: foo\nrelated:\n  - a/b.md\n  - c/d.md\npriority: search\n";
    expect(parseRelatedField(fm)).toEqual(["a/b.md", "c/d.md"]);
  });

  it("stops at the next top-level field", () => {
    const fm = "related:\n  - a/b.md\npriority: search\n  - bogus.md\n";
    expect(parseRelatedField(fm)).toEqual(["a/b.md"]);
  });

  it("returns empty when related: missing", () => {
    expect(parseRelatedField("title: foo\npriority: search\n")).toEqual([]);
  });
});

describe("expandViaGraph", () => {
  const entry = (relPath: string, related: string[]): WikiEntry => ({
    relPath,
    frontmatter: { related },
  });

  it("returns seeds unchanged at depth 0", () => {
    const seeds = [entry("a.md", ["b.md"]), entry("b.md", [])];
    const out = expandViaGraph(seeds, () => null, 0);
    expect(out.map((e) => e.relPath)).toEqual(["a.md", "b.md"]);
  });

  it("dedupes seeds", () => {
    const seeds = [entry("a.md", []), entry("a.md", [])];
    const out = expandViaGraph(seeds, () => null, 1);
    expect(out.map((e) => e.relPath)).toEqual(["a.md"]);
  });

  it("expands 1-hop neighbors via loadEntry", () => {
    const graph: Record<string, WikiEntry> = {
      "a.md": entry("a.md", ["b.md", "c.md"]),
      "b.md": entry("b.md", ["d.md"]),
      "c.md": entry("c.md", []),
      "d.md": entry("d.md", []),
    };
    const out = expandViaGraph(
      [graph["a.md"]],
      (p) => graph[p] ?? null,
      1,
    );
    expect(out.map((e) => e.relPath).sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("expands 2-hop neighbors when maxDepth=2", () => {
    const graph: Record<string, WikiEntry> = {
      "a.md": entry("a.md", ["b.md"]),
      "b.md": entry("b.md", ["c.md"]),
      "c.md": entry("c.md", []),
    };
    const out = expandViaGraph(
      [graph["a.md"]],
      (p) => graph[p] ?? null,
      2,
    );
    expect(out.map((e) => e.relPath)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("skips broken links silently", () => {
    const graph: Record<string, WikiEntry> = {
      "a.md": entry("a.md", ["missing.md", "b.md"]),
      "b.md": entry("b.md", []),
    };
    const out = expandViaGraph([graph["a.md"]], (p) => graph[p] ?? null, 1);
    expect(out.map((e) => e.relPath)).toEqual(["a.md", "b.md"]);
  });

  it("respects maxNodes cap", () => {
    const graph: Record<string, WikiEntry> = {
      "a.md": entry("a.md", ["b.md", "c.md", "d.md"]),
      "b.md": entry("b.md", []),
      "c.md": entry("c.md", []),
      "d.md": entry("d.md", []),
    };
    const out = expandViaGraph(
      [graph["a.md"]],
      (p) => graph[p] ?? null,
      1,
      2,
    );
    expect(out.map((e) => e.relPath)).toEqual(["a.md", "b.md"]);
  });

  it("avoids infinite loops on cyclic graphs", () => {
    const graph: Record<string, WikiEntry> = {
      "a.md": entry("a.md", ["b.md"]),
      "b.md": entry("b.md", ["a.md"]),
    };
    const out = expandViaGraph([graph["a.md"]], (p) => graph[p] ?? null, 5);
    expect(out.map((e) => e.relPath).sort()).toEqual(["a.md", "b.md"]);
  });
});
