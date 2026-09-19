import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HashEmbedder } from "./retriever/embedder.js";
import { buildIndex } from "./retriever/index-builder.js";
import { VectorCache } from "./retriever/search.js";
import { IndexStore } from "./retriever/store.js";
import { errEnvelope, fromMcpResult, invokeTool, okEnvelope, resolveReadable, TOOL_NAMES, type ToolDeps } from "./tools.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function setup(): Promise<ToolDeps> {
  dir = mkdtempSync(join(tmpdir(), "bh-tools-"));
  const wiki = join(dir, "wiki");
  const tastes = join(dir, "tastes");
  mkdirSync(join(wiki, "dashboard"), { recursive: true });
  mkdirSync(tastes, { recursive: true });
  writeFileSync(
    join(wiki, "dashboard", "kanban.md"),
    "---\ntitle: Kanban range filters by updated_at\ndomain: [dashboard]\n---\n\n## Rule\nUse all time to see stale goals.\n\n## Apply when\nA goal vanished from the board.\n",
  );
  writeFileSync(join(dir, "secret.md"), "outside\n");
  const store = new IndexStore(new DatabaseSync(":memory:"));
  const embedder = new HashEmbedder(32);
  await buildIndex({ roots: [{ dir: wiki, corpus: "wiki" }, { dir: tastes, corpus: "tastes" }], store, embedder });
  return { store, cache: new VectorCache(store), embedder, readableRoots: [wiki, tastes], wikiRoot: dir, version: "test" };
}

describe("invokeTool", () => {
  it("memory_search returns hits in the gateway envelope", async () => {
    const deps = await setup();
    const env = await invokeTool(deps, "memory_search", { query: "goal vanished board", limit: 5 });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("unreachable");
    expect(env.result.details.count).toBe(1);
    expect(env.result.details.citations).toBe("auto");
    expect(JSON.parse(env.result.content[0]!.text).results[0].relPath).toBe("wiki/dashboard/kanban.md");
    const viaMax = await invokeTool(deps, "memory_search", { query: "goal", maxResults: 1 });
    expect(viaMax.ok && viaMax.result.details.count).toBe(1);
  });

  it("memory_search rejects a missing query and surfaces an unusable index as an error", async () => {
    const deps = await setup();
    expect(await invokeTool(deps, "memory_search", { query: "  " })).toEqual(errEnvelope("invalid_request", "memory_search requires a non-empty `query`"));
    const empty = { ...deps, store: new IndexStore(new DatabaseSync(":memory:")) };
    const env = await invokeTool({ ...empty, cache: new VectorCache(empty.store) }, "memory_search", { query: "x" });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("unreachable");
    expect(env.error.type).toBe("search_unavailable");
    expect(env.error.message).toMatch(/index is empty/);
  });

  it("memory_get reads by wiki-relative, root-relative and absolute path with line windows", async () => {
    const deps = await setup();
    const rel = await invokeTool(deps, "memory_get", { path: "wiki/dashboard/kanban.md", from: 6, lines: 2 });
    expect(rel.ok && rel.result.details).toMatchObject({ from: 6, lines: 2, text: "## Rule\nUse all time to see stale goals." });
    const rootRel = await invokeTool(deps, "memory_get", { path: "dashboard/kanban.md" });
    expect(rootRel.ok && (rootRel.result.details.total as number)).toBeGreaterThan(5);
    const abs = await invokeTool(deps, "memory_get", { path: join(dir, "wiki", "dashboard", "kanban.md"), from: 0, lines: 0 });
    expect(abs.ok && abs.result.details.from).toBe(1);
  });

  it("memory_get refuses paths outside the roots and reports missing files", async () => {
    const deps = await setup();
    expect((await invokeTool(deps, "memory_get", {})).ok).toBe(false);
    const outside = await invokeTool(deps, "memory_get", { path: "../secret.md" });
    expect(!outside.ok && outside.error.type).toBe("forbidden");
    const absOutside = await invokeTool(deps, "memory_get", { path: join(dir, "secret.md") });
    expect(!absOutside.ok && absOutside.error.type).toBe("forbidden");
    const missing = await invokeTool(deps, "memory_get", { path: "wiki/dashboard/nope.md" });
    expect(!missing.ok && missing.error.type).toBe("not_found");
  });

  it("wiki status reports index stats; other actions are rejected", async () => {
    const deps = await setup();
    const st = await invokeTool(deps, "wiki", {});
    expect(st.ok && st.result.details).toMatchObject({ status: "ok", version: "test", entries: 1, sections: 2 });
    const bad = await invokeTool(deps, "wiki", { action: "read" });
    expect(!bad.ok && bad.error.type).toBe("invalid_request");
  });

  it("unknown tools name the served set", async () => {
    const deps = await setup();
    const env = await invokeTool(deps, "tasks", {});
    expect(!env.ok && env.error.message).toContain(TOOL_NAMES.join(", "));
  });

  it("routes to mounted orchestrator tools and lists them in the unknown-tool message", async () => {
    const deps = await setup();
    const extra = new Map([
      ["tasks", { name: "tasks", description: "d", execute: async (p: Readonly<Record<string, unknown>>) => ({ content: [{ type: "text" as const, text: `action=${p.action}` }], details: { json: { ok: 1 } } }) }],
      ["failing", { name: "failing", description: "d", execute: async () => ({ content: [{ type: "text" as const, text: "nope" }], details: {}, isError: true }) }],
    ]);
    const withExtra = { ...deps, extraTools: extra };
    const ok = await invokeTool(withExtra, "tasks", { action: "board" });
    expect(ok).toEqual({ ok: true, result: { content: [{ type: "text", text: "action=board" }], details: { json: { ok: 1 } } } });
    const failing = await invokeTool(withExtra, "failing", {});
    expect(failing.ok && failing.result.isError).toBe(true);
    const unknown = await invokeTool(withExtra, "zzz", {});
    expect(!unknown.ok && unknown.error.message).toContain("tasks, failing");
  });

  it("fromMcpResult copies content and details", () => {
    const env = fromMcpResult({ content: [{ type: "text", text: "t" }], details: { a: 1 } });
    expect(env).toEqual({ ok: true, result: { content: [{ type: "text", text: "t" }], details: { a: 1 } } });
  });

  it("okEnvelope pretty-prints details", () => {
    const env = okEnvelope({ a: 1 });
    expect(env.ok && env.result.content[0]!.text).toBe('{\n  "a": 1\n}');
  });
});

describe("resolveReadable", () => {
  it("accepts a root itself and rejects traversal", () => {
    expect(resolveReadable(["/r/wiki"], "/r", "/r/wiki")).toBe("/r/wiki");
    expect(resolveReadable(["/r/wiki"], "/r", "wiki/../../etc/passwd")).toBeNull();
    expect(resolveReadable(["/r/wiki/"], "/r", "wiki/a.md")).toBe("/r/wiki/a.md");
  });
});
