import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PNPM_SPEC,
  OVERLAY_DIRNAMES,
  defaultExec,
  pnpmSpecFromPackageManager,
  resolvePnpmSpec,
  selectMatureStableTag,
  updateOpenclaw,
  type ExecFn,
  type ExecResult,
} from "./updater.js";

describe("selectMatureStableTag", () => {
  const HOUR = 3600 * 1000;
  const now = Date.parse("2026-05-28T12:00:00Z");

  it("picks the most recent stable tag that is old enough, skipping pre-releases", () => {
    // Real-world shape: newest-first, with alpha/beta siblings interleaved.
    const lines = [
      "v2026.5.28-alpha.1|2026-05-28T06:00:00Z",
      "v2026.5.27-beta.1|2026-05-27T20:00:00Z",
      "v2026.5.27|2026-05-27T00:00:00Z", // ~36h old → eligible
      "v2026.5.12|2026-05-12T00:00:00Z",
    ];
    const got = selectMatureStableTag(lines, now, 24);
    expect(got?.ref).toBe("v2026.5.27");
  });

  it("skips a stable tag that is younger than the maturity window", () => {
    const lines = [
      "v2026.5.28|2026-05-28T06:00:00Z", // 6h old → too fresh
      "v2026.5.27|2026-05-27T00:00:00Z", // ~36h old → eligible
    ];
    expect(selectMatureStableTag(lines, now, 24)?.ref).toBe("v2026.5.27");
  });

  it("returns null when no stable tag qualifies (caller falls back to origin/main)", () => {
    const lines = [
      "v2026.5.28-rc.1|2026-05-28T00:00:00Z",
      "v2026.5.28|2026-05-28T11:00:00Z", // 1h old
    ];
    expect(selectMatureStableTag(lines, now, 24)).toBeNull();
  });

  it("ignores malformed and dateless lines", () => {
    const lines = ["", "garbage", "v9.9.9|not-a-date", "v1.0.0|2026-05-01T00:00:00Z"];
    expect(selectMatureStableTag(lines, now, 24)?.ref).toBe("v1.0.0");
  });
});

// ── updateOpenclaw with injected fakes ────────────────────────────────────

interface ScriptConfig {
  headSha: string;
  targetSha: string;
  targetRef: string;
  /** Distinct sha returned for a bare (un-peeled) `rev-parse <tag>` to emulate
   *  an annotated tag whose tag-object sha differs from its commit sha. */
  tagObjectSha?: string;
  fromVersion: string;
  toVersion: string;
  /** Optional package.json `packageManager` field returned by `git show`. */
  fromPackageManager?: string;
  targetPackageManager?: string;
  tagsOutput: string;
  porcelain?: string;
  tracked?: string;
  corepackStatus?: number;
  fetchStatus?: number;
  checkoutStatus?: number;
  installStatus?: number;
  buildStatus?: number;
  smokeStatus?: number;
  hasOpenclaw?: boolean;
  restartStatus?: number;
  installServiceStatus?: number;
}

