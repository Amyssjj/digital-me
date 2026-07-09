import { describe, expect, it } from "vitest";
import {
  applyRecallHygiene,
  buildMemorySearchTrace,
  buildRouteIndex,
  extractActivePolicies,
  extractRuleSection,
  formatRecallInjection,
  formatRouteInjection,
  loadBootContext,
  matchRouteConditions,
  parseDigitalMeAck,
  parseRouteFrontmatter,
  readWikiBody,
  type AckEntry,
  type BootContextFsAccess,
  type RecallHit,
  type WikiBodyReader,
} from "./recall-hooks.js";

// ─── Hook A ─────────────────────────────────────────────────────────────

describe("extractActivePolicies", () => {
  it("extracts the section between three === fences", () => {
    const indexText = [
      "# Wiki Index",
      "",
      "=====",
      "## ACTIVE POLICIES",
      "- Rule 1",
      "- Rule 2",
      "=====",
      "(generated daily)",
      "=====",
      "",
      "## Domains",
      "...",
    ].join("\n");
    const out = extractActivePolicies(indexText);
    expect(out).toContain("ACTIVE POLICIES");
    expect(out).toContain("Rule 1");
    expect(out).toContain("generated daily");
  });

  it("returns null when fewer than 3 fences present", () => {
    expect(extractActivePolicies("# heading\n=====\nincomplete\n")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractActivePolicies("")).toBeNull();
  });
});

describe("loadBootContext", () => {
  function makeFs(files: Record<string, string>): BootContextFsAccess {
    return {
      readFile: (p) => files[p] ?? null,
      existsSync: (p) =>
        p in files || Object.keys(files).some((k) => k.startsWith(`${p}/`)),
      readdirSync: (p) =>
        Object.keys(files)
          .filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes("/"))
          .map((k) => k.slice(p.length + 1)),
    };
  }

  it("always injects the protocol", () => {
    const out = loadBootContext({ digitalMeProtocol: "Follow the rules." }, makeFs({}));
    expect(out).toContain("<digital-me-protocol>");
    expect(out).toContain("Follow the rules.");
    expect(out).toContain("</digital-me-protocol>");
    expect(out).not.toContain("<active-policies>");
  });

  it("appends ACTIVE POLICIES when _INDEX.md parses cleanly", () => {
    const idx = "=====\n## ACTIVE POLICIES\n- Be careful\n=====\nend\n=====\n";
    const fs = makeFs({ "/wiki/_INDEX.md": idx });
    const out = loadBootContext(
      { digitalMeProtocol: "P", activePoliciesPath: "/wiki/_INDEX.md" },
      fs,
    );
    expect(out).toContain("<active-policies>");
    expect(out).toContain("Be careful");
  });

  it("omits active-policies block when _INDEX.md has bad structure", () => {
    const fs = makeFs({ "/wiki/_INDEX.md": "no fences here\n" });
    const out = loadBootContext(
      { digitalMeProtocol: "P", activePoliciesPath: "/wiki/_INDEX.md" },
      fs,
    );
    expect(out).not.toContain("<active-policies>");
  });

  it("omits active-policies block when path doesn't exist", () => {
    const out = loadBootContext(
      { digitalMeProtocol: "P", activePoliciesPath: "/missing.md" },
      makeFs({}),
    );
    expect(out).not.toContain("<active-policies>");
  });

  it("concatenates protocolsDir/*.md files", () => {
    const fs = makeFs({
      "/protocols/a.md": "Protocol A body",
      "/protocols/b.md": "Protocol B body",
      "/protocols/skip.txt": "ignored",
    });
    const out = loadBootContext(
      { digitalMeProtocol: "P", protocolsDir: "/protocols" },
      fs,
    );
    expect(out).toContain("<shared-protocols>");
    expect(out).toContain("Protocol A body");
    expect(out).toContain("Protocol B body");
    expect(out).not.toContain("ignored");
  });

  it("skips shared-protocols when the dir vanishes between exists check and read", () => {
    const racyFs: BootContextFsAccess = {
      readFile: () => null,
      existsSync: () => true,
      readdirSync: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    };
    const out = loadBootContext(
      { digitalMeProtocol: "P", protocolsDir: "/gone" },
      racyFs,
    );
    expect(out).toContain("<digital-me-protocol>");
    expect(out).not.toContain("<shared-protocols>");
  });
});

