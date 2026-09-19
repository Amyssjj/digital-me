import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEntryDoc, listMarkdownFiles, parseFrontmatter, parseList, scanCorpus, splitSections } from "./corpus.js";

const WIKI_ENTRY = `---
title: Kanban range filters by updated_at
domain:
- dashboard
tags: [kanban, filters]
priority: search
---

## Rule
Use "All time" to see stale goals.

## How it came up
Goals vanished from short windows.

## Apply when
Debugging a missing goal on the board.
`;

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { root: string; wiki: string } {
  dir = mkdtempSync(join(tmpdir(), "bh-corpus-"));
  const wiki = join(dir, "wiki");
  mkdirSync(join(wiki, "dashboard"), { recursive: true });
  mkdirSync(join(wiki, ".hidden"), { recursive: true });
  writeFileSync(join(wiki, "dashboard", "kanban-range.md"), WIKI_ENTRY);
  writeFileSync(join(wiki, "dashboard", "_OVERVIEW.md"), "# overview\n");
  writeFileSync(join(wiki, "_INDEX.md"), "# index\n");
  writeFileSync(join(wiki, "dashboard", "notes.txt"), "not markdown");
  writeFileSync(join(wiki, ".hidden", "x.md"), "hidden");
  return { root: dir, wiki };
}

describe("listMarkdownFiles", () => {
  it("skips underscore/hidden names and non-markdown, returns sorted paths", () => {
    const { wiki } = fixture();
    expect(listMarkdownFiles(wiki)).toEqual([join(wiki, "dashboard", "kanban-range.md")]);
  });
  it("returns nothing for a missing directory", () => {
    expect(listMarkdownFiles("/nonexistent/brain-host-test")).toEqual([]);
  });
});

describe("parseFrontmatter", () => {
  it("parses scalar and block-list fields and reports the body start", () => {
    const { fields, bodyStartLine } = parseFrontmatter(WIKI_ENTRY);
    expect(fields.title).toBe("Kanban range filters by updated_at");
    expect(fields.domain).toBe("dashboard");
    expect(fields.tags).toBe("[kanban, filters]");
    expect(bodyStartLine).toBe(8);
  });
  it("handles a block list with multiple items", () => {
    const { fields } = parseFrontmatter("---\ndomain:\n- a\n- b\n---\nbody");
    expect(fields.domain).toBe("a, b");
  });
  it("returns empty fields when there is no frontmatter or it never closes", () => {
    expect(parseFrontmatter("# no fm\n")).toEqual({ fields: {}, bodyStartLine: 1 });
    expect(parseFrontmatter("---\ntitle: x\n")).toEqual({ fields: {}, bodyStartLine: 1 });
  });
});

describe("parseList", () => {
  it("accepts bracketed, bare and quoted lists", () => {
    expect(parseList("[a, 'b', \"c\"]")).toEqual(["a", "b", "c"]);
    expect(parseList("a, b")).toEqual(["a", "b"]);
    expect(parseList(undefined)).toEqual([]);
    expect(parseList("")).toEqual([]);
  });
});

describe("splitSections", () => {
  it("splits on ## headings with 1-based line ranges and drops empty sections", () => {
    const lines = "## A\nx\n\n## Empty\n\n## B\ny\nz".split("\n");
    expect(splitSections(lines, 1)).toEqual([
      { heading: "A", text: "x", startLine: 1, endLine: 3 },
      { heading: "B", text: "y\nz", startLine: 6, endLine: 8 },
    ]);
  });
  it("ignores text before the first heading", () => {
    expect(splitSections(["intro", "## A", "x"], 1)).toEqual([{ heading: "A", text: "x", startLine: 2, endLine: 3 }]);
  });
});

describe("buildEntryDoc", () => {
  it("builds the entry text from Rule + Apply when and keeps all sections", () => {
    const { wiki } = fixture();
    const file = join(wiki, "dashboard", "kanban-range.md");
    const doc = buildEntryDoc({ dir: wiki, corpus: "wiki" }, file, WIKI_ENTRY);
    expect(doc.relPath).toBe("wiki/dashboard/kanban-range.md");
    expect(doc.domain).toBe("dashboard");
    expect(doc.tags).toEqual(["kanban", "filters"]);
    expect(doc.sections.map((s) => s.heading)).toEqual(["Rule", "How it came up", "Apply when"]);
    expect(doc.entryText).toContain("Kanban range filters by updated_at");
    expect(doc.entryText).toContain("tags: kanban, filters");
    expect(doc.entryText).toContain('Use "All time"');
    expect(doc.entryText).not.toContain("Goals vanished");
    expect(doc.fullText.startsWith("\n## Rule")).toBe(true);
    expect(doc.hash).toHaveLength(64);
  });

  it("falls back to filename title, path domain and all sections when frontmatter is missing", () => {
    const doc = buildEntryDoc({ dir: "/w", corpus: "wiki" }, "/w/infra/some-thing_here.md", "## Notes\nbody\n");
    expect(doc.title).toBe("some thing here");
    expect(doc.domain).toBe("infra");
    expect(doc.entryText).toContain("body");
    expect(doc.entryText).not.toContain("tags:");
  });

  it("uses the corpus as domain for a top-level file and strips quoted titles", () => {
    const doc = buildEntryDoc({ dir: "/t", corpus: "tastes" }, "/t/leaf.md", "---\ntitle: 'Quoted'\n---\n## Principle\np\n## Evidence\ne\n");
    expect(doc.title).toBe("Quoted");
    expect(doc.domain).toBe("tastes");
    expect(doc.entryText).toContain("p");
    expect(doc.entryText).not.toContain("\ne");
  });
});

describe("scanCorpus", () => {
  it("reads every markdown entry under each root", () => {
    const { wiki } = fixture();
    const docs = scanCorpus([{ dir: wiki, corpus: "wiki" }, { dir: join(dir, "tastes"), corpus: "tastes" }]);
    expect(docs.map((d) => d.relPath)).toEqual(["wiki/dashboard/kanban-range.md"]);
  });
});
