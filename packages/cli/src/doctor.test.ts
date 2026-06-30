import { describe, expect, it } from "vitest";
import {
  OPENCLAW_SHADOW_LOCATIONS,
  RUNTIME_EXPECTATIONS,
  formatReport,
  parsePythonVersion,
  runDoctor,
  runOpenclawShadowCheck,
  type DoctorDeps,
} from "./doctor.js";

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    fileExists: () => false,
    env: { HOME: "/home/u" },
    which: () => undefined,
    ...overrides,
  };
}

describe("RUNTIME_EXPECTATIONS", () => {
  it("ships paths for all 7 runtimes", () => {
    expect(Object.keys(RUNTIME_EXPECTATIONS).sort()).toEqual([
      "claude-code",
      "codex",
      "dashboard",
      "digest",
      "dream-cycle",
      "hermes",
      "openclaw",
    ]);
    // digest shares the dream-cycle venv — its marker is the console script there.
    expect(RUNTIME_EXPECTATIONS["digest"]).toContain(
      "$HOME/.venvs/dream-cycle/bin/digital-me-digest",
    );
    expect(RUNTIME_EXPECTATIONS["claude-code"]).toContain(
      "$HOME/.claude/hooks/dm_memory_search_inject.sh",
    );
    expect(RUNTIME_EXPECTATIONS["dream-cycle"]).toContain(
      "$HOME/.venvs/dream-cycle/bin/python3",
    );
    expect(RUNTIME_EXPECTATIONS["dream-cycle"]).toContain(
      "$HOME/.venvs/dream-cycle/bin/digital-me-dream-cycle",
    );
    expect(RUNTIME_EXPECTATIONS["dashboard"]).toContain(
      "$HOME/.local/share/digital-me/dashboard/dist/index.html",
    );
    // the old expectation checked for a file the build never produces
    expect(RUNTIME_EXPECTATIONS["dashboard"]).not.toContain(
      "$HOME/.local/share/digital-me/dashboard/dist/server/server.js",
    );
  });
});

