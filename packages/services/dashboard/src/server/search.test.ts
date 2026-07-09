import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import {
  buildSearchResponse,
  buildSearchRouter,
  coerceCorpus,
  coerceLimit,
  displayPath,
  loadMarkdown,
  normalizeSearchResults,
  resolveContentPath,
  titleForHit,
} from "./search.js";

describe("coerceCorpus / coerceLimit", () => {
  it("accepts the three corpora and falls back to 'all'", () => {
    expect(coerceCorpus("wiki")).toBe("wiki");
    expect(coerceCorpus("memory")).toBe("memory");
    expect(coerceCorpus("all")).toBe("all");
    expect(coerceCorpus("bogus")).toBe("all");
    expect(coerceCorpus(undefined)).toBe("all");
  });

  it("bounds the limit to 1..50 with a default of 20", () => {
    expect(coerceLimit("5")).toBe(5);
    expect(coerceLimit("50")).toBe(50);
    expect(coerceLimit("51")).toBe(20);
    expect(coerceLimit("0")).toBe(20);
    expect(coerceLimit("abc")).toBe(20);
    expect(coerceLimit(undefined)).toBe(20);
  });
});

describe("normalizeSearchResults", () => {
  it("extracts path/snippet/score from a well-formed payload", () => {
    const hits = normalizeSearchResults({
      results: [{ path: "wiki/a.md", snippet: "## Rule\nDo X", score: 0.91 }],
    });
    expect(hits).toEqual([{ path: "wiki/a.md", snippet: "## Rule\nDo X", score: 0.91 }]);
  });

  it("degrades malformed payloads to an empty list", () => {
    expect(normalizeSearchResults(null)).toEqual([]);
    expect(normalizeSearchResults("nope")).toEqual([]);
    expect(normalizeSearchResults({})).toEqual([]);
    expect(normalizeSearchResults({ results: "nope" })).toEqual([]);
  });

  it("skips entries without a usable path and defaults missing fields", () => {
    const hits = normalizeSearchResults({
      results: [
        null,
        "string-entry",
        { snippet: "no path" },
        { path: "" },
        { path: "ok.md", snippet: 42, score: "high" },
      ],
    });
    expect(hits).toEqual([{ path: "ok.md", snippet: "", score: null }]);
  });
});

describe("titleForHit", () => {
  it("prefers the frontmatter title line, unquoting it", () => {
    expect(titleForHit("---\ntitle: Plain Title\n---\nbody", "x.md")).toBe("Plain Title");
    expect(titleForHit("---\ntitle: 'Quoted Title'\n---", "x.md")).toBe("Quoted Title");
  });

  it("falls back to a de-kebabed filename when there is no title", () => {
    expect(titleForHit("no frontmatter", "wiki/dash/feed-intake-location.md")).toBe(
      "Feed intake location",
    );
  });

  it("ignores an empty frontmatter title and survives odd paths", () => {
    expect(titleForHit("title: ''\n", "wiki/some_entry.md")).toBe("Some entry");
    expect(titleForHit("", ".md")).toBe(".md");
  });
});

describe("displayPath", () => {
  it("cuts to the wiki/tastes/memory/inbox tree marker", () => {
    expect(displayPath("../../../someone/digital-me/wiki/dash/a.md")).toBe("wiki/dash/a.md");
    expect(displayPath("/abs/digital-me/tastes/design/b.md")).toBe("tastes/design/b.md");
    expect(displayPath("memory/2026-05-15.md")).toBe("memory/2026-05-15.md");
    expect(displayPath("../inbox/c.md")).toBe("inbox/c.md");
  });

  it("strips ../ churn and collapses foreign absolute paths to a basename", () => {
    expect(displayPath("../../notes/d.md")).toBe("notes/d.md");
    expect(displayPath("/etc/passwd")).toBe("passwd");
    expect(displayPath("plain.md")).toBe("plain.md");
  });

  it("normalizes backslashes", () => {
    expect(displayPath("..\\..\\digital-me\\wiki\\a.md")).toBe("wiki/a.md");
  });
});

