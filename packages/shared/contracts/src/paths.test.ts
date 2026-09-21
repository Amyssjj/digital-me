import { describe, expect, it } from "vitest";

import {
  brainDataDirOf,
  openclawHomeOf,
  resolveBrainDbPath,
  resolveEnvFilePath,
  wikiRootOf,
} from "./paths.js";

const HOME = "/home/t";

function deps(env: Record<string, string | undefined>, existing: readonly string[] = []) {
  return { env, home: HOME, exists: (p: string) => existing.includes(p) };
}

describe("wikiRootOf / openclawHomeOf / brainDataDirOf", () => {
  it("prefer DIGITAL_ME_WIKI_ROOT, then the legacy DIGITAL_ME_HOME alias, then ~/digital-me", () => {
    expect(wikiRootOf({ DIGITAL_ME_WIKI_ROOT: "/w", DIGITAL_ME_HOME: "/h" }, HOME)).toBe("/w");
    expect(wikiRootOf({ DIGITAL_ME_HOME: "/h" }, HOME)).toBe("/h");
    expect(wikiRootOf({}, HOME)).toBe("/home/t/digital-me");
  });

  it("openclaw home honours OPENCLAW_HOME and defaults to ~/.openclaw", () => {
    expect(openclawHomeOf({ OPENCLAW_HOME: "/oc" }, HOME)).toBe("/oc");
    expect(openclawHomeOf({}, HOME)).toBe("/home/t/.openclaw");
  });

  it("the data dir is <wiki-root>/.data", () => {
    expect(brainDataDirOf({}, HOME)).toBe("/home/t/digital-me/.data");
  });
});

describe("resolveBrainDbPath", () => {
  it("an explicit DIGITAL_ME_BRAIN_DB wins over everything, even when both files exist", () => {
    const r = resolveBrainDbPath(
      deps({ DIGITAL_ME_BRAIN_DB: "/x/brain.db" }, ["/home/t/digital-me/.data/brain.db", "/home/t/.openclaw/data/brain.db"]),
    );
    expect(r).toEqual({ path: "/x/brain.db", source: "env" });
  });

  it("a blank DIGITAL_ME_BRAIN_DB counts as unset", () => {
    expect(resolveBrainDbPath(deps({ DIGITAL_ME_BRAIN_DB: "   " })).source).toBe("canonical");
  });

  it("prefers the canonical <wiki-root>/.data/brain.db once it exists", () => {
    const r = resolveBrainDbPath(
      deps({}, ["/home/t/digital-me/.data/brain.db", "/home/t/.openclaw/data/brain.db"]),
    );
    expect(r).toEqual({ path: "/home/t/digital-me/.data/brain.db", source: "canonical" });
  });

  it("falls back to the legacy ~/.openclaw/data/brain.db while only that one exists (pre-move installs keep working)", () => {
    const r = resolveBrainDbPath(deps({}, ["/home/t/.openclaw/data/brain.db"]));
    expect(r).toEqual({ path: "/home/t/.openclaw/data/brain.db", source: "legacy-openclaw" });
  });

  it("a fresh machine gets the canonical path (never a path under ~/.openclaw)", () => {
    const r = resolveBrainDbPath(deps({}));
    expect(r).toEqual({ path: "/home/t/digital-me/.data/brain.db", source: "canonical" });
  });

  it("honours DIGITAL_ME_WIKI_ROOT and OPENCLAW_HOME for both candidates", () => {
    expect(resolveBrainDbPath(deps({ DIGITAL_ME_WIKI_ROOT: "/w" })).path).toBe("/w/.data/brain.db");
    expect(
      resolveBrainDbPath(deps({ DIGITAL_ME_WIKI_ROOT: "/w", OPENCLAW_HOME: "/oc" }, ["/oc/data/brain.db"])).path,
    ).toBe("/oc/data/brain.db");
  });
});

describe("resolveEnvFilePath", () => {
  it("DIGITAL_ME_ENV_FILE → canonical <wiki-root>/.data/.env → legacy ~/.openclaw/.env → canonical", () => {
    expect(resolveEnvFilePath(deps({ DIGITAL_ME_ENV_FILE: "/e" }))).toEqual({ path: "/e", source: "env" });
    expect(resolveEnvFilePath(deps({}, ["/home/t/digital-me/.data/.env", "/home/t/.openclaw/.env"]))).toEqual({
      path: "/home/t/digital-me/.data/.env",
      source: "canonical",
    });
    expect(resolveEnvFilePath(deps({}, ["/home/t/.openclaw/.env"]))).toEqual({
      path: "/home/t/.openclaw/.env",
      source: "legacy-openclaw",
    });
    expect(resolveEnvFilePath(deps({}))).toEqual({
      path: "/home/t/digital-me/.data/.env",
      source: "canonical",
    });
  });
});
