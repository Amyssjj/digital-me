import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import {
  _internal,
  allEnvKeys,
  describeEnv,
  loadConfig,
  MissingRequiredEnvError,
} from "./env.js";

describe("loadConfig — DIGITAL_ME_HOME is an optional alias for DIGITAL_ME_WIKI_ROOT", () => {
  it("does not throw when DIGITAL_ME_HOME is unset (no required vars)", () => {
    expect(() => loadConfig({})).not.toThrow();
  });

  it("falls back to the DIGITAL_ME_WIKI_ROOT default when unset", () => {
    const cfg = loadConfig({});
    expect(cfg.DIGITAL_ME_HOME).toBe(path.join(homedir(), "digital-me"));
    expect(cfg.DIGITAL_ME_WIKI_ROOT).toBe(path.join(homedir(), "digital-me"));
  });

  it("treats empty string as unset and falls back to DIGITAL_ME_WIKI_ROOT", () => {
    const cfg = loadConfig({ DIGITAL_ME_HOME: "", DIGITAL_ME_WIKI_ROOT: "/data/me" });
    expect(cfg.DIGITAL_ME_HOME).toBe("/data/me");
  });

  it("accepts an explicit DIGITAL_ME_HOME value", () => {
    const cfg = loadConfig({ DIGITAL_ME_HOME: "/data/me" });
    expect(cfg.DIGITAL_ME_HOME).toBe("/data/me");
  });

  it("an explicit DIGITAL_ME_WIKI_ROOT flows into the DIGITAL_ME_HOME alias", () => {
    const cfg = loadConfig({ DIGITAL_ME_WIKI_ROOT: "/data/me" });
    expect(cfg.DIGITAL_ME_HOME).toBe("/data/me");
    expect(cfg.DIGITAL_ME_WIKI_DIR).toBe("/data/me/wiki");
  });
});

describe("loadConfig — derived defaults", () => {
  it("derives DIGITAL_ME_WIKI_DIR from DIGITAL_ME_HOME", () => {
    const cfg = loadConfig({ DIGITAL_ME_HOME: "/data/me" });
    expect(cfg.DIGITAL_ME_WIKI_DIR).toBe("/data/me/wiki");
  });

  it("derives DREAM_CYCLE_HOME from DIGITAL_ME_HOME", () => {
    const cfg = loadConfig({ DIGITAL_ME_HOME: "/data/me" });
    expect(cfg.DREAM_CYCLE_HOME).toBe("/data/me/dream_cycle");
  });

  it("derives DREAM_CYCLE_VENV from DREAM_CYCLE_HOME (which is itself derived)", () => {
    const cfg = loadConfig({ DIGITAL_ME_HOME: "/data/me" });
    expect(cfg.DREAM_CYCLE_VENV).toBe("/data/me/dream_cycle/.venv");
  });

  it("derives OPENCLAW_DATA_DIR from the default OPENCLAW_HOME", () => {
    const cfg = loadConfig({ DIGITAL_ME_HOME: "/data/me" });
    expect(cfg.OPENCLAW_HOME).toBe(path.join(homedir(), ".openclaw"));
    expect(cfg.OPENCLAW_DATA_DIR).toBe(
      path.join(homedir(), ".openclaw", "data"),
    );
  });

  it("derives ORCHESTRATOR_DB_PATH from OPENCLAW_DATA_DIR", () => {
    const cfg = loadConfig({
      DIGITAL_ME_HOME: "/data/me",
      OPENCLAW_DATA_DIR: "/custom/data",
    });
    expect(cfg.ORCHESTRATOR_DB_PATH).toBe("/custom/data/orchestrator.db");
  });

  it("propagates an explicit OPENCLAW_HOME into the derived OPENCLAW_DATA_DIR", () => {
    const cfg = loadConfig({
      DIGITAL_ME_HOME: "/data/me",
      OPENCLAW_HOME: "/srv/openclaw",
    });
    expect(cfg.OPENCLAW_DATA_DIR).toBe("/srv/openclaw/data");
    expect(cfg.ORCHESTRATOR_DB_PATH).toBe(
      "/srv/openclaw/data/orchestrator.db",
    );
  });
});