describe("runDoctor", () => {
  it("reports DIGITAL_ME_WIKI_ROOT missing when env var unset", () => {
    const r = runDoctor(makeDeps({ env: { HOME: "/home/u" } }), []);
    const c = r.checks.find((x) => x.label === "DIGITAL_ME_WIKI_ROOT")!;
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toMatch(/not set/);
  });

  it("reports DIGITAL_ME_WIKI_ROOT not-found when env var points at missing path", () => {
    const r = runDoctor(
      makeDeps({
        env: { HOME: "/home/u", DIGITAL_ME_WIKI_ROOT: "$HOME/nope" },
        fileExists: () => false,
      }),
      [],
    );
    const c = r.checks.find((x) => x.label === "DIGITAL_ME_WIKI_ROOT")!;
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toMatch(/Path does not exist/);
  });

  it("reports DIGITAL_ME_WIKI_ROOT ok when env var set + path exists", () => {
    const r = runDoctor(
      makeDeps({
        env: { HOME: "/home/u", DIGITAL_ME_WIKI_ROOT: "$HOME/wiki" },
        fileExists: (p) => p === "/home/u/wiki",
      }),
      [],
    );
    const c = r.checks.find((x) => x.label === "DIGITAL_ME_WIKI_ROOT")!;
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.note).toBe("$HOME/wiki");
  });

  it("finds the openclaw config at the canonical location", () => {
    const r = runDoctor(
      makeDeps({
        fileExists: (p) => p === "/home/u/.openclaw/openclaw.json",
      }),
      [],
    );
    const c = r.checks.find((x) => x.label === "openclaw config")!;
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.note).toBe("/home/u/.openclaw/openclaw.json");
  });

  it("falls back to the legacy ~/.clawdbot path if newer is missing", () => {
    const r = runDoctor(
      makeDeps({
        fileExists: (p) => p === "/home/u/.clawdbot/openclaw.json",
      }),
      [],
    );
    const c = r.checks.find((x) => x.label === "openclaw config")!;
    expect(c.ok).toBe(true);
  });

  it("honors DIGITAL_ME_OPENCLAW_CONFIG override when set", () => {
    const r = runDoctor(
      makeDeps({
        env: {
          HOME: "/home/u",
          DIGITAL_ME_OPENCLAW_CONFIG: "$HOME/custom-openclaw.json",
        },
        fileExists: (p) => p === "/home/u/custom-openclaw.json",
      }),
      [],
    );
    const c = r.checks.find((x) => x.label === "openclaw config")!;
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.note).toBe("/home/u/custom-openclaw.json");
  });

  it("flags missing openclaw config when no candidate exists", () => {
    const r = runDoctor(makeDeps(), []);
    const c = r.checks.find((x) => x.label === "openclaw config")!;
    expect(c.ok).toBe(false);
  });

  it("reports brain-mcp-proxy bin OK when the path exists", () => {
    const ok = runDoctor(
      makeDeps({
        brainMcpProxyBinPath: "/abs/path/to/brain-mcp-proxy.mjs",
        fileExists: (p) => p === "/abs/path/to/brain-mcp-proxy.mjs",
      }),
      [],
    );
    const c = ok.checks.find((c) => c.label === "brain-mcp-proxy bin")!;
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.note).toBe("/abs/path/to/brain-mcp-proxy.mjs");
  });

  it("reports brain-mcp-proxy bin FAIL when path is provided but missing", () => {
    const r = runDoctor(
      makeDeps({
        brainMcpProxyBinPath: "/missing/brain-mcp-proxy.mjs",
        fileExists: () => false,
      }),
      [],
    );
    const c = r.checks.find((c) => c.label === "brain-mcp-proxy bin")!;
    expect(c.ok).toBe(false);
  });

  it("skips brain-mcp-proxy check when no bin path provided", () => {
    const r = runDoctor(makeDeps({}), []);
    const c = r.checks.find((c) => c.label === "brain-mcp-proxy bin")!;
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.note).toContain("skipped");
  });

  it("per-runtime: emits an OK check for each expected path that exists", () => {
    const r = runDoctor(
      makeDeps({
        env: { HOME: "/home/u", DIGITAL_ME_WIKI_ROOT: "$HOME/wiki" },
        fileExists: () => true,
      }),
      ["hermes"],
    );
    const hermesChecks = r.checks.filter((c) =>
      c.label.startsWith("hermes:"),
    );
    expect(hermesChecks).toHaveLength(1);
    expect(hermesChecks[0]!.ok).toBe(true);
  });

  it("per-runtime: emits a FAIL check + repair hint for each expected path missing", () => {
    const r = runDoctor(
      makeDeps({ fileExists: () => false }),
      ["claude-code"],
    );
    const failing = r.checks.filter(
      (c) => c.label.startsWith("claude-code:") && !c.ok,
    );
    expect(failing.length).toBe(6); // 5 hooks + 1 skill
    if (!failing[0]!.ok)
      expect(failing[0]!.reason).toMatch(
        /digital-me install --runtime claude-code/,
      );
  });

  it("aggregates summary counts correctly", () => {
    const r = runDoctor(
      makeDeps({
        env: { HOME: "/home/u", DIGITAL_ME_WIKI_ROOT: "$HOME/wiki" },
        fileExists: () => true,
        which: () => "/usr/local/bin/digital-me-brain-proxy",
      }),
      ["hermes"],
    );
    expect(r.summary.failed).toBe(0);
    expect(r.summary.passed).toBe(r.summary.total);
  });

  it("falls back to literal $HOME when env.HOME is undefined", () => {
    const r = runDoctor(
      {
        fileExists: (p) => p === "$HOME/wiki",
        env: { DIGITAL_ME_WIKI_ROOT: "$HOME/wiki" },
        which: () => undefined,
      },
      [],
    );
    expect(
      r.checks.find((c) => c.label === "DIGITAL_ME_WIKI_ROOT")!.ok,
    ).toBe(true);
  });

  it("expands ${HOME} variant (curly brace) in path strings", () => {
    const r = runDoctor(
      {
        fileExists: (p) => p === "/home/u/wiki",
        env: { HOME: "/home/u", DIGITAL_ME_WIKI_ROOT: "${HOME}/wiki" },
        which: () => undefined,
      },
      [],
    );
    expect(
      r.checks.find((c) => c.label === "DIGITAL_ME_WIKI_ROOT")!.ok,
    ).toBe(true);
  });

  it("dream-cycle: not installed + not requested → informational skip, not FAIL", () => {
    // The `setup --minimal` node-only configuration: no venv, no python3,
    // dream-cycle not in the runtime list. Must not produce a red doctor.
    const r = runDoctor(makeDeps({ which: () => undefined }), []);
    const py = r.checks.find((c) => c.label === "dream-cycle: python3")!;
    const mod = r.checks.find(
      (c) => c.label === "dream-cycle: dream_cycle module",
    )!;
    expect(py.ok).toBe(true);
    expect(mod.ok).toBe(true);
    if (py.ok) expect(py.note).toMatch(/dream-cycle not installed/);
    if (mod.ok)
      expect(mod.note).toMatch(/digital-me install --runtime dream-cycle/);
  });

  it("dream-cycle: venv present → strict checks even when not requested", () => {
    // An installed dream-cycle is always health-checked, requested or not.
    const r = runDoctor(
      makeDeps({
        fileExists: (p) => p === "/home/u/.venvs/dream-cycle/bin/python3",
        which: () => undefined,
      }),
      [],
    );
    const py = r.checks.find((c) => c.label === "dream-cycle: python3")!;
    // No execCommand in deps → resolves the venv python and reports the
    // version check as skipped (not the "not installed" note).
    expect(py.ok).toBe(true);
    if (py.ok) expect(py.note).toMatch(/\.venvs\/dream-cycle/);
  });

  it("dream-cycle: reports python3 FAIL when which returns undefined", () => {
    const r = runDoctor(makeDeps({ which: () => undefined }), ["dream-cycle"]);
    const py = r.checks.find((c) => c.label === "dream-cycle: python3")!;
    const mod = r.checks.find(
      (c) => c.label === "dream-cycle: dream_cycle module",
    )!;
    expect(py.ok).toBe(false);
    expect(mod.ok).toBe(false);
    if (!py.ok) expect(py.reason).toMatch(/not on PATH/);
  });

  it("dream-cycle: skips version + import checks when execCommand absent", () => {
    const r = runDoctor(
      makeDeps({ which: (c) => (c === "python3" ? "/usr/bin/python3" : undefined) }),
      ["dream-cycle"],
    );
    const py = r.checks.find((c) => c.label === "dream-cycle: python3")!;
    const mod = r.checks.find(
      (c) => c.label === "dream-cycle: dream_cycle module",
    )!;
    expect(py.ok).toBe(true);
    expect(mod.ok).toBe(true);
    if (py.ok) expect(py.note).toMatch(/skipped/);
  });

  it("dream-cycle: passes when python3 reports 3.11 and dream_cycle imports", () => {
    const r = runDoctor(
      makeDeps({
        which: (c) => (c === "python3" ? "/opt/homebrew/bin/python3" : undefined),
        execCommand: (_cmd, args) => {
          if (args[0] === "--version") {
            return { status: 0, stdout: "Python 3.11.6\n", stderr: "" };
          }
          if (args[0] === "-c") {
            return {
              status: 0,
              stdout: "/site-packages/dream_cycle/__init__.py\n",
              stderr: "",
            };
          }
          return { status: 1, stdout: "", stderr: "unknown" };
        },
      }),
      ["dream-cycle"],
    );
    const py = r.checks.find((c) => c.label === "dream-cycle: python3")!;
    const mod = r.checks.find(
      (c) => c.label === "dream-cycle: dream_cycle module",
    )!;
    expect(py.ok).toBe(true);
    if (py.ok) expect(py.note).toMatch(/3\.11/);
    expect(mod.ok).toBe(true);
    if (mod.ok)
      expect(mod.note).toBe("/site-packages/dream_cycle/__init__.py");
  });

  it("dream-cycle: fails when python3 is older than 3.11", () => {
    const r = runDoctor(
      makeDeps({
        which: () => "/usr/bin/python3",
        execCommand: () => ({
          status: 0,
          stdout: "Python 3.9.18\n",
          stderr: "",
        }),
      }),
      ["dream-cycle"],
    );
    const py = r.checks.find((c) => c.label === "dream-cycle: python3")!;
    expect(py.ok).toBe(false);
    if (!py.ok) expect(py.reason).toMatch(/3\.9.*>=\s*3\.11/);
  });

  // Module-not-importable hint is environment-aware. Three branches:
  //   1. PEP 668 externally-managed → venv recipe
  //   2. pip missing → venv recipe (fallback for any broken pip)
  //   3. pip works AND not externally-managed → plain `python3 -m pip install`

  function makeImportFailingDeps(
    overrides: {
      externallyManaged?: boolean;
      pipWorks?: boolean;
    } = {},
  ) {
    const externallyManaged = overrides.externallyManaged ?? false;
    const pipWorks = overrides.pipWorks ?? true;
    return makeDeps({
      which: () => "/usr/bin/python3",
      execCommand: (_cmd, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "Python 3.12.1\n", stderr: "" };
        }
        if (args[0] === "-c" && (args[1] ?? "").includes("import dream_cycle;")) {
          return {
            status: 1,
            stdout: "",
            stderr: "ModuleNotFoundError: No module named 'dream_cycle'",
          };
        }
        if (args[0] === "-c" && (args[1] ?? "").includes("EXTERNALLY-MANAGED")) {
          return {
            status: 0,
            stdout: externallyManaged ? "true" : "false",
            stderr: "",
          };
        }
        if (args[0] === "-m" && args[1] === "pip" && args[2] === "--version") {
          return pipWorks
            ? { status: 0, stdout: "pip 24.0 from ...", stderr: "" }
            : { status: 1, stdout: "", stderr: "No module named pip" };
        }
        return { status: 1, stdout: "", stderr: "unexpected probe" };
      },
    });
  }

  it("dream-cycle: PEP 668 externally-managed → venv recipe", () => {
    const r = runDoctor(makeImportFailingDeps({ externallyManaged: true }), ["dream-cycle"]);
    const mod = r.checks.find(
      (c) => c.label === "dream-cycle: dream_cycle module",
    )!;
    expect(mod.ok).toBe(false);
    if (!mod.ok) {
      expect(mod.reason).toMatch(/externally-managed/);
      expect(mod.reason).toMatch(/PEP 668/);
      expect(mod.reason).toMatch(/python3 -m venv/);
      expect(mod.reason).toMatch(/~\/\.venvs\/dream-cycle/);
    }
  });

  it("dream-cycle: pip missing → venv fallback", () => {
    const r = runDoctor(
      makeImportFailingDeps({ externallyManaged: false, pipWorks: false }),
      ["dream-cycle"],
    );
    const mod = r.checks.find(
      (c) => c.label === "dream-cycle: dream_cycle module",
    )!;
    expect(mod.ok).toBe(false);
    if (!mod.ok) {
      expect(mod.reason).toMatch(/pip not available/);
      expect(mod.reason).toMatch(/python3 -m venv/);
    }
  });

  it("dream-cycle: pip works + not externally-managed → plain pip install", () => {
    const r = runDoctor(
      makeImportFailingDeps({ externallyManaged: false, pipWorks: true }),
      ["dream-cycle"],
    );
    const mod = r.checks.find(
      (c) => c.label === "dream-cycle: dream_cycle module",
    )!;
    expect(mod.ok).toBe(false);
    if (!mod.ok) {
      expect(mod.reason).toMatch(/\/usr\/bin\/python3 -m pip install/);
      expect(mod.reason).toMatch(/packages\/services\/dream-cycle/);
      // Should NOT suggest a venv when pip is healthy.
      expect(mod.reason).not.toMatch(/python3 -m venv/);
    }
  });

  it("dream-cycle: inlines absolute repo path when repoRoot is set", () => {
    // Source-checkout case — recipe is copy-paste-and-go.
    const deps = makeImportFailingDeps({ externallyManaged: true });
    const r = runDoctor({ ...deps, repoRoot: "/home/test/digital-me-os" }, [
      "dream-cycle",
    ]);
    const mod = r.checks.find(
      (c) => c.label === "dream-cycle: dream_cycle module",
    )!;
    expect(mod.ok).toBe(false);
    if (!mod.ok) {
      expect(mod.reason).toMatch(
        /\/home\/test\/digital-me-os\/packages\/services\/dream-cycle/,
      );
      // No placeholder when we know the path.
      expect(mod.reason).not.toMatch(/<digital-me-os-repo>/);
    }
  });

  it("dream-cycle: falls back to placeholder when repoRoot unset", () => {
    // npm-installed-CLI case — repo root isn't knowable.
    const r = runDoctor(makeImportFailingDeps({ externallyManaged: true }), ["dream-cycle"]);
    const mod = r.checks.find(
      (c) => c.label === "dream-cycle: dream_cycle module",
    )!;
    expect(mod.ok).toBe(false);
    if (!mod.ok) {
      expect(mod.reason).toMatch(/<digital-me-os-repo>/);
    }
  });

  it("dream-cycle: no execCommand → fallback hint with diagnostic note", () => {
    const r = runDoctor(
      makeDeps({ which: () => "/usr/bin/python3" }), // no execCommand
      ["dream-cycle"],
    );
    const mod = r.checks.find(
      (c) => c.label === "dream-cycle: dream_cycle module",
    )!;
    expect(mod.ok).toBe(true); // skipped-as-OK when execCommand absent (existing behavior)
  });

  it("dream-cycle: LLM auth — OK when standalone engine env var set", () => {
    const r = runDoctor(
      makeDeps({
        env: { HOME: "/home/u", GEMINI_API_KEY: "secret-key-here" },
        which: () => "/usr/bin/python3",
        execCommand: (_cmd, args) => {
          const src = args[1] ?? "";
          if (args[0] === "--version") {
            return { status: 0, stdout: "Python 3.12.1\n", stderr: "" };
          }
          if (src.includes("import dream_cycle;")) {
            return { status: 0, stdout: "/x/dream_cycle.py", stderr: "" };
          }
          if (src.includes("from dream_cycle.config")) {
            return {
              status: 0,
              stdout: "standalone\tGEMINI_API_KEY\n",
              stderr: "",
            };
          }
          return { status: 1, stdout: "", stderr: "?" };
        },
      }),
      ["dream-cycle"],
    );
    const auth = r.checks.find((c) => c.label === "dream-cycle: LLM auth")!;
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.note).toMatch(/standalone.*GEMINI_API_KEY/);
  });

  it("dream-cycle: LLM auth — FAIL when standalone env var unset", () => {
    const r = runDoctor(
      makeDeps({
        env: { HOME: "/home/u" }, // no GEMINI_API_KEY
        which: () => "/usr/bin/python3",
        execCommand: (_cmd, args) => {
          const src = args[1] ?? "";
          if (args[0] === "--version") {
            return { status: 0, stdout: "Python 3.12.1\n", stderr: "" };
          }
          if (src.includes("import dream_cycle;")) {
            return { status: 0, stdout: "/x/dream_cycle.py", stderr: "" };
          }
          if (src.includes("from dream_cycle.config")) {
            return {
              status: 0,
              stdout: "standalone\tGEMINI_API_KEY\n",
              stderr: "",
            };
          }
          return { status: 1, stdout: "", stderr: "?" };
        },
      }),
      ["dream-cycle"],
    );
    const auth = r.checks.find((c) => c.label === "dream-cycle: LLM auth")!;
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.reason).toMatch(/GEMINI_API_KEY is not set/);
  });

  it("dream-cycle: LLM auth — defers to openclaw.json for engine=openclaw", () => {
    const r = runDoctor(
      makeDeps({
        which: () => "/usr/bin/python3",
        execCommand: (_cmd, args) => {
          const src = args[1] ?? "";
          if (args[0] === "--version") {
            return { status: 0, stdout: "Python 3.12.1\n", stderr: "" };
          }
          if (src.includes("import dream_cycle;")) {
            return { status: 0, stdout: "/x/dream_cycle.py", stderr: "" };
          }
          if (src.includes("from dream_cycle.config")) {
            return {
              status: 0,
              stdout: "openclaw\tGEMINI_API_KEY\n",
              stderr: "",
            };
          }
          return { status: 1, stdout: "", stderr: "?" };
        },
      }),
      ["dream-cycle"],
    );
    const auth = r.checks.find((c) => c.label === "dream-cycle: LLM auth")!;
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.note).toMatch(/openclaw\.json/);
  });

  it("dream-cycle: LLM auth — skipped gracefully when config.yaml missing", () => {
    const r = runDoctor(
      makeDeps({
        which: () => "/usr/bin/python3",
        execCommand: (_cmd, args) => {
          const src = args[1] ?? "";
          if (args[0] === "--version") {
            return { status: 0, stdout: "Python 3.12.1\n", stderr: "" };
          }
          if (src.includes("import dream_cycle;")) {
            return { status: 0, stdout: "/x/dream_cycle.py", stderr: "" };
          }
          return {
            status: 1,
            stdout: "",
            stderr: "FileNotFoundError: Config not found: /home/u/digital-me/config.yaml",
          };
        },
      }),
      ["dream-cycle"],
    );
    const auth = r.checks.find((c) => c.label === "dream-cycle: LLM auth")!;
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.note).toMatch(/skipped.*config\.yaml not found/);
  });

  it("dream-cycle: LLM auth — skipped when module not importable", () => {
    const r = runDoctor(
      makeDeps({
        which: () => "/usr/bin/python3",
        execCommand: (_cmd, args) => {
          if (args[0] === "--version") {
            return { status: 0, stdout: "Python 3.12.1\n", stderr: "" };
          }
          return {
            status: 1,
            stdout: "",
            stderr: "ModuleNotFoundError: No module named 'dream_cycle'",
          };
        },
      }),
      ["dream-cycle"],
    );
    const auth = r.checks.find((c) => c.label === "dream-cycle: LLM auth")!;
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.note).toMatch(/dream_cycle module not importable/);
  });
});

