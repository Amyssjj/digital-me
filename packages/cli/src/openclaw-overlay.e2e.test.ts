import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PLUGINS } from "@digital-me/runtime-openclaw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { materializeOpenclawOverlay } from "./openclaw-overlay.js";

/**
 * End-to-end install path: run the REAL materialize (real esbuild bundling of
 * the template entries + real fs writes) into a temp dir and assert the
 * compatibility contract lands in the generated artifacts. No gateway needed —
 * `node --check` is the same syntax-smoke the updater uses, since the bundle
 * externalizes `openclaw/*`.
 */
describe("materializeOpenclawOverlay (e2e)", () => {
  let target: string;
  let rc: number;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    target = fs.mkdtempSync(path.join(os.tmpdir(), "oc-overlay-e2e-"));
    rc = await materializeOpenclawOverlay(target);
  }, 120_000);

  afterAll(() => {
    vi.restoreAllMocks();
    if (target) fs.rmSync(target, { recursive: true, force: true });
  });

  it("returns success", () => {
    expect(rc).toBe(0);
  });

  it("ships the shared cli-exec worker", () => {
    expect(
      fs.existsSync(path.join(target, "scripts", "cli-exec-worker.mjs")),
    ).toBe(true);
  });

  for (const plugin of PLUGINS) {
    describe(plugin.pluginDirname, () => {
      const dir = () => path.join(target, plugin.pluginDirname);

      it("generates package.json with the enforced minHostVersion floor", () => {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(dir(), "package.json"), "utf-8"),
        ) as {
          openclaw?: { extensions?: string[] };
          install?: { minHostVersion?: string };
        };
        // openclaw's loader reads install.minHostVersion and refuses to load on
        // an older host (the only openclaw-enforced compat field).
        expect(pkg.install?.minHostVersion).toMatch(/^>=\d+\.\d+\.\d+$/);
        expect(pkg.openclaw?.extensions).toEqual(["./index.mjs"]);
      });

      it("copies the manifest with the documented compat range", () => {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(dir(), "openclaw.plugin.json"), "utf-8"),
        ) as { compat?: { openclaw?: string; testedThrough?: string } };
        expect(manifest.compat?.openclaw).toMatch(/^>=\d+\.\d+\.\d+$/);
        expect(manifest.compat?.testedThrough).toMatch(/^\d+\.\d+\.\d+$/);
      });

      it("bundles a syntactically valid index.mjs containing the warn-only ceiling check", () => {
        const entry = path.join(dir(), "index.mjs");
        expect(fs.existsSync(entry)).toBe(true);
        // node --check: same smoke the updater uses (bundle externalizes openclaw/*).
        const smoke = spawnSync(process.execPath, ["--check", entry], {
          encoding: "utf-8",
        });
        expect(smoke.status).toBe(0);
        const src = fs.readFileSync(entry, "utf-8");
        expect(src).toContain("newer than the verified range");
      });
    });
  }
});
