import { describe, expect, it } from "vitest";
import {
  RUNTIME_DETECTION,
  buildDefaultAliases,
  buildTranscriptSources,
  detectInstalledRuntimes,
  planWikiInit,
  renderStarterConfig,
  type SetupDeps,
} from "./setup.js";

function makeDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    env: { HOME: "/home/u" },
    dirExists: () => false,
    ...overrides,
  };
}

describe("RUNTIME_DETECTION", () => {
  it("maps each detectable runtime to one or more dir candidates", () => {
    expect(Object.keys(RUNTIME_DETECTION).sort()).toEqual([
      "claude-code",
      "codex",
      "hermes",
      "openclaw",
    ]);
    expect(RUNTIME_DETECTION["claude-code"]).toContain("$HOME/.claude");
    expect(RUNTIME_DETECTION.openclaw).toContain("$HOME/.openclaw");
  });
});

describe("detectInstalledRuntimes", () => {
  it("returns the runtimes whose canonical dir is present", () => {
    const deps = makeDeps({
      dirExists: (p) => p === "/home/u/.claude" || p === "/home/u/.codex",
    });
    const r = detectInstalledRuntimes(deps);
    expect(r.runtimes.sort()).toEqual(["claude-code", "codex"]);
    expect(r.skipped.sort()).toEqual(["hermes", "openclaw"]);
  });

  it("returns empty list when no runtime dirs exist", () => {
    const r = detectInstalledRuntimes(makeDeps());
    expect(r.runtimes).toEqual([]);
    expect(r.skipped.sort()).toEqual([
      "claude-code",
      "codex",
      "hermes",
      "openclaw",
    ]);
  });

  it("expands $HOME via the injected env", () => {
    const deps = makeDeps({
      env: { HOME: "/somewhere/else" },
      dirExists: (p) => p === "/somewhere/else/.hermes",
    });
    expect(detectInstalledRuntimes(deps).runtimes).toEqual(["hermes"]);
  });

  it("leaves literal $HOME if env.HOME is unset (degenerate but safe)", () => {
    const deps: SetupDeps = {
      env: {},
      dirExists: (p) => p === "$HOME/.claude",
    };
    expect(detectInstalledRuntimes(deps).runtimes).toEqual(["claude-code"]);
  });
});

describe("buildDefaultAliases", () => {
  it("emits no aliases for empty input", () => {
    expect(buildDefaultAliases([])).toEqual({});
  });

  it("emits claude-code-cli stanza when claude-code is detected", () => {
    const a = buildDefaultAliases(["claude-code"]);
    expect(a["claude-code-cli"]).toBeDefined();
    expect(a["claude-code-cli"]!.binary).toBe("claude");
    expect(a["claude-code-cli"]!.args.some((x) => x === "{{prompt}}")).toBe(
      true,
    );
    expect(a["claude-code-cli"]!.env?.OPENCLAW_AGENT_ID).toBe("claude-code");
  });

  it("emits codex-cli stanza with finalMessageArg when codex is detected", () => {
    const a = buildDefaultAliases(["codex"]);
    expect(a["codex-cli"]).toBeDefined();
    expect(a["codex-cli"]!.binary).toBe("codex");
    expect(a["codex-cli"]!.finalMessageArg).toBe("--output-last-message");
  });

  it("emits both stanzas when both are detected", () => {
    const a = buildDefaultAliases(["claude-code", "codex"]);
    expect(Object.keys(a).sort()).toEqual(["claude-code-cli", "codex-cli"]);
  });

  it("does not emit an alias for hermes (no exec dispatch pattern yet)", () => {
    expect(buildDefaultAliases(["hermes"])).toEqual({});
  });
});

describe("buildTranscriptSources", () => {
  it("returns one source per detected runtime, in canonical order", () => {
    const out = buildTranscriptSources([
      "openclaw",
      "claude-code",
      "hermes",
      "codex",
    ]);
    expect(out.map((s) => s.id)).toEqual([
      "claude-code-transcripts",
      "codex-transcripts",
      "hermes-transcripts",
      "openclaw-agent-transcripts",
    ]);
  });

  it("returns empty list when nothing is detected", () => {
    expect(buildTranscriptSources([])).toEqual([]);
  });

  it("each manifest carries path + format and Hermes carries a glob", () => {
    const [cc, codex, hermes, openclaw] = buildTranscriptSources([
      "claude-code",
      "codex",
      "hermes",
      "openclaw",
    ]);
    expect(cc).toMatchObject({
      path: "$HOME/.claude/projects",
      format: "claude-code-jsonl",
    });
    expect(codex).toMatchObject({
      path: "$HOME/.codex/sessions",
      format: "codex-jsonl",
    });
    expect(hermes).toMatchObject({
      path: "$HOME/.hermes/sessions",
      format: "hermes-session-json",
      glob: "session_*.json",
    });
    expect(openclaw).toMatchObject({
      path: "$HOME/.openclaw/agents",
      format: "openclaw-agent-jsonl",
    });
  });
});

