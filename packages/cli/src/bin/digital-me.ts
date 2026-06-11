#!/usr/bin/env node
/**
 * `digital-me` CLI entry. Subcommands:
 *
 *   digital-me setup [--wiki-root=<path>]
 *     One-shot orchestrator: detect installed CLIs, run install for each,
 *     scaffold a wiki dir, link the `digital-me` command onto PATH, run
 *     doctor at the end.
 *
 *   digital-me init [--wiki-root=<path>]
 *     Scaffold the wiki directory (wiki/, inbox/, .cache/, config.example.yaml).
 *
 *   digital-me doctor [--runtime <id>...]
 *     Diagnose the environment.
 *
 *   digital-me install --runtime <id> [--runtime <id>...]
 *     Install the bundled assets (hooks / SOUL.md / CODEX.md) for the
 *     selected runtimes into the user's home directory.
 *
 *   digital-me dream-cycle [args...]
 *     Run the dream-cycle knowledge distillation pipeline (proxies to
 *     `python3 -m dream_cycle.run`). All args after `dream-cycle` pass
 *     through verbatim.
 *
 * The install path runs filesystem writes; it's intentionally NOT in
 * the unit-test surface. The pure data layer (doctor.ts, setup.ts, and
 * each runtime package's installer) IS tested.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_NAMES,
  HOOKS_DIR as CLAUDE_HOOKS_DIR,
  SKILLS_DIR as CLAUDE_SKILLS_DIR,
  buildClaudeHooksManifest,
  mergeHooksIntoSettings,
} from "@digital-me/runtime-claude-code";
import {
  CODEX_MD_TEMPLATE,
  HOOK_NAMES as CODEX_HOOK_NAMES,
  HOOKS_DIR as CODEX_HOOKS_DIR,
  buildCodexMcpConfig,
  mergeCodexHooksJson,
  mergeCodexMd,
  mergeMcpServer,
} from "@digital-me/runtime-codex";
import { BIN_PATH as BRAIN_MCP_PROXY_BIN } from "@digital-me/brain-mcp-proxy";
import {
  SOUL_MD_TEMPLATE,
  mergeSoulMd,
  RECALL_PLUGIN_NAME as HERMES_RECALL_PLUGIN_NAME,
  RECALL_PLUGIN_SRC_DIR as HERMES_RECALL_PLUGIN_SRC_DIR,
  RECALL_PLUGIN_FILES as HERMES_RECALL_PLUGIN_FILES,
  RECALL_PLUGIN_ENABLE_COMMAND as HERMES_RECALL_PLUGIN_ENABLE_COMMAND,
} from "@digital-me/runtime-hermes";
import {
  DEFAULT_WORKER_SCRIPT as OPENCLAW_CLI_EXEC_WORKER_SCRIPT,
  EXTENSION_PACKAGE_JSON as OPENCLAW_EXTENSION_PACKAGE_JSON,
  PLUGINS as OPENCLAW_PLUGINS,
  updateOpenclaw,
} from "@digital-me/runtime-openclaw";
import { build as esbuildBuild } from "esbuild";
import { runDoctor, formatReport, type RuntimeId } from "../doctor.js";
import { resolveOpenclawExtensionsDir } from "../openclaw-paths.js";
import { ensureOpenclawMemoryPaths } from "../openclaw-memory.js";
import {
  DASHBOARD_SERVICE_LABEL,
  buildDashboardServiceUnit,
  dashboardServiceUnitPath,
  isTransientBootstrapError,
  resolveDashboardServiceConfig,
} from "../dashboard-service.js";
import {
  analyzeDeployPreflight,
  parseAheadBehind,
  parseRecallAckMode,
  planDeployRuntimes,
} from "../deploy.js";
import {
  buildDefaultAliases,
  buildTranscriptSources,
  detectInstalledRuntimes,
  planWikiInit,
  type DetectedRuntime,
} from "../setup.js";
import { formatReport as formatMigrateReport, migrateBrainDb } from "../migrate.js";
import {
  AGENTS_MIGRATIONS,
  GOALS_MIGRATIONS,
  LEARNINGS_MIGRATIONS,
  SCHEDULES_MIGRATIONS,
  TASKS_MIGRATIONS,
  TRACES_MIGRATIONS,
  WORKFLOWS_MIGRATIONS,
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
  type Migration,
} from "@digital-me/brain-orchestrator";
import { createRequire as nodeCreateRequire } from "node:module";

const _nodeRequire = nodeCreateRequire(import.meta.url);

/**
 * `node:sqlite` ships in Node >= 22.5. Only `migrate` needs it, so require
 * it lazily — a top-level require would crash EVERY command (even --help)
 * on older Nodes with an opaque ERR_UNKNOWN_BUILTIN_MODULE.
 */
function requireSqlite(): typeof import("node:sqlite") {
  return _nodeRequire("node:sqlite") as typeof import("node:sqlite");
}

const VALID_RUNTIMES: readonly RuntimeId[] = [
  "claude-code",
  "codex",
  "hermes",
  "openclaw",
  "dream-cycle",
  "dashboard",
];

// Canonical venv location for the dream-cycle Python package. Picked to
// match the doctor's not-importable hint (P2.10) — keep these in sync.
const DREAM_CYCLE_VENV_DIRNAME = "dream-cycle";

/** Parse and validate `--tag-maturity-hours <N>`. Exits the process with
 * status 2 on a non-numeric or negative value so typos like `--tag-maturity-hours=2h`
 * surface immediately instead of silently degrading to `origin/main`
 * (Number("2h") → NaN → every tag is skipped). */
function parseTagMaturityHours(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(
      `update: --tag-maturity-hours must be a non-negative number, got: ${JSON.stringify(raw)}`,
    );
    process.exit(2);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): {
  cmd: string;
  runtimes: RuntimeId[];
  wikiRoot?: string;
  extensionsDir?: string;
  from?: string;
  to?: string;
  yes: boolean;
  dryRun: boolean;
  skipRestart: boolean;
  minimal: boolean;
  skipOpenclawCheck: boolean;
  noService: boolean;
  help: boolean;
  repoDir?: string;
  tagMaturityHours?: number;
  pnpmSpec?: string;
} {
  const cmd = argv[0] ?? "help";
  const runtimes: RuntimeId[] = [];
  let wikiRoot: string | undefined;
  let extensionsDir: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let yes = false;
  let dryRun = false;
  let skipRestart = false;
  let minimal = false;
  let skipOpenclawCheck = false;
  let noService = false;
  let help = false;
  let repoDir: string | undefined;
  let tagMaturityHours: number | undefined;
  let pnpmSpec: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    // A --help/-h flag after a subcommand (e.g. `deploy --help`) must print
    // usage, NOT run the subcommand. Catch it here so main() can short-circuit
    // before dispatch — otherwise it falls through as an unknown flag and the
    // subcommand executes (a real deploy/install).
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--skip-restart") {
      skipRestart = true;
      continue;
    }
    if (arg === "--minimal") {
      minimal = true;
      continue;
    }
    if (arg === "--skip-openclaw-check") {
      skipOpenclawCheck = true;
      continue;
    }
    if (arg === "--no-service") {
      noService = true;
      continue;
    }
    if (arg.startsWith("--repo-dir=")) {
      repoDir = arg.slice("--repo-dir=".length);
      continue;
    }
    if (arg === "--repo-dir" && argv[i + 1]) {
      repoDir = argv[i + 1] as string;
      i++;
      continue;
    }
    if (arg.startsWith("--tag-maturity-hours=")) {
      tagMaturityHours = parseTagMaturityHours(
        arg.slice("--tag-maturity-hours=".length),
      );
      continue;
    }
    if (arg === "--tag-maturity-hours" && argv[i + 1]) {
      tagMaturityHours = parseTagMaturityHours(argv[i + 1] as string);
      i++;
      continue;
    }
    if (arg.startsWith("--pnpm-spec=")) {
      pnpmSpec = arg.slice("--pnpm-spec=".length);
      continue;
    }
    if (arg === "--pnpm-spec" && argv[i + 1]) {
      pnpmSpec = argv[i + 1] as string;
      i++;
      continue;
    }
    if (arg.startsWith("--wiki-root=")) {
      wikiRoot = arg.slice("--wiki-root=".length);
      continue;
    }
    if (arg === "--wiki-root" && argv[i + 1]) {
      wikiRoot = argv[i + 1] as string;
      i++;
      continue;
    }
    if (arg.startsWith("--extensions-dir=")) {
      extensionsDir = arg.slice("--extensions-dir=".length);
      continue;
    }
    if (arg === "--extensions-dir" && argv[i + 1]) {
      extensionsDir = argv[i + 1] as string;
      i++;
      continue;
    }
    if (arg.startsWith("--from=")) {
      from = arg.slice("--from=".length);
      continue;
    }
    if (arg === "--from" && argv[i + 1]) {
      from = argv[i + 1] as string;
      i++;
      continue;
    }
    if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length);
      continue;
    }
    if (arg === "--to" && argv[i + 1]) {
      to = argv[i + 1] as string;
      i++;
      continue;
    }
    if (argv[i] === "--runtime" && argv[i + 1]) {
      const v = argv[i + 1] as string;
      if ((VALID_RUNTIMES as readonly string[]).includes(v)) {
        runtimes.push(v as RuntimeId);
      } else {
        console.error(`Unknown runtime: ${v}`);
        process.exit(2);
      }
      i++;
    }
  }
  return {
    cmd,
    runtimes,
    wikiRoot,
    extensionsDir,
    from,
    to,
    yes,
    dryRun,
    skipRestart,
    minimal,
    skipOpenclawCheck,
    noService,
    help,
    repoDir,
    tagMaturityHours,
    pnpmSpec,
  };
}

function which(cmd: string): string | undefined {
  const r = spawnSync("which", [cmd], { encoding: "utf-8" });
  if (r.status !== 0) return undefined;
  const out = r.stdout.trim();
  return out.length > 0 ? out : undefined;
}

