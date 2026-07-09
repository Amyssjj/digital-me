import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { build } from "esbuild";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { materializeOpenclawOverlay } from "./openclaw-overlay.js";

/**
 * Unit tests for the branches the e2e suite (real esbuild bundling of the
 * real PLUGINS) cannot reach: malformed plugin descriptors, the published-CLI
 * prebuilt-bundle fast path, and an esbuild failure. The runtime-openclaw
 * constants and esbuild are mocked so each test controls the plugin set.
 */

type TestPlugin = {
  pluginDirname: string;
  displayName: string;
  installFiles: ReadonlyArray<{ src: string; target: string }>;
};

const state = vi.hoisted(() => ({
  prebuiltDir: "",
  workerScript: "",
  plugins: [] as TestPlugin[],
}));

vi.mock("@digital-me/runtime-openclaw", () => ({
  get PLUGINS() {
    return state.plugins;
  },
  get PREBUILT_DIR() {
    return state.prebuiltDir;
  },
  get DEFAULT_WORKER_SCRIPT() {
    return state.workerScript;
  },
  EXTENSION_PACKAGE_JSON: "package.json",
  OPENCLAW_MIN_HOST_VERSION: ">=2.0.0",
}));

vi.mock("esbuild", () => ({ build: vi.fn() }));

describe("materializeOpenclawOverlay (unit)", () => {
  let fixtures: string;
  let target: string;
  let manifestSrc: string;
  let entrySrc: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "oc-overlay-unit-"));
    manifestSrc = path.join(fixtures, "openclaw.plugin.json");
    fs.writeFileSync(manifestSrc, JSON.stringify({ id: "test-plugin" }) + "\n", "utf-8");
    entrySrc = path.join(fixtures, "index.template.mjs");
    fs.writeFileSync(entrySrc, "export default {};\n", "utf-8");
    state.workerScript = path.join(fixtures, "cli-exec-worker.mjs");
    fs.writeFileSync(state.workerScript, "// worker\n", "utf-8");
    state.prebuiltDir = path.join(fixtures, "prebuilt");
    fs.mkdirSync(path.join(state.prebuiltDir, "prebuilt-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(state.prebuiltDir, "prebuilt-plugin", "index.mjs"),
      "// prebuilt bundle\n",
      "utf-8",
    );
  });

  afterAll(() => {
    if (fixtures) fs.rmSync(fixtures, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.mocked(build).mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    target = fs.mkdtempSync(path.join(os.tmpdir(), "oc-overlay-unit-target-"));
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (target) fs.rmSync(target, { recursive: true, force: true });
  });

  it("returns 2 when a plugin descriptor ships no manifest", async () => {
    state.plugins = [
      {
        pluginDirname: "broken-plugin",
        displayName: "broken-plugin",
        installFiles: [{ src: entrySrc, target: "index.mjs" }],
      },
    ];
    expect(await materializeOpenclawOverlay(target)).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/broken-plugin has no manifest in INSTALL_FILES/),
    );
  });

  it("returns 2 when a plugin descriptor ships no entry", async () => {
    state.plugins = [
      {
        pluginDirname: "manifest-only-plugin",
        displayName: "manifest-only-plugin",
        installFiles: [{ src: manifestSrc, target: "openclaw.plugin.json" }],
      },
    ];
    expect(await materializeOpenclawOverlay(target)).toBe(2);
    // The manifest was already copied before the entry lookup failed.
    expect(
      fs.existsSync(path.join(target, "manifest-only-plugin", "openclaw.plugin.json")),
    ).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest-only-plugin has no entry in INSTALL_FILES/),
    );
  });

  it("copies the publish-time prebuilt bundle instead of esbuilding", async () => {
    state.plugins = [
      {
        pluginDirname: "prebuilt-plugin",
        displayName: "prebuilt-plugin",
        installFiles: [
          { src: manifestSrc, target: "openclaw.plugin.json" },
          { src: entrySrc, target: "index.mjs" },
        ],
      },
    ];
    expect(await materializeOpenclawOverlay(target)).toBe(0);
    expect(build).not.toHaveBeenCalled();
    const dir = path.join(target, "prebuilt-plugin");
    expect(fs.readFileSync(path.join(dir, "index.mjs"), "utf-8")).toBe(
      "// prebuilt bundle\n",
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as {
      description?: string;
      openclaw?: { extensions?: string[] };
      install?: { minHostVersion?: string };
    };
    expect(pkg.description).toMatch(/publish-time esbuild bundle/);
    expect(pkg.openclaw?.extensions).toEqual(["./index.mjs"]);
    expect(pkg.install?.minHostVersion).toBe(">=2.0.0");
    // Full success still ships the shared cli-exec worker.
    expect(fs.readFileSync(path.join(target, "scripts", "cli-exec-worker.mjs"), "utf-8")).toBe(
      "// worker\n",
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/installed prebuilt-plugin \(prebuilt\)/),
    );
  });

  it("returns 1 when esbuild fails to bundle the entry", async () => {
    state.plugins = [
      {
        pluginDirname: "bundle-me-plugin",
        displayName: "bundle-me-plugin",
        installFiles: [
          { src: manifestSrc, target: "openclaw.plugin.json" },
          { src: entrySrc, target: "index.mjs" },
        ],
      },
    ];
    vi.mocked(build).mockRejectedValueOnce(new Error("resolve failed: yaml"));
    expect(await materializeOpenclawOverlay(target)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/esbuild failed for bundle-me-plugin: resolve failed: yaml/),
    );
  });

  it("writes the bundled-plugin package.json when esbuild succeeds", async () => {
    state.plugins = [
      {
        pluginDirname: "bundle-me-plugin",
        displayName: "bundle-me-plugin",
        installFiles: [
          { src: manifestSrc, target: "openclaw.plugin.json" },
          { src: entrySrc, target: "index.mjs" },
        ],
      },
    ];
    vi.mocked(build).mockResolvedValueOnce({} as never);
    expect(await materializeOpenclawOverlay(target)).toBe(0);
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPoints: [entrySrc],
        outfile: path.join(target, "bundle-me-plugin", "index.mjs"),
        external: ["openclaw/*", "node:*"],
      }),
    );
    const pkg = JSON.parse(
      fs.readFileSync(path.join(target, "bundle-me-plugin", "package.json"), "utf-8"),
    ) as { description?: string; install?: { minHostVersion?: string } };
    expect(pkg.description).toMatch(/esbuild-produced single-file plugin entry/);
    expect(pkg.install?.minHostVersion).toBe(">=2.0.0");
    expect(fs.existsSync(path.join(target, "scripts", "cli-exec-worker.mjs"))).toBe(true);
  });
});
