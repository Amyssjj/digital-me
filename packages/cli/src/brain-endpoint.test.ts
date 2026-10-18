import { describe, expect, it } from "vitest";

import {
  brainHostTokenFileOf,
  detectBrainEndpoint,
  isOpenclawInstalled,
  noBrainEndpointMessage,
  orderRuntimesHubFirst,
  runtimesNeedingBrain,
  workflowImportFailureMessage,
} from "./brain-endpoint.js";

const HOME = "/home/t";
const TOKEN = "/home/t/digital-me/.data/brain-host.token";

function probe(over: {
  env?: Record<string, string | undefined>;
  files?: readonly string[];
  which?: (b: string) => string | undefined;
}) {
  return {
    home: HOME,
    env: over.env ?? {},
    fileExists: (p: string) => (over.files ?? []).includes(p),
    which: over.which ?? (() => undefined),
  };
}

describe("brainHostTokenFileOf", () => {
  it("DIGITAL_ME_BRAIN_TOKEN_FILE → <DIGITAL_ME_WIKI_ROOT>/.data/brain-host.token → ~/digital-me/.data/brain-host.token", () => {
    expect(brainHostTokenFileOf({ home: HOME, env: { DIGITAL_ME_BRAIN_TOKEN_FILE: "/t" } })).toBe("/t");
    expect(brainHostTokenFileOf({ home: HOME, env: { DIGITAL_ME_BRAIN_TOKEN_FILE: "  " } })).toBe(TOKEN);
    expect(brainHostTokenFileOf({ home: HOME, env: { DIGITAL_ME_WIKI_ROOT: "/w" } })).toBe("/w/.data/brain-host.token");
    expect(brainHostTokenFileOf({ home: HOME, env: {} })).toBe(TOKEN);
  });
});

describe("isOpenclawInstalled", () => {
  it("binary on PATH, or the OPENCLAW_HOME / ~/.openclaw dir", () => {
    expect(isOpenclawInstalled(probe({ which: (b) => (b === "openclaw" ? "/usr/local/bin/openclaw" : undefined) }))).toBe(true);
    expect(isOpenclawInstalled(probe({ files: ["/home/t/.openclaw"] }))).toBe(true);
    expect(isOpenclawInstalled(probe({ env: { OPENCLAW_HOME: "/oc" }, files: ["/oc"] }))).toBe(true);
    expect(isOpenclawInstalled(probe({}))).toBe(false);
  });
});

describe("detectBrainEndpoint", () => {
  it("brain-host wins whenever its token file exists, even with openclaw around", () => {
    const e = detectBrainEndpoint(probe({ files: [TOKEN, "/home/t/.openclaw"] }));
    expect(e).toEqual({ kind: "brain-host", detail: TOKEN });
  });

  it("falls back to a legacy openclaw gateway", () => {
    const e = detectBrainEndpoint(probe({ files: ["/home/t/.openclaw"] }));
    expect(e.kind).toBe("openclaw-gateway");
    expect(e.detail).toMatch(/openclaw detected/);
  });

  it("reports none, naming the token path it looked for", () => {
    const e = detectBrainEndpoint(probe({}));
    expect(e.kind).toBe("none");
    expect(e.detail).toBe(`no brain-host token at ${TOKEN}, no openclaw install`);
  });
});

describe("noBrainEndpointMessage", () => {
  it("names the context, the install command and the token path", () => {
    const m = noBrainEndpointMessage("the requested runtimes", TOKEN);
    expect(m).toContain("[STOP] no brain endpoint on this machine — the requested runtimes would have nothing to connect to.");
    expect(m).toContain("digital-me install --runtime brain-host");
    expect(m).toContain(`Looked for its token file at ${TOKEN}.`);
    expect(m).toContain("legacy openclaw gateway");
  });
});

describe("workflowImportFailureMessage", () => {
  const base = {
    runtime: "dream-cycle",
    missing: "workflows aren't imported",
    tokenFile: TOKEN,
  } as const;

  it("names brain-host first, the token file, the openclaw fallback and the exact re-run command", () => {
    const m = workflowImportFailureMessage({
      ...base,
      status: 3,
      command: ["/home/t/.venvs/dream-cycle/bin/python3", "-m", "dream_cycle.install_workflows", "--wiki-root", "/home/t/digital-me"],
    });
    expect(m).toContain("install dream-cycle: workflow import returned exit 3. The venv is ready, but workflows aren't imported.");
    expect(m).toContain(`else through its token file ${TOKEN} (check with \`digital-me doctor\`)`);
    expect(m).toContain("without brain-host, the openclaw gateway is not running");
    expect(m).toMatch(
      /Re-run later with: \/home\/t\/\.venvs\/dream-cycle\/bin\/python3 -m dream_cycle\.install_workflows --wiki-root \/home\/t\/digital-me$/,
    );
  });

  it("reports an unknown exit status and shell-quotes arguments that need it", () => {
    const m = workflowImportFailureMessage({
      ...base,
      status: null,
      command: ["python3", "-m", "digest.install_workflows", "--wiki-root", "/srv/my wiki/it's here"],
    });
    expect(m).toContain("returned exit ?.");
    expect(m).toMatch(/Re-run later with: python3 -m digest\.install_workflows --wiki-root '\/srv\/my wiki\/it'\\''s here'$/);
  });
});

describe("runtimesNeedingBrain / orderRuntimesHubFirst", () => {
  it("brain-host and the openclaw plugin are never gated; everything else is", () => {
    expect(runtimesNeedingBrain(["brain-host", "openclaw"])).toEqual([]);
    expect(runtimesNeedingBrain(["claude-code", "brain-host", "dashboard"])).toEqual(["claude-code", "dashboard"]);
  });

  it("moves brain-host to the front and keeps the rest in the user's order", () => {
    expect(orderRuntimesHubFirst(["codex", "claude-code", "brain-host", "hermes"])).toEqual(["brain-host", "codex", "claude-code", "hermes"]);
    expect(orderRuntimesHubFirst(["codex"])).toEqual(["codex"]);
    expect(orderRuntimesHubFirst([])).toEqual([]);
  });
});