function execCommand(
  cmd: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args as string[], { encoding: "utf-8" });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function resolveRepoRoot(): string | undefined {
  // The CLI's package.json is at <repoRoot>/packages/cli/package.json,
  // so the repo root is two dirs up. Only treat it as a "real repo" if
  // the dream-cycle pyproject.toml lives where we'd expect — otherwise
  // we're running from an npm-installed CLI (node_modules), and there's
  // no source repo to point at.
  try {
    const cliRoot = findCliPackageRoot();
    const candidate = path.resolve(cliRoot, "..", "..");
    const sentinel = path.join(
      candidate,
      "packages",
      "services",
      "dream-cycle",
      "pyproject.toml",
    );
    return existsSync(sentinel) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Put the `digital-me` command on the user's PATH via `pnpm link --global`.
 * Without this, the README/help/doctor instructions to run a bare
 * `digital-me …` fail with "command not found" — the only working invocation
 * would be the verbose `node packages/cli/dist/bin/digital-me.js …`. Runs from
 * a source checkout only (an npm-installed global is already on PATH).
 * Best-effort: warns and prints the manual fallback rather than failing setup.
 */
function linkCliGlobally(): void {
  if (which("digital-me")) return; // already on PATH (linked or globally installed)
  const repoRoot = resolveRepoRoot();
  if (!repoRoot) return; // not a source checkout — nothing to link
  const cliDir = path.join(repoRoot, "packages", "cli");
  const manualHint =
    `Run it yourself from ${cliDir}:  pnpm link --global  ` +
    `(or invoke the CLI as: node ${path.join(cliDir, "dist", "bin", "digital-me.js")} <cmd>)`;
  const pnpmBin = which("pnpm");
  if (!pnpmBin) {
    console.log(`[SKIP] linking \`digital-me\` onto PATH — pnpm not found. ${manualHint}`);
    return;
  }
  console.log("setup: linking `digital-me` onto your PATH (pnpm link --global) ...");
  const r = spawnSync(pnpmBin, ["link", "--global"], { cwd: cliDir, stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`[WARN] \`pnpm link --global\` exited ${r.status ?? "?"}. ${manualHint}`);
  } else {
    console.log("[OK] `digital-me` is now on your PATH.");
  }
}

function doctor(runtimes: RuntimeId[]): number {
  const report = runDoctor(
    {
      fileExists: (p) => existsSync(p),
      env: process.env,
      which,
      execCommand,
      brainMcpProxyBinPath: BRAIN_MCP_PROXY_BIN,
      repoRoot: resolveRepoRoot(),
    },
    runtimes.length > 0 ? runtimes : VALID_RUNTIMES,
  );
  console.log(formatReport(report));
  return report.summary.failed > 0 ? 1 : 0;
}

// Subcommand routing for `digital-me dream-cycle <subcommand> ...`. Each
// subcommand maps to a Python module that owns its own argparse. Add new
// rows when adding new helpers (e.g. `dispatch`, `status`); the default
// path (no subcommand) still goes to dream_cycle.run for backwards
// compatibility.
const DREAM_CYCLE_SUBCOMMANDS: Readonly<Record<string, string>> = {
  "import-workflow": "dream_cycle.workflow_import",
};

function dreamCycle(args: readonly string[]): number {
  // Prefer the venv `installDreamCycle` created — system python3 won't have
  // the dream_cycle module unless the user manually added the venv to PATH.
  // Mirrors the doctor's resolution (doctor.ts runDreamCycleChecks).
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const venvPython = path.join(
    home,
    ".venvs",
    DREAM_CYCLE_VENV_DIRNAME,
    "bin",
    "python3",
  );
  const python = existsSync(venvPython)
    ? venvPython
    : (which("python3") ?? "python3");
  const sub = args[0];
  let pythonModule = "dream_cycle.run";
  let forwardedArgs: readonly string[] = args;
  if (sub && Object.prototype.hasOwnProperty.call(DREAM_CYCLE_SUBCOMMANDS, sub)) {
    pythonModule = DREAM_CYCLE_SUBCOMMANDS[sub]!;
    forwardedArgs = args.slice(1);
  } else if (args.includes("--via-agents")) {
    // --via-agents is a flag, not a subcommand: route to the agent-driven
    // entry point and strip the flag before forwarding.
    pythonModule = "dream_cycle.via_agents";
    forwardedArgs = args.filter((a) => a !== "--via-agents");
  }
  const r = spawnSync(python, ["-m", pythonModule, ...forwardedArgs], {
    stdio: "inherit",
  });
  if (r.error) {
    console.error(`dream-cycle: failed to spawn ${python}: ${r.error.message}`);
    return 127;
  }
  return r.status ?? 1;
}

/**
 * Parse a user-owned JSON config (settings.json, hooks.json, …) with an
 * actionable error instead of a raw JSON.parse stack — these files are
 * hand-edited and a trailing comma must not kill an install mid-flight
 * with no hint about which file is broken.
 */
function readUserJson(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${filePath} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `Fix or remove the file, then re-run.`,
    );
  }
}

function copyFile(src: string, dst: string): void {
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, readFileSync(src, "utf-8"), "utf-8");
}

function chmodExec(p: string): void {
  // Best-effort chmod +x for shell hooks. Ignore on Windows.
  try {
    const stat = statSync(p);
    const mode = stat.mode | 0o111;
    if (mode !== stat.mode) {
      chmodSync(p, mode);
    }
  } catch {
    // Best-effort.
  }
}

function installClaudeCode(home: string): void {
  const targetHooksDir = path.join(home, ".claude", "hooks");
  for (const name of HOOK_NAMES) {
    const src = path.join(CLAUDE_HOOKS_DIR, name);
    const dst = path.join(targetHooksDir, name);
    copyFile(src, dst);
    chmodExec(dst);
  }
  const targetSkillDir = path.join(home, ".claude", "skills", "digital-me");
  copyFile(
    path.join(CLAUDE_SKILLS_DIR, "digital-me", "SKILL.md"),
    path.join(targetSkillDir, "SKILL.md"),
  );
  // Merge hooks into ~/.claude/settings.json
  const settingsPath = path.join(home, ".claude", "settings.json");
  const existing = existsSync(settingsPath) ? readUserJson(settingsPath) : {};
  const merged = mergeHooksIntoSettings(existing);
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  // Reference the manifest so this gets imported (tree-shake protection):
  void buildClaudeHooksManifest;
  console.log("[OK] installed claude-code: hooks + skill + settings.json merged");
  // Register the openclaw-brain MCP server in Claude Code's CLI registry
  installClaudeCodeMcp();
}

