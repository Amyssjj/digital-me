import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  digitalMeKnowledgePaths,
  ensureOpenclawMemoryPaths,
  mergeMemoryExtraPaths,
  resolveOpenclawConfigPath,
  type MemoryPathIO,
} from "./openclaw-memory.js";

/** In-memory IO so the wiring is tested without touching disk. */
function memIO(initial: Record<string, string> = {}): MemoryPathIO & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    exists: (p) => p in files,
    read: (p) => files[p]!,
    write: (p, data) => {
      files[p] = data;
    },
    mkdirp: () => {},
  };
}

describe("resolveOpenclawConfigPath", () => {
  it("honors the tiered override order", () => {
    expect(resolveOpenclawConfigPath("/home/u", { DIGITAL_ME_OPENCLAW_CONFIG: "/x/cfg.json" })).toBe("/x/cfg.json");
    expect(resolveOpenclawConfigPath("/home/u", { OPENCLAW_HOME: "/oc" })).toBe("/oc/openclaw.json");
    expect(resolveOpenclawConfigPath("/home/u", {})).toBe("/home/u/.openclaw/openclaw.json");
  });
});

describe("digitalMeKnowledgePaths", () => {
  it("returns wiki + tastes under the resolved data root", () => {
    expect(digitalMeKnowledgePaths("/home/u", "/data/dm", {})).toEqual(["/data/dm/wiki", "/data/dm/tastes"]);
    expect(digitalMeKnowledgePaths("/home/u", undefined, { DIGITAL_ME_WIKI_ROOT: "/env/dm" })).toEqual([
      "/env/dm/wiki",
      "/env/dm/tastes",
    ]);
    expect(digitalMeKnowledgePaths("/home/u", undefined, {})).toEqual([
      "/home/u/digital-me/wiki",
      "/home/u/digital-me/tastes",
    ]);
  });
});

describe("mergeMemoryExtraPaths", () => {
  it("creates the nested structure and appends paths", () => {
    const { cfg, added } = mergeMemoryExtraPaths({}, ["/a/wiki", "/a/tastes"]);
    expect(added).toEqual(["/a/wiki", "/a/tastes"]);
    expect((cfg as any).agents.defaults.memorySearch.extraPaths).toEqual(["/a/wiki", "/a/tastes"]);
  });

  it("preserves existing memorySearch settings and dedups", () => {
    const existing = {
      agents: { defaults: { memorySearch: { provider: "gemini", extraPaths: ["/a/wiki"] } } },
    };
    const { cfg, added } = mergeMemoryExtraPaths(existing, ["/a/wiki", "/a/tastes"]);
    expect(added).toEqual(["/a/tastes"]); // wiki already present
    const ms = (cfg as any).agents.defaults.memorySearch;
    expect(ms.provider).toBe("gemini");
    expect(ms.extraPaths).toEqual(["/a/wiki", "/a/tastes"]);
  });
});

describe("ensureOpenclawMemoryPaths", () => {
  it("writes a fresh config when none exists", () => {
    const io = memIO();
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(res.ok).toBe(true);
    expect(res.added).toEqual(["/home/u/digital-me/wiki", "/home/u/digital-me/tastes"]);
    const written = JSON.parse(io.files["/home/u/.openclaw/openclaw.json"]!);
    expect(written.agents.defaults.memorySearch.extraPaths).toEqual([
      "/home/u/digital-me/wiki",
      "/home/u/digital-me/tastes",
    ]);
  });

  it("is idempotent — a second run adds nothing and does not rewrite", () => {
    const io = memIO();
    const first = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(first.added).toHaveLength(2);
    const snapshot = io.files["/home/u/.openclaw/openclaw.json"];
    const second = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(second.added).toEqual([]);
    expect(io.files["/home/u/.openclaw/openclaw.json"]).toBe(snapshot);
  });

  it("merges into an existing config without clobbering the api key", () => {
    const cfgPath = "/home/u/.openclaw/openclaw.json";
    const io = memIO({
      [cfgPath]: JSON.stringify({
        agents: { defaults: { memorySearch: { remote: { apiKey: "secret" }, extraPaths: ["/home/u/digital-me/wiki"] } } },
      }),
    });
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(res.added).toEqual(["/home/u/digital-me/tastes"]);
    const written = JSON.parse(io.files[cfgPath]!);
    expect(written.agents.defaults.memorySearch.remote.apiKey).toBe("secret");
    expect(written.agents.defaults.memorySearch.extraPaths).toEqual([
      "/home/u/digital-me/wiki",
      "/home/u/digital-me/tastes",
    ]);
  });

  it("reports a malformed config instead of clobbering it", () => {
    const cfgPath = "/home/u/.openclaw/openclaw.json";
    const io = memIO({ [cfgPath]: "{not json" });
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(res.ok).toBe(false);
    expect(res.added).toEqual([]);
    expect(io.files[cfgPath]).toBe("{not json"); // untouched
  });

  it("resolves the config path under OPENCLAW_HOME", () => {
    const io = memIO();
    const res = ensureOpenclawMemoryPaths("/home/u", "/data/dm", { OPENCLAW_HOME: "/oc" }, io);
    expect(res.configPath).toBe(path.join("/oc", "openclaw.json"));
    expect(io.files["/oc/openclaw.json"]).toBeDefined();
  });
});
