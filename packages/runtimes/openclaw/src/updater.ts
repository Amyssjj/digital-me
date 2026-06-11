/**
 * runtime-openclaw updater — `digital-me update --runtime openclaw`.
 *
 * Model: STOCK upstream openclaw + a re-materialized additive overlay.
 * Each update checks out a fresh mature stable tag into the user's openclaw
 * SOURCE repo, rebuilds, then re-lays the digital-me plugin overlay
 * (digital-me-brain / digital-me-recall) from digital-me-os source. There is
 * no fork branch, no rebase, and no cherry-pick — so the historical
 * "accumulated upstream cruft" rebase failure cannot happen.
 *
 * This module is orchestration-only: it shells out to git / pnpm / openclaw
 * via an injected {@link ExecFn} and delegates the (esbuild-based) overlay
 * materialization to an injected callback, so the heavy esbuild dependency
 * stays in @digital-me/cli and this module stays unit-testable with fakes.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { PLUGINS } from "./installer.js";

export const DEFAULT_TAG_MATURITY_HOURS = 24;

/**
 * pnpm version run via corepack for install/build. Pinned to 10.33.2 to dodge
 * pnpm v11's `minimumReleaseAge` metadata regression (ERR_PNPM_MISSING_TIME).
 * Overridable via `--pnpm-spec` / opts.pnpmSpec.
 */
export const DEFAULT_PNPM_SPEC = "pnpm@10.33.2";

/**
 * Overlay plugin dirnames. Their presence in the openclaw repo working tree
 * must NOT count as "dirty" (they are intentionally untracked), and a fresh
 * tag checkout must preserve them. Derived from PLUGINS so it stays in sync.
 */
export const OVERLAY_DIRNAMES: readonly string[] = PLUGINS.map(
  (p) => p.pluginDirname,
);

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  cmd: string,
  args: readonly string[],
  opts?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
  },
) => ExecResult;

export interface UpdateOpenclawOptions {
  /** User home; used only for default repo resolution. */
  home: string;
  /** openclaw SOURCE repo dir. Resolution: opts > $OPENCLAW_REPO > <home>/openclaw. */
  repoDir?: string;
  /** Overlay target dir. Resolution: opts > $OPENCLAW_EXTENSIONS_DIR > <repoDir>/extensions. */
  extensionsDir?: string;
  /** Read-only: pick tag, run preflight, print the plan; no checkout/install/build/restart. */
  dryRun?: boolean;
  /** Minimum age (hours) for a stable tag to be eligible. Default 24. */
  tagMaturityHours?: number;
  /** Skip the gateway restart at the end (CI / headless / manual restart). */
  skipRestart?: boolean;
  /** Pinned pnpm spec for corepack. Default {@link DEFAULT_PNPM_SPEC}. */
  pnpmSpec?: string;
  /** Re-materialize the overlay into extensionsDir. Injected by the CLI so the
   *  esbuild dependency lives in @digital-me/cli. Never called in dryRun. */
  rematerializeOverlay: (args: { extensionsDir: string }) => Promise<number>;
  /** Process runner. Defaults to a spawnSync wrapper. Injected for tests. */
  exec?: ExecFn;
  /** Logger. Defaults to console.log. */
  log?: (line: string) => void;
}

export type UpdateStatus = "updated" | "noop" | "dry-run" | "failed";

export interface UpdateResult {
  exitCode: number;
  status: UpdateStatus;
  fromRef?: string;
  toRef?: string;
  fromVersion?: string;
  toVersion?: string;
  blockers: string[];
}

const MINUTE = 60_000;

