import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONVERSATION_HOOK_PLUGIN_IDS,
  detectMemorySearchLayout,
  detectOpenclawHostVersion,
  digitalMeKnowledgePaths,
  ensureOpenclawMemoryPaths,
  mergeHookGrants,
  mergeMemoryExtraPaths,
  migrateMemorySearchLayout,
  parseOpenclawVersionOutput,
  probeOpenclawVersion,
  resolveMemorySearchLayout,
  resolveOpenclawConfigPath,
  seedKeylessEmbeddingFallback,
  type MemoryPathIO,
} from "./openclaw-memory.js";

/** Deterministic `openclaw --version` probes. Without these the suite would
 *  read the HOST's installed openclaw and pick a config layout from it — the
 *  tests would then pass or fail depending on the machine. */
const OC_6_11 = () => "OpenClaw 2026.6.11 (e085fa1)";
const OC_8_1 = () => "OpenClaw 2026.8.1 (4d37fc4)";
const OC_UNKNOWN = () => undefined;

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
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
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
    ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
    expect(io.mkdirps).toContain("/home/u/digital-me/wiki");
    expect(io.mkdirps).toContain("/home/u/digital-me/tastes");
    // Config parent dir too (fresh machine has no ~/.openclaw yet).
    expect(io.mkdirps).toContain("/home/u/.openclaw");
  });

  it("is idempotent — a second run adds nothing and does not rewrite", () => {
    const io = memIO();
    const first = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
    expect(first.added).toHaveLength(2);
    const snapshot = io.files["/home/u/.openclaw/openclaw.json"];
    const second = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
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
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
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
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
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
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
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
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
    expect(res.ok).toBe(false);
    expect(res.added).toEqual([]);
    expect(io.files[cfgPath]).toBe("{not json"); // untouched
  });

  it("treats a parseable non-object config as empty rather than crashing", () => {
    const cfgPath = "/home/u/.openclaw/openclaw.json";
    const io = memIO({ [cfgPath]: "null" });
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
    expect(res.ok).toBe(true);
    expect(res.added).toHaveLength(2);
    const written = JSON.parse(io.files[cfgPath]!);
    expect(written.agents.defaults.memorySearch.extraPaths).toHaveLength(2);
  });

  it("resolves the config path under OPENCLAW_HOME", () => {
    const io = memIO();
    const res = ensureOpenclawMemoryPaths("/home/u", "/data/dm", { OPENCLAW_HOME: "/oc" }, io, OC_6_11);
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

    const first = ensureOpenclawMemoryPaths("/home/u", path.join(tmp, "dm"), env, undefined, OC_6_11);
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
    const second = ensureOpenclawMemoryPaths("/home/u", path.join(tmp, "dm"), env, undefined, OC_6_11);
    expect(second.ok).toBe(true);
    expect(second.added).toEqual([]);
  });
});

// ── openclaw 2026.7.1 memory-search namespace cutover ──────────────────────
//
// openclaw moved this block from `agents.defaults.memorySearch` to root
// `memory.search` in 2026.7.1. Both schemas are `.strict()` and the loader
// THROWS on an unknown key, so writing the wrong layout does not merely leave
// the corpus unindexed — it stops the gateway from starting. These tests pin
// that we always write exactly one layout, and the one the host accepts.

describe("detectMemorySearchLayout", () => {
  it("identifies each layout and reports neither for an empty config", () => {
    expect(detectMemorySearchLayout({ agents: { defaults: { memorySearch: {} } } })).toBe("legacy");
    expect(detectMemorySearchLayout({ memory: { search: {} } })).toBe("namespaced");
    expect(detectMemorySearchLayout({})).toBeUndefined();
    expect(detectMemorySearchLayout({ agents: { defaults: {} } })).toBeUndefined();
  });
});

describe("resolveMemorySearchLayout", () => {
  it("lets an existing block win over the host version", () => {
    // Moving a block is a migration, never a side effect of wiring paths.
    const legacyCfg = { agents: { defaults: { memorySearch: {} } } };
    expect(resolveMemorySearchLayout(legacyCfg, "2026.8.1")).toBe("legacy");
    const nsCfg = { memory: { search: {} } };
    expect(resolveMemorySearchLayout(nsCfg, "2026.6.11")).toBe("namespaced");
  });

  it("picks by host version when the config has no block", () => {
    expect(resolveMemorySearchLayout({}, "2026.6.11")).toBe("legacy");
    expect(resolveMemorySearchLayout({}, "2026.7.1")).toBe("namespaced");
    expect(resolveMemorySearchLayout({}, "2026.8.1")).toBe("namespaced");
  });

  it("defaults to the current namespace when the host version is unknown", () => {
    expect(resolveMemorySearchLayout({}, undefined)).toBe("namespaced");
  });
});