describe("parsePythonVersion", () => {
  it("parses standard CPython output", () => {
    expect(parsePythonVersion("Python 3.11.6")).toEqual([3, 11]);
    expect(parsePythonVersion("Python 3.14.3\n")).toEqual([3, 14]);
  });

  it("returns null on garbage", () => {
    expect(parsePythonVersion("not python at all")).toBeNull();
    expect(parsePythonVersion("")).toBeNull();
  });

  it("handles pre-release / suffixed versions", () => {
    expect(parsePythonVersion("Python 3.13.0a4")).toEqual([3, 13]);
  });
});

describe("formatReport", () => {
  it("renders OK and FAIL lines + summary", () => {
    const out = formatReport({
      checks: [
        { ok: true, label: "x", note: "found" },
        { ok: false, label: "y", reason: "missing" },
      ],
      summary: { total: 2, passed: 1, failed: 1 },
    });
    expect(out).toContain("[OK]   x (found)");
    expect(out).toContain("[FAIL] y — missing");
    expect(out).toContain("Summary: 1/2 passed, 1 failed.");
  });

  it("omits the parenthetical when the OK check has no note", () => {
    const out = formatReport({
      checks: [{ ok: true, label: "x" }],
      summary: { total: 1, passed: 1, failed: 0 },
    });
    expect(out).toContain("[OK]   x\n");
    expect(out).not.toContain("[OK]   x (");
  });
});

