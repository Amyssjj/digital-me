import { describe, expect, it } from "vitest";

import {
  brainHostTokenFileOf,
  detectBrainEndpoint,
  isOpenclawInstalled,
  noBrainEndpointMessage,
  orderRuntimesHubFirst,
  runtimesNeedingBrain,
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