describe("loadConfig — explicit override beats derived default", () => {
  it("explicit DIGITAL_ME_WIKI_DIR overrides the derived value", () => {
    const cfg = loadConfig({
      DIGITAL_ME_HOME: "/data/me",
      DIGITAL_ME_WIKI_DIR: "/different/wiki",
    });
    expect(cfg.DIGITAL_ME_WIKI_DIR).toBe("/different/wiki");
  });

  it("explicit ORCHESTRATOR_DB_PATH overrides the derived value", () => {
    const cfg = loadConfig({
      DIGITAL_ME_HOME: "/data/me",
      ORCHESTRATOR_DB_PATH: "/somewhere/else.db",
    });
    expect(cfg.ORCHESTRATOR_DB_PATH).toBe("/somewhere/else.db");
  });
});

describe("loadConfig — literal defaults", () => {
  it("returns documented defaults for variables with non-null defaults", () => {
    const cfg = loadConfig({ DIGITAL_ME_HOME: "/data/me" });
    expect(cfg.OPENCLAW_GATEWAY_HOST).toBe("127.0.0.1");
    expect(cfg.OPENCLAW_GATEWAY_PORT).toBe("18789");
    expect(cfg.DASHBOARD_PORT).toBe("3458");
    expect(cfg.DASHBOARD_TITLE).toBe("Operations Dashboard");
    expect(cfg.OPENCLAW_AGENT_ID).toBe("unknown");
    expect(cfg.DIGITAL_ME_WIKI_ROOT).toBe(path.join(homedir(), "digital-me"));
  });

  it("allows defaults to be overridden via env", () => {
    const cfg = loadConfig({
      DIGITAL_ME_HOME: "/data/me",
      OPENCLAW_GATEWAY_PORT: "9999",
      DASHBOARD_TITLE: "My Custom Dashboard",
    });
    expect(cfg.OPENCLAW_GATEWAY_PORT).toBe("9999");
    expect(cfg.DASHBOARD_TITLE).toBe("My Custom Dashboard");
  });
});