describe("migrateMemorySearchLayout", () => {
  it("moves the block to the new namespace, preserving every sub-key", () => {
    const cfg: Record<string, unknown> = {
      agents: { defaults: { memorySearch: { enabled: true, extraPaths: ["/w"], provider: "gemini", remote: { apiKey: "${K}" } } } },
    };
    const { migrated, from } = migrateMemorySearchLayout(cfg, "namespaced");
    expect(migrated).toBe(true);
    expect(from).toBe("legacy");
    expect(cfg.memory).toEqual({
      search: { enabled: true, extraPaths: ["/w"], provider: "gemini", remote: { apiKey: "${K}" } },
    });
    // The legacy key MUST be gone: leaving it makes openclaw >= 2026.7.1
    // reject the whole config, not just ignore the stale key.
    expect((cfg.agents as Record<string, Record<string, unknown>>).defaults.memorySearch).toBeUndefined();
  });

  it("moves back to the legacy layout for an older host", () => {
    const cfg: Record<string, unknown> = { memory: { search: { extraPaths: ["/w"] } } };
    const { migrated } = migrateMemorySearchLayout(cfg, "legacy");
    expect(migrated).toBe(true);
    expect((cfg.agents as Record<string, Record<string, unknown>>).defaults.memorySearch).toEqual({
      extraPaths: ["/w"],
    });
    // An emptied `memory` wrapper is dropped rather than left as noise.
    expect(cfg.memory).toBeUndefined();
  });

  it("keeps a sibling memory key when only search moves out", () => {
    const cfg: Record<string, unknown> = { memory: { citations: "on", search: { extraPaths: [] } } };
    migrateMemorySearchLayout(cfg, "legacy");
    expect(cfg.memory).toEqual({ citations: "on" });
  });

  it("is a no-op when already on target or when there is no block", () => {
    expect(migrateMemorySearchLayout({ memory: { search: {} } }, "namespaced").migrated).toBe(false);
    expect(migrateMemorySearchLayout({}, "namespaced").migrated).toBe(false);
  });
});

describe("mergeMemoryExtraPaths (layout-aware)", () => {
  it("writes to memory.search and leaves the legacy key absent", () => {
    const { cfg } = mergeMemoryExtraPaths({}, ["/w", "/t"], "namespaced");
    expect(cfg).toEqual({ memory: { search: { extraPaths: ["/w", "/t"] } } });
    expect(cfg.agents).toBeUndefined();
  });

  it("preserves foreign {path, pattern} entries openclaw >= 2026.7.1 allows", () => {
    const cfg: Record<string, unknown> = {
      memory: { search: { extraPaths: [{ path: "/notes", pattern: "*.md" }, "/w"] } },
    };
    const { added } = mergeMemoryExtraPaths(cfg, ["/w", "/t"], "namespaced");
    expect(added).toEqual(["/t"]);
    expect((cfg.memory as Record<string, Record<string, unknown>>).search.extraPaths).toEqual([
      { path: "/notes", pattern: "*.md" },
      "/w",
      "/t",
    ]);
  });
});

describe("mergeHookGrants", () => {
  it("grants conversation access to digital-me-recall only", () => {
    const cfg: Record<string, unknown> = {};
    const { granted } = mergeHookGrants(cfg, CONVERSATION_HOOK_PLUGIN_IDS);
    expect(granted).toEqual(["digital-me-recall"]);
    expect(cfg.plugins).toEqual({
      entries: { "digital-me-recall": { hooks: { allowConversationAccess: true } } },
    });
    // digital-me-brain registers tools and no hooks — granting it would hand
    // out a capability it never uses.
    expect(CONVERSATION_HOOK_PLUGIN_IDS).not.toContain("digital-me-brain");
  });

  it("preserves an existing entry's other settings", () => {
    const cfg: Record<string, unknown> = {
      plugins: { entries: { "digital-me-recall": { enabled: true, config: { debug: true } } } },
    };
    mergeHookGrants(cfg, ["digital-me-recall"]);
    const entry = (cfg.plugins as Record<string, Record<string, Record<string, unknown>>>).entries[
      "digital-me-recall"
    ]!;
    expect(entry.enabled).toBe(true);
    expect(entry.config).toEqual({ debug: true });
    expect((entry.hooks as Record<string, unknown>).allowConversationAccess).toBe(true);
  });

  it("never overrides a deliberate opt-out", () => {
    const cfg: Record<string, unknown> = {
      plugins: { entries: { "digital-me-recall": { hooks: { allowConversationAccess: false } } } },
    };
    const { granted } = mergeHookGrants(cfg, ["digital-me-recall"]);
    expect(granted).toEqual([]);
    const entry = (cfg.plugins as Record<string, Record<string, Record<string, unknown>>>).entries[
      "digital-me-recall"
    ]!;
    expect((entry.hooks as Record<string, unknown>).allowConversationAccess).toBe(false);
  });

  it("is idempotent", () => {
    const cfg: Record<string, unknown> = {};
    mergeHookGrants(cfg, ["digital-me-recall"]);
    expect(mergeHookGrants(cfg, ["digital-me-recall"]).granted).toEqual([]);
  });
});