// ─── Hook B ─────────────────────────────────────────────────────────────

describe("formatRecallInjection", () => {
  it("returns empty string for zero hits", () => {
    expect(formatRecallInjection([])).toBe("");
  });

  it("wraps hits in <recalled-knowledge> tag", () => {
    const out = formatRecallInjection([
      { path: "a.md", title: "Alpha", body: "Body of A" },
    ]);
    expect(out).toContain("<recalled-knowledge>");
    expect(out).toContain("## Alpha");
    expect(out).toContain("Body of A");
    expect(out).toContain("</recalled-knowledge>");
  });

  it("falls back to path when title missing", () => {
    const out = formatRecallInjection([{ path: "tools/x.md", body: "X" }]);
    expect(out).toContain("## tools/x.md");
  });

  it("respects maxChars cap (truncates extra hits)", () => {
    const big = "a".repeat(500);
    const hits = Array.from({ length: 20 }, (_, i) => ({
      path: `e${i}.md`,
      title: `E${i}`,
      body: big,
    }));
    const out = formatRecallInjection(hits, 2000);
    // The cap is 2000; output should be much smaller than 20×500 = 10000.
    expect(out.length).toBeLessThan(2500);
    expect(out).toContain("E0");
    expect(out).not.toContain("E19");
  });

  it("returns empty string when even the first hit exceeds maxChars", () => {
    const out = formatRecallInjection(
      [{ path: "big.md", body: "x".repeat(500) }],
      100,
    );
    expect(out).toBe("");
  });
});

// ─── Hook C ─────────────────────────────────────────────────────────────

describe("parseRouteFrontmatter", () => {
  it("parses tool-only route", () => {
    expect(parseRouteFrontmatter("title: x\nroute: tool=tasks")).toEqual({
      toolName: "tasks",
      conditions: "",
    });
  });

  it("parses tool + contains condition", () => {
    const fm = `route: tool=exec, params.command contains "ffmpeg"`;
    expect(parseRouteFrontmatter(fm)).toEqual({
      toolName: "exec",
      conditions: 'params.command contains "ffmpeg"',
    });
  });

  it("strips surrounding single quotes (YAML scalar form)", () => {
    const fm = `route: 'tool=exec, params.command contains "ffmpeg"'`;
    expect(parseRouteFrontmatter(fm)).toEqual({
      toolName: "exec",
      conditions: 'params.command contains "ffmpeg"',
    });
  });

  it("strips surrounding double quotes (YAML scalar form)", () => {
    expect(parseRouteFrontmatter('route: "tool=tasks"')).toEqual({
      toolName: "tasks",
      conditions: "",
    });
  });

  it("returns null when route missing", () => {
    expect(parseRouteFrontmatter("title: x\npriority: search")).toBeNull();
  });

  it("returns null when route value lacks tool=...", () => {
    expect(parseRouteFrontmatter("route: garbage")).toBeNull();
  });
});