describe("loadConfig — optional unset vars", () => {
  it("omits optional vars without defaults from the result", () => {
    const cfg = loadConfig({ DIGITAL_ME_HOME: "/data/me" }) as Record<
      string,
      string | undefined
    >;
    expect(cfg.TEAM_WORKSPACE_ROOT).toBeUndefined();
    expect(cfg.LEARNING_SOURCE_DIR).toBeUndefined();
    expect(cfg.LEARNING_DEST_DIR).toBeUndefined();
    expect(cfg.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(cfg.BRAIN_PROXY_PATH).toBeUndefined();
  });

  it("includes optional vars when explicitly set", () => {
    const cfg = loadConfig({
      DIGITAL_ME_HOME: "/data/me",
      TEAM_WORKSPACE_ROOT: "/teams",
      LEARNING_SOURCE_DIR: "/learn/src",
      LEARNING_DEST_DIR: "/learn/dst",
    });
    expect(cfg.TEAM_WORKSPACE_ROOT).toBe("/teams");
    expect(cfg.LEARNING_SOURCE_DIR).toBe("/learn/src");
    expect(cfg.LEARNING_DEST_DIR).toBe("/learn/dst");
  });

  it("types always-present keys as string and optional keys as string | undefined", () => {
    const cfg = loadConfig({ DIGITAL_ME_HOME: "/data/me" });
    // Always-present (literal default or derived) → assignable to `string`.
    const host: string = cfg.OPENCLAW_GATEWAY_HOST;
    const wikiDir: string = cfg.DIGITAL_ME_WIKI_DIR;
    expect(typeof host).toBe("string");
    expect(typeof wikiDir).toBe("string");
    // Optional (no default, no derivation) → `string | undefined`. Assigning to
    // `string` MUST be a type error; the @ts-expect-error guards the Config
    // partition (an unused directive fails typecheck if the type regresses).
    // @ts-expect-error optional env key is `string | undefined`, not `string`
    const token: string = cfg.OPENCLAW_GATEWAY_TOKEN;
    void token;
  });
});

describe("describeEnv", () => {
  it("returns spec for the DIGITAL_ME_HOME alias (optional, no literal default)", () => {
    const spec = describeEnv("DIGITAL_ME_HOME");
    expect(spec.required).toBe(false);
    expect(spec.default).toBeNull();
    expect(spec.description.length).toBeGreaterThan(0);
  });

  it("returns spec with default for an optional key", () => {
    const spec = describeEnv("OPENCLAW_GATEWAY_PORT");
    expect(spec.required).toBe(false);
    expect(spec.default).toBe("18789");
  });
});

describe("allEnvKeys", () => {
  it("returns the full registry of keys", () => {
    const keys = allEnvKeys();
    expect(keys).toContain("DIGITAL_ME_HOME");
    expect(keys).toContain("DIGITAL_ME_WIKI_DIR");
    expect(keys).toContain("DASHBOARD_TITLE");
    expect(keys).toContain("OPENCLAW_AGENT_ID");
    expect(keys.length).toBeGreaterThanOrEqual(17);
  });

  it("documents every key", () => {
    for (const key of allEnvKeys()) {
      const spec = describeEnv(key);
      expect(
        spec.description.length,
        `key ${key} should have a non-empty description`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("loadConfig — resolution order exhaustiveness", () => {
  // Guard against adding a new key to REGISTRY without also adding it to
  // the resolution order in loadConfig. If this test fails, update the
  // `order` array in env.ts to include the missing key.
  it("resolves every required and defaulted key in the registry", () => {
    const cfg = loadConfig({
      DIGITAL_ME_HOME: "/data/me",
    }) as Record<string, string | undefined>;

    for (const key of allEnvKeys()) {
      const spec = describeEnv(key);
      const shouldBePresent = spec.required || spec.default !== null;
      if (shouldBePresent) {
        expect(
          cfg[key],
          `loadConfig should resolve key '${key}' (required=${spec.required}, default=${String(spec.default)})`,
        ).toBeTruthy();
      }
    }
  });
});

describe("_internal.deriveValue — defensive branches", () => {
  // These branches are unreachable through loadConfig (the resolution order
  // guarantees every parent is set before its child). Tested directly to
  // prove the defensive code behaves correctly.
  it("returns null for DIGITAL_ME_WIKI_DIR when DIGITAL_ME_HOME is missing from resolved", () => {
    expect(_internal.deriveValue("DIGITAL_ME_WIKI_DIR", {})).toBeNull();
  });

  it("derives DIGITAL_ME_HOME from DIGITAL_ME_WIKI_ROOT when present", () => {
    expect(
      _internal.deriveValue("DIGITAL_ME_HOME", { DIGITAL_ME_WIKI_ROOT: "/w" }),
    ).toBe("/w");
  });

  it("returns null for DIGITAL_ME_HOME when DIGITAL_ME_WIKI_ROOT is missing from resolved", () => {
    expect(_internal.deriveValue("DIGITAL_ME_HOME", {})).toBeNull();
  });

  it("derives DIGITAL_ME_WIKI_DIR from DIGITAL_ME_WIKI_ROOT when HOME is absent", () => {
    expect(
      _internal.deriveValue("DIGITAL_ME_WIKI_DIR", { DIGITAL_ME_WIKI_ROOT: "/w" }),
    ).toBe("/w/wiki");
  });

  it("returns null for DREAM_CYCLE_HOME when DIGITAL_ME_HOME is missing", () => {
    expect(_internal.deriveValue("DREAM_CYCLE_HOME", {})).toBeNull();
  });

  it("returns null for DREAM_CYCLE_VENV when DREAM_CYCLE_HOME is missing", () => {
    expect(_internal.deriveValue("DREAM_CYCLE_VENV", {})).toBeNull();
  });

  it("returns null for OPENCLAW_DATA_DIR when OPENCLAW_HOME is missing", () => {
    expect(_internal.deriveValue("OPENCLAW_DATA_DIR", {})).toBeNull();
  });

  it("returns null for ORCHESTRATOR_DB_PATH when OPENCLAW_DATA_DIR is missing", () => {
    expect(_internal.deriveValue("ORCHESTRATOR_DB_PATH", {})).toBeNull();
  });

  it("returns null for non-derived keys", () => {
    expect(_internal.deriveValue("OPENCLAW_GATEWAY_PORT", {})).toBeNull();
    expect(
      _internal.deriveValue("DASHBOARD_TITLE", { DIGITAL_ME_HOME: "/x" }),
    ).toBeNull();
  });
});

describe("_internal.resolveKey — direct paths", () => {
  it("returns the literal default for a non-derived optional key", () => {
    const result = _internal.resolveKey("DASHBOARD_PORT", {}, {});
    expect(result).toBe("3458");
  });

  it("returns null for an optional non-derived key with no default", () => {
    const result = _internal.resolveKey("TEAM_WORKSPACE_ROOT", {}, {});
    expect(result).toBeNull();
  });

  it("returns null for DIGITAL_ME_HOME when env, derivation (WIKI_ROOT absent), and default all miss", () => {
    expect(_internal.resolveKey("DIGITAL_ME_HOME", {}, {})).toBeNull();
  });

  it("still throws MissingRequiredEnvError for a key forced required via requireOverride", () => {
    expect(() =>
      _internal.resolveKey(
        "DIGITAL_ME_HOME",
        {},
        {},
        new Set(["DIGITAL_ME_HOME"]),
      ),
    ).toThrow(MissingRequiredEnvError);
  });

  it("returns the env value when set (treating it as the highest precedence)", () => {
    const result = _internal.resolveKey(
      "DASHBOARD_PORT",
      { DASHBOARD_PORT: "9999" },
      {},
    );
    expect(result).toBe("9999");
  });

  it("falls through empty-string env to the derived/default path", () => {
    const result = _internal.resolveKey(
      "DASHBOARD_PORT",
      { DASHBOARD_PORT: "" },
      {},
    );
    expect(result).toBe("3458");
  });

  it("requireOverride: throws for a key in the override set when env+derivation+default all miss", () => {
    expect(() =>
      _internal.resolveKey(
        "TEAM_WORKSPACE_ROOT",
        {},
        {},
        new Set(["TEAM_WORKSPACE_ROOT"]),
      ),
    ).toThrow(MissingRequiredEnvError);
  });

  it("requireOverride: returns null (no throw) for a key absent from the override set", () => {
    const result = _internal.resolveKey(
      "DIGITAL_ME_HOME",
      {},
      {},
      new Set(["TEAM_WORKSPACE_ROOT"]),
    );
    expect(result).toBeNull();
  });

  it("requireOverride empty set treats nothing as required", () => {
    const result = _internal.resolveKey(
      "DIGITAL_ME_HOME",
      {},
      {},
      new Set<never>(),
    );
    expect(result).toBeNull();
  });
});

describe("loadConfig — requireOverride option", () => {
  it("loadConfig with requireOverride=[] resolves DIGITAL_ME_HOME from the WIKI_ROOT default and does not throw", () => {
    const cfg = loadConfig({}, { requireOverride: [] }) as Record<
      string,
      string | undefined
    >;
    expect(cfg.DIGITAL_ME_HOME).toBe(path.join(homedir(), "digital-me"));
    expect(cfg.OPENCLAW_HOME).toBeTruthy();
    expect(cfg.OPENCLAW_GATEWAY_PORT).toBe("18789");
  });

  it("loadConfig with requireOverride=['OPENCLAW_HOME'] succeeds when OPENCLAW_HOME has its default", () => {
    const cfg = loadConfig({}, { requireOverride: ["OPENCLAW_HOME"] });
    expect(cfg.OPENCLAW_HOME).toBeTruthy();
  });

  it("loadConfig with requireOverride=['TEAM_WORKSPACE_ROOT'] throws when TEAM_WORKSPACE_ROOT is unset", () => {
    expect(() =>
      loadConfig({}, { requireOverride: ["TEAM_WORKSPACE_ROOT"] }),
    ).toThrow(MissingRequiredEnvError);
  });
});