/** A stateful fake git/pnpm/openclaw runner driven by ScriptConfig. */
function scriptedExec(cfg: ScriptConfig): ExecFn & { calls: { cmd: string; args: string[] }[] } {
  let checkedOut = false;
  const calls: { cmd: string; args: string[] }[] = [];
  const ok = (stdout = ""): ExecResult => ({ status: 0, stdout, stderr: "" });
  const exec = ((cmd: string, args: readonly string[]): ExecResult => {
    const a = [...args];
    calls.push({ cmd, args: a });
    const has = (...needles: string[]) => needles.every((n) => a.includes(n));

    if (cmd === "corepack" && has("--version")) {
      return { status: cfg.corepackStatus ?? 0, stdout: "0.0.0", stderr: "" };
    }
    if (cmd === "which") return { status: cfg.hasOpenclaw ? 0 : 1, stdout: "", stderr: "" };

    if (cmd === "git") {
      if (has("rev-parse", "--is-inside-work-tree")) return ok("true");
      if (has("rev-parse", "HEAD")) return ok(checkedOut ? cfg.targetSha : cfg.headSha);
      if (a.includes("rev-parse") && a.includes(`${cfg.targetRef}^{commit}`)) {
        return ok(cfg.targetSha); // peeled → commit sha
      }
      if (a.includes("rev-parse") && a.includes(cfg.targetRef)) {
        return ok(cfg.tagObjectSha ?? cfg.targetSha); // bare → tag-object sha
      }
      if (has("ls-files")) return ok(cfg.tracked ?? "");
      if (has("fetch")) return { status: cfg.fetchStatus ?? 0, stdout: "", stderr: "" };
      if (has("for-each-ref")) return ok(cfg.tagsOutput);
      if (has("status", "--porcelain")) return ok(cfg.porcelain ?? "");
      if (has("rev-list", "--count")) return ok("7");
      if (has("show")) {
        const spec = a.find((x) => x.endsWith(":package.json")) ?? "";
        const isHead = spec.startsWith("HEAD");
        const version = isHead ? cfg.fromVersion : cfg.toVersion;
        const packageManager = isHead
          ? cfg.fromPackageManager
          : cfg.targetPackageManager;
        return ok(
          JSON.stringify(
            packageManager ? { version, packageManager } : { version },
          ),
        );
      }
      if (has("checkout", "-f")) {
        checkedOut = true;
        return { status: cfg.checkoutStatus ?? 0, stdout: "", stderr: "" };
      }
      return ok("");
    }

    if (cmd === "corepack" || cmd === "pnpm") {
      if (has("install")) return { status: cfg.installStatus ?? 0, stdout: "", stderr: "" };
      if (has("build")) return { status: cfg.buildStatus ?? 0, stdout: "", stderr: "" };
      return ok("");
    }
    if (cmd === "node") return { status: cfg.smokeStatus ?? 0, stdout: "", stderr: "" };
    if (cmd === "openclaw") {
      if (has("gateway", "install", "--force"))
        return { status: cfg.installServiceStatus ?? 0, stdout: "", stderr: "" };
      if (has("restart")) return { status: cfg.restartStatus ?? 0, stdout: "", stderr: "" };
      if (has("--version")) return ok(`OpenClaw ${cfg.toVersion}`);
      if (has("status")) return ok("Connectivity probe: ok");
      return ok("");
    }
    return ok("");
  }) as ExecFn & { calls: { cmd: string; args: string[] }[] };
  (exec as { calls: typeof calls }).calls = calls;
  return exec;
}

/** Wrap a scripted exec, letting `override` intercept specific commands while
 *  keeping the underlying call recording intact. */
function withOverride(
  inner: ReturnType<typeof scriptedExec>,
  override: (cmd: string, args: readonly string[]) => ExecResult | undefined,
): ExecFn & { calls: { cmd: string; args: string[] }[] } {
  const exec = ((cmd, args, opts) => {
    const hit = override(cmd, args);
    if (hit) {
      inner.calls.push({ cmd, args: [...args] });
      return hit;
    }
    return inner(cmd, args, opts);
  }) as ExecFn & { calls: { cmd: string; args: string[] }[] };
  exec.calls = inner.calls;
  return exec;
}

const tmpDirs: string[] = [];
function makeRepo(): { repoDir: string; extensionsDir: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-upd-"));
  const extensionsDir = path.join(repoDir, "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });
  tmpDirs.push(repoDir);
  return { repoDir, extensionsDir };
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** Writes the overlay entry files so the smoke existsSync() check passes. */
function writingRematerialize(extensionsDir: string) {
  return async () => {
    for (const dir of OVERLAY_DIRNAMES) {
      const d = path.join(extensionsDir, dir);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "index.mjs"), "export default { register(){} }");
    }
    return 0;
  };
}