describe("openclaw canonical install dir", () => {
  it("expects the brain plugin in the STATE dir (~/.openclaw/extensions), not the overlay", () => {
    expect(RUNTIME_EXPECTATIONS.openclaw).toEqual([
      "$HOME/.openclaw/extensions/digital-me-brain/index.mjs",
    ]);
    expect(RUNTIME_EXPECTATIONS.openclaw).not.toContain(
      "$HOME/openclaw/extensions/digital-me-brain/index.mjs",
    );
  });
});

describe("runOpenclawShadowCheck", () => {
  it("passes (single OK) when no shadow copies exist", () => {
    const out = runOpenclawShadowCheck(makeDeps({ fileExists: () => false }));
    expect(out).toHaveLength(1);
    expect(out[0]!.ok).toBe(true);
    expect(out[0]!.label).toMatch(/no shadow plugin copies/);
  });

  it("flags the stale dist/extensions build copy (index.js) as a failure", () => {
    const shadow = "/home/u/openclaw/dist/extensions/digital-me-recall/index.js";
    const out = runOpenclawShadowCheck(
      makeDeps({ env: { HOME: "/home/u" }, fileExists: (p) => p === shadow }),
    );
    const fail = out.find((c) => !c.ok)!;
    expect(fail).toBeTruthy();
    expect(fail.label).toContain(shadow);
    if (!fail.ok) expect(fail.reason).toMatch(/override the canonical/);
  });

  it("flags the overlay copy (index.mjs) as a failure", () => {
    const shadow = "/home/u/openclaw/extensions/digital-me-brain/index.mjs";
    const out = runOpenclawShadowCheck(
      makeDeps({ env: { HOME: "/home/u" }, fileExists: (p) => p === shadow }),
    );
    expect(out.some((c) => !c.ok && c.label.includes(shadow))).toBe(true);
  });

  it("runDoctor surfaces shadow checks only when openclaw is enabled", () => {
    const deps = makeDeps({
      env: { HOME: "/home/u", DIGITAL_ME_WIKI_ROOT: "$HOME/wiki" },
      fileExists: () => false,
    });
    const without = runDoctor(deps, []);
    expect(
      without.checks.some((c) => c.label.includes("shadow")),
    ).toBe(false);
    const withOc = runDoctor(deps, ["openclaw"]);
    expect(
      withOc.checks.some((c) => c.label.includes("no shadow plugin copies")),
    ).toBe(true);
  });

  it("shadow locations cover both plugins in both lower-precedence dirs", () => {
    const paths = OPENCLAW_SHADOW_LOCATIONS.map((l) => l.path);
    expect(paths).toContain(
      "$HOME/openclaw/dist/extensions/digital-me-brain/index.js",
    );
    expect(paths).toContain(
      "$HOME/openclaw/dist/extensions/digital-me-recall/index.js",
    );
    expect(paths).toContain(
      "$HOME/openclaw/extensions/digital-me-brain/index.mjs",
    );
    expect(paths).toContain(
      "$HOME/openclaw/extensions/digital-me-recall/index.mjs",
    );
  });
});