describe("renderStarterConfig", () => {
  it("emits a yaml-shaped starter config with no aliases when none are passed", () => {
    const out = renderStarterConfig({ wikiRoot: "/x", aliases: {} });
    expect(out).toContain("engine: openclaw");
    expect(out).toContain("sources: []");
    expect(out).not.toContain("cli_exec_aliases");
  });

  it("renders one sources: entry per supplied transcript source", () => {
    const out = renderStarterConfig({
      wikiRoot: "/x",
      aliases: {},
      sources: buildTranscriptSources(["claude-code", "hermes"]),
    });
    expect(out).not.toContain("sources: []");
    expect(out).toContain("sources:");
    expect(out).toContain("- name: claude-code-transcripts");
    expect(out).toContain('path: "$HOME/.claude/projects"');
    expect(out).toContain("format: claude-code-jsonl");
    expect(out).toContain("- name: hermes-transcripts");
    expect(out).toContain('path: "$HOME/.hermes/sessions"');
    expect(out).toContain('glob: "session_*.json"');
  });

  it("falls back to sources: [] when an empty sources list is supplied", () => {
    const out = renderStarterConfig({
      wikiRoot: "/x",
      aliases: {},
      sources: [],
    });
    expect(out).toContain("sources: []");
  });

  it("renders cli_exec_aliases when aliases are supplied", () => {
    const out = renderStarterConfig({
      wikiRoot: "/x",
      aliases: buildDefaultAliases(["claude-code"]),
    });
    expect(out).toContain("cli_exec_aliases:");
    expect(out).toContain("claude-code-cli:");
    expect(out).toContain('binary: "claude"');
  });

  it("renders all the alias sub-fields (env, timeoutMs, finalMessageArg)", () => {
    const out = renderStarterConfig({
      wikiRoot: "/x",
      aliases: buildDefaultAliases(["codex"]),
    });
    expect(out).toContain("env:");
    expect(out).toContain('OPENCLAW_AGENT_ID: "codex"');
    expect(out).toContain("timeoutMs: 1800000");
    expect(out).toContain('finalMessageArg: "--output-last-message"');
  });

  it("emits an alias with no env when the stanza omits it", () => {
    const out = renderStarterConfig({
      wikiRoot: "/x",
      aliases: { bare: { binary: "/bin/echo", args: ["{{prompt}}"] } },
    });
    expect(out).toContain("bare:");
    // env block should not appear for an alias with no env.
    expect(out).not.toMatch(/bare:[\s\S]*?env:/);
  });

  it("emits an alias with no timeoutMs/finalMessageArg when stanza omits them", () => {
    const out = renderStarterConfig({
      wikiRoot: "/x",
      aliases: { bare: { binary: "/bin/echo", args: ["{{prompt}}"] } },
    });
    expect(out).not.toMatch(/bare:[\s\S]*?timeoutMs:/);
    expect(out).not.toMatch(/bare:[\s\S]*?finalMessageArg:/);
  });
});

describe("planWikiInit", () => {
  it("lists wiki/, inbox/, .cache/ + root dir", () => {
    const plan = planWikiInit({ wikiRoot: "/wiki-root", aliases: {} });
    expect(plan.dirsToCreate).toEqual([
      "/wiki-root",
      "/wiki-root/wiki",
      "/wiki-root/inbox",
      "/wiki-root/.cache",
    ]);
  });

  it("includes config.example.yaml, a live config.yaml, + .gitkeep stubs", () => {
    const plan = planWikiInit({ wikiRoot: "/r", aliases: {} });
    const paths = plan.filesToCreate.map((f) => f.path).sort();
    expect(paths).toEqual([
      "/r/config.example.yaml",
      "/r/config.yaml",
      "/r/inbox/.gitkeep",
      "/r/wiki/.gitkeep",
    ]);
  });

  it("seeds config.yaml with the same starter content as the example", () => {
    const plan = planWikiInit({
      wikiRoot: "/r",
      aliases: buildDefaultAliases(["claude-code"]),
    });
    const live = plan.filesToCreate.find((f) => f.path === "/r/config.yaml")!;
    const example = plan.filesToCreate.find(
      (f) => f.path === "/r/config.example.yaml",
    )!;
    expect(live.contents).toBe(example.contents);
    expect(live.contents).toContain("engine: openclaw");
  });

  it("inlines the rendered starter config in the example yaml", () => {
    const plan = planWikiInit({
      wikiRoot: "/r",
      aliases: buildDefaultAliases(["claude-code"]),
    });
    const yaml = plan.filesToCreate.find((f) =>
      f.path.endsWith("config.example.yaml"),
    )!;
    expect(yaml.contents).toContain("cli_exec_aliases:");
    expect(yaml.contents).toContain("claude-code-cli:");
  });

  it(".gitkeep stubs are empty strings (placeholder files)", () => {
    const plan = planWikiInit({ wikiRoot: "/r", aliases: {} });
    const gitkeeps = plan.filesToCreate.filter((f) =>
      f.path.endsWith(".gitkeep"),
    );
    expect(gitkeeps.every((f) => f.contents === "")).toBe(true);
  });
});