function installCodex(home: string): void {
  const codexDir = path.join(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  // CODEX.md
  const target = path.join(codexDir, "CODEX.md");
  const newManaged = readFileSync(CODEX_MD_TEMPLATE, "utf-8");
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
  writeFileSync(target, mergeCodexMd(existing, newManaged), "utf-8");
  // config.toml — build the openclaw-brain MCP entry with absolute paths
  // resolved at install time. No PATH dependency, no global npm install.
  // OPENCLAW_HOME is canonically the openclaw state dir (~/.openclaw),
  // NOT the openclaw source checkout (~/openclaw). The proxy reads
  // openclaw.json from this path to discover the gateway port + auth token.
  const openclawHome =
    process.env.OPENCLAW_HOME ?? path.join(home, ".openclaw");
  const tomlFragment = buildCodexMcpConfig({
    nodeBin: process.execPath,
    proxyBinPath: BRAIN_MCP_PROXY_BIN,
    openclawHome,
    agentId: "codex",
  });
  const tomlTarget = path.join(codexDir, "config.toml");
  const tomlExisting = existsSync(tomlTarget)
    ? readFileSync(tomlTarget, "utf-8")
    : "";
  writeFileSync(
    tomlTarget,
    mergeMcpServer(tomlExisting, tomlFragment),
    "utf-8",
  );
  // Lifecycle hooks: copy the scripts into ~/.codex/hooks/ and merge the
  // wiring stanzas into ~/.codex/hooks.json. Codex hooks are I/O-compatible
  // with Claude Code's, so this mirrors installClaudeCode's hook step.
  const targetHooksDir = path.join(codexDir, "hooks");
  for (const name of CODEX_HOOK_NAMES) {
    const src = path.join(CODEX_HOOKS_DIR, name);
    const dst = path.join(targetHooksDir, name);
    copyFile(src, dst);
    chmodExec(dst);
  }
  // Codex does not document `$HOME` expansion in hook command paths, so we
  // wire absolute paths resolved at install time.
  const hooksJsonPath = path.join(codexDir, "hooks.json");
  const hooksExisting = existsSync(hooksJsonPath)
    ? readUserJson(hooksJsonPath)
    : {};
  const mergedHooks = mergeCodexHooksJson(hooksExisting, targetHooksDir);
  writeFileSync(hooksJsonPath, JSON.stringify(mergedHooks, null, 2) + "\n", "utf-8");
  console.log(
    `[OK] installed codex: CODEX.md + config.toml merged ` +
      `(mcp openclaw-brain → ${BRAIN_MCP_PROXY_BIN}); ` +
      `${CODEX_HOOK_NAMES.length} hooks + hooks.json wired`,
  );
}

/**
 * Register the openclaw-brain MCP server with Claude Code's CLI registry
 * via `claude mcp add`. Idempotent — if a server with the same name
 * exists, remove it first.
 */
function installClaudeCodeMcp(): void {
  if (!which("claude")) {
    console.log(
      "[SKIP] claude-code MCP: 'claude' CLI not on PATH. Install Claude Code, then re-run.",
    );
    return;
  }
  // Remove any existing openclaw-brain registration from BOTH scopes
  // (local + user). The legacy registration might be in either scope; we
  // need both gone before we re-add at user scope.
  for (const scope of ["local", "user", "project"] as const) {
    spawnSync("claude", ["mcp", "remove", "openclaw-brain", "-s", scope], {
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  // OPENCLAW_HOME is canonically the openclaw state dir (~/.openclaw),
  // NOT the openclaw source checkout (~/openclaw). The proxy reads
  // openclaw.json from this path to discover the gateway port + auth token.
  const openclawHome =
    process.env.OPENCLAW_HOME ?? path.join(home, ".openclaw");
  const env = {
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_AGENT_ID: "claude-code",
  };
  // Install at user scope so the server is available across all
  // projects, not just the current cwd's project-local scope.
  const args: string[] = ["mcp", "add", "openclaw-brain", "-s", "user"];
  for (const [k, v] of Object.entries(env)) {
    args.push("-e", `${k}=${v}`);
  }
  args.push("--", process.execPath, BRAIN_MCP_PROXY_BIN);
  const r = spawnSync("claude", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    console.error(
      `[WARN] claude-code MCP: 'claude mcp add' failed (exit ${r.status}). ` +
        `stderr: ${(r.stderr ?? "").trim()}`,
    );
    return;
  }
  console.log(
    `[OK] claude-code MCP: registered openclaw-brain → ${BRAIN_MCP_PROXY_BIN}`,
  );
}

/**
 * Install the dream-cycle Python sibling package into a dedicated venv.
 *
 * Two steps:
 *   1. `python3 -m venv ~/.venvs/dream-cycle/` — fresh venv, isolated
 *      from system Python and other tools.
 *   2. `<venv>/bin/pip install -e <repoRoot>/packages/services/dream-cycle`
 *      — editable install so subsequent `git pull` picks up changes
 *      without re-installing.
 *
 * On success the venv exposes `digital-me-dream-cycle` + `python3 -m
 * dream_cycle.<step>`. Production cron jobs / brain workflow exec
 * dispatches should point at `~/.venvs/dream-cycle/bin/python3` so they
 * use the same installed code path as `digital-me dream-cycle`.
 *
 * Returns 0 on success, non-zero on failure. Idempotent — if the venv
 * already exists, pip install -e overwrites the editable link.
 */
function installDreamCycle(home: string, wikiRoot?: string): number {
  const venvDir = path.join(home, ".venvs", DREAM_CYCLE_VENV_DIRNAME);
  const systemPython3 = which("python3");
  if (!systemPython3) {
    console.error(
      "install dream-cycle: python3 not on PATH. Install Python 3.11+ first.",
    );
    return 2;
  }
  const repoRoot = resolveRepoRoot();
  if (!repoRoot) {
    console.error(
      "install dream-cycle: could not locate the digital-me-os repo root " +
        "from the CLI binary. Are you running from a source checkout? " +
        "(npm-installed CLIs don't carry the source tree — clone the repo " +
        "and re-run this command from the checkout.)",
    );
    return 2;
  }
  const packagePath = path.join(
    repoRoot,
    "packages",
    "services",
    "dream-cycle",
  );
  if (!existsSync(path.join(packagePath, "pyproject.toml"))) {
    console.error(
      `install dream-cycle: package not found at ${packagePath}. ` +
        `Expected pyproject.toml.`,
    );
    return 2;
  }

  // Create the venv (idempotent — `python -m venv` is a no-op when the
  // dir already has a working venv, but it'll refresh the shims).
  console.log(`install dream-cycle: creating venv at ${venvDir} ...`);
  const venvResult = spawnSync(
    systemPython3,
    ["-m", "venv", venvDir],
    { stdio: "inherit" },
  );
  if (venvResult.error || venvResult.status !== 0) {
    console.error(
      `install dream-cycle: venv creation failed (exit ${venvResult.status ?? "?"}).`,
    );
    return venvResult.status ?? 1;
  }

  // pip install -e the package. The [dev] extras include pytest so
  // users can run the bundled test suite if they want.
  const venvPip = path.join(venvDir, "bin", "pip");
  console.log(`install dream-cycle: pip install -e ${packagePath}[dev] ...`);
  const pipResult = spawnSync(
    venvPip,
    ["install", "-e", `${packagePath}[dev]`],
    { stdio: "inherit" },
  );
  if (pipResult.error || pipResult.status !== 0) {
    console.error(
      `install dream-cycle: pip install failed (exit ${pipResult.status ?? "?"}).`,
    );
    return pipResult.status ?? 1;
  }

  // Smoke-check by invoking the console script's --help. Catches
  // entry-point misregistration immediately.
  const consoleScript = path.join(venvDir, "bin", "digital-me-dream-cycle");
  const smokeResult = spawnSync(consoleScript, ["--help"], {
    encoding: "utf-8",
  });
  if (smokeResult.status !== 0) {
    console.error(
      `install dream-cycle: console script smoke-test failed ` +
        `(exit ${smokeResult.status ?? "?"}). Install may be incomplete.`,
    );
    return smokeResult.status ?? 1;
  }

  // Import bundled workflows into the openclaw brain. This makes
  // `digital-me install --runtime dream-cycle` a one-stop setup: venv
  // ready + workflows imported with the correct python_path + wiki_root
  // baked in. Skip if the brain is unreachable — the workflow import
  // can be re-run later via `python -m dream_cycle.install_workflows`.
  const venvPython = path.join(venvDir, "bin", "python3");
  const installWorkflowsArgs = ["-m", "dream_cycle.install_workflows"];
  if (wikiRoot) {
    installWorkflowsArgs.push("--wiki-root", wikiRoot);
  }
  console.log(
    `install dream-cycle: importing bundled workflows into the brain ...`,
  );
  const wfResult = spawnSync(venvPython, installWorkflowsArgs, {
    stdio: "inherit",
  });
  if (wfResult.status !== 0) {
    console.error(
      `install dream-cycle: workflow import returned exit ${wfResult.status ?? "?"}. ` +
        `The venv is ready, but workflows aren't imported. ` +
        `Common causes: openclaw gateway not running, or auth token missing in ~/.openclaw/openclaw.json. ` +
        `Re-run later with: ${venvPython} -m dream_cycle.install_workflows`,
    );
    // Non-zero exit but don't return — we still want to print the
    // success summary so the user knows the venv part worked.
  }

  console.log(
    `\n[OK] installed dream-cycle:\n` +
      `       python:    ${venvPython}\n` +
      `       script:    ${consoleScript}\n` +
      `       wiki root: ${wikiRoot ?? "(default; pass --wiki-root to override)"}\n` +
      `\n` +
      `Next steps:\n` +
      `  • Add to PATH for interactive use:\n` +
      `      export PATH="${path.join(venvDir, "bin")}:$PATH"\n` +
      `  • Nightly distillation is scheduled for you: workflow 'dream-cycle-nightly'\n` +
      `    runs at 03:00 daily (schedule id 'dream-cycle-nightly'). Adjust or\n` +
      `    disable it via the dashboard or tasks.schedule_* — no manual cron needed.\n` +
      `  • Verify end-to-end with: digital-me doctor`,
  );
  return 0;
}

/**
 * Install the Dashboard service — Vite+React frontend + Express server.
 *
 * Lays the package out at $HOME/.local/share/digital-me/dashboard/, runs
 * `npm install`, builds, then applies the DB migration and registers the
 * `dashboard-intake` workflow with the openclaw brain.
 *
 * The DB migration + workflow registration are intentionally light stubs
 * for now — §B of the NUX scope-down fills them in. This installer just
 * sets up the runnable surface so subsequent steps have a target.
 */
function installDashboard(home: string, wikiRoot?: string): number {
  const installDir = path.join(home, ".local", "share", "digital-me", "dashboard");
  const repoRoot = resolveRepoRoot();
  if (!repoRoot) {
    console.error(
      "install dashboard: could not locate the digital-me-os repo root " +
        "from the CLI binary. Are you running from a source checkout? " +
        "(npm-installed CLIs don't carry the source tree — clone the repo " +
        "and re-run this command from the checkout.)",
    );
    return 2;
  }
  const packagePath = path.join(repoRoot, "packages", "services", "dashboard");
  if (!existsSync(path.join(packagePath, "package.json"))) {
    console.error(
      `install dashboard: package not found at ${packagePath}. ` +
        `Expected package.json.`,
    );
    return 2;
  }
  const systemNpm = which("npm");
  if (!systemNpm) {
    console.error("install dashboard: npm not on PATH. Install Node.js 22+ first.");
    return 2;
  }

  // The runtime install dir is a thin symlink/marker — the actual code
  // stays in the workspace at packages/services/dashboard. This lets the
  // user `git pull` to update without re-running install.
  mkdirSync(path.dirname(installDir), { recursive: true });
  if (!existsSync(installDir)) {
    console.log(`install dashboard: linking ${installDir} -> ${packagePath}`);
    const linkResult = spawnSync("ln", ["-s", packagePath, installDir], { stdio: "inherit" });
    if (linkResult.status !== 0) {
      console.error(`install dashboard: symlink failed (exit ${linkResult.status ?? "?"}).`);
      return linkResult.status ?? 1;
    }
  }

  // Install deps + build via pnpm at the workspace root. npm can't
  // resolve our `workspace:*` cross-package references, so we drive
  // pnpm here regardless of which package manager the user invoked.
  // Falls back to npm at the package path only if pnpm isn't available
  // (degraded mode — will fail later if the package uses workspace:* deps).
  const pnpmBin = which("pnpm");
  if (pnpmBin) {
    console.log(`install dashboard: pnpm install at ${repoRoot} ...`);
    const pnpmInstall = spawnSync(
      pnpmBin,
      ["install", "--filter", "@digital-me/dashboard..."],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (pnpmInstall.status !== 0) {
      console.error(`install dashboard: pnpm install failed (exit ${pnpmInstall.status ?? "?"}).`);
      return pnpmInstall.status ?? 1;
    }
    console.log(`install dashboard: pnpm --filter @digital-me/dashboard build ...`);
    const pnpmBuild = spawnSync(
      pnpmBin,
      ["--filter", "@digital-me/dashboard", "build"],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (pnpmBuild.status !== 0) {
      console.error(
        `install dashboard: build failed (exit ${pnpmBuild.status ?? "?"}). ` +
          `The dev server may still work via 'pnpm dashboard' — investigate the type errors.`,
      );
      // Non-fatal: dev server can still boot even if production build fails.
    }
  } else {
    console.log(`install dashboard: npm install at ${packagePath} (pnpm not found — degraded mode) ...`);
    const npmInstall = spawnSync(systemNpm, ["install"], { cwd: packagePath, stdio: "inherit" });
    if (npmInstall.status !== 0) {
      console.error(
        `install dashboard: npm install failed (exit ${npmInstall.status ?? "?"}). ` +
          `This workspace uses pnpm 'workspace:*' deps that npm doesn't resolve. ` +
          `Install pnpm (https://pnpm.io/installation) and re-run this command.`,
      );
      return npmInstall.status ?? 1;
    }
    const npmBuild = spawnSync(systemNpm, ["run", "build"], { cwd: packagePath, stdio: "inherit" });
    if (npmBuild.status !== 0) {
      console.error(`install dashboard: build failed (exit ${npmBuild.status ?? "?"}).`);
    }
  }

  // Apply the §B schema migration. Canonical dashboard DB path collapses
  // under ~/digital-me/ so everything user-owned lives in one root —
  // wiki/, tastes/, and machine-managed .data/. Hidden via leading dot
  // since the DB is regenerable from primary sources (one cron tick) and
  // shouldn't show up in the user's `ls ~/digital-me/`.
  //
  // Backward compat: if the legacy ~/.local/share/digital-me/dashboard/data/
  // system_monitor.db exists and the new canonical path doesn't, move it
  // so existing installs don't lose data on upgrade.
  const dataDir = path.join(home, "digital-me", ".data");
  const dbPath = path.join(dataDir, "dashboard.db");
  mkdirSync(dataDir, { recursive: true });
  const legacyDbPath = path.join(
    home, ".local", "share", "digital-me", "dashboard", "data", "system_monitor.db",
  );
  if (existsSync(legacyDbPath) && !existsSync(dbPath)) {
    console.log(
      `install dashboard: migrating legacy DB ${legacyDbPath} -> ${dbPath} (original kept as rollback backup)`,
    );
    // Copy (don't move) so the legacy DB stays put as a rollback backup. Copy
    // WAL sidecars before the main DB so the new path is never in a state where
    // the DB exists without its companions (SQLite replays -wal on open).
    for (const suffix of ["-wal", "-shm"] as const) {
      const legacySidecar = legacyDbPath + suffix;
      if (existsSync(legacySidecar)) {
        spawnSync("cp", [legacySidecar, dbPath + suffix], { stdio: "inherit" });
      }
    }
    const cpResult = spawnSync("cp", [legacyDbPath, dbPath], { stdio: "inherit" });
    if (cpResult.status !== 0) {
      console.error(
        `install dashboard: legacy DB migration failed (exit ${cpResult.status ?? "?"}). ` +
          `Continuing with fresh DB — old data is still at ${legacyDbPath} if you need it.`,
      );
    }
  }
  const migrateScript = path.join(packagePath, "src", "server", "migrate.ts");
  console.log(`install dashboard: running schema migration -> ${dbPath} ...`);
  const tsxBin = path.join(packagePath, "node_modules", ".bin", "tsx");
  const migrateBin = existsSync(tsxBin) ? tsxBin : "tsx";
  const migrateResult = spawnSync(migrateBin, [migrateScript, dbPath], {
    cwd: packagePath,
    stdio: "inherit",
  });
  if (migrateResult.status !== 0) {
    console.error(
      `install dashboard: schema migration failed (exit ${migrateResult.status ?? "?"}). ` +
        `Dashboard endpoints will 500 until this is resolved.`,
    );
    // Non-fatal: leave the rest of install to finish so user can debug.
  }

  // Install the dashboard_intake Python package into dream-cycle's venv
  // (re-using the existing Python install). The intake modules don't justify
  // their own venv since they only need pyyaml + sqlite3.
  const dcVenvPip = path.join(home, ".venvs", "dream-cycle", "bin", "pip");
  const intakePkgPath = path.join(packagePath, "src", "intake");
  if (existsSync(dcVenvPip)) {
    console.log(`install dashboard: pip install -e ${intakePkgPath} ...`);
    const pipResult = spawnSync(dcVenvPip, ["install", "-e", intakePkgPath], { stdio: "inherit" });
    if (pipResult.status !== 0) {
      console.error(
        `install dashboard: pip install of dashboard_intake failed (exit ${pipResult.status ?? "?"}). ` +
          `Run dream-cycle first: digital-me install --runtime dream-cycle`,
      );
    }
  } else {
    console.log(
      `install dashboard: dream-cycle venv not found at ${dcVenvPip}. ` +
        `Skipping dashboard_intake pip install — re-run after dream-cycle install lands.`,
    );
  }

  // Register the dashboard-intake workflow + its 1-minute schedule with
  // the openclaw brain using dream-cycle's existing install_workflows
  // script. --workflows-dir overrides the default dream_cycle/workflows/
  // scan target; --dashboard-db supplies the workflow's required
  // dashboard_db variable; the script auto-detects sibling
  // <workflow>.schedule.json files and registers the schedule.
  const dcVenvPython = path.join(home, ".venvs", "dream-cycle", "bin", "python3");
  const dashboardWorkflowsDir = path.join(packagePath, "workflows");
  if (existsSync(dcVenvPython)) {
    const wfArgs = [
      "-m", "dream_cycle.install_workflows",
      "--workflows-dir", dashboardWorkflowsDir,
      "--dashboard-db", dbPath,
    ];
    if (wikiRoot) wfArgs.push("--wiki-root", wikiRoot);
    console.log(`install dashboard: importing dashboard-intake workflow + schedule into the brain ...`);
    const wfResult = spawnSync(dcVenvPython, wfArgs, { stdio: "inherit" });
    if (wfResult.status !== 0) {
      console.error(
        `install dashboard: workflow import returned exit ${wfResult.status ?? "?"}. ` +
          `DB + intake modules are ready; workflow can be re-imported with: ` +
          `${dcVenvPython} -m dream_cycle.install_workflows --workflows-dir ${dashboardWorkflowsDir} --dashboard-db ${dbPath}`,
      );
    }
  } else {
    console.log(
      `install dashboard: dream-cycle venv missing — skipping workflow import. ` +
        `Run dream-cycle install first, then re-run this command.`,
    );
  }

  // Write the discovery file so the dashboard server (and any sibling
  // process) can pick up the install layout without env-var spelunking.
  // Co-located with the DB it describes under ~/digital-me/.data/ — the
  // single root for everything digital-me-owned. (Mirrors ~/.openclaw/
  // openclaw.json's role for the openclaw gateway, but kept inside the
  // digital-me tree because dashboard.json describes a digital-me-os
  // service, not openclaw infrastructure.)
  const discoveryPath = path.join(dataDir, "dashboard.json");
  const discovery = {
    schemaVersion: 1,
    package: packagePath,
    installDir,
    db: dbPath,
    venv: {
      python: dcVenvPython,
      intake: intakePkgPath,
    },
    server: {
      // Defaults match server.ts + vite.config.ts (3458 / 3457). Override
      // at boot via $PORT / $VITE_PORT; the dashboard server reads these
      // env vars first, then falls back to the values written here.
      port: 3458,
      vitePort: 3457,
    },
    workflows: {
      bundledDir: dashboardWorkflowsDir,
    },
  };
  writeFileSync(discoveryPath, JSON.stringify(discovery, null, 2) + "\n", "utf-8");
  console.log(`install dashboard: wrote discovery file -> ${discoveryPath}`);

  console.log(
    `\n[OK] installed dashboard:\n` +
      `       package:   ${packagePath}\n` +
      `       install:   ${installDir}\n` +
      `       db:        ${dbPath}\n` +
      `       discovery: ${discoveryPath}\n` +
      `       wiki root: ${wikiRoot ?? "(default; pass --wiki-root to override)"}\n` +
      `\n` +
      `Next steps:\n` +
      `  • Boot for development from the workspace root:\n` +
      `      pnpm dashboard            # Vite :3457 + Express :3458 (no env vars needed)\n` +
      `  • Open: http://localhost:3457\n` +
      `  • The 1-minute dashboard-intake schedule is already registered with the brain\n` +
      `  • Verify end-to-end with: digital-me doctor`,
  );
  return 0;
}

function installHermes(home: string): void {
  const target = path.join(home, ".hermes", "SOUL.md");
  mkdirSync(path.dirname(target), { recursive: true });
  const newManaged = readFileSync(SOUL_MD_TEMPLATE, "utf-8");
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
  writeFileSync(target, mergeSoulMd(existing, newManaged), "utf-8");
  console.log("[OK] installed hermes: SOUL.md merged");
  // Register the openclaw-brain MCP server in Hermes's CLI registry
  installHermesMcp(home);
  // Copy the digital-me-recall-hermes plugin into $HERMES_HOME/plugins/
  // and tell the user how to enable it (Hermes plugins are opt-in).
  installHermesRecallPlugin(home);
}

/**
 * Copy the digital-me-recall-hermes Python plugin into the user's
 * Hermes home AND auto-enable it via `hermes plugins enable`. By
 * running `digital-me install --runtime hermes` the user has already
 * consented to the recall plugin, so we skip the manual enable step.
 *
 * Hermes plugins are opt-in by Hermes-design (config flag in
 * config.yaml's `plugins.enabled` list). The `hermes plugins enable`
 * subcommand flips that flag idempotently — calling it twice is safe.
 *
 * If the `hermes` CLI is not on PATH, we still copy the files (so a
 * later `hermes plugins enable` works) and surface the manual command.
 */
function installHermesRecallPlugin(home: string): void {
  const hermesHome = process.env.HERMES_HOME ?? path.join(home, ".hermes");
  const targetDir = path.join(
    hermesHome,
    "plugins",
    HERMES_RECALL_PLUGIN_NAME,
  );
  try {
    mkdirSync(targetDir, { recursive: true });
    for (const file of HERMES_RECALL_PLUGIN_FILES) {
      const src = path.join(HERMES_RECALL_PLUGIN_SRC_DIR, file);
      const dst = path.join(targetDir, file);
      writeFileSync(dst, readFileSync(src));
    }
    console.log(
      `[OK] hermes plugin: copied ${HERMES_RECALL_PLUGIN_NAME} → ${targetDir}`,
    );
  } catch (err) {
    console.error(
      `[WARN] hermes plugin install failed (${HERMES_RECALL_PLUGIN_NAME}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Auto-enable via `hermes plugins enable <name>`. Idempotent — safe to
  // re-run on subsequent installs.
  if (!which("hermes")) {
    console.log(
      `[SKIP] hermes plugin auto-enable: 'hermes' CLI not on PATH.\n` +
        `       After installing hermes-agent, run:\n` +
        `       ${HERMES_RECALL_PLUGIN_ENABLE_COMMAND}`,
    );
    return;
  }
  const r = spawnSync(
    "hermes",
    ["plugins", "enable", HERMES_RECALL_PLUGIN_NAME],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (r.status !== 0) {
    console.error(
      `[WARN] hermes plugin auto-enable failed (exit ${r.status}). ` +
        `Run manually: ${HERMES_RECALL_PLUGIN_ENABLE_COMMAND}\n` +
        `       stderr: ${(r.stderr ?? "").trim()}`,
    );
    return;
  }
  console.log(
    `[OK] hermes plugin: auto-enabled ${HERMES_RECALL_PLUGIN_NAME} ` +
      `(no further action needed)`,
  );
}

/**
 * Register the openclaw-brain MCP server with Hermes's CLI registry
 * via `hermes mcp add`. Idempotent — remove any existing entry first.
 */
function installHermesMcp(home: string): void {
  if (!which("hermes")) {
    console.log(
      "[SKIP] hermes MCP: 'hermes' CLI not on PATH. Install hermes-agent, then re-run.",
    );
    return;
  }
  // Remove any existing openclaw-brain registration so re-installs are
  // idempotent and any legacy path gets replaced.
  spawnSync("hermes", ["mcp", "remove", "openclaw-brain"], {
    encoding: "utf-8",
    stdio: ["ignore", "ignore", "ignore"],
  });
  const openclawHome =
    process.env.OPENCLAW_HOME ?? path.join(home, ".openclaw");
  const args = [
    "mcp",
    "add",
    "openclaw-brain",
    "--command",
    process.execPath,
    "--args",
    BRAIN_MCP_PROXY_BIN,
    "--env",
    `OPENCLAW_HOME=${openclawHome}`,
    `OPENCLAW_AGENT_ID=hermes`,
  ];
  // hermes mcp add probes the server, prints its tool list, then prompts
  // "Enable all N tools? [Y/n/select]:". From a non-TTY parent the prompt
  // gets cancelled. Pipe "y\n" repeatedly to auto-confirm.
  const r = spawnSync("hermes", args, {
    encoding: "utf-8",
    input: "y\ny\ny\n",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    console.error(
      `[WARN] hermes MCP: 'hermes mcp add' failed (exit ${r.status}). ` +
        `stderr: ${(r.stderr ?? "").trim()}`,
    );
    return;
  }
  console.log(
    `[OK] hermes MCP: registered openclaw-brain → ${BRAIN_MCP_PROXY_BIN}`,
  );
}

/**
 * Find this CLI package's own root by walking up from `import.meta.url`
 * until we hit a package.json whose name is "@digital-me/cli".
 */
function findCliPackageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  while (dir !== path.dirname(dir)) {
    const p = path.join(dir, "package.json");
    if (existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, "utf-8")) as {
          name?: string;
        };
        if (parsed.name === "@digital-me/cli") return dir;
      } catch {
        // not a valid package.json — keep walking
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find @digital-me/cli package root from ${here}`);
}

/**
 * Resolve the on-disk root of a workspace dep by name. The CLI declares
 * the @digital-me/* packages as deps, so they're guaranteed present in
 * `<cli-pkg-root>/node_modules/`. realpath resolves the pnpm symlink (or
 * just returns the directory under npm) to give the canonical package
 * root — that's what we use as the `file:` dep target.
 *
 * We can't use `require.resolve(name + "/package.json")` because the
 * @digital-me/* packages declare an `exports` field that blocks that
 * subpath, and we can't use `require.resolve(name)` because the
 * packages have only an `import` condition (no `require`).
 */
function resolvePackageRoot(name: string, cliRoot: string): string {
  const candidate = path.join(cliRoot, "node_modules", name);
  if (!existsSync(candidate)) {
    throw new Error(
      `Could not find ${name} in ${path.join(cliRoot, "node_modules")}`,
    );
  }
  return realpathSync(candidate);
}

async function installOpenclaw(
  home: string,
  extensionsDir: string | undefined,
  wikiRoot: string | undefined,
): Promise<number> {
  const target = resolveOpenclawExtensionsDir(home, process.env, extensionsDir);
  // The state-dir extensions folder may not exist yet on a fresh machine.
  // It lives outside the openclaw checkout, so creating it is safe.
  mkdirSync(target, { recursive: true });
  const rc = await materializeOpenclawOverlay(target);
  if (rc !== 0) return rc;

  // Auto-index the wiki + tastes trees in memory_search so captured knowledge
  // AND distilled taste principles both surface in recall. Non-fatal: a config
  // hiccup must not fail the plugin install.
  const mem = ensureOpenclawMemoryPaths(home, wikiRoot);
  if (!mem.ok) {
    console.error(
      `install openclaw: could not update memory paths (${mem.error}). ` +
        `Add the wiki + tastes dirs to agents.defaults.memorySearch.extraPaths ` +
        `in ${mem.configPath} manually.`,
    );
  } else if (mem.added.length > 0) {
    console.log(
      `[OK] memory_search will index ${mem.added.length} new path(s) ` +
        `(${mem.added.join(", ")}) → ${mem.configPath}`,
    );
  } else {
    console.log(`     memory_search already indexes the wiki + tastes trees.`);
  }

  console.log(
    `     Restart openclaw (gateway daemon) for the plugins to load.\n` +
      `     Then: 'digital-me doctor' should show all checks green.`,
  );
  return 0;
}

/**
 * Bundle + write every PLUGINS entry into `extensionsDir`. Shared by the
 * `install` and `update` commands.
 *
 * We esbuild-bundle the plugin entry into a single self-contained file
 * alongside a minimal package.json. This matches openclaw's own
 * dist/extensions/*\/index.js pattern: no node_modules in the install
 * dir, no symlinks, no dependency resolution at gateway startup, no
 * plugin-safety-scan rejection. Works identically whether the
 * @digital-me/* packages live in a workspace or are installed from
 * npm — bundling resolves all of that at install time.
 *
 * Externals: openclaw/* (provided by the gateway runtime) and node:*
 * built-ins. Everything else (yaml, typebox, @digital-me/*) gets
 * inlined into the bundled output.
 */
async function materializeOpenclawOverlay(target: string): Promise<number> {
  for (const plugin of OPENCLAW_PLUGINS) {
    const pluginDir = path.join(target, plugin.pluginDirname);
    mkdirSync(pluginDir, { recursive: true });

    // Copy the manifest verbatim (not bundled — openclaw reads it as JSON)
    const manifestFile = plugin.installFiles.find(
      (f) => f.target === "openclaw.plugin.json",
    );
    if (!manifestFile) {
      console.error(
        `install openclaw: ${plugin.displayName} has no manifest in INSTALL_FILES`,
      );
      return 2;
    }
    writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      readFileSync(manifestFile.src, "utf-8"),
      "utf-8",
    );

    // Bundle index.mjs
    const entryFile = plugin.installFiles.find(
      (f) => f.target === "index.mjs",
    );
    if (!entryFile) {
      console.error(
        `install openclaw: ${plugin.displayName} has no entry in INSTALL_FILES`,
      );
      return 2;
    }
    try {
      await esbuildBuild({
        entryPoints: [entryFile.src],
        outfile: path.join(pluginDir, "index.mjs"),
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        // openclaw runtime APIs come from the gateway, never bundle:
        external: [
          "openclaw/*",
          // node: built-ins (also auto-externalized by platform=node, but
          // listing explicitly is safer across esbuild versions):
          "node:*",
        ],
        // Source map is small + helps debug live errors:
        sourcemap: "inline",
        // Silence the dev-time warnings about node built-ins:
        logLevel: "warning",
      });
    } catch (err) {
      console.error(
        `install openclaw: esbuild failed for ${plugin.displayName}: ${(err as Error).message}`,
      );
      return 1;
    }

    // Minimal package.json — no deps (everything's bundled), but we still
    // emit `openclaw.extensions` so the gateway's discovery sees it as
    // an openclaw plugin under the new extensions schema.
    const pkgJson = {
      name: `${plugin.pluginDirname}-extension`,
      version: "0.0.0-local",
      private: true,
      type: "module",
      description: `Bundled install of ${plugin.pluginDirname} (esbuild-produced single-file plugin entry). Auto-generated by \`digital-me install --runtime openclaw\`.`,
      openclaw: { extensions: ["./index.mjs"] },
    };
    writeFileSync(
      path.join(pluginDir, OPENCLAW_EXTENSION_PACKAGE_JSON),
      JSON.stringify(pkgJson, null, 2) + "\n",
      "utf-8",
    );

    // No npm install needed — the bundle is self-contained.

    console.log(`[OK] installed ${plugin.displayName}: ${pluginDir}`);
  }

  // Ship the shared cli-exec worker so `cli_exec_aliases` (e.g. claude-code-cli)
  // actually resolve. The brain's alias resolver bakes a task command pointing
  // at `<extensionsDir>/scripts/cli-exec-worker.mjs` (one level up from each
  // plugin dir); without this file the worker fails ENOENT and every cli-exec
  // task dies. The worker is a plain node-builtins script — copy it verbatim.
  const cliExecScriptsDir = path.join(target, "scripts");
  mkdirSync(cliExecScriptsDir, { recursive: true });
  copyFileSync(
    OPENCLAW_CLI_EXEC_WORKER_SCRIPT,
    path.join(cliExecScriptsDir, "cli-exec-worker.mjs"),
  );
  console.log(
    `[OK] installed cli-exec worker: ${path.join(cliExecScriptsDir, "cli-exec-worker.mjs")}`,
  );

  return 0;
}

async function install(
  runtimes: RuntimeId[],
  extensionsDir: string | undefined,
  wikiRoot: string | undefined,
  skipOpenclawCheck: boolean = false,
  noService: boolean = false,
): Promise<number> {
  if (runtimes.length === 0) {
    console.error(
      `install: specify one or more runtimes with --runtime <id> (${VALID_RUNTIMES.join(" | ")})`,
    );
    return 2;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    console.error("install: HOME / USERPROFILE not set");
    return 2;
  }
  // Prerequisite gate for everything except installing openclaw's own brain
  // plugin (`--runtime openclaw` materializes into the openclaw checkout, which
  // a user may set up before first running the gateway). Adapters/services for
  // other runtimes are useless without a working gateway.
  const needsGateway = runtimes.some((r) => r !== "openclaw");
  if (!skipOpenclawCheck && needsGateway && !isOpenclawInstalled(home)) {
    printOpenclawMissing("the requested runtimes");
    return 2;
  }
  let exit = 0;
  for (const r of runtimes) {
    if (r === "claude-code") installClaudeCode(home);
    else if (r === "codex") installCodex(home);
    else if (r === "hermes") installHermes(home);
    else if (r === "openclaw") {
      const rc = await installOpenclaw(home, extensionsDir, wikiRoot);
      if (rc !== 0) exit = rc;
    } else if (r === "dream-cycle") {
      const rc = installDreamCycle(home, wikiRoot);
      if (rc !== 0) exit = rc;
    } else if (r === "dashboard") {
      const rc = installDashboard(home, wikiRoot);
      if (rc !== 0) exit = rc;
      else if (noService) {
        console.log(
          "install dashboard: skipped always-on service (--no-service). " +
            "Enable later with 'digital-me service dashboard install'.",
        );
      } else {
        // Make the dashboard always-on (no terminal needed) by default.
        // Non-fatal: a service-setup failure must not fail the whole install.
        const sc = await setupDashboardService(home);
        if (sc !== 0) {
          console.error(
            "install dashboard: always-on service did not complete; " +
              "retry with 'digital-me service dashboard install'.",
          );
        }
      }
    }
  }
  return exit;
}

async function update(
  runtimes: RuntimeId[],
  extensionsDir: string | undefined,
  opts: {
    dryRun: boolean;
    skipRestart: boolean;
    repoDir?: string;
    tagMaturityHours?: number;
    pnpmSpec?: string;
  },
): Promise<number> {
  if (runtimes.length !== 1 || runtimes[0] !== "openclaw") {
    if (runtimes.length === 0) {
      console.error("update: --runtime openclaw is required.");
    } else if (!runtimes.includes("openclaw")) {
      console.error(
        `update: only \`--runtime openclaw\` is supported today (got: ${runtimes.join(", ")}).`,
      );
    } else {
      const others = runtimes.filter((r) => r !== "openclaw");
      console.error(
        `update: only one --runtime is supported per invocation; remove the extra runtime${others.length > 1 ? "s" : ""}: ${others.join(", ")}`,
      );
    }
    return 2;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    console.error("update: HOME / USERPROFILE not set");
    return 2;
  }
  const repoDir =
    opts.repoDir ?? process.env.OPENCLAW_REPO ?? path.join(home, "openclaw");
  // Materialize into the canonical STATE dir (highest precedence, build- and
  // checkout-immune) — NOT <repoDir>/extensions, which is shadowed by the
  // stock build's dist/extensions and never loads. See
  // resolveOpenclawExtensionsDir.
  const resolvedExtensions = resolveOpenclawExtensionsDir(
    home,
    process.env,
    extensionsDir,
  );

  const result = await updateOpenclaw({
    home,
    repoDir,
    extensionsDir: resolvedExtensions,
    dryRun: opts.dryRun,
    skipRestart: opts.skipRestart,
    tagMaturityHours: opts.tagMaturityHours,
    pnpmSpec: opts.pnpmSpec,
    // Keep esbuild in the CLI: the updater calls back into the shared bundler.
    rematerializeOverlay: ({ extensionsDir }: { extensionsDir: string }) =>
      materializeOpenclawOverlay(extensionsDir),
  });

  if (result.status === "failed" && result.blockers.length > 0) {
    console.error(`update failed:\n  - ${result.blockers.join("\n  - ")}`);
  }
  return result.exitCode;
}

function initWikiDir(wikiRoot: string, detected: readonly DetectedRuntime[]): number {
  const aliases = buildDefaultAliases(detected);
  const sources = buildTranscriptSources(detected);
  const plan = planWikiInit({ wikiRoot, aliases, sources });
  for (const d of plan.dirsToCreate) {
    mkdirSync(d, { recursive: true });
  }
  let created = 0;
  let skipped = 0;
  for (const f of plan.filesToCreate) {
    if (existsSync(f.path) && !f.overwrite) {
      skipped++;
      continue;
    }
    writeFileSync(f.path, f.contents, "utf-8");
    created++;
  }
  console.log(
    `[OK] init wiki dir at ${wikiRoot}: ${created} file(s) created, ${skipped} already present`,
  );
  return 0;
}

/**
 * openclaw is the mandatory foundation: the gateway daemon every brain MCP
 * tool (memory_search, tasks, …) rides on. Detect a real install via the
 * binary on PATH or the config/data home (~/.openclaw). Installing the wiki +
 * runtime adapters without it just produces a half-brain with nothing to
 * connect to — so setup/install hard-stop and point the user at openclaw first.
 */
function isOpenclawInstalled(home: string): boolean {
  return which("openclaw") !== undefined || existsSync(path.join(home, ".openclaw"));
}

function printOpenclawMissing(context: string): void {
  console.error(
    [
      ``,
      `[STOP] openclaw not found — it is the mandatory foundation for digital-me-os.`,
      ``,
      `Without the openclaw gateway, the brain MCP tools and every runtime adapter`,
      `${context} would install would have nothing to connect to. Install openclaw first:`,
      ``,
      `  1. Install openclaw — see https://github.com/openclaw/openclaw`,
      `  2. Verify it works:  openclaw --version`,
      `  3. Re-run:           pnpm dm setup`,
      ``,
      `Advanced / CI: pass --skip-openclaw-check to bypass this gate.`,
      ``,
    ].join("\n"),
  );
}

async function setup(
  wikiRootArg: string | undefined,
  extensionsDirArg: string | undefined,
  minimal: boolean = false,
  skipOpenclawCheck: boolean = false,
): Promise<number> {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    console.error("setup: HOME / USERPROFILE not set");
    return 2;
  }
  // Prerequisite gate — fail fast before scaffolding/installing anything.
  if (!skipOpenclawCheck && !isOpenclawInstalled(home)) {
    printOpenclawMissing("this command");
    return 2;
  }
  const wikiRoot = wikiRootArg ?? path.join(home, "digital-me");

  console.log("");
  console.log("digital-me setup — orchestrated install");
  console.log("");

  // 1. Detect installed CLIs
  const detection = detectInstalledRuntimes({
    env: process.env,
    dirExists: (p) => existsSync(p) && statSync(p).isDirectory(),
  });
  console.log(
    `Detected CLIs: ${detection.runtimes.length > 0 ? detection.runtimes.join(", ") : "(none)"}`,
  );
  if (detection.skipped.length > 0) {
    console.log(`Skipped (not installed): ${detection.skipped.join(", ")}`);
  }
  console.log("");

  // 2. Init wiki dir + write starter config (idempotent — skips existing files)
  initWikiDir(wikiRoot, detection.runtimes);

  // 3. Install each detected runtime. A failure in one (e.g. a hand-edited
  // settings.json that no longer parses) must not abort the others.
  const runtimeInstallFailures: string[] = [];
  for (const r of detection.runtimes) {
    try {
      if (r === "claude-code") installClaudeCode(home);
      else if (r === "codex") installCodex(home);
      else if (r === "hermes") installHermes(home);
    } catch (err) {
      runtimeInstallFailures.push(r);
      console.error(
        `[FAIL] install ${r}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 3b + 3c. Optional heavy services: the dream-cycle Python venv (pip install
  // + native build) and the dashboard (pnpm install + Vite/tsc build). These
  // are the slowest, most failure-prone parts of setup and a node-only user
  // who just wants the agent-runtime brain wiring doesn't need either. `--minimal`
  // skips both; the default still lights them up. Both stay best-effort
  // (WARN, don't abort) so a failure never blocks the rest of setup.
  if (minimal) {
    console.log(
      "[SKIP] --minimal: skipping the dream-cycle Python venv + dashboard build.\n" +
        "       Add them later with:  digital-me install --runtime dream-cycle" +
        "  and  digital-me install --runtime dashboard",
    );
    console.log("");
  } else {
    const dcRc = installDreamCycle(home, wikiRoot);
    if (dcRc !== 0) {
      console.log(
        `[WARN] dream-cycle install returned exit ${dcRc}. setup will continue ` +
          `but the distillation pipeline won't run until this is fixed. ` +
          `(Re-run setup with --minimal to skip it.)`,
      );
    }

    const dashRc = installDashboard(home, wikiRoot);
    if (dashRc !== 0) {
      console.log(
        `[WARN] dashboard install returned exit ${dashRc}. setup will continue ` +
          `but the dashboard won't boot until this is fixed. ` +
          `(Re-run setup with --minimal to skip it.)`,
      );
    }
  }

  // 4. Install the openclaw brain plugin into the canonical state-dir
  //    extensions folder (resolveOpenclawExtensionsDir → ~/.openclaw/extensions
  //    by default — the HIGHEST-precedence load location, immune to checkout
  //    upgrades and dist/extensions shadowing). installOpenclaw creates the
  //    dir if missing, so a fresh machine needs no pre-existing checkout.
  //    Never target ~/openclaw/extensions: it is the LOWEST precedence and
  //    never actually loads (see openclaw-paths.ts).
  let openclawInstallRc = 0;
  let openclawInstallAttempted = false;
  if (isOpenclawInstalled(home)) {
    openclawInstallAttempted = true;
    openclawInstallRc = await installOpenclaw(home, extensionsDirArg, wikiRoot);
  } else {
    // Only reachable with --skip-openclaw-check (the prerequisite gate
    // hard-stops otherwise).
    console.log(
      `[SKIP] openclaw not detected — skipping the brain plugin install.\n` +
        `       After installing openclaw, run:  digital-me install --runtime openclaw`,
    );
  }
  console.log("");

  // 3d. Put the `digital-me` command on PATH so the bare-command guidance the
  // doctor + README give actually works on the next invocation.
  linkCliGlobally();
  console.log("");

  // 4. Doctor at the end. Pass execCommand + repoRoot so the Python-side
  // checks (python version, dream_cycle import, LLM auth) actually run —
  // without them they silently degrade to "skipped" notes and setup's
  // closing "doctor confirms everything resolved" promise is hollow.
  const doctorRuntimes: RuntimeId[] = [...(detection.runtimes as RuntimeId[])];
  if (openclawInstallAttempted && !doctorRuntimes.includes("openclaw")) {
    doctorRuntimes.push("openclaw");
  }
  if (!minimal && !doctorRuntimes.includes("dream-cycle")) {
    doctorRuntimes.push("dream-cycle");
  }
  const report = runDoctor(
    {
      fileExists: (p) => existsSync(p),
      env: { ...process.env, DIGITAL_ME_WIKI_ROOT: wikiRoot },
      which,
      execCommand,
      brainMcpProxyBinPath: BRAIN_MCP_PROXY_BIN,
      repoRoot: resolveRepoRoot(),
    },
    doctorRuntimes,
  );
  console.log(formatReport(report));
  console.log("");
  console.log(`Next:`);
  console.log(`  • Review ${wikiRoot}/config.yaml (auto-created; sources pre-filled from detected CLIs).`);
  console.log(`    Default engine=openclaw reads your LLM key from ~/.openclaw/openclaw.json — no extra key needed.`);
  console.log(`  • export DIGITAL_ME_WIKI_ROOT=${wikiRoot}`);
  console.log(`  • Run 'digital-me doctor' anytime to re-verify`);
  if (openclawInstallRc !== 0) return openclawInstallRc;
  if (runtimeInstallFailures.length > 0) return 1;
  return report.summary.failed > 0 ? 1 : 0;
}

function migrate(fromArg: string | undefined, toArg: string | undefined): number {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    console.error("migrate: HOME / USERPROFILE not set");
    return 2;
  }
  const fromPath =
    fromArg ?? path.join(home, ".openclaw", "data", "task-orchestrator.db");
  const toPath = toArg ?? path.join(home, ".openclaw", "data", "brain.db");
  if (!existsSync(fromPath)) {
    console.error(`migrate: source DB not found: ${fromPath}`);
    return 2;
  }
  if (path.resolve(fromPath) === path.resolve(toPath)) {
    console.error("migrate: source and target must be different files");
    return 2;
  }

  console.log(`migrate: ${fromPath} → ${toPath}`);
  mkdirSync(path.dirname(toPath), { recursive: true });

  // Open source readonly; open target writable.
  // Note: node:sqlite doesn't support readonly mode directly — the
  // migrator's SELECT-only queries are the safety; we never call any
  // UPDATE/DELETE/INSERT on `source`.
  const { DatabaseSync: SqliteDatabase } = requireSqlite();
  const source = new SqliteDatabase(fromPath);
  const target = new SqliteDatabase(toPath);
  target.exec("PRAGMA journal_mode=WAL");

  // Ensure target schema is up to date before copying.
  resetMigrationRegistryForTests();
  for (const m of [
    ...GOALS_MIGRATIONS,
    ...TASKS_MIGRATIONS,
    ...WORKFLOWS_MIGRATIONS,
    ...SCHEDULES_MIGRATIONS,
    ...AGENTS_MIGRATIONS,
    ...LEARNINGS_MIGRATIONS,
    ...TRACES_MIGRATIONS,
  ] as Migration[]) {
    registerMigration(m);
  }
  runMigrations(target);

  try {
    const report = migrateBrainDb({ source, target });
    console.log(formatMigrateReport(report));
    console.log("");
    console.log(
      `[OK] migrate done. Inspect with: sqlite3 ${toPath} .tables`,
    );
    return 0;
  } catch (err) {
    console.error(`migrate failed: ${(err as Error).message}`);
    return 1;
  } finally {
    source.close();
    target.close();
  }
}

function printHelp(): void {
  console.log(
    [
      "digital-me — install, doctor, and orchestrate the digital-me ecosystem.",
      "",
      "Usage:",
      "  digital-me setup [--wiki-root <path>] [--minimal] [--skip-openclaw-check]",
      "    One-shot: detect CLIs, init wiki dir, install runtimes, link the",
      "    `digital-me` command onto PATH, doctor. Requires openclaw (the",
      "    mandatory foundation) — hard-stops with install guidance if it's",
      "    missing. --minimal skips the heavy optional services (dream-cycle",
      "    Python venv + dashboard build); --skip-openclaw-check bypasses the",
      "    prerequisite gate (advanced / CI).",
      "",
      "  digital-me init [--wiki-root <path>]",
      "    Scaffold wiki/, inbox/, .cache/, config.example.yaml.",
      "",
      "  digital-me doctor [--runtime <id>...]",
      "    Diagnose the environment.",
      "",
      "  digital-me install --runtime <id> [--runtime <id>...] [--no-service]",
      "    Install a specific runtime adapter. For --runtime dashboard, also",
      "    sets up an always-on service (launchd/systemd) so the dashboard",
      "    survives closing the terminal + reboot; --no-service skips that.",
      "",
      "  digital-me service dashboard <install|uninstall|status>",
      "    Manage the always-on dashboard service (cross-platform: launchd on",
      "    macOS, systemd --user on Linux). 'install' generates + loads the unit",
      "    anchored at the stable install symlink and verifies it serves.",
      "",
      "  digital-me update --runtime openclaw [--dry-run] [--skip-restart]",
      "                    [--repo-dir <path>] [--tag-maturity-hours <n>] [--pnpm-spec <spec>]",
      "    Update openclaw to the latest mature stable upstream tag and",
      "    re-materialize the digital-me plugin overlay (stock + overlay model:",
      "    no fork, no rebase). --dry-run prints the plan without writing;",
      "    --skip-restart leaves the gateway untouched.",
      "",
      "  digital-me deploy [--runtime openclaw|dashboard ...] [--dry-run]",
      "    Turn 'merged in git' into 'verified live' in one safe step: refuse if",
      "    the source checkout is dirty/ahead, fast-forward main, rebuild, reinstall",
      "    to the canonical loaded location, restart the service, and self-verify the",
      "    live fingerprint matches. No --runtime → every deployable runtime detected.",
      "",
      "  digital-me migrate [--from <path>] [--to <path>]",
      "    One-shot copy from upstream task-orchestrator.db to brain.db.",
      "    Idempotent — re-runs skip already-migrated rows.",
      "",
      "  digital-me dream-cycle [args...]",
      "    Run the dream-cycle knowledge distillation pipeline. All args",
      "    after `dream-cycle` pass through to `python3 -m dream_cycle.run`.",
      "",
      "  digital-me dream-cycle import-workflow <path>",
      "    Import a workflow.json into the openclaw brain via the gateway.",
      "",
      "  digital-me dream-cycle --via-agents [args...]",
      "    Run dream-cycle via brain-orchestrator spawn-dispatch instead of",
      "    inline-Python LLM. Requires an imported workflow + a running gateway.",
      "",
      "Runtimes:",
      "  claude-code   5 hooks + digital-me skill into ~/.claude/",
      "  codex         CODEX.md + openclaw-brain MCP into ~/.codex/",
      "  hermes        SOUL.md digital-me protocol into ~/.hermes/",
      "  openclaw      see @digital-me/runtime-openclaw README",
      "  dream-cycle   creates ~/.venvs/dream-cycle/ + pip install -e the Python service",
      "  dashboard     builds the dashboard + installs the always-on service (see --no-service)",
    ].join("\n"),
  );
}

// ─── dashboard always-on service (launchd on macOS / systemd --user on Linux) ──

function servicePlatform(): "darwin" | "linux" | null {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return null;
}

async function pollDashboard(port: number, totalMs: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.ok) return true;
    } catch {
      // not up yet
    } finally {
      clearTimeout(t);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Generate + load the always-on dashboard service for the current OS and
 * verify it serves. Non-fatal on unsupported platforms (returns 0). Used by
 * `digital-me service dashboard install` and (by default) `install --runtime
 * dashboard`.
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `launchctl print <target>` until the job is no longer loaded (status
 * != 0) or the timeout elapses. `launchctl bootout` is asynchronous — the old
 * KeepAlive job takes a moment to tear down — and bootstrapping before it
 * finishes returns the opaque "Bootstrap failed: 5: Input/output error".
 */
async function waitForLaunchdGone(target: string, totalMs: number): Promise<void> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const r = spawnSync("launchctl", ["print", target], { encoding: "utf-8" });
    if (r.status !== 0) return; // not loaded anymore
    await sleepMs(500);
  }
}

/** Describe the process listening on a TCP port (for diagnosing EADDRINUSE). */
function portHolder(port: number): string | null {
  const r = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
    { encoding: "utf-8" },
  );
  if (r.status !== 0 || !r.stdout) return null;
  const rows = r.stdout.trim().split("\n").slice(1); // drop header
  if (rows.length === 0) return null;
  const cols = rows[0]!.trim().split(/\s+/);
  return `pid ${cols[1]} (${cols[0]})`;
}

async function setupDashboardService(home: string): Promise<number> {
  const platform = servicePlatform();
  if (!platform) {
    console.log(
      `service dashboard: no supported service manager on '${process.platform}'. ` +
        `Start it manually with 'pnpm dashboard'.`,
    );
    return 0;
  }
  const npmBin = which("npm");
  if (!npmBin) {
    console.error("service dashboard: npm not on PATH. Install Node.js 22+ first.");
    return 2;
  }
  const cfg = resolveDashboardServiceConfig(home, process.env, npmBin);
  if (!existsSync(cfg.workingDir)) {
    console.error(
      `service dashboard: install dir missing (${cfg.workingDir}). ` +
        `Run 'digital-me install --runtime dashboard' first.`,
    );
    return 2;
  }
  const unitPath = dashboardServiceUnitPath(home, platform);
  mkdirSync(path.dirname(unitPath), { recursive: true });
  mkdirSync(path.dirname(cfg.stdoutLog), { recursive: true });
  writeFileSync(unitPath, buildDashboardServiceUnit(cfg, platform), "utf-8");
  console.log(`service dashboard: wrote ${unitPath}`);

  if (platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    const target = `${domain}/${cfg.label}`;
    // Replace any previous instance, then WAIT for it to drain before
    // bootstrapping (bootout is async; racing it → "Bootstrap failed: 5").
    spawnSync("launchctl", ["bootout", target], { stdio: "ignore" });
    await waitForLaunchdGone(target, 10000);
    let boot = spawnSync("launchctl", ["bootstrap", domain, unitPath], { encoding: "utf-8" });
    for (
      let attempt = 0;
      attempt < 3 &&
      boot.status !== 0 &&
      isTransientBootstrapError(boot.stderr, boot.status);
      attempt++
    ) {
      // Old job still draining — give it more time, then retry.
      await waitForLaunchdGone(target, 5000);
      await sleepMs(1500);
      boot = spawnSync("launchctl", ["bootstrap", domain, unitPath], { encoding: "utf-8" });
    }
    if (boot.status !== 0) {
      console.error(
        `service dashboard: launchctl bootstrap failed: ${(boot.stderr ?? "").trim()}`,
      );
      return boot.status ?? 1;
    }
    spawnSync("launchctl", ["kickstart", "-k", target], { stdio: "ignore" });
  } else {
    // Stop any prior instance first so enable --now re-binds cleanly.
    spawnSync("systemctl", ["--user", "stop", `${cfg.label}.service`], { stdio: "ignore" });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    const en = spawnSync(
      "systemctl",
      ["--user", "enable", "--now", `${cfg.label}.service`],
      { encoding: "utf-8" },
    );
    if (en.status !== 0) {
      console.error(`service dashboard: systemctl enable failed: ${en.stderr ?? ""}`.trim());
      return en.status ?? 1;
    }
  }

  process.stdout.write(`service dashboard: verifying http://localhost:${cfg.port}/ ...`);
  const ok = await pollDashboard(cfg.port, 30000);
  console.log(ok ? " OK" : " (not responding yet)");
  if (!ok) {
    // Most common cause: something else (e.g. a manual `pnpm dashboard`) is
    // already holding the port, so the service can't bind it.
    const holder = portHolder(cfg.port);
    if (holder) {
      console.error(
        `service dashboard: port ${cfg.port} is already in use by ${holder}. ` +
          `Stop it (e.g. a manual 'pnpm dashboard') and re-run ` +
          `'digital-me service dashboard install'.`,
      );
    } else {
      const where =
        platform === "darwin"
          ? cfg.stderrLog
          : `journalctl --user -u ${cfg.label}`;
      console.error(
        `service dashboard: loaded but not serving on :${cfg.port} yet — check ${where}.`,
      );
    }
    return 1;
  }
  console.log(
    `[OK] dashboard always-on at http://localhost:${cfg.port} ` +
      `(survives closing the terminal + reboot).`,
  );
  return 0;
}

function removeDashboardService(home: string): number {
  const platform = servicePlatform();
  if (!platform) return 0;
  const unitPath = dashboardServiceUnitPath(home, platform);
  if (platform === "darwin") {
    spawnSync(
      "launchctl",
      ["bootout", `gui/${process.getuid?.() ?? 0}/${DASHBOARD_SERVICE_LABEL}`],
      { stdio: "ignore" },
    );
  } else {
    spawnSync(
      "systemctl",
      ["--user", "disable", "--now", `${DASHBOARD_SERVICE_LABEL}.service`],
      { stdio: "ignore" },
    );
  }
  if (existsSync(unitPath)) {
    rmSync(unitPath);
    console.log(`service dashboard: removed ${unitPath}`);
  }
  if (platform === "linux") {
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  }
  console.log("[OK] dashboard service removed.");
  return 0;
}

function dashboardServiceStatus(home: string): number {
  const platform = servicePlatform();
  if (!platform) {
    console.log(`service dashboard: no supported service manager on ${process.platform}.`);
    return 0;
  }
  const unitPath = dashboardServiceUnitPath(home, platform);
  console.log(`unit file: ${existsSync(unitPath) ? unitPath : "(not installed)"}`);
  const r =
    platform === "darwin"
      ? spawnSync("launchctl", ["list", DASHBOARD_SERVICE_LABEL], { encoding: "utf-8" })
      : spawnSync(
          "systemctl",
          ["--user", "status", `${DASHBOARD_SERVICE_LABEL}.service`],
          { encoding: "utf-8" },
        );
  console.log((r.stdout || r.stderr || "(not loaded)").trim());
  return 0;
}

/** `digital-me service dashboard <install|uninstall|status>` */
async function serviceCommand(args: readonly string[]): Promise<number> {
  const target = args[0];
  const action = args[1] ?? "install";
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    console.error("service: HOME / USERPROFILE not set");
    return 2;
  }
  if (target !== "dashboard") {
    console.error(
      `service: unknown target '${target ?? ""}'. ` +
        `Usage: digital-me service dashboard <install|uninstall|status>`,
    );
    return 2;
  }
  if (action === "install") return setupDashboardService(home);
  if (action === "uninstall" || action === "remove") return removeDashboardService(home);
  if (action === "status") return dashboardServiceStatus(home);
  console.error(
    `service dashboard: unknown action '${action}'. Use install | uninstall | status.`,
  );
  return 2;
}

