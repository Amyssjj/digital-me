import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PNPM_SPEC,
  OVERLAY_DIRNAMES,
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
        const version = spec.startsWith("HEAD") ? cfg.fromVersion : cfg.toVersion;
        return ok(JSON.stringify({ version }));
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
  }) {
    const prevHome = process.env.OPENCLAW_HOME;
    const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-home-"));
    tmpDirs.push(openclawHome);
    process.env.OPENCLAW_HOME = openclawHome;
    if (opts.withSentinel) {
      fs.writeFileSync(path.join(openclawHome, "disable-launchagent"), "");
    }
    const exec = scriptedExec(opts.cfg);
    const { repoDir, extensionsDir } = makeRepo();
    try {
      const res = await updateOpenclaw({
        home: os.tmpdir(),
        repoDir,
        extensionsDir,
        exec,
        log: () => {},
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
});