describe("parseOpenclawVersionOutput", () => {
  it("extracts the calendar version from the CLI banner", () => {
    expect(parseOpenclawVersionOutput("OpenClaw 2026.8.1 (4d37fc4)")).toBe("2026.8.1");
    expect(parseOpenclawVersionOutput("2026.6.11\n")).toBe("2026.6.11");
    expect(parseOpenclawVersionOutput("OpenClaw 2026.9.1-beta.1")).toBe("2026.9.1-beta.1");
  });

  it("returns undefined for output with no version", () => {
    expect(parseOpenclawVersionOutput("command not found")).toBeUndefined();
    expect(parseOpenclawVersionOutput(undefined)).toBeUndefined();
  });
});

describe("detectOpenclawHostVersion", () => {
  it("prefers the source checkout — it is the binary the shim runs", () => {
    // Mid-update the checkout is already on the new tag while the config
    // stamp still says the old one; the checkout is the truth.
    const io = memIO({ "/home/u/openclaw/package.json": JSON.stringify({ version: "2026.8.1" }) });
    expect(
      detectOpenclawHostVersion("/home/u", { meta: { lastTouchedVersion: "2026.6.11" } }, {}, io, OC_6_11),
    ).toBe("2026.8.1");
  });

  it("falls back to the CLI probe, then to the config stamp", () => {
    const io = memIO();
    expect(detectOpenclawHostVersion("/home/u", {}, {}, io, OC_8_1)).toBe("2026.8.1");
    expect(
      detectOpenclawHostVersion("/home/u", { meta: { lastTouchedVersion: "2026.6.11" } }, {}, io, OC_UNKNOWN),
    ).toBe("2026.6.11");
    expect(detectOpenclawHostVersion("/home/u", {}, {}, io, OC_UNKNOWN)).toBeUndefined();
  });

  it("honors $OPENCLAW_REPO for a non-default checkout location", () => {
    const io = memIO({ "/srv/oc/package.json": JSON.stringify({ version: "2026.7.1" }) });
    expect(detectOpenclawHostVersion("/home/u", {}, { OPENCLAW_REPO: "/srv/oc" }, io, OC_UNKNOWN)).toBe(
      "2026.7.1",
    );
  });

  it("ignores an unreadable checkout package.json instead of throwing", () => {
    const io = memIO({ "/home/u/openclaw/package.json": "{ not json" });
    expect(detectOpenclawHostVersion("/home/u", {}, {}, io, OC_8_1)).toBe("2026.8.1");
  });
});

