import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONVERSATION_HOOK_PROMPT_BUILD_MIN_VERSION,
  isAtLeastOpenclawVersion,
  MAX_TESTED_OPENCLAW_VERSION,
  MEMORY_SEARCH_NAMESPACE_MIN_VERSION,
  OPENCLAW_MIN_HOST_VERSION,
  resolveHostOpenclawVersion,
  warnIfUntestedHost,
} from "./compat.js";

// resolveHostOpenclawVersion reads these before falling back to config; clear
// them so tests exercise the config.meta path deterministically.
const VERSION_ENV_VARS = [
  "OPENCLAW_BUNDLED_VERSION",
  "OPENCLAW_VERSION",
  "OPENCLAW_SERVICE_VERSION",
];

function makeApi(lastTouchedVersion?: string) {
  const warnings: string[] = [];
  return {
    api: {
      config: lastTouchedVersion
        ? { meta: { lastTouchedVersion } }
        : undefined,
      logger: { warn: (msg: string) => warnings.push(msg) },
    },
    warnings,
  };
}

describe("compat", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of VERSION_ENV_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of VERSION_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("OPENCLAW_MIN_HOST_VERSION uses openclaw's >=x.y.z shape", () => {
    expect(OPENCLAW_MIN_HOST_VERSION).toMatch(/^>=\d+\.\d+\.\d+$/);
  });

  it("resolves host version from config.meta.lastTouchedVersion", () => {
    const { api } = makeApi("2026.6.10");
    expect(resolveHostOpenclawVersion(api)).toBe("2026.6.10");
  });

  it("prefers an env var over config.meta", () => {
    process.env.OPENCLAW_BUNDLED_VERSION = "2026.6.5";
    const { api } = makeApi("2026.6.10");
    expect(resolveHostOpenclawVersion(api)).toBe("2026.6.5");
  });

  it("warns when the host is newer than the tested range", () => {
    const { api, warnings } = makeApi("2026.9.1");
    warnIfUntestedHost(api, "digital-me-brain");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("digital-me-brain");
    expect(warnings[0]).toContain("2026.9.1");
  });

  it("does not warn when the host equals the tested ceiling", () => {
    const { api, warnings } = makeApi(MAX_TESTED_OPENCLAW_VERSION);
    warnIfUntestedHost(api, "digital-me-brain");
    expect(warnings).toHaveLength(0);
  });

  it("does not warn when the host is within the tested range", () => {
    const { api, warnings } = makeApi("2026.6.9");
    warnIfUntestedHost(api, "digital-me-recall");
    expect(warnings).toHaveLength(0);
  });

  it("does not warn (and does not throw) when the host version is unknown", () => {
    const { api, warnings } = makeApi(undefined);
    expect(() => warnIfUntestedHost(api, "digital-me-brain")).not.toThrow();
    expect(warnings).toHaveLength(0);
  });

  it("never throws on a missing api", () => {
    expect(() => warnIfUntestedHost(undefined, "digital-me-brain")).not.toThrow();
  });

  it("warns when the host is newer by YEAR (not just month/patch)", () => {
    const { api, warnings } = makeApi("2027.1.0");
    warnIfUntestedHost(api, "digital-me-brain");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("2027.1.0");
  });

  it("does not warn when the host is older by YEAR", () => {
    const { api, warnings } = makeApi("2025.12.99");
    warnIfUntestedHost(api, "digital-me-brain");
    expect(warnings).toHaveLength(0);
  });

  it("does not warn (and does not throw) on an unparseable host version", () => {
    const { api, warnings } = makeApi("beta");
    expect(() => warnIfUntestedHost(api, "digital-me-brain")).not.toThrow();
    expect(warnings).toHaveLength(0);
  });

  it("resolveHostOpenclawVersion returns undefined when the api throws on access", () => {
    // Defensive contract: a hostile/buggy api object (throwing config getter)
    // must resolve to "unknown version", never propagate.
    const throwingApi = {
      get config(): never {
        throw new Error("boom");
      },
    } as unknown as Parameters<typeof resolveHostOpenclawVersion>[0];
    expect(resolveHostOpenclawVersion(throwingApi)).toBeUndefined();
  });

  it("warnIfUntestedHost swallows a throwing logger (compat check must never block load)", () => {
    const api = {
      config: { meta: { lastTouchedVersion: "2027.1.0" } },
      logger: {
        warn: () => {
          throw new Error("logger exploded");
        },
      },
    };
    expect(() => warnIfUntestedHost(api, "digital-me-brain")).not.toThrow();
  });
});

describe("isAtLeastOpenclawVersion", () => {
  it("compares on [year, month, patch], not string order", () => {
    // "2026.10.1" < "2026.9.1" lexicographically but is NEWER by calendar.
    expect(isAtLeastOpenclawVersion("2026.10.1", "2026.9.1")).toBe(true);
    expect(isAtLeastOpenclawVersion("2026.6.11", "2026.7.1")).toBe(false);
    expect(isAtLeastOpenclawVersion("2026.7.1", "2026.7.1")).toBe(true);
    expect(isAtLeastOpenclawVersion("2026.8.1", "2026.7.1")).toBe(true);
    // Patch ordering within a month is numeric, not lexical: 6.34 > 6.11.
    expect(isAtLeastOpenclawVersion("2026.6.34", "2026.6.11")).toBe(true);
  });

  it("tolerates a prerelease suffix on the host version", () => {
    expect(isAtLeastOpenclawVersion("2026.9.1-beta.1", "2026.8.1")).toBe(true);
  });

  it("returns undefined — never false — when a version is unparseable", () => {
    // A caller must be able to distinguish "older" from "unknown": picking a
    // config layout from a bad parse would make openclaw reject the config.
    expect(isAtLeastOpenclawVersion(undefined, "2026.7.1")).toBeUndefined();
    expect(isAtLeastOpenclawVersion("unknown", "2026.7.1")).toBeUndefined();
    expect(isAtLeastOpenclawVersion("2026.7.1", "not-a-version")).toBeUndefined();
  });
});

describe("openclaw cutover constants", () => {
  it("pins the releases whose behaviour digital-me branches on", () => {
    // Changing either of these changes which config layout we write and when
    // we expect hooks to be gated — both are load-bearing, so pin them.
    expect(MEMORY_SEARCH_NAMESPACE_MIN_VERSION).toBe("2026.7.1");
    expect(CONVERSATION_HOOK_PROMPT_BUILD_MIN_VERSION).toBe("2026.8.1");
    // The verified ceiling must not drift below a cutover we already handle.
    expect(isAtLeastOpenclawVersion(MAX_TESTED_OPENCLAW_VERSION, MEMORY_SEARCH_NAMESPACE_MIN_VERSION)).toBe(true);
  });
});