describe("updateOpenclaw", () => {
  const base = (): ScriptConfig => ({
    headSha: "aaaaaaaaaaaa",
    targetSha: "bbbbbbbbbbbb",
    targetRef: "v2026.5.27",
    fromVersion: "2026.5.12",
    toVersion: "2026.5.27",
    tagsOutput: "v2026.5.27|2026-05-01T00:00:00Z",
  });

  it("noop when already at the target tag (and never re-materializes)", async () => {
    const cfg = base();
    cfg.targetSha = cfg.headSha; // already current
    const exec = scriptedExec(cfg);
    const { repoDir, extensionsDir } = makeRepo();
    let rematerialized = false;
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      exec,
      log: () => {},
      rematerializeOverlay: async () => {
        rematerialized = true;
        return 0;
      },
    });
    expect(res.status).toBe("noop");
    expect(res.exitCode).toBe(0);
    expect(rematerialized).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("checkout"))).toBe(false);
  });

  it("dry-run fetches + selects a tag but performs no checkout/install and no overlay", async () => {
    const exec = scriptedExec(base());
    const { repoDir, extensionsDir } = makeRepo();
    let rematerialized = false;
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      dryRun: true,
      exec,
      log: () => {},
      rematerializeOverlay: async () => {
        rematerialized = true;
        return 0;
      },
    });
    expect(res.status).toBe("dry-run");
    expect(res.toRef).toBe("v2026.5.27");
    expect(exec.calls.some((c) => c.args.includes("fetch"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("checkout"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("install"))).toBe(false);
    expect(rematerialized).toBe(false);
  });

  it("dry-run plan describes the re-stamp + restart step", async () => {
    const exec = scriptedExec(base());
    const { repoDir, extensionsDir } = makeRepo();
    const lines: string[] = [];
    await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      dryRun: true,
      exec,
      log: (l) => lines.push(l),
      rematerializeOverlay: async () => 0,
    });
    expect(lines.join("\n")).toMatch(/re-stamp service \+ restart gateway/);
  });

  it("full update runs steps in order and re-materializes after build", async () => {
    const cfg = base();
    cfg.hasOpenclaw = true;
    const exec = scriptedExec(cfg);
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec,
      log: () => {},
      rematerializeOverlay: writingRematerialize(extensionsDir),
    });
    expect(res.status).toBe("updated");
    expect(res.exitCode).toBe(0);

    const order = exec.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    const idxCheckout = order.findIndex((l) => l.includes("checkout -f"));
    const idxInstall = order.findIndex((l) => l.includes("install --no-frozen-lockfile"));
    const idxBuild = order.findIndex((l) => l.includes("corepack") && l.includes("build"));
    expect(idxCheckout).toBeGreaterThanOrEqual(0);
    expect(idxInstall).toBeGreaterThan(idxCheckout);
    expect(idxBuild).toBeGreaterThan(idxInstall);
    // default pnpm spec is used
    expect(order.some((l) => l.includes(DEFAULT_PNPM_SPEC))).toBe(true);
  });

  it("runs install/build under the target tag's packageManager pin (not the default)", async () => {
    const cfg = base();
    cfg.hasOpenclaw = true;
    // Upstream bumped its pin; the updater must match it, not DEFAULT_PNPM_SPEC.
    cfg.targetPackageManager = "pnpm@11.2.2+sha512.deadbeef";
    const exec = scriptedExec(cfg);
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec,
      log: () => {},
      rematerializeOverlay: writingRematerialize(extensionsDir),
    });
    expect(res.status).toBe("updated");
    const order = exec.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    // corepack invoked with the upstream-pinned version (hash stripped)…
    expect(order.some((l) => l.includes("pnpm@11.2.2 install"))).toBe(true);
    // …and never the stale default.
    expect(order.some((l) => l.includes(DEFAULT_PNPM_SPEC))).toBe(false);
  });

  it("peels annotated tags to their commit (tag-object sha != commit sha)", async () => {
    // Regression: release tags are annotated. `rev-parse <tag>` returns the
    // tag-object sha; checkout lands HEAD on the commit. The updater must
    // compare/checkout the commit, not the tag object.
    const cfg = base();
    cfg.tagObjectSha = "ffffffffffff"; // bare rev-parse <tag> → tag object
    cfg.targetSha = "cccccccccccc"; // peeled rev-parse <tag>^{commit} → commit
    cfg.hasOpenclaw = true;
    const exec = scriptedExec(cfg);
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec,
      log: () => {},
      rematerializeOverlay: writingRematerialize(extensionsDir),
    });
    expect(res.status).toBe("updated");
    // checkout used the commit sha, and the post-checkout HEAD check passed.
    expect(
      exec.calls.some(
        (c) => c.args.includes("checkout") && c.args.includes("cccccccccccc"),
      ),
    ).toBe(true);
  });

  it("skipRestart omits the gateway restart", async () => {
    const cfg = base();
    cfg.hasOpenclaw = true;
    const exec = scriptedExec(cfg);
    const { repoDir, extensionsDir } = makeRepo();
    await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec,
      log: () => {},
      rematerializeOverlay: writingRematerialize(extensionsDir),
    });
    expect(
      exec.calls.some((c) => c.cmd === "openclaw" && c.args.includes("restart")),
    ).toBe(false);
  });

  /** Run `updateOpenclaw` with a fresh temp OPENCLAW_HOME, optionally seeding
   * the `disable-launchagent` sentinel, so the service-restart branch is
   * deterministic regardless of the ambient environment. */
  async function runWithOpenclawHome(opts: {
    cfg: ScriptConfig;
    withSentinel: boolean;
    /** Optional log collector (defaults to a silent logger). */
    log?: (line: string) => void;
    /** Optional exec override (defaults to scriptedExec(cfg)). */
    exec?: ExecFn & { calls: { cmd: string; args: string[] }[] };
  }) {
    const prevHome = process.env.OPENCLAW_HOME;
    const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-home-"));
    tmpDirs.push(openclawHome);
    process.env.OPENCLAW_HOME = openclawHome;
    if (opts.withSentinel) {
      fs.writeFileSync(path.join(openclawHome, "disable-launchagent"), "");
    }
    const exec = opts.exec ?? scriptedExec(opts.cfg);
    const { repoDir, extensionsDir } = makeRepo();
    try {
      const res = await updateOpenclaw({
        home: os.tmpdir(),
        repoDir,
        extensionsDir,
        exec,
        log: opts.log ?? (() => {}),
        rematerializeOverlay: writingRematerialize(extensionsDir),
      });
      return { res, exec };
    } finally {
      if (prevHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = prevHome;
    }
  }

  it("re-stamps via `gateway install --force` THEN restarts (no sentinel)", async () => {
    const cfg = base();
    cfg.hasOpenclaw = true;
    const { res, exec } = await runWithOpenclawHome({ cfg, withSentinel: false });
    expect(res.status).toBe("updated");
    const idxInstall = exec.calls.findIndex(
      (c) =>
        c.cmd === "openclaw" &&
        c.args.includes("install") &&
        c.args.includes("--force"),
    );
    const idxRestart = exec.calls.findIndex(
      (c) => c.cmd === "openclaw" && c.args.includes("restart"),
    );
    // install --force re-stamps the files, then restart loads the new code.
    expect(idxInstall).toBeGreaterThanOrEqual(0);
    expect(idxRestart).toBeGreaterThan(idxInstall);
  });

  it("respects disable-launchagent: restarts only, never re-stamps the service", async () => {
    const cfg = base();
    cfg.hasOpenclaw = true;
    const { res, exec } = await runWithOpenclawHome({ cfg, withSentinel: true });
    expect(res.status).toBe("updated");
    // Sentinel present → plain restart, and the service files are left alone.
    expect(
      exec.calls.some((c) => c.cmd === "openclaw" && c.args.includes("restart")),
    ).toBe(true);
    expect(
      exec.calls.some(
        (c) => c.cmd === "openclaw" && c.args.includes("install"),
      ),
    ).toBe(false);
  });

  it("falls back to a plain restart when `gateway install --force` fails", async () => {
    const cfg = base();
    cfg.hasOpenclaw = true;
    cfg.installServiceStatus = 1; // service re-stamp fails
    const { res, exec } = await runWithOpenclawHome({ cfg, withSentinel: false });
    // Non-fatal: the binary + overlay are already updated.
    expect(res.status).toBe("updated");
    expect(
      exec.calls.some(
        (c) =>
          c.cmd === "openclaw" &&
          c.args.includes("install") &&
          c.args.includes("--force"),
      ),
    ).toBe(true);
    // Fell back to a bare restart so the new code still loads.
    expect(
      exec.calls.some((c) => c.cmd === "openclaw" && c.args.includes("restart")),
    ).toBe(true);
  });

  it("fails with a blocker when pnpm install fails", async () => {
    const cfg = base();
    cfg.installStatus = 1;
    const exec = scriptedExec(cfg);
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec,
      log: () => {},
      rematerializeOverlay: writingRematerialize(extensionsDir),
    });
    expect(res.status).toBe("failed");
    expect(res.exitCode).toBe(1);
    expect(res.blockers.join(" ")).toMatch(/pnpm install failed/);
  });

  it("clean-check ignores untracked overlay paths but rejects other dirt", async () => {
    const overlayOnly = scriptedExec({
      ...base(),
      hasOpenclaw: true,
      porcelain: "?? extensions/digital-me-brain/index.mjs",
    });
    const repoA = makeRepo();
    const okRes = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir: repoA.repoDir,
      extensionsDir: repoA.extensionsDir,
      skipRestart: true,
      exec: overlayOnly,
      log: () => {},
      rematerializeOverlay: writingRematerialize(repoA.extensionsDir),
    });
    expect(okRes.status).toBe("updated");

    const dirty = scriptedExec({
      ...base(),
      porcelain: " M src/index.ts",
    });
    const repoB = makeRepo();
    const failRes = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir: repoB.repoDir,
      extensionsDir: repoB.extensionsDir,
      exec: dirty,
      log: () => {},
      rematerializeOverlay: async () => 0,
    });
    expect(failRes.status).toBe("failed");
    expect(failRes.blockers.join(" ")).toMatch(/uncommitted changes/);
  });

  it("falls back to plain pnpm (no DEFAULT_PNPM_SPEC) when corepack is missing", async () => {
    const cfg = base();
    cfg.corepackStatus = 1; // simulate corepack not found on PATH
    cfg.hasOpenclaw = true;
    const exec = scriptedExec(cfg);
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec,
      log: () => {},
      rematerializeOverlay: writingRematerialize(extensionsDir),
    });

    expect(res.status).toBe("updated");
    // pnpm install/build went through the plain `pnpm` binary, not `corepack`.
    const pnpmInstall = exec.calls.find(
      (c) => c.cmd === "pnpm" && c.args.includes("install"),
    );
    const pnpmBuild = exec.calls.find(
      (c) => c.cmd === "pnpm" && c.args.includes("build"),
    );
    expect(pnpmInstall).toBeDefined();
    expect(pnpmBuild).toBeDefined();
    // No corepack invocation for install/build (only the `--version` probe).
    const corepackBuildOrInstall = exec.calls.find(
      (c) =>
        c.cmd === "corepack" &&
        (c.args.includes("install") || c.args.includes("build")),
    );
    expect(corepackBuildOrInstall).toBeUndefined();
    // DEFAULT_PNPM_SPEC (e.g. "pnpm@10.33.2") must NOT leak into plain pnpm
    // argv — pnpm itself wouldn't understand it as a version specifier.
    const leakedSpec = exec.calls.find(
      (c) =>
        c.cmd === "pnpm" && c.args.some((a) => /^pnpm@\d/.test(a)),
    );
    expect(leakedSpec).toBeUndefined();
  });

  // ── preflight failures + path resolution ─────────────────────────────

  it("fails when the repo dir is missing, via the default exec and console logger", async () => {
    // No exec/log injected: exercises the defaultExec + console.log defaults.
    // Nothing is spawned — the existsSync preflight fails first.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const prevRepo = process.env.OPENCLAW_REPO;
    delete process.env.OPENCLAW_REPO;
    try {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-nohome-"));
      tmpDirs.push(home);
      const res = await updateOpenclaw({
        home,
        rematerializeOverlay: async () => 0,
      });
      expect(res.status).toBe("failed");
      expect(res.exitCode).toBe(1);
      expect(res.blockers.join(" ")).toMatch(/openclaw repo not found/);
      // Default repo resolution: <home>/openclaw.
      expect(res.blockers.join(" ")).toContain(path.join(home, "openclaw"));
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      if (prevRepo !== undefined) process.env.OPENCLAW_REPO = prevRepo;
    }
  });

  it("resolves the repo from $OPENCLAW_REPO when --repo-dir is not given", async () => {
    const prevRepo = process.env.OPENCLAW_REPO;
    process.env.OPENCLAW_REPO = "/nonexistent/openclaw-env-repo";
    try {
      const res = await updateOpenclaw({
        home: os.tmpdir(),
        exec: scriptedExec(base()),
        log: () => {},
        rematerializeOverlay: async () => 0,
      });
      expect(res.status).toBe("failed");
      expect(res.blockers.join(" ")).toContain("/nonexistent/openclaw-env-repo");
    } finally {
      if (prevRepo === undefined) delete process.env.OPENCLAW_REPO;
      else process.env.OPENCLAW_REPO = prevRepo;
    }
  });

  it("fails when the dir is not a git work tree", async () => {
    const exec = withOverride(scriptedExec(base()), (cmd, args) =>
      cmd === "git" && args.includes("--is-inside-work-tree")
        ? { status: 0, stdout: "false", stderr: "" }
        : undefined,
    );
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      exec,
      log: () => {},
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/not a git work tree/);
  });

  it("fails on a stale .git/index.lock", async () => {
    const { repoDir, extensionsDir } = makeRepo();
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".git", "index.lock"), "");
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      exec: scriptedExec(base()),
      log: () => {},
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/index\.lock/);
  });

  it("counts in-tree overlay-like paths as dirt when extensionsDir is outside the repo", async () => {
    // With the overlay outside repoDir, git-status entries can never belong
    // to it — an in-tree extensions/ path is real dirt, not overlay.
    const { repoDir } = makeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ext-"));
    tmpDirs.push(outside);
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir: outside,
      exec: scriptedExec({
        ...base(),
        porcelain: "?? extensions/digital-me-brain/index.mjs",
      }),
      log: () => {},
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/uncommitted changes/);
  });

  it("updates cleanly with an extensionsDir outside the repo", async () => {
    const cfg = base();
    const { repoDir } = makeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ext-"));
    tmpDirs.push(outside);
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir: outside,
      skipRestart: true,
      exec: scriptedExec(cfg),
      log: () => {},
      rematerializeOverlay: writingRematerialize(outside),
    });
    expect(res.status).toBe("updated");
  });

  it("treats overlay dirs at the repo root as overlay when extensionsDir IS the repo dir", async () => {
    const { repoDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir: repoDir,
      dryRun: true,
      exec: scriptedExec({
        ...base(),
        porcelain: "?? digital-me-brain/index.mjs",
      }),
      log: () => {},
      rematerializeOverlay: async () => 0,
    });
    // The root-level overlay dir is ignored by the clean check.
    expect(res.status).toBe("dry-run");
  });

  it("logs a NOTE when the overlay is git-tracked (legacy fork model)", async () => {
    const cfg = base();
    cfg.tracked = "extensions/digital-me-brain/index.mjs";
    const { repoDir, extensionsDir } = makeRepo();
    const lines: string[] = [];
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      dryRun: true,
      exec: scriptedExec(cfg),
      log: (l) => lines.push(l),
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("dry-run");
    expect(lines.join("\n")).toMatch(/\[NOTE\] Plugin overlay is git-tracked/);
  });

  // ── fetch / tag selection / resolution failures ──────────────────────

  it("fails with a blocker when git fetch fails", async () => {
    const cfg = base();
    cfg.fetchStatus = 1;
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      exec: scriptedExec(cfg),
      log: () => {},
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/git fetch failed/);
  });

  it("falls back to origin/main (with a WARN) when no mature stable tag exists", async () => {
    const cfg = base();
    cfg.tagsOutput = "";
    cfg.targetRef = "origin/main";
    const { repoDir, extensionsDir } = makeRepo();
    const lines: string[] = [];
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      dryRun: true,
      exec: scriptedExec(cfg),
      log: (l) => lines.push(l),
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("dry-run");
    expect(res.toRef).toBe("origin/main");
    expect(lines.join("\n")).toMatch(/no stable tag/);
  });

  it("fails when the target ref cannot be resolved to a commit", async () => {
    const exec = withOverride(scriptedExec(base()), (cmd, args) =>
      cmd === "git" && args.some((a) => a.endsWith("^{commit}"))
        ? { status: 1, stdout: "", stderr: "" }
        : undefined,
    );
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      exec,
      log: () => {},
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/could not resolve target ref/);
  });

  it("logs --pnpm-spec as the pnpm source when explicitly overridden", async () => {
    const { repoDir, extensionsDir } = makeRepo();
    const lines: string[] = [];
    await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      dryRun: true,
      pnpmSpec: "pnpm@9.9.9",
      exec: scriptedExec(base()),
      log: (l) => lines.push(l),
      rematerializeOverlay: async () => 0,
    });
    expect(lines.join("\n")).toMatch(/pnpm@9\.9\.9 \(--pnpm-spec\)/);
  });

  it("noop reports 'unknown' when package.json cannot be parsed at either ref", async () => {
    const cfg = base();
    cfg.targetSha = cfg.headSha; // already current
    const exec = withOverride(scriptedExec(cfg), (cmd, args) =>
      cmd === "git" && args.includes("show")
        ? { status: 0, stdout: "not-json{", stderr: "" }
        : undefined,
    );
    const { repoDir, extensionsDir } = makeRepo();
    const lines: string[] = [];
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      exec,
      log: (l) => lines.push(l),
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("noop");
    expect(lines.join("\n")).toMatch(/\(unknown\)/);
  });

  it("plans with sha/'?' fallbacks when git show fails at both refs (dry-run, skipRestart)", async () => {
    const cfg = base();
    const exec = withOverride(scriptedExec(cfg), (cmd, args) =>
      cmd === "git" && args.includes("show")
        ? { status: 1, stdout: "", stderr: "fatal: bad object" }
        : undefined,
    );
    const { repoDir, extensionsDir } = makeRepo();
    const lines: string[] = [];
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      dryRun: true,
      skipRestart: true,
      exec,
      log: (l) => lines.push(l),
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("dry-run");
    expect(res.fromVersion).toBeUndefined();
    expect(res.toVersion).toBeUndefined();
    const all = lines.join("\n");
    // Plan header falls back to the abbreviated sha and "?".
    expect(all).toMatch(/aaaaaaaaaa → \?/);
    // skipRestart drops the re-stamp/restart step from the dry-run plan.
    expect(all).not.toMatch(/re-stamp service \+ restart gateway/);
  });

  // ── checkout / build / overlay / smoke failures ──────────────────────

  it("fails with a blocker when git checkout fails", async () => {
    const cfg = base();
    cfg.checkoutStatus = 1;
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec: scriptedExec(cfg),
      log: () => {},
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/git checkout failed/);
  });

  it("fails when post-checkout HEAD does not land on the target sha", async () => {
    const cfg = base();
    // rev-parse HEAD keeps answering the OLD sha even after checkout.
    const exec = withOverride(scriptedExec(cfg), (cmd, args) =>
      cmd === "git" && args.includes("rev-parse") && args.includes("HEAD")
        ? { status: 0, stdout: cfg.headSha, stderr: "" }
        : undefined,
    );
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec,
      log: () => {},
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/post-checkout HEAD/);
  });

  it("fails with a blocker when pnpm build fails", async () => {
    const cfg = base();
    cfg.buildStatus = 1;
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec: scriptedExec(cfg),
      log: () => {},
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/pnpm build failed/);
  });

  it("fails when overlay materialization returns a non-zero exit", async () => {
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec: scriptedExec(base()),
      log: () => {},
      rematerializeOverlay: async () => 3,
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/overlay materialization failed \(exit 3\)/);
  });

  it("fails when a built overlay entry is missing on disk", async () => {
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec: scriptedExec(base()),
      log: () => {},
      // Claims success but writes nothing.
      rematerializeOverlay: async () => 0,
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/missing built overlay entry/);
  });

  it("fails when an overlay bundle flunks the node --check syntax smoke", async () => {
    const cfg = base();
    cfg.smokeStatus = 1;
    const { repoDir, extensionsDir } = makeRepo();
    const res = await updateOpenclaw({
      home: os.tmpdir(),
      repoDir,
      extensionsDir,
      skipRestart: true,
      exec: scriptedExec(cfg),
      log: () => {},
      rematerializeOverlay: writingRematerialize(extensionsDir),
    });
    expect(res.status).toBe("failed");
    expect(res.blockers.join(" ")).toMatch(/failed syntax smoke/);
  });

  // ── restart / audit edge cases ───────────────────────────────────────

  it("warns (non-fatal) when gateway restart fails", async () => {
    const cfg = base();
    cfg.hasOpenclaw = true;
    cfg.restartStatus = 1;
    const lines: string[] = [];
    const { res } = await runWithOpenclawHome({
      cfg,
      withSentinel: true, // restart-only path
      log: (l) => lines.push(l),
    });
    // Non-fatal: the update itself is applied.
    expect(res.status).toBe("updated");
    expect(lines.join("\n")).toMatch(/gateway restart returned 1/);
  });

  it("warns and skips the restart when 'openclaw' is not on PATH", async () => {
    const cfg = base(); // hasOpenclaw defaults to falsy → `which` fails
    const lines: string[] = [];
    const { res, exec } = await runWithOpenclawHome({
      cfg,
      withSentinel: false,
      log: (l) => lines.push(l),
    });
    expect(res.status).toBe("updated");
    expect(lines.join("\n")).toMatch(/'openclaw' not on PATH/);
    expect(exec.calls.some((c) => c.cmd === "openclaw")).toBe(false);
  });

  it("audit warns when the live version/probe don't reflect the update yet", async () => {
    const cfg = base();
    cfg.hasOpenclaw = true;
    const exec = withOverride(scriptedExec(cfg), (cmd, args) => {
      if (cmd === "openclaw" && args.includes("--version")) {
        return { status: 0, stdout: "OpenClaw 0.0.0", stderr: "" };
      }
      if (cmd === "openclaw" && args.includes("status")) {
        return { status: 0, stdout: "still starting", stderr: "" };
      }
      return undefined;
    });
    const lines: string[] = [];
    const { res } = await runWithOpenclawHome({
      cfg,
      withSentinel: true, // restart-only path runs the audit directly
      log: (l) => lines.push(l),
      exec,
    });
    expect(res.status).toBe("updated");
    const all = lines.join("\n");
    expect(all).toMatch(/does not include 2026\.5\.27/);
    expect(all).toMatch(/did not report 'Connectivity probe: ok'/);
  });

  it("falls back to ref names in logs when versions are unknown (full update + re-stamp)", async () => {
    const cfg = base();
    cfg.hasOpenclaw = true;
    const exec = withOverride(scriptedExec(cfg), (cmd, args) =>
      cmd === "git" && args.includes("show")
        ? { status: 0, stdout: "{invalid", stderr: "" }
        : undefined,
    );
    const lines: string[] = [];
    const { res } = await runWithOpenclawHome({
      cfg,
      withSentinel: false, // re-stamp + restart path
      log: (l) => lines.push(l),
      exec,
    });
    expect(res.status).toBe("updated");
    const all = lines.join("\n");
    // toVersion unknown → both stamps fall back to the tag ref…
    expect(all).toMatch(/service files re-stamped to v2026\.5\.27/);
    // …and the final OK line falls back to the abbreviated sha + tag ref.
    expect(all).toMatch(/openclaw updated aaaaaaaaaa → v2026\.5\.27/);
  });

  // ── env-var extensionsDir resolution ─────────────────────────────────

  it("resolves extensionsDir from $OPENCLAW_EXTENSIONS_DIR when not given", async () => {
    const prevExt = process.env.OPENCLAW_EXTENSIONS_DIR;
    const envExt = fs.mkdtempSync(path.join(os.tmpdir(), "oc-envext-"));
    tmpDirs.push(envExt);
    process.env.OPENCLAW_EXTENSIONS_DIR = envExt;
    try {
      const { repoDir } = makeRepo();
      let got: string | undefined;
      const res = await updateOpenclaw({
        home: os.tmpdir(),
        repoDir,
        skipRestart: true,
        exec: scriptedExec(base()),
        log: () => {},
        rematerializeOverlay: async ({ extensionsDir }) => {
          got = extensionsDir;
          await writingRematerialize(extensionsDir)();
          return 0;
        },
      });
      expect(res.status).toBe("updated");
      expect(got).toBe(envExt);
    } finally {
      if (prevExt === undefined) delete process.env.OPENCLAW_EXTENSIONS_DIR;
      else process.env.OPENCLAW_EXTENSIONS_DIR = prevExt;
    }
  });

  it("defaults extensionsDir to <OPENCLAW_HOME>/extensions when nothing else is set", async () => {
    const prevExt = process.env.OPENCLAW_EXTENSIONS_DIR;
    const prevHome = process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_EXTENSIONS_DIR;
    const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-statehome-"));
    tmpDirs.push(openclawHome);
    process.env.OPENCLAW_HOME = openclawHome;
    try {
      const { repoDir } = makeRepo();
      let got: string | undefined;
      const res = await updateOpenclaw({
        home: os.tmpdir(),
        repoDir,
        skipRestart: true,
        exec: scriptedExec(base()),
        log: () => {},
        rematerializeOverlay: async ({ extensionsDir }) => {
          got = extensionsDir;
          await writingRematerialize(extensionsDir)();
          return 0;
        },
      });
      expect(res.status).toBe("updated");
      expect(got).toBe(path.join(openclawHome, "extensions"));
    } finally {
      if (prevExt === undefined) delete process.env.OPENCLAW_EXTENSIONS_DIR;
      else process.env.OPENCLAW_EXTENSIONS_DIR = prevExt;
      if (prevHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = prevHome;
    }
  });
});

