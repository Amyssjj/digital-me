import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  digitalMeKnowledgePaths,
  ensureOpenclawMemoryPaths,
  mergeMemoryExtraPaths,
  resolveOpenclawConfigPath,
  seedKeylessEmbeddingFallback,
  type MemoryPathIO,
} from "./openclaw-memory.js";

/** In-memory IO so the wiring is tested without touching disk. */
function memIO(initial: Record<string, string> = {}): MemoryPathIO & {
  files: Record<string, string>;
  mkdirps: string[];
} {
  const files = { ...initial };
  const mkdirps: string[] = [];
  return {
    files,
    mkdirps,
    exists: (p) => p in files,
    read: (p) => files[p]!,
    write: (p, data) => {
      files[p] = data;
    },
    mkdirp: (p) => {
      mkdirps.push(p);
    },
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
  it("tolerates a null/non-object cfg by starting from an empty root", () => {
    // Defensive: callers hand in whatever JSON.parse produced.
    const { cfg, added } = mergeMemoryExtraPaths(
      null as unknown as Record<string, unknown>,
      ["/a/wiki"],
    );
    expect(added).toEqual(["/a/wiki"]);
    expect((cfg as any).agents.defaults.memorySearch.extraPaths).toEqual(["/a/wiki"]);
  });

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

describe("seedKeylessEmbeddingFallback", () => {
  it("seeds fallback: 'local' when the config has no embedding intent", () => {
    const { cfg } = mergeMemoryExtraPaths({}, ["/a/wiki"]);
    expect(seedKeylessEmbeddingFallback(cfg)).toBe(true);
    expect((cfg as any).agents.defaults.memorySearch.fallback).toBe("local");
  });

  it.each([
    ["provider", { provider: "gemini" }],
    ["fallback", { fallback: "none" }],
    ["remote", { remote: { apiKey: "k" } }],
  ] as const)("never touches a config with an explicit %s", (_name, ms) => {
    const { cfg } = mergeMemoryExtraPaths(
      { agents: { defaults: { memorySearch: { ...ms } } } },
      ["/a/wiki"],
    );
    expect(seedKeylessEmbeddingFallback(cfg)).toBe(false);
    expect((cfg as any).agents.defaults.memorySearch.fallback).toBe(
      (ms as Record<string, unknown>).fallback,
    );
  });
});

describe("ensureOpenclawMemoryPaths", () => {
  it("writes a fresh config when none exists (and seeds the keyless fallback)", () => {
    const io = memIO();
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(res.ok).toBe(true);
    expect(res.added).toEqual(["/home/u/digital-me/wiki", "/home/u/digital-me/tastes"]);
    expect(res.seededLocalFallback).toBe(true);
    expect(res.json5Rewritten).toBe(false);
    const written = JSON.parse(io.files["/home/u/.openclaw/openclaw.json"]!);
    expect(written.agents.defaults.memorySearch.extraPaths).toEqual([
      "/home/u/digital-me/wiki",
      "/home/u/digital-me/tastes",
    ]);
    // No embedding config at all → openclaw would default to `openai` (key
    // required) and index nothing on a keyless machine. The keyless bundled
    // fallback keeps a fresh install's index alive.
    expect(written.agents.defaults.memorySearch.fallback).toBe("local");
  });

  it("creates the knowledge dirs so the gateway can watch them from first start", () => {
    const io = memIO();
    ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(io.mkdirps).toContain("/home/u/digital-me/wiki");
    expect(io.mkdirps).toContain("/home/u/digital-me/tastes");
    // Config parent dir too (fresh machine has no ~/.openclaw yet).
    expect(io.mkdirps).toContain("/home/u/.openclaw");
  });

  it("is idempotent — a second run adds nothing and does not rewrite", () => {
    const io = memIO();
    const first = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(first.added).toHaveLength(2);
    const snapshot = io.files["/home/u/.openclaw/openclaw.json"];
    const second = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(second.added).toEqual([]);
    expect(second.seededLocalFallback).toBeUndefined();
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
    // remote block present = embedding intent → never seed over it.
    expect(res.seededLocalFallback).toBe(false);
    expect(written.agents.defaults.memorySearch.fallback).toBeUndefined();
  });

  it("seeds the keyless fallback even when both paths are already wired", () => {
    // Upgrade path: an install from before the seeding existed re-runs the
    // installer — added=[] must not short-circuit the seed-write.
    const cfgPath = "/home/u/.openclaw/openclaw.json";
    const io = memIO({
      [cfgPath]: JSON.stringify({
        agents: {
          defaults: {
            memorySearch: {
              extraPaths: ["/home/u/digital-me/wiki", "/home/u/digital-me/tastes"],
            },
          },
        },
      }),
    });
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(res.ok).toBe(true);
    expect(res.added).toEqual([]);
    expect(res.seededLocalFallback).toBe(true);
    const written = JSON.parse(io.files[cfgPath]!);
    expect(written.agents.defaults.memorySearch.fallback).toBe("local");
  });

  it("accepts a JSON5 config (comments, trailing commas) like openclaw itself", () => {
    // openclaw parses openclaw.json with the `json5` package — a
    // hand-annotated config is legal for the gateway and must not abort
    // the wiring (it used to: strict JSON.parse threw, the installer
    // printed a warning nobody read, and memory_search indexed nothing).
    const cfgPath = "/home/u/.openclaw/openclaw.json";
    const io = memIO({
      [cfgPath]: `{
        // my hand-tuned config
        agents: {
          defaults: {
            memorySearch: {
              provider: 'gemini',
              extraPaths: ["/home/u/digital-me/wiki",],
            },
          },
        },
      }`,
    });
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(res.ok).toBe(true);
    expect(res.added).toEqual(["/home/u/digital-me/tastes"]);
    expect(res.json5Rewritten).toBe(true);
    expect(res.seededLocalFallback).toBe(false); // provider present
    // Rewritten as plain JSON — openclaw's own config writer does the same.
    const written = JSON.parse(io.files[cfgPath]!);
    expect(written.agents.defaults.memorySearch.provider).toBe("gemini");
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

  it("treats a parseable non-object config as empty rather than crashing", () => {
    const cfgPath = "/home/u/.openclaw/openclaw.json";
    const io = memIO({ [cfgPath]: "null" });
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io);
    expect(res.ok).toBe(true);
    expect(res.added).toHaveLength(2);
    const written = JSON.parse(io.files[cfgPath]!);
    expect(written.agents.defaults.memorySearch.extraPaths).toHaveLength(2);
  });

  it("resolves the config path under OPENCLAW_HOME", () => {
    const io = memIO();
    const res = ensureOpenclawMemoryPaths("/home/u", "/data/dm", { OPENCLAW_HOME: "/oc" }, io);
    expect(res.configPath).toBe(path.join("/oc", "openclaw.json"));
    expect(io.files["/oc/openclaw.json"]).toBeDefined();
  });
});

describe("ensureOpenclawMemoryPaths (default disk IO)", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "dm-openclaw-memory-"));
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("writes then re-reads the real config file when no io seam is injected", () => {
    // Point the config at a nested path that does not exist yet so the
    // default IO exercises mkdirp + write, then exists + read on rerun.
    const cfgPath = path.join(tmp, "state", "openclaw.json");
    const env = { DIGITAL_ME_OPENCLAW_CONFIG: cfgPath };

    const first = ensureOpenclawMemoryPaths("/home/u", path.join(tmp, "dm"), env);
    expect(first.ok).toBe(true);
    expect(first.configPath).toBe(cfgPath);
    expect(first.added).toEqual([path.join(tmp, "dm", "wiki"), path.join(tmp, "dm", "tastes")]);
    expect(existsSync(cfgPath)).toBe(true);
    // The knowledge dirs are created for real, so the gateway's watcher
    // picks them up on its first post-install restart.
    expect(existsSync(path.join(tmp, "dm", "wiki"))).toBe(true);
    expect(existsSync(path.join(tmp, "dm", "tastes"))).toBe(true);
    const written = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(written.agents.defaults.memorySearch.extraPaths).toEqual([
      path.join(tmp, "dm", "wiki"),
      path.join(tmp, "dm", "tastes"),
    ]);
    expect(written.agents.defaults.memorySearch.fallback).toBe("local");

    // Second run reads the file back from disk and adds nothing.
    const second = ensureOpenclawMemoryPaths("/home/u", path.join(tmp, "dm"), env);
    expect(second.ok).toBe(true);
    expect(second.added).toEqual([]);
  });
});