function defaultExec(
  cmd: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
  } = {},
): ExecResult {
  const res = spawnSync(cmd, [...args], {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 2 * MINUTE,
    maxBuffer: 64 * 1024 * 1024,
    env: opts.env ?? process.env,
  });
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/**
 * Pick the most recent stable upstream tag at least `maturityHours` old.
 *
 * @param tagLines lines of "<name>|<iso-date>" (e.g. from
 *   `git for-each-ref --sort=-creatordate --format='%(refname:short)|%(creatordate:iso-strict)' refs/tags/v*`).
 *   Assumed already sorted newest-first; this function does not re-sort.
 * @returns the chosen tag, or null when none qualify (caller falls back to origin/main).
 */
export function selectMatureStableTag(
  tagLines: readonly string[],
  now: number,
  maturityHours: number,
): { ref: string; date: string } | null {
  const cutoff = now - maturityHours * 3600 * 1000;
  for (const line of tagLines) {
    if (!line) continue;
    const [name, date] = line.split("|");
    if (!name || !date) continue;
    if (/-beta|-alpha|-rc/i.test(name)) continue;
    const ts = Date.parse(date);
    if (!Number.isFinite(ts)) continue;
    if (ts <= cutoff) return { ref: name, date };
  }
  return null;
}

/** True if a `git status --porcelain` path belongs to the untracked overlay.
 *
 * `overlayRelPrefix` is the slash-terminated relative path from repoDir to the
 * resolved extensionsDir (e.g. "extensions/" by default, "my-plugins/" with
 * --extensions-dir override). Empty string means the overlay lives in repoDir
 * itself; in that case any overlay dir name matches at the repo root.
 *
 * Returns false if `overlayRelPrefix` is undefined — meaning extensionsDir is
 * outside repoDir, in which case git status entries can never reference it,
 * so the porcelain output is always non-overlay by definition.
 */
function isOverlayPath(
  porcelainLine: string,
  overlayRelPrefix: string | undefined,
): boolean {
  if (overlayRelPrefix === undefined) return false;
  // porcelain format: "XY <path>" (e.g. "?? extensions/digital-me-brain/foo")
  const file = porcelainLine.slice(3).trim();
  return OVERLAY_DIRNAMES.some(
    (dir) =>
      file === `${overlayRelPrefix}${dir}` ||
      file.startsWith(`${overlayRelPrefix}${dir}/`),
  );
}

/** Compute the slash-terminated relative path from repoDir to extensionsDir,
 * suitable for prefix-matching against `git status --porcelain` output.
 * Returns `undefined` if extensionsDir is outside repoDir. */
function overlayRelativePrefix(
  repoDir: string,
  extensionsDir: string,
): string | undefined {
  const rel = path.relative(repoDir, extensionsDir);
  // Anything starting with `..` (or an absolute path on Windows) is outside repoDir.
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  if (rel === "") return "";
  return `${rel.replace(/[\\/]+$/, "")}/`;
}

function packageVersionAt(
  exec: ExecFn,
  repoDir: string,
  ref: string,
): string | undefined {
  const show = exec("git", ["-C", repoDir, "show", `${ref}:package.json`]);
  if (show.status !== 0) return undefined;
  try {
    return (JSON.parse(show.stdout) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

export async function updateOpenclaw(
  opts: UpdateOpenclawOptions,
): Promise<UpdateResult> {
  const exec = opts.exec ?? defaultExec;
  const log = opts.log ?? ((l: string) => console.log(l));
  const blockers: string[] = [];
  const result: UpdateResult = { exitCode: 0, status: "failed", blockers };
  const fail = (msg: string): UpdateResult => {
    blockers.push(msg);
    log(`[FAIL] ${msg}`);
    result.status = "failed";
    result.exitCode = 1;
    return result;
  };

  // ── 0. Resolve paths ──────────────────────────────────────────────────
  const repoDir =
    opts.repoDir ??
    process.env.OPENCLAW_REPO ??
    path.join(opts.home, "openclaw");
  // Canonical target = the STATE dir's extensions folder (highest load
  // precedence, and outside the openclaw checkout so it survives both
  // `git checkout <tag>` and being baked into <repoDir>/dist/extensions by the
  // stock build). NOT <repoDir>/extensions — that overlay is the lowest
  // precedence and is shadowed by the build's dist/extensions copy.
  const openclawHome =
    process.env.OPENCLAW_HOME ?? path.join(opts.home, ".openclaw");
  const extensionsDir =
    opts.extensionsDir ??
    process.env.OPENCLAW_EXTENSIONS_DIR ??
    path.join(openclawHome, "extensions");
  const maturityHours = opts.tagMaturityHours ?? DEFAULT_TAG_MATURITY_HOURS;
  const pnpmSpec = opts.pnpmSpec ?? DEFAULT_PNPM_SPEC;

  // ── 1. Preflight (read-only) ──────────────────────────────────────────
  if (!existsSync(repoDir)) {
    return fail(
      `openclaw repo not found: ${repoDir}. Override with --repo-dir <path> or $OPENCLAW_REPO.`,
    );
  }
  const isRepo = exec("git", ["-C", repoDir, "rev-parse", "--is-inside-work-tree"]);
  if (isRepo.status !== 0 || isRepo.stdout.trim() !== "true") {
    return fail(`not a git work tree: ${repoDir}`);
  }
  if (existsSync(path.join(repoDir, ".git", "index.lock"))) {
    return fail(`${repoDir} has a stale .git/index.lock; remove it and retry.`);
  }
  // Clean check, ignoring the (intentionally untracked) overlay paths.
  const overlayRelPrefix = overlayRelativePrefix(repoDir, extensionsDir);
  const statusOut = exec("git", ["-C", repoDir, "status", "--porcelain"]);
  const dirty = statusOut.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .filter((l) => !isOverlayPath(l, overlayRelPrefix));
  if (dirty.length > 0) {
    return fail(
      `openclaw repo has uncommitted changes (outside the plugin overlay):\n${dirty.join("\n")}\nCommit/stash them, then retry.`,
    );
  }
  const corepackOk = exec("corepack", ["--version"]).status === 0;
  if (!corepackOk) {
    log(
      `[WARN] corepack not found; falling back to plain pnpm on PATH. The pnpm-v11 minimumReleaseAge bug may surface — install corepack or pass --pnpm-spec.`,
    );
  }
  const fromSha = exec("git", ["-C", repoDir, "rev-parse", "HEAD"]).stdout.trim();
  const fromVersion = packageVersionAt(exec, repoDir, "HEAD");
  result.fromRef = fromSha;
  result.fromVersion = fromVersion;

  // Legacy fork detection (overlay tracked in git) — informational only.
  // Skip if the overlay lives outside repoDir (no in-tree paths to query).
  const tracked =
    overlayRelPrefix === undefined
      ? { stdout: "", stderr: "", status: 0 }
      : exec("git", [
          "-C",
          repoDir,
          "ls-files",
          ...OVERLAY_DIRNAMES.map((d) => `${overlayRelPrefix}${d}`),
        ]);
  if (tracked.stdout.trim().length > 0) {
    log(
      `[NOTE] Plugin overlay is git-tracked (legacy fork model). This updater uses the untracked-overlay model; checkout -f will reset to the stock tag and the overlay is re-materialized afterward. Your existing branch is left untouched as a backup.`,
    );
  }

  // ── 2. Fetch + select target tag ──────────────────────────────────────
  log(`[..] fetching upstream tags`);
  const fetch = exec(
    "git",
    ["-C", repoDir, "fetch", "origin", "--tags", "--force", "--quiet"],
    { timeoutMs: 10 * MINUTE },
  );
  if (fetch.status !== 0) {
    return fail(`git fetch failed: ${(fetch.stderr || fetch.stdout).slice(0, 800)}`);
  }
  const tagsRaw = exec("git", [
    "-C",
    repoDir,
    "for-each-ref",
    "--sort=-creatordate",
    "--format=%(refname:short)|%(creatordate:iso-strict)",
    "refs/tags/v*",
  ]);
  const mature = selectMatureStableTag(
    tagsRaw.stdout.split("\n"),
    Date.now(),
    maturityHours,
  );
  const targetRef = mature ? mature.ref : "origin/main";
  if (!mature) {
    log(
      `[WARN] no stable tag ≥ ${maturityHours}h old found; falling back to ${targetRef}`,
    );
  }
  // Peel to the underlying commit: release tags are annotated, so a bare
  // `rev-parse <tag>` yields the tag-object sha, but checkout lands HEAD on
  // the commit it points to. `^{commit}` makes both sides comparable.
  const toSha = exec("git", [
    "-C",
    repoDir,
    "rev-parse",
    `${targetRef}^{commit}`,
  ]).stdout.trim();
  if (!toSha) {
    return fail(`could not resolve target ref ${targetRef}`);
  }
  const toVersion = packageVersionAt(exec, repoDir, toSha);
  result.toRef = mature ? mature.ref : targetRef;
  result.toVersion = toVersion;

  if (toSha === fromSha) {
    log(
      `[OK] already up to date at ${result.toRef} (${toVersion ?? fromVersion ?? "unknown"}).`,
    );
    result.status = "noop";
    result.exitCode = 0;
    return result;
  }

  const aheadCount = exec("git", [
    "-C",
    repoDir,
    "rev-list",
    "--count",
    `HEAD..${toSha}`,
  ]).stdout.trim();
  log(
    `[plan] ${fromVersion ?? fromSha.slice(0, 10)} → ${toVersion ?? "?"} (${result.toRef}, ${aheadCount} upstream commits)\n` +
      `       repo:       ${repoDir}\n` +
      `       extensions: ${extensionsDir}`,
  );

  // ── 3. Dry-run gate ───────────────────────────────────────────────────
  if (opts.dryRun) {
    log(
      `[dry-run] would: checkout -f ${toSha.slice(0, 10)} → ${pnpmSpec} install → ${pnpmSpec} build → re-materialize overlay → smoke${opts.skipRestart ? "" : " → re-stamp service + restart gateway"}`,
    );
    result.status = "dry-run";
    result.exitCode = 0;
    return result;
  }

  // ── 4. Checkout the target tag (detached; stock upstream) ─────────────
  log(`[..] checking out ${result.toRef}`);
  const checkout = exec("git", ["-C", repoDir, "checkout", "-f", toSha]);
  if (checkout.status !== 0) {
    return fail(`git checkout failed: ${(checkout.stderr || checkout.stdout).slice(0, 800)}`);
  }
  const headNow = exec("git", ["-C", repoDir, "rev-parse", "HEAD"]).stdout.trim();
  if (headNow !== toSha) {
    return fail(`post-checkout HEAD ${headNow} != target ${toSha}`);
  }

  // ── 5/6. Install + build (pinned pnpm, non-interactive) ───────────────
  const pnpmEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "true",
    NO_COLOR: "1",
    TERM: "dumb",
    npm_config_verify_deps_before_run: "false",
  };
  const pnpmRun = (label: string, pnpmArgs: string[]): ExecResult => {
    const [cmd, args] = corepackOk
      ? ["corepack", [pnpmSpec, ...pnpmArgs]]
      : ["pnpm", pnpmArgs];
    log(`[..] ${label}`);
    return exec(cmd as string, args as string[], {
      cwd: repoDir,
      env: pnpmEnv,
      timeoutMs: 20 * MINUTE,
    });
  };

  const install = pnpmRun("pnpm install", ["install", "--no-frozen-lockfile"]);
  if (install.status !== 0) {
    return fail(`pnpm install failed: ${(install.stderr || install.stdout).slice(0, 1200)}`);
  }
  const build = pnpmRun("pnpm build", ["build"]);
  if (build.status !== 0) {
    return fail(`pnpm build failed: ${(build.stderr || build.stdout).slice(0, 1200)}`);
  }

  // ── 7. Re-materialize the overlay AFTER build (keeps lockfile clean) ───
  log(`[..] re-materializing plugin overlay`);
  const overlayRc = await opts.rematerializeOverlay({ extensionsDir });
  if (overlayRc !== 0) {
    return fail(`overlay materialization failed (exit ${overlayRc})`);
  }

  // ── 8. Smoke: each overlay bundle exists and is valid JS ──────────────
  // We syntax-check with `node --check` rather than executing the bundle:
  // the plugin entries externalize `openclaw/*` (provided by the gateway at
  // load time), so a standalone import() cannot resolve it. The gateway's
  // own loader is the real load test. `node --check` catches truncated /
  // corrupt esbuild output without needing the externalized deps.
  for (const dir of OVERLAY_DIRNAMES) {
    const entry = path.join(extensionsDir, dir, "index.mjs");
    if (!existsSync(entry)) {
      return fail(`missing built overlay entry: ${entry}`);
    }
    const smoke = exec("node", ["--check", entry], { timeoutMs: MINUTE });
    if (smoke.status !== 0) {
      return fail(`overlay plugin ${dir} failed syntax smoke: ${(smoke.stderr || smoke.stdout).slice(0, 600)}`);
    }
  }
  log(`[OK] overlay bundles validate`);

  // ── 9. Re-stamp the service files + restart the gateway (cross-platform)
  // The checkout bumped the binary, but the launchd/systemd/schtasks SERVICE
  // files still carry the OLD version stamp (and possibly a non-minimal PATH).
  // Left alone, `openclaw gateway status` then nags "Service config out of
  // date — installed by <old>; current CLI is <new>" after every update.
  // openclaw's own `gateway install --force` regenerates those files in the
  // correct per-platform format — so we run it to re-stamp, THEN restart.
  //
  // `gateway install` only WRITES/loads the service files (its `runDaemonInstall`
  // → `installDaemonServiceAndEmit` just calls `service.install()` + emits); it
  // does NOT reload a running gateway. So a re-stamp alone would leave the old
  // process serving stale code while we report success. We therefore ALWAYS
  // follow the install with an explicit `gateway restart` to load the new
  // binary + overlay. (One restart cycle; install itself does not cycle.)
  //
  // EXCEPTION — the `disable-launchagent` sentinel: when
  // `<OPENCLAW_HOME>/disable-launchagent` exists the user is intentionally
  // managing the gateway by hand (e.g. a foreground/debug run) to avoid port
  // collisions. We must NOT (re)write or (re)enable the service in that case;
  // fall back to a plain restart and leave the service files untouched.
  const launchAgentDisabled = existsSync(
    path.join(openclawHome, "disable-launchagent"),
  );
  // Best-effort, non-fatal post-restart audit shared by every branch below.
  const auditLiveGateway = (): void => {
    const version = exec("openclaw", ["--version"]).stdout;
    if (toVersion && !version.includes(toVersion)) {
      log(`[WARN] openclaw --version (${version.trim()}) does not include ${toVersion}`);
    }
    const gwStatus = exec("openclaw", ["gateway", "status"]).stdout;
    if (!gwStatus.includes("Connectivity probe: ok")) {
      log(`[WARN] gateway status did not report 'Connectivity probe: ok' yet (it may still be starting).`);
    } else {
      log(`[OK] gateway probe ok`);
    }
  };
  const restartOnly = (): void => {
    const restart = exec("openclaw", ["gateway", "restart"], {
      timeoutMs: 5 * MINUTE,
    });
    if (restart.status !== 0) {
      log(
        `[WARN] gateway restart returned ${restart.status}: ${(restart.stderr || restart.stdout).slice(0, 600)}. The update is applied; restart manually if needed.`,
      );
    } else {
      auditLiveGateway();
    }
  };

  if (opts.skipRestart) {
    log(
      `[SKIP] gateway restart (run \`openclaw gateway install --force\` to re-stamp the service + load the update).`,
    );
  } else if (exec("which", ["openclaw"]).status !== 0) {
    log(
      `[WARN] 'openclaw' not on PATH; skipping restart. Run \`openclaw gateway install --force\` manually.`,
    );
  } else if (launchAgentDisabled) {
    log(
      `[..] restarting gateway (service files NOT re-stamped: LaunchAgent writes disabled via ${path.join(openclawHome, "disable-launchagent")})`,
    );
    restartOnly();
  } else {
    log(`[..] re-stamping gateway service (gateway install --force)`);
    const install = exec("openclaw", ["gateway", "install", "--force"], {
      timeoutMs: 5 * MINUTE,
    });
    if (install.status !== 0) {
      // Non-fatal: the binary + overlay are already updated. The version stamp
      // may stay stale until the next successful install — but we still restart
      // below so the new code loads.
      log(
        `[WARN] 'gateway install --force' returned ${install.status}: ${(install.stderr || install.stdout).slice(0, 600)}. Restarting without a re-stamp.`,
      );
    } else {
      log(`[OK] service files re-stamped to ${toVersion ?? result.toRef}`);
    }
    // install only writes/loads the files; always restart to load new code.
    restartOnly();
  }

  log(
    `[OK] openclaw updated ${fromVersion ?? fromSha.slice(0, 10)} → ${toVersion ?? result.toRef}`,
  );
  result.status = "updated";
  result.exitCode = 0;
  return result;
}