describe("defaultExec", () => {
  it("runs a real process, forwarding cwd/env/input/timeout", () => {
    const res = defaultExec(
      process.execPath,
      [
        "-e",
        "process.stdout.write(require('node:fs').readFileSync(0,'utf8') + process.env.DM_TEST_MARK)",
      ],
      {
        cwd: os.tmpdir(),
        env: { ...process.env, DM_TEST_MARK: "-mark" },
        input: "echoed",
        timeoutMs: 30_000,
      },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("echoed-mark");
  });

  it("uses the built-in defaults (no opts) and captures stderr + exit code", () => {
    const res = defaultExec(process.execPath, [
      "-e",
      "process.stderr.write('warn'); process.exit(3)",
    ]);
    expect(res.status).toBe(3);
    expect(res.stderr).toBe("warn");
    expect(res.stdout).toBe("");
  });

  it("maps a spawn error (missing binary) to status 1 with empty output", () => {
    const res = defaultExec("/definitely/not/a/binary-dm-test", []);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });

  it("maps a signal-killed process (null status, no spawn error) to status 0", () => {
    const res = defaultExec(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGKILL')",
    ]);
    expect(res.status).toBe(0);
  });
});

describe("pnpmSpecFromPackageManager", () => {
  it("extracts pnpm@x.y.z and drops the integrity hash", () => {
    expect(pnpmSpecFromPackageManager("pnpm@11.2.2+sha512.abc123")).toBe(
      "pnpm@11.2.2",
    );
  });

  it("accepts a bare pnpm@x.y.z (no hash)", () => {
    expect(pnpmSpecFromPackageManager("pnpm@10.33.2")).toBe("pnpm@10.33.2");
  });

  it("keeps a prerelease tag but drops the hash", () => {
    expect(pnpmSpecFromPackageManager("pnpm@11.0.0-rc.1+sha512.x")).toBe(
      "pnpm@11.0.0-rc.1",
    );
  });

  it("returns undefined for missing or non-pnpm specs", () => {
    expect(pnpmSpecFromPackageManager(undefined)).toBeUndefined();
    expect(pnpmSpecFromPackageManager("")).toBeUndefined();
    expect(pnpmSpecFromPackageManager("yarn@4.1.0")).toBeUndefined();
  });
});

describe("resolvePnpmSpec", () => {
  it("prefers the explicit override above all", () => {
    expect(resolvePnpmSpec("pnpm@9.0.0", "pnpm@11.2.2")).toBe("pnpm@9.0.0");
  });

  it("falls back to the upstream pin when no override", () => {
    expect(resolvePnpmSpec(undefined, "pnpm@11.2.2")).toBe("pnpm@11.2.2");
  });

  it("falls back to DEFAULT_PNPM_SPEC when neither is set", () => {
    expect(resolvePnpmSpec(undefined, undefined)).toBe(DEFAULT_PNPM_SPEC);
  });
});