describe("ensureOpenclawMemoryPaths (host-version aware)", () => {
  it("writes memory.search and grants the recall hook on a 2026.8.1 host", () => {
    const io = memIO();
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_8_1);
    expect(res.ok).toBe(true);
    expect(res.layout).toBe("namespaced");
    expect(res.hookGrants).toEqual(["digital-me-recall"]);
    const written = JSON.parse(io.files["/home/u/.openclaw/openclaw.json"]!);
    expect(written.memory.search.extraPaths).toEqual([
      "/home/u/digital-me/wiki",
      "/home/u/digital-me/tastes",
    ]);
    expect(written.agents?.defaults?.memorySearch).toBeUndefined();
    expect(written.plugins.entries["digital-me-recall"].hooks.allowConversationAccess).toBe(true);
  });

  it("migrates a legacy config forward when the host has crossed the cutover", () => {
    // This is the update path: the config was written by 2026.6.x and the
    // binary is now 2026.8.1. Left alone, openclaw rejects it and the gateway
    // will not start.
    const io = memIO({
      "/home/u/.openclaw/openclaw.json": JSON.stringify({
        agents: {
          defaults: {
            memorySearch: { extraPaths: ["/home/u/digital-me/wiki"], provider: "gemini" },
          },
        },
      }),
    });
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_8_1);
    expect(res.migratedLayoutFrom).toBe("legacy");
    const written = JSON.parse(io.files["/home/u/.openclaw/openclaw.json"]!);
    expect(written.memory.search.provider).toBe("gemini");
    expect(written.memory.search.extraPaths).toEqual([
      "/home/u/digital-me/wiki",
      "/home/u/digital-me/tastes",
    ]);
    expect(written.agents.defaults.memorySearch).toBeUndefined();
  });

  it("migrates BACK when the host is rolled back below the cutover", () => {
    const io = memIO({
      "/home/u/.openclaw/openclaw.json": JSON.stringify({
        memory: { search: { extraPaths: ["/home/u/digital-me/wiki"] } },
      }),
    });
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
    expect(res.layout).toBe("legacy");
    expect(res.migratedLayoutFrom).toBe("namespaced");
    const written = JSON.parse(io.files["/home/u/.openclaw/openclaw.json"]!);
    expect(written.agents.defaults.memorySearch.extraPaths).toHaveLength(2);
    expect(written.memory).toBeUndefined();
  });

  it("writes the grant even when every path is already wired", () => {
    // The paths were wired by an older digital-me that knew nothing about the
    // hook policy; the run must still repair the grant rather than no-op.
    const io = memIO({
      "/home/u/.openclaw/openclaw.json": JSON.stringify({
        agents: {
          defaults: {
            memorySearch: {
              fallback: "local",
              extraPaths: ["/home/u/digital-me/wiki", "/home/u/digital-me/tastes"],
            },
          },
        },
      }),
    });
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_6_11);
    expect(res.added).toEqual([]);
    expect(res.hookGrants).toEqual(["digital-me-recall"]);
    const written = JSON.parse(io.files["/home/u/.openclaw/openclaw.json"]!);
    expect(written.plugins.entries["digital-me-recall"].hooks.allowConversationAccess).toBe(true);
  });

  it("is idempotent on a fully-wired 2026.8.1 config", () => {
    const io = memIO();
    ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_8_1);
    const before = io.files["/home/u/.openclaw/openclaw.json"];
    const second = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_8_1);
    expect(second.added).toEqual([]);
    expect(second.hookGrants).toEqual([]);
    expect(second.migratedLayoutFrom).toBeUndefined();
    expect(io.files["/home/u/.openclaw/openclaw.json"]).toBe(before);
  });
});

describe("probeOpenclawVersion", () => {
  const opts = { encoding: "utf-8" as const, timeout: 20_000 };

  it("returns stdout on a clean exit", () => {
    const calls: unknown[][] = [];
    const out = probeOpenclawVersion((cmd, args, o) => {
      calls.push([cmd, args, o]);
      return { status: 0, stdout: "OpenClaw 2026.8.1 (4d37fc4)\n" };
    });
    expect(out).toBe("OpenClaw 2026.8.1 (4d37fc4)\n");
    expect(calls[0]).toEqual(["openclaw", ["--version"], opts]);
  });

  it("returns undefined on a non-zero exit or a signal kill", () => {
    expect(probeOpenclawVersion(() => ({ status: 1, stdout: "nope" }))).toBeUndefined();
    // A timeout kill surfaces as status null, not a throw.
    expect(probeOpenclawVersion(() => ({ status: null }))).toBeUndefined();
  });

  it("swallows a throwing spawn — a missing binary must not fail the install", () => {
    expect(
      probeOpenclawVersion(() => {
        throw new Error("ENOENT");
      }),
    ).toBeUndefined();
  });
});

describe("ensureOpenclawMemoryPaths (unknown host version)", () => {
  it("falls back to the config's own layout rather than guessing", () => {
    // No checkout, no CLI, no stamp — but the config already says which
    // layout this machine's openclaw speaks. Trust it over any default.
    const io = memIO({
      "/home/u/.openclaw/openclaw.json": JSON.stringify({
        agents: { defaults: { memorySearch: { extraPaths: [] } } },
      }),
    });
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_UNKNOWN);
    expect(res.layout).toBe("legacy");
    expect(res.migratedLayoutFrom).toBeUndefined();
    const written = JSON.parse(io.files["/home/u/.openclaw/openclaw.json"]!);
    expect(written.agents.defaults.memorySearch.extraPaths).toHaveLength(2);
    expect(written.memory).toBeUndefined();
  });

  it("defaults a blank config to the current namespace", () => {
    const io = memIO();
    const res = ensureOpenclawMemoryPaths("/home/u", "/home/u/digital-me", {}, io, OC_UNKNOWN);
    expect(res.layout).toBe("namespaced");
  });
});
