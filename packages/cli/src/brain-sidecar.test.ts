import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAIN_SIDECAR_FILE, renderBrainSidecar } from "@digital-me/contracts";
import { describeBrainSidecar, syncBrainSidecar } from "./brain-sidecar.js";

const caller = {
  brainUrl: "http://127.0.0.1:18791/tools/invoke",
  brainTokenFile: "/home/t/digital-me/.data/brain-host.token",
};

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "dm-brain-sidecar-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("syncBrainSidecar", () => {
  it("brain-host resolved → writes digital-me-brain.env with the contract's exact contents (URL + token-file path, never the token)", () => {
    const hooks = path.join(tmp, ".codex", "hooks");
    mkdirSync(hooks, { recursive: true });
    const sync = syncBrainSidecar(hooks, caller);
    const file = path.join(hooks, BRAIN_SIDECAR_FILE);
    expect(sync).toEqual({ action: "written", file, brainUrl: caller.brainUrl });
    const text = readFileSync(file, "utf-8");
    expect(text).toBe(renderBrainSidecar(caller));
    expect(text).toContain(`DIGITAL_ME_BRAIN_URL=${caller.brainUrl}\n`);
    expect(text).toContain(`DIGITAL_ME_BRAIN_TOKEN_FILE=${caller.brainTokenFile}\n`);
  });

  it("creates the target dir when it does not exist yet and overwrites an older sidecar in place", () => {
    const plugin = path.join(tmp, ".hermes", "plugins", "digital-me-recall-hermes");
    expect(syncBrainSidecar(plugin, { ...caller, brainUrl: "http://old:1/tools/invoke" }).action).toBe("written");
    syncBrainSidecar(plugin, caller);
    const text = readFileSync(path.join(plugin, BRAIN_SIDECAR_FILE), "utf-8");
    expect(text).toContain(`DIGITAL_ME_BRAIN_URL=${caller.brainUrl}\n`);
    expect(text).not.toContain("http://old:1");
  });

  it("no brain-host → removes a stale sidecar so the hooks fall back to their env / the gateway", () => {
    const file = path.join(tmp, BRAIN_SIDECAR_FILE);
    writeFileSync(file, renderBrainSidecar(caller));
    expect(syncBrainSidecar(tmp, undefined)).toEqual({ action: "removed", file });
    expect(existsSync(file)).toBe(false);
  });

  it("no brain-host and no sidecar → nothing to do (the dir is not created)", () => {
    const missing = path.join(tmp, "not-installed");
    expect(syncBrainSidecar(missing, undefined)).toEqual({
      action: "absent",
      file: path.join(missing, BRAIN_SIDECAR_FILE),
    });
    expect(existsSync(missing)).toBe(false);
  });

  it("propagates the contract's refusal to write half a pair", () => {
    expect(() => syncBrainSidecar(tmp, { ...caller, brainTokenFile: "" })).toThrow(/must be set together/);
    expect(existsSync(path.join(tmp, BRAIN_SIDECAR_FILE))).toBe(false);
  });
});

describe("describeBrainSidecar", () => {
  it("names the file and the URL for a write, flags a removal, and stays quiet when nothing changed", () => {
    expect(describeBrainSidecar({ action: "written", file: "/h/digital-me-brain.env", brainUrl: caller.brainUrl })).toBe(
      `/h/digital-me-brain.env → brain-host at ${caller.brainUrl}`,
    );
    expect(describeBrainSidecar({ action: "removed", file: "/h/digital-me-brain.env" })).toBe(
      "removed stale /h/digital-me-brain.env (no brain-host configured)",
    );
    expect(describeBrainSidecar({ action: "absent", file: "/h/digital-me-brain.env" })).toBeUndefined();
  });
});