describe("resolveContentPath", () => {
  const root = "/home/u/digital-me";
  const exists = (present: string[]) => (p: string) => present.includes(p);

  it("resolves a root-relative path", () => {
    expect(
      resolveContentPath("wiki/a.md", [root], exists(["/home/u/digital-me/wiki/a.md"])),
    ).toBe("/home/u/digital-me/wiki/a.md");
  });

  it("accepts an absolute path inside a root", () => {
    expect(
      resolveContentPath(
        "/home/u/digital-me/wiki/a.md",
        [root],
        exists(["/home/u/digital-me/wiki/a.md"]),
      ),
    ).toBe("/home/u/digital-me/wiki/a.md");
  });

  it("recovers a deep ../-relative path via the root-basename marker", () => {
    expect(
      resolveContentPath(
        "../../../../../someone/digital-me/wiki/dash/a.md",
        [root],
        exists(["/home/u/digital-me/wiki/dash/a.md"]),
      ),
    ).toBe("/home/u/digital-me/wiki/dash/a.md");
  });

  it("tries roots in order and falls through to the next", () => {
    const workspace = "/home/u/.openclaw/workspace";
    expect(
      resolveContentPath(
        "memory/2026.md",
        [root, workspace],
        exists(["/home/u/.openclaw/workspace/memory/2026.md"]),
      ),
    ).toBe("/home/u/.openclaw/workspace/memory/2026.md");
  });

  it("refuses traversal escapes and absolute paths outside every root", () => {
    const anything = () => true; // even if the file exists, containment must fail
    expect(resolveContentPath("../../etc/passwd", [root], anything)).toBeNull();
    expect(resolveContentPath("/etc/passwd", [root], anything)).toBeNull();
    expect(resolveContentPath("wiki/../../escape.md", [root], anything)).toBeNull();
  });

  it("returns null when nothing exists", () => {
    expect(resolveContentPath("wiki/a.md", [root], () => false)).toBeNull();
  });

  it("uses the real filesystem by default", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "search-root-"));
    try {
      fs.mkdirSync(path.join(tmp, "wiki"));
      fs.writeFileSync(path.join(tmp, "wiki", "real.md"), "# hi", "utf-8");
      expect(resolveContentPath("wiki/real.md", [tmp])).toBe(path.join(tmp, "wiki", "real.md"));
      expect(resolveContentPath("wiki/missing.md", [tmp])).toBeNull();
      // A directory is not a previewable file.
      expect(resolveContentPath("wiki", [tmp])).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadMarkdown", () => {
  it("reads content and caps oversized files", () => {
    expect(loadMarkdown("/x.md", () => "# body")).toBe("# body");
    const huge = "x".repeat(256 * 1024 + 10);
    expect(loadMarkdown("/x.md", () => huge)).toHaveLength(256 * 1024);
  });

  it("degrades a read failure to null", () => {
    expect(
      loadMarkdown("/x.md", () => {
        throw new Error("EACCES");
      }),
    ).toBeNull();
  });

  it("uses the real filesystem by default", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "search-md-"));
    try {
      const p = path.join(tmp, "a.md");
      fs.writeFileSync(p, "# real", "utf-8");
      expect(loadMarkdown(p)).toBe("# real");
      expect(loadMarkdown(path.join(tmp, "missing.md"))).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("buildSearchResponse", () => {
  const root = "/home/u/digital-me";
  const deps = {
    contentRoots: [root],
    fileExists: (p: string) => p === "/home/u/digital-me/wiki/a.md",
    readFile: (p: string) => `content of ${p}`,
  };

  it("ranks hits in payload order and hydrates resolvable previews", () => {
    const raw = {
      results: [
        { path: "wiki/a.md", snippet: "---\ntitle: Entry A\n---\nRule", score: 0.9 },
        { path: "wiki/gone.md", snippet: "", score: 0.5 },
      ],
    };
    const res = buildSearchResponse("feed", "wiki", raw, deps);
    expect(res.query).toBe("feed");
    expect(res.corpus).toBe("wiki");
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toMatchObject({
      rank: 1,
      title: "Entry A",
      path: "wiki/a.md",
      score: 0.9,
      markdown: "content of /home/u/digital-me/wiki/a.md",
    });
    // Unresolvable hit still ranks — snippet-only preview.
    expect(res.results[1]).toMatchObject({ rank: 2, markdown: null });
    expect(res.results.map((r) => r.id)).toEqual(["wiki/a.md#1", "wiki/gone.md#2"]);
  });

  it("passes default fs seams through when none are injected", () => {
    const res = buildSearchResponse("q", "all", { results: [{ path: "nope/x.md" }] }, {
      contentRoots: ["/definitely/not/a/real/root"],
    });
    expect(res.results[0]!.markdown).toBeNull();
  });
});

describe("buildSearchRouter (HTTP)", () => {
  let server: http.Server;
  let base: string;
  let memorySearch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    memorySearch = vi.fn();
    const app = express();
    app.use(
      "/api/search",
      buildSearchRouter({
        memorySearch,
        contentRoots: ["/home/u/digital-me"],
        fileExists: () => false,
        readFile: () => "",
      }),
    );
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it("400s without a query (missing or blank)", async () => {
    expect((await fetch(`${base}/api/search`)).status).toBe(400);
    expect((await fetch(`${base}/api/search?q=%20`)).status).toBe(400);
    expect(memorySearch).not.toHaveBeenCalled();
  });

  it("forwards query/corpus/limit to memory_search and returns ranked results", async () => {
    memorySearch.mockResolvedValue({
      results: [{ path: "wiki/a.md", snippet: "title: A\n", score: 0.8 }],
    });
    const res = await fetch(`${base}/api/search?q=feed+design&corpus=wiki&limit=5`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { query: string; results: Array<{ title: string }> };
    expect(memorySearch).toHaveBeenCalledWith("feed design", { corpus: "wiki", limit: 5 });
    expect(json.query).toBe("feed design");
    expect(json.results[0]!.title).toBe("A");
  });

  it("coerces a bogus corpus/limit to the defaults", async () => {
    memorySearch.mockResolvedValue({ results: [] });
    const res = await fetch(`${base}/api/search?q=x&corpus=bogus&limit=999`);
    expect(res.status).toBe(200);
    expect(memorySearch).toHaveBeenCalledWith("x", { corpus: "all", limit: 20 });
  });

  it("502s when the brain is unreachable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      memorySearch.mockRejectedValue(new Error("proxy down"));
      const res = await fetch(`${base}/api/search?q=x`);
      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain("memory_search unavailable");
    } finally {
      spy.mockRestore();
    }
  });
});