describe("buildRouteIndex", () => {
  const entry = (
    filePath: string,
    title: string,
    route: string | null,
    rule: string,
  ) => ({
    filePath,
    text: [
      "---",
      `title: ${title}`,
      route ? `route: ${route}` : "",
      "priority: search",
      "---",
      "",
      "## Rule",
      rule,
      "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  });

  it("groups entries by toolName", () => {
    const idx = buildRouteIndex([
      entry("a.md", "A", "tool=exec, params.command contains \"ffmpeg\"", "Use -loglevel error"),
      entry("b.md", "B", "tool=exec, params.command contains \"git\"", "Quote your paths"),
      entry("c.md", "C", "tool=tasks", "Stringify the tasks JSON"),
    ]);
    expect(idx.get("exec")?.length).toBe(2);
    expect(idx.get("tasks")?.length).toBe(1);
  });

  it("skips entries without a route: field", () => {
    const idx = buildRouteIndex([entry("x.md", "X", null, "rule")]);
    expect(idx.size).toBe(0);
  });

  it("preserves title and rule on each record", () => {
    const idx = buildRouteIndex([entry("a.md", "Alpha", "tool=tasks", "Be careful")]);
    const rec = idx.get("tasks")![0];
    expect(rec.title).toBe("Alpha");
    expect(rec.rule).toBe("Be careful");
    expect(rec.filePath).toBe("a.md");
  });

  it("skips entries with no frontmatter block", () => {
    const idx = buildRouteIndex([
      { filePath: "x.md", text: "# no fences here\nroute: tool=exec\n" },
    ]);
    expect(idx.size).toBe(0);
  });

  it("leaves title undefined when the frontmatter has no title:", () => {
    const idx = buildRouteIndex([
      {
        filePath: "untitled.md",
        text: "---\nroute: tool=tasks\n---\n\n## Rule\nBe safe\n",
      },
    ]);
    const rec = idx.get("tasks")![0];
    expect(rec.title).toBeUndefined();
    expect(rec.rule).toBe("Be safe");
  });
});

describe("matchRouteConditions", () => {
  it("matches empty condition (tool-only)", () => {
    expect(matchRouteConditions("", { command: "anything" })).toBe(true);
  });

  it("matches contains single value", () => {
    expect(
      matchRouteConditions('params.command contains "ffmpeg"', { command: "ffmpeg -i in.mp4" }),
    ).toBe(true);
    expect(
      matchRouteConditions('params.command contains "ffmpeg"', { command: "ls -la" }),
    ).toBe(false);
  });

  it("matches contains OR alternatives", () => {
    const cond = 'params.command contains "ffmpeg" OR "manim"';
    expect(matchRouteConditions(cond, { command: "manim render" })).toBe(true);
    expect(matchRouteConditions(cond, { command: "ffmpeg" })).toBe(true);
    expect(matchRouteConditions(cond, { command: "ls" })).toBe(false);
  });

  it("returns false when params lack the named field", () => {
    expect(
      matchRouteConditions('params.command contains "x"', { other: "x" }),
    ).toBe(false);
  });

  it("matches params.X OR params.Y existence check", () => {
    expect(
      matchRouteConditions("params.sessionKey OR params.label", { label: "foo" }),
    ).toBe(true);
    expect(
      matchRouteConditions("params.sessionKey OR params.label", {}),
    ).toBe(false);
  });

  it("returns false for unknown condition shapes (fail-closed)", () => {
    expect(matchRouteConditions("magic stuff here", { command: "x" })).toBe(false);
  });

  it("returns false when the named param is not a string", () => {
    expect(
      matchRouteConditions('params.command contains "x"', { command: 42 }),
    ).toBe(false);
  });

  it("returns false for a contains condition with no quoted patterns", () => {
    expect(
      matchRouteConditions("params.command contains ffmpeg", {
        command: "ffmpeg -i in.mp4",
      }),
    ).toBe(false);
  });
});

describe("formatRouteInjection", () => {
  it("returns empty string for no matches", () => {
    expect(formatRouteInjection([])).toBe("");
  });

  it("wraps matched rules in <routed-learnings>", () => {
    const out = formatRouteInjection([
      {
        toolName: "exec",
        conditions: "",
        rule: "Always use -loglevel error",
        filePath: "x.md",
        title: "ffmpeg flag",
      },
    ]);
    expect(out).toContain("<routed-learnings>");
    expect(out).toContain("### ffmpeg flag");
    expect(out).toContain("-loglevel error");
    expect(out).toContain("</routed-learnings>");
  });

  it("labels rules without a title as (untitled)", () => {
    const out = formatRouteInjection([
      { toolName: "exec", conditions: "", rule: "R", filePath: "x.md" },
    ]);
    expect(out).toContain("### (untitled)");
  });

  it("caps total length, dropping rules that would overflow", () => {
    const small = {
      toolName: "exec",
      conditions: "",
      rule: "tiny rule",
      filePath: "a.md",
      title: "A",
    };
    const huge = {
      toolName: "exec",
      conditions: "",
      rule: "x".repeat(5000),
      filePath: "b.md",
      title: "B",
    };
    const out = formatRouteInjection([small, huge], 200);
    expect(out).toContain("### A");
    expect(out).not.toContain("### B");
  });

  it("returns empty string when even the first rule exceeds maxChars", () => {
    const huge = {
      toolName: "exec",
      conditions: "",
      rule: "x".repeat(5000),
      filePath: "b.md",
      title: "B",
    };
    expect(formatRouteInjection([huge], 100)).toBe("");
  });
});

describe("extractRuleSection", () => {
  it("pulls the ## Rule section body", () => {
    const text = "## Rule\nDo X.\n\n## How it came up\nLong story";
    expect(extractRuleSection(text)).toBe("Do X.");
  });

  it("returns empty string when no ## Rule heading", () => {
    expect(extractRuleSection("# Title\nbody")).toBe("");
  });

  it("caps at maxChars and appends ellipsis", () => {
    const big = "a".repeat(1000);
    const out = extractRuleSection(`## Rule\n${big}\n\n## next`, 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ─── Hook D ─────────────────────────────────────────────────────────────

describe("buildMemorySearchTrace", () => {
  it("returns an ISO timestamp", () => {
    const t = buildMemorySearchTrace({
      agentId: "claude",
      query: "x",
      hitCount: 3,
      now: new Date("2026-05-18T10:00:00Z"),
    });
    expect(t.timestamp).toBe("2026-05-18T10:00:00.000Z");
    expect(t.agentId).toBe("claude");
    expect(t.query).toBe("x");
    expect(t.hitCount).toBe(3);
    expect(t.sessionKey).toBe("");
  });

  it("preserves sessionKey when provided", () => {
    const t = buildMemorySearchTrace({
      agentId: "a",
      sessionKey: "k",
      query: "q",
      hitCount: 0,
    });
    expect(t.sessionKey).toBe("k");
  });

  it("truncates query at 500 chars", () => {
    const big = "x".repeat(1000);
    const t = buildMemorySearchTrace({
      agentId: "a",
      query: big,
      hitCount: 0,
    });
    expect(t.query.length).toBe(500);
  });
});

// ─── M1 hygiene helpers (2026-05-22) ────────────────────────────────────

const fakeReader = (files: Record<string, string>): WikiBodyReader => ({
  readFile: (p) => files[p] ?? null,
  existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
});

describe("readWikiBody", () => {
  it("returns null for empty path", () => {
    expect(readWikiBody("", "/wiki", fakeReader({}))).toBeNull();
  });

  it("returns null when file does not exist", () => {
    expect(readWikiBody("foo.md", "/wiki", fakeReader({}))).toBeNull();
  });

  it("strips frontmatter and returns body", () => {
    const reader = fakeReader({
      "/wiki/foo.md": "---\ntitle: X\n---\n## Rule\nDo X.",
    });
    expect(readWikiBody("foo.md", "/wiki", reader)).toBe("## Rule\nDo X.");
  });

  it("truncates to maxChars and appends ellipsis", () => {
    const body = "## Rule\n" + "x".repeat(5000);
    const reader = fakeReader({ "/wiki/foo.md": `---\n---\n${body}` });
    const out = readWikiBody("foo.md", "/wiki", reader, 100);
    expect(out).toMatch(/…$/);
    expect(out!.length).toBe(101);
  });

  it("normalizes path with /wiki/ prefix from search results", () => {
    const reader = fakeReader({
      "/wiki/infra/x.md": "---\n---\nbody",
    });
    // Test fixture path mimics the brain's cwd-relative encoding without
    // hardcoding a real home path (sanitize gate rejects /Users/<user>).
    expect(
      readWikiBody("../../home/digital-me/wiki/infra/x.md", "/wiki", reader),
    ).toBe("body");
  });

  it("skips memory/* paths (per-agent memory, not shared wiki)", () => {
    const reader = fakeReader({ "/wiki/memory/2026-05-21.md": "x" });
    expect(readWikiBody("memory/2026-05-21.md", "/wiki", reader)).toBeNull();
  });

  it("skips absolute paths outside the wiki root", () => {
    const reader = fakeReader({ "/wiki/x.md": "body" });
    expect(readWikiBody("/etc/passwd", "/wiki", reader)).toBeNull();
  });

  it("resolves /tastes/ hits to the tastes tree next to the wiki root", () => {
    const reader = fakeReader({
      "/dm/tastes/food/x.md": "---\ntitle: X\n---\ntaste body",
    });
    expect(
      readWikiBody("../../home/digital-me/tastes/food/x.md", "/dm/wiki", reader),
    ).toBe("taste body");
  });

  it("resolves a bare wiki/-prefixed hit under the wiki root", () => {
    const reader = fakeReader({ "/dm/wiki/infra/x.md": "---\n---\nbody" });
    expect(readWikiBody("wiki/infra/x.md", "/dm/wiki", reader)).toBe("body");
  });

  it("resolves a bare tastes/-prefixed hit when wikiRoot is not */wiki", () => {
    // Backcompat shape: a caller passing the digital-me parent dir directly.
    const reader = fakeReader({
      "/knowledge/tastes/food/x.md": "---\n---\ntaste",
    });
    expect(readWikiBody("tastes/food/x.md", "/knowledge", reader)).toBe("taste");
  });

  it("returns null when the file exists but reads empty", () => {
    const reader = fakeReader({ "/wiki/foo.md": "" });
    expect(readWikiBody("foo.md", "/wiki", reader)).toBeNull();
  });

  it("returns null when the body is empty after stripping frontmatter", () => {
    const reader = fakeReader({ "/wiki/foo.md": "---\ntitle: x\n---\n   \n" });
    expect(readWikiBody("foo.md", "/wiki", reader)).toBeNull();
  });

  it("returns the whole text when there is no frontmatter to strip", () => {
    const reader = fakeReader({ "/wiki/foo.md": "just a body, no fences" });
    expect(readWikiBody("foo.md", "/wiki", reader)).toBe(
      "just a body, no fences",
    );
  });
});

describe("applyRecallHygiene", () => {
  it("filters out hits below minScore", () => {
    const seen = new Set<string>();
    const out = applyRecallHygiene({
      hits: [
        { path: "a.md", body: "A", score: 0.6 },
        { path: "b.md", body: "B", score: 0.3 },
        { path: "c.md", body: "C", score: 0.5 },
      ],
      seen,
      minScore: 0.4,
    });
    expect(out.map((h) => h.path)).toEqual(["a.md", "c.md"]);
  });

  it("filters out already-seen paths", () => {
    const seen = new Set<string>(["a.md"]);
    const out = applyRecallHygiene({
      hits: [
        { path: "a.md", body: "A", score: 0.9 },
        { path: "b.md", body: "B", score: 0.9 },
      ],
      seen,
    });
    expect(out.map((h) => h.path)).toEqual(["b.md"]);
  });

  it("adds surviving paths to seen set", () => {
    const seen = new Set<string>();
    applyRecallHygiene({
      hits: [
        { path: "a.md", body: "A", score: 0.9 },
        { path: "b.md", body: "B", score: 0.9 },
      ],
      seen,
    });
    expect(seen.has("a.md")).toBe(true);
    expect(seen.has("b.md")).toBe(true);
  });

  it("does NOT add filtered-out paths to seen set", () => {
    const seen = new Set<string>();
    applyRecallHygiene({
      hits: [
        { path: "low.md", body: "L", score: 0.1 },
        { path: "high.md", body: "H", score: 0.9 },
      ],
      seen,
      minScore: 0.4,
    });
    expect(seen.has("low.md")).toBe(false);
    expect(seen.has("high.md")).toBe(true);
  });

  it("replaces top-1 body with full file body when reader returns content", () => {
    const seen = new Set<string>();
    const reader = fakeReader({
      "/wiki/foo.md": "---\n---\n## Rule\nFULL RULE TEXT",
    });
    const out = applyRecallHygiene({
      hits: [
        { path: "foo.md", body: "snippet", score: 0.9 },
        { path: "bar.md", body: "B", score: 0.9 },
      ],
      seen,
      wikiRoot: "/wiki",
      reader,
    });
    expect(out[0]!.body).toBe("## Rule\nFULL RULE TEXT");
    // Second hit untouched
    expect(out[1]!.body).toBe("B");
  });

  it("falls back to original body when reader returns null", () => {
    const seen = new Set<string>();
    const out = applyRecallHygiene({
      hits: [{ path: "missing.md", body: "snippet-only", score: 0.9 }],
      seen,
      wikiRoot: "/wiki",
      reader: fakeReader({}),
    });
    expect(out[0]!.body).toBe("snippet-only");
  });

  it("returns empty array when all hits are filtered out", () => {
    const seen = new Set<string>();
    const out = applyRecallHygiene({
      hits: [{ path: "a.md", body: "A", score: 0.1 }],
      seen,
      minScore: 0.5,
    });
    expect(out).toEqual([]);
  });

  it("skips null-ish hits and hits without a path", () => {
    // Upstream search payloads are untrusted — a malformed element must not
    // break hygiene for the well-formed hits around it.
    const seen = new Set<string>();
    const out = applyRecallHygiene({
      hits: [
        null as unknown as RecallHit,
        { path: "", body: "no-path" },
        { path: "ok.md", body: "OK", score: 0.9 },
      ],
      seen,
    });
    expect(out.map((h) => h.path)).toEqual(["ok.md"]);
    expect(seen.has("")).toBe(false);
  });
});

describe("formatRecallInjection — [Digital Me] attribution + directive", () => {
  it("appends the [Digital Me] closing line when hits present", () => {
    // 2026-05-22: tag is "[Digital Me]" — mixed case, no OS suffix,
    // brackets carry the system-attribution signal. Body still references
    // M1 application_rate so the directive is preserved.
    const out = formatRecallInjection([{ path: "x.md", body: "body" }]);
    expect(out).toContain("[Digital Me]");
    expect(out).toContain("application_rate");
  });

  it("returns empty string when no hits (no [Digital Me] line either)", () => {
    expect(formatRecallInjection([])).toBe("");
    expect(formatRecallInjection([])).not.toContain("[Digital Me]");
  });

  it("instructs the agent to begin its reply with the [Digital Me] marker", () => {
    const out = formatRecallInjection([{ path: "x.md", body: "body" }]);
    expect(out).toContain("BEGIN your reply with a line that starts `[Digital Me]`");
    expect(out).toContain("application_rate");
  });
});

describe("parseDigitalMeAck — [Digital Me] application-start marker", () => {
  const surfaced: AckEntry[] = [
    {
      path: "infrastructure/m1-universal-event-protocol.md",
      title: "M1 Universal Event Protocol",
    },
    { path: "youtube/thumbnail-rules.md", title: "Thumbnail Rules" },
  ];

  it("counts an explicit_path ack when the reply names a surfaced slug", () => {
    const reply =
      "[Digital Me] applying m1-universal-event-protocol — the scorer pairs surfaced↔ack.";
    const { ackSignal, actedEntries } = parseDigitalMeAck(reply, surfaced);
    expect(ackSignal).toBe("explicit_path");
    expect(actedEntries.map((e) => e.path)).toEqual([
      "infrastructure/m1-universal-event-protocol.md",
    ]);
  });

  it("counts a title_match when the reply names the entry title only", () => {
    const reply = "[Digital Me] applying the Thumbnail Rules entry.";
    const { ackSignal, actedEntries } = parseDigitalMeAck(reply, surfaced);
    expect(ackSignal).toBe("title_match");
    expect(actedEntries.map((e) => e.path)).toEqual([
      "youtube/thumbnail-rules.md",
    ]);
  });

  it("returns no_applicable on an explicit decline (counts as ack, acted=[])", () => {
    const reply = "[Digital Me] no applicable wiki entries. Proceeding.";
    const { ackSignal, actedEntries } = parseDigitalMeAck(reply, surfaced);
    expect(ackSignal).toBe("no_applicable");
    expect(actedEntries).toEqual([]);
  });

  it("falls back to the top-1 surfaced entry when the prefix names nothing matchable", () => {
    const reply = "[Digital Me] applying the relevant guidance below.";
    const { ackSignal, actedEntries } = parseDigitalMeAck(reply, surfaced);
    expect(ackSignal).toBe("title_match");
    expect(actedEntries.map((e) => e.path)).toEqual([
      "infrastructure/m1-universal-event-protocol.md",
    ]);
  });

  it("does not count when the reply has no [Digital Me] prefix and cites nothing", () => {
    const reply = "Sure, here is a quick answer with no protocol prefix.";
    const { ackSignal, actedEntries } = parseDigitalMeAck(reply, surfaced);
    expect(ackSignal).toBe("no_acknowledgement");
    expect(actedEntries).toEqual([]);
  });

  it("returns no_acknowledgement when nothing was surfaced", () => {
    const { ackSignal } = parseDigitalMeAck("[Digital Me] applying x", []);
    expect(ackSignal).toBe("no_acknowledgement");
  });

  it("returns no_acknowledgement for an empty or whitespace-only reply", () => {
    expect(parseDigitalMeAck("", surfaced).ackSignal).toBe(
      "no_acknowledgement",
    );
    expect(parseDigitalMeAck("   \n\t ", surfaced).ackSignal).toBe(
      "no_acknowledgement",
    );
  });

  it("counts explicit_path for a slug hit without an .md extension", () => {
    const entries: AckEntry[] = [
      { path: "infrastructure/deploy-runbook-notes", title: "Deploy Runbook Notes" },
    ];
    const { ackSignal, actedEntries } = parseDigitalMeAck(
      "[Digital Me] applying deploy-runbook-notes as instructed.",
      entries,
    );
    expect(ackSignal).toBe("explicit_path");
    expect(actedEntries).toHaveLength(1);
  });

  it("matches by path when the surfaced entry has no title", () => {
    const entries: AckEntry[] = [{ path: "youtube/thumbnail-rules.md" }];
    const { ackSignal, actedEntries } = parseDigitalMeAck(
      "[Digital Me] applying thumbnail-rules here.",
      entries,
    );
    expect(ackSignal).toBe("explicit_path");
    expect(actedEntries.map((e) => e.path)).toEqual([
      "youtube/thumbnail-rules.md",
    ]);
  });

  it("tolerates entries with an empty path (title-only match)", () => {
    const entries: AckEntry[] = [
      { path: "", title: "Deployment Runbook Checklist" },
    ];
    const { ackSignal, actedEntries } = parseDigitalMeAck(
      "[Digital Me] applying Deployment Runbook Checklist.",
      entries,
    );
    expect(ackSignal).toBe("title_match");
    expect(actedEntries).toHaveLength(1);
  });

  it("matches a title stem, ignoring trailing decorations like ' (2026 edition)'", () => {
    const entries: AckEntry[] = [
      { path: "a.md", title: "Thumbnail Rules (2026 edition)" },
    ];
    const { ackSignal } = parseDigitalMeAck(
      "[Digital Me] applying Thumbnail Rules.",
      entries,
    );
    expect(ackSignal).toBe("title_match");
  });

  it("refuses to title-match a stem shorter than 5 chars (falls back to top-1 attribution)", () => {
    // "Git" stems to < 5 chars — too short to be a confident title match, so
    // the bare prefix falls back to top-1 attribution instead.
    const entries: AckEntry[] = [{ path: "a.md", title: "Git" }];
    const { ackSignal, actedEntries } = parseDigitalMeAck(
      "[Digital Me] applying Git",
      entries,
    );
    expect(ackSignal).toBe("title_match");
    expect(actedEntries).toEqual([entries[0]]);
  });
});