// ─── deploy: merged-in-git → verified-live ────────────────────────────────

function git(repo: string, args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Deployable runtimes detected as installed on this machine. */
function detectDeployableInstalled(home: string): string[] {
  const out: string[] = [];
  const stateExt = resolveOpenclawExtensionsDir(home, process.env, undefined);
  if (
    existsSync(path.join(stateExt, "digital-me-brain", "index.mjs")) ||
    existsSync(path.join(stateExt, "digital-me-recall", "index.mjs"))
  ) {
    out.push("openclaw");
  }
  if (existsSync(path.join(home, ".local", "share", "digital-me", "dashboard"))) {
    out.push("dashboard");
  }
  return out;
}

/** Restart the openclaw gateway (cross-platform via the openclaw CLI) and
 * confirm the LIVE recall marker matches the freshly-deployed bundle. */
async function restartAndVerifyOpenclaw(home: string): Promise<boolean> {
  if (!which("openclaw")) {
    console.log(
      "deploy openclaw: 'openclaw' not on PATH — restart the gateway manually to load the new plugin.",
    );
    return false;
  }
  spawnSync("openclaw", ["gateway", "restart"], { stdio: "inherit" });
  // Expected fingerprint = the marker baked into the just-deployed bundle.
  const recallEntry = path.join(
    resolveOpenclawExtensionsDir(home, process.env, undefined),
    "digital-me-recall",
    "index.mjs",
  );
  const expected = existsSync(recallEntry)
    ? readFileSync(recallEntry, "utf-8").match(/assistant_ack=([^,"`)\s]+)/)?.[1] ?? null
    : null;
  const logPath = path.join(home, "Library", "Logs", "openclaw", "gateway.log");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const live = parseRecallAckMode(readFileSync(logPath, "utf-8").slice(-20000));
      if (live) {
        if (!expected || live === expected) {
          console.log(`[OK] openclaw gateway live: recall assistant_ack=${live}`);
          return true;
        }
        console.error(
          `deploy openclaw: DIVERGENCE — live marker (${live}) != deployed (${expected}).`,
        );
        return false;
      }
    }
    await sleepMs(2000);
  }
  // Registration is lazy (fires on the first agent turn) — restart succeeded.
  console.log(
    "deploy openclaw: gateway restarted; recall marker will confirm on the next agent turn.",
  );
  return true;
}

/**
 * `digital-me deploy [--runtime <id>...] [--dry-run]` — sync source, rebuild,
 * redeploy to the canonical loaded location, restart, and self-verify so the
 * running system provably matches origin/main.
 */
async function deploy(
  runtimes: RuntimeId[],
  opts: { dryRun: boolean },
): Promise<number> {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    console.error("deploy: HOME / USERPROFILE not set");
    return 2;
  }
  const repo = resolveRepoRoot();
  if (!repo) {
    console.error(
      "deploy: no source checkout found (the CLI is running from an npm install). " +
        "Clone digital-me-os and run deploy from that checkout.",
    );
    return 2;
  }

  // ── preflight: pristine + not-ahead source ──
  git(repo, ["fetch", "origin", "main"]);
  const porcelain = git(repo, ["status", "--porcelain"]).stdout;
  const ab = parseAheadBehind(
    git(repo, ["rev-list", "--left-right", "--count", "main...origin/main"]).stdout,
  );
  const pre = analyzeDeployPreflight({ porcelain, ahead: ab.ahead, behind: ab.behind });
  if (!pre.ok) {
    console.error(`deploy: ${pre.reason}`);
    return 2;
  }

  const targets = planDeployRuntimes(runtimes, detectDeployableInstalled(home));
  if (targets.length === 0) {
    console.error(
      "deploy: nothing deployable found (expected openclaw and/or dashboard installed). " +
        "Specify with --runtime openclaw|dashboard.",
    );
    return 2;
  }
  console.log(
    `deploy: plan → fast-forward main (behind ${ab.behind}) → rebuild → ` +
      `redeploy [${targets.join(", ")}] → restart + verify`,
  );
  if (opts.dryRun) {
    console.log("deploy: --dry-run, stopping (no changes made).");
    return 0;
  }

  // ── sync source ──
  git(repo, ["checkout", "main"]);
  const pull = git(repo, ["pull", "--ff-only"]);
  if (pull.status !== 0) {
    console.error(`deploy: 'git pull --ff-only' failed:\n${pull.stderr.trim()}`);
    return 1;
  }

  // ── rebuild git-ignored dist ──
  const pnpmBin = which("pnpm");
  if (!pnpmBin) {
    console.error("deploy: pnpm not on PATH (https://pnpm.io/installation).");
    return 2;
  }
  console.log("deploy: rebuilding @digital-me/cli + deps ...");
  const build = spawnSync(pnpmBin, ["--filter", "@digital-me/cli...", "build"], {
    cwd: repo,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    console.error("deploy: build failed — aborting before touching the running system.");
    return build.status ?? 1;
  }

  // ── redeploy → restart → verify ──
  let exit = 0;
  for (const t of targets) {
    if (t === "openclaw") {
      const rc = await installOpenclaw(home, undefined, undefined); // canonical state dir
      if (rc !== 0) {
        exit = rc;
        continue;
      }
      if (!(await restartAndVerifyOpenclaw(home))) exit = 1;
    } else if (t === "dashboard") {
      const rc = installDashboard(home, undefined);
      if (rc !== 0) {
        exit = rc;
        continue;
      }
      const rc2 = await setupDashboardService(home); // restarts + HTTP-verifies
      if (rc2 !== 0) exit = rc2;
    }
  }
  console.log(
    exit === 0
      ? "[OK] deploy complete — running system matches origin/main."
      : "deploy: completed with issues (see above).",
  );
  return exit;
}

/**
 * Minimum supported Node. 22.5 is where `node:sqlite` (used by `migrate`)
 * landed; everything else in the CLI assumes >= 22. Checked up front so a
 * too-old Node gets one actionable line instead of a runtime stack trace.
 */
const MIN_NODE = [22, 5] as const;

function checkNodeVersion(): string | undefined {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map((p) => Number.parseInt(p, 10));
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) {
    return undefined;
  }
  return (
    `digital-me requires Node >= ${MIN_NODE.join(".")} (you are running ${process.versions.node}).\n` +
    `Upgrade Node (e.g. via nvm: 'nvm install 22'), then re-run.`
  );
}

async function main(): Promise<number> {
  const nodeError = checkNodeVersion();
  if (nodeError) {
    console.error(nodeError);
    return 2;
  }
  // `dream-cycle` is a pure passthrough to python3 -m dream_cycle.run.
  // Parse it BEFORE parseArgs so flags like --no-compile or --wiki-root
  // belong to the Python CLI, not the TS one.
  if (process.argv[2] === "dream-cycle") {
    return dreamCycle(process.argv.slice(3));
  }
  // `service` manages OS daemons (e.g. the always-on dashboard). Positional
  // sub-args (target + action), so route before the flag parser.
  if (process.argv[2] === "service") {
    return serviceCommand(process.argv.slice(3));
  }
  const {
    cmd,
    runtimes,
    wikiRoot,
    extensionsDir,
    from,
    to,
    dryRun,
    skipRestart,
    minimal,
    skipOpenclawCheck,
    noService,
    help,
    repoDir,
    tagMaturityHours,
    pnpmSpec,
  } = parseArgs(process.argv.slice(2));
  // A --help/-h flag anywhere short-circuits to usage and exits cleanly,
  // before any subcommand runs. This is the guard that stops e.g.
  // `digital-me deploy --help` from executing a real deploy.
  if (help) {
    printHelp();
    return 0;
  }
  if (cmd === "setup") return setup(wikiRoot, extensionsDir, minimal, skipOpenclawCheck);
  if (cmd === "init") {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home) {
      console.error("init: HOME / USERPROFILE not set");
      return 2;
    }
    const root = wikiRoot ?? path.join(home, "digital-me");
    const detection = detectInstalledRuntimes({
      env: process.env,
      dirExists: (p) => existsSync(p) && statSync(p).isDirectory(),
    });
    return initWikiDir(root, detection.runtimes);
  }
  if (cmd === "doctor") return doctor(runtimes);
  if (cmd === "install")
    return install(runtimes, extensionsDir, wikiRoot, skipOpenclawCheck, noService);
  if (cmd === "update") {
    return update(runtimes, extensionsDir, {
      dryRun,
      skipRestart,
      repoDir,
      tagMaturityHours,
      pnpmSpec,
    });
  }
  if (cmd === "deploy") return deploy(runtimes, { dryRun });
  if (cmd === "migrate") return migrate(from, to);
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }
  console.error(`Unknown command: ${cmd}`);
  printHelp();
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
