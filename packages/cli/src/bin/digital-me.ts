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
 *   digital-me dashboard [--port <n>] [--no-open]
 *     Launch the OA dashboard: open the browser if it's already serving,
 *     otherwise start the always-on service first.
 *
 * The install path runs filesystem writes; it's intentionally NOT in
 * the unit-test surface. The pure data layer (doctor.ts, setup.ts, and
 * each runtime package's installer) IS tested.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_NAMES,
  HOOKS_DIR as CLAUDE_HOOKS_DIR,
  SKILLS_DIR as CLAUDE_SKILLS_DIR,
  buildClaudeHooksManifest,
  mergeBrainEnvIntoSettings,
  mergeHooksIntoSettings,
} from "@digital-me/runtime-claude-code";
import {
  CODEX_MD_TEMPLATE,
  HOOK_NAMES as CODEX_HOOK_NAMES,
  HOOKS_DIR as CODEX_HOOKS_DIR,
  brainHookEnv,
  buildCodexMcpConfig,
  mergeCodexHooksJson,
  mergeCodexMd,
  mergeMcpServer,
  mergeShellEnvPolicySet,
} from "@digital-me/runtime-codex";
import { BIN_PATH as BRAIN_MCP_PROXY_BIN } from "@digital-me/brain-mcp-proxy";
import { stabilizeRegistration } from "../stable-registration.js";
import {
  SOUL_MD_TEMPLATE,
  buildHermesMcpEnv,
  mergeSoulMd,
  RECALL_PLUGIN_NAME as HERMES_RECALL_PLUGIN_NAME,
  RECALL_PLUGIN_SRC_DIR as HERMES_RECALL_PLUGIN_SRC_DIR,
  RECALL_PLUGIN_FILES as HERMES_RECALL_PLUGIN_FILES,
  RECALL_PLUGIN_ENABLE_COMMAND as HERMES_RECALL_PLUGIN_ENABLE_COMMAND,
} from "@digital-me/runtime-hermes";
import { updateOpenclaw } from "@digital-me/runtime-openclaw";
import { materializeOpenclawOverlay } from "../openclaw-overlay.js";
import {
  runDoctor,
  formatReport,
  type RuntimeId,
  type WorkflowProvenance,
} from "../doctor.js";
import { resolveOpenclawExtensionsDir } from "../openclaw-paths.js";
import JSON5 from "json5";
import {
  ensureOpenclawMemoryPaths,
  resolveOpenclawConfigPath,
} from "../openclaw-memory.js";
import {
  DASHBOARD_SERVICE_LABEL,
  buildDashboardServiceUnit,
  dashboardServiceUnitPath,
  isTransientBootstrapError,
  resolveDashboardServiceConfig,
} from "../dashboard-service.js";
import {
  BRAIN_HOST_SERVICE_LABEL,
  type BrainCallerEnv,
  brainHostInvokeUrl,
  brainHostServiceUnitPath,
  buildBrainHostServiceUnit,
  resolveBrainCallerEnv,
  resolveBrainHostServiceConfig,
} from "../brain-host-service.js";
import { describeBrainSidecar, syncBrainSidecar } from "../brain-sidecar.js";
import {
  DASHBOARD_COMMAND_USAGE,
  browserOpenCommand,
  dashboardInstallDir,
  parseDashboardArgs,
  planDashboardLaunch,
  resolveDashboardPort,
} from "../dashboard-command.js";
import {
  analyzeDeployPreflight,
  parseAheadBehind,
  parseRecallAckMode,
  planDeployRuntimes,
  expectedRecallAckMode,
  resolveGatewayLog,
} from "../deploy.js";
import {
  buildDefaultAliases,
  buildTranscriptSources,
  detectInstalledRuntimes,
  ensureGitignoreEntries,
  planWikiInit,
  type DetectedRuntime,
} from "../setup.js";
import {
  brainHostTokenFileOf,
  detectBrainEndpoint,
  isOpenclawInstalled as probeOpenclawInstalled,
  noBrainEndpointMessage,
  orderRuntimesHubFirst,
  runtimesNeedingBrain,
} from "../brain-endpoint.js";
import { planBrainDbMigration, postMigrationSteps } from "../brain-db.js";
import { resolveBrainDbPath } from "@digital-me/contracts";
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
  "digest",
  "brain-host",
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

/**
 * Read each workflow template's provenance straight from the brain DB.
 *
 * Read-only and best-effort: doctor must never be the reason a machine
 * looks broken. A missing DB, a pre-migration schema, or a locked file all
 * degrade to "skipped", never to a failed check.
 */
function readWorkflowProvenance(): WorkflowProvenance[] {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return [];
  const dbPath = resolveBrainDbPath({ env: process.env, home, exists: existsSync }).path;
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { open: true });
  try {
    const rows = db
      .prepare(
        "SELECT id, source_path, source_hash, created_at FROM workflow_templates",
      )
      .all() as Array<{
      id: string;
      source_path: string | null;
      source_hash: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sourcePath: r.source_path ?? undefined,
      sourceHash: r.source_hash ?? undefined,
      importedAt: r.created_at,
    }));
  } catch {
    // Pre-v301 schema has no source_* columns. Nothing is wrong, there is
    // just nothing to verify yet.
    return [];
  } finally {
    db.close();
  }
}

function doctor(runtimes: RuntimeId[]): number {
  const report = runDoctor(
    {
      fileExists: (p) => existsSync(p),
      env: process.env,
      which,
      execCommand,
      readFile: (p) => readFileSync(p, "utf-8"),
      brainMcpProxyBinPath: BRAIN_MCP_PROXY_BIN,
      repoRoot: resolveRepoRoot(),
      workflowProvenance: readWorkflowProvenance,
      hashFile: (p) => {
        try {
          return createHash("sha256").update(readFileSync(p)).digest("hex");
        } catch {
          return undefined;
        }
      },
    },
    runtimes.length > 0 ? runtimes : defaultDoctorRuntimes(),
  );
  console.log(formatReport(report));
  return report.summary.failed > 0 ? 1 : 0;
}

/**
 * `digital-me doctor` with no --runtime: every runtime the default setup
 * lights up, plus openclaw only where it is actually installed — it is an
 * optional runtime, so its rows must not turn a brain-host-only machine red.
 */
function defaultDoctorRuntimes(): readonly RuntimeId[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return VALID_RUNTIMES.filter((r) => r !== "openclaw" || isOpenclawInstalled(home));
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
    env: brainChildEnv(home),
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
      { cause: err },
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
  let merged = mergeHooksIntoSettings(existing);
  // brain-host plumbing: once `digital-me install --runtime brain-host` has
  // minted a bearer token, point the hooks at brain-host through settings.json
  // `env` (Claude Code exports it to every hook process). Without this the
  // hooks keep talking to the openclaw gateway after the cutover, silently.
  // Only DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN_FILE are written — the
  // secret stays in the mode-600 token file and every hook reads it itself;
  // a DIGITAL_ME_BRAIN_TOKEN an earlier install wrote is removed. A URL with
  // no resolvable token is a hard error in every caller, never a fallback.
  const brainCfg = resolveBrainHostServiceConfig(home, process.env, process.execPath);
  const brainCaller = resolveBrainCallerEnv(process.env, brainCfg, readTokenFileIfExists);
  let brainNote = "";
  if (brainCaller !== undefined) {
    merged = mergeBrainEnvIntoSettings(merged, {
      url: brainCaller.brainUrl,
      tokenFile: brainCaller.brainTokenFile,
    });
    brainNote = ` + env DIGITAL_ME_BRAIN_URL=${brainCaller.brainUrl} DIGITAL_ME_BRAIN_TOKEN_FILE=${brainCaller.brainTokenFile}`;
  }
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  // The same pair in digital-me-brain.env next to the hooks, which read it
  // when their environment has no DIGITAL_ME_BRAIN_URL (a hook launched
  // without settings.json `env`). Removed when brain-host is not configured.
  const sidecarNote = describeBrainSidecar(syncBrainSidecar(targetHooksDir, brainCaller));
  // Reference the manifest so this gets imported (tree-shake protection):
  void buildClaudeHooksManifest;
  console.log(`[OK] installed claude-code: hooks + skill + settings.json merged${brainNote}`);
  if (sidecarNote) console.log(`     claude-code hooks: ${sidecarNote}`);
  // Register the openclaw-brain MCP server in Claude Code's CLI registry
  installClaudeCodeMcp(brainCaller);
}

/** Token-file reader for resolveBrainCallerEnv: contents when present, else undefined. */
function readTokenFileIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf-8") : undefined;
}

/**
 * Environment for a child process that talks to the brain (the Python
 * workflow importers, dream-cycle, the digest smoke): the installer's own
 * env plus DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN_FILE whenever
 * brain-host is installed on this machine. Without this a fresh `setup`
 * (no env exported yet) would send those registrations to an openclaw
 * gateway that may not exist. `wikiRoot` scopes the token-file default.
 */
function brainChildEnv(home: string, wikiRoot?: string): NodeJS.ProcessEnv {
  const env = wikiRoot ? { ...process.env, DIGITAL_ME_WIKI_ROOT: wikiRoot } : { ...process.env };
  const nodeBin = which("node") ?? "node";
  let caller: BrainCallerEnv | undefined;
  try {
    caller = resolveBrainCallerEnv(env, resolveBrainHostServiceConfig(home, env, nodeBin), readTokenFileIfExists);
  } catch {
    caller = undefined; // a misconfigured DIGITAL_ME_BRAIN_URL is reported by the adapter installers
  }
  return caller
    ? { ...env, DIGITAL_ME_BRAIN_URL: caller.brainUrl, DIGITAL_ME_BRAIN_TOKEN_FILE: caller.brainTokenFile }
    : env;
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
  // ~/.codex/config.toml is persistent user config — same hardening as the
  // other two clients (see stable-registration.ts).
  const codexStable = stabilizeRegistration(process.execPath, BRAIN_MCP_PROXY_BIN);
  for (const note of codexStable.notes) {
    console.log(`     codex MCP: ${note}`);
  }
  // Backend for the proxy Codex spawns. Codex does not forward this shell's
  // env to MCP servers, so DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN_FILE
  // (the path — never the secret) must be baked into the stanza: this
  // process's env first, else the always-on brain-host service (token file on
  // disk), else the stanza stays on the openclaw gateway. Re-installing drops
  // a DIGITAL_ME_BRAIN_TOKEN an earlier version wrote (the block is replaced).
  const brainHostCfg = resolveBrainHostServiceConfig(home, process.env, codexStable.nodePath);
  const brainCaller = resolveBrainCallerEnv(process.env, brainHostCfg, readTokenFileIfExists);
  console.log(
    brainCaller
      ? `     codex MCP: proxy env → brain-host at ${brainCaller.brainUrl} (token file ${brainCaller.brainTokenFile})`
      : `     codex MCP: proxy env → openclaw gateway (no brain-host token at ${brainHostCfg.tokenFile}; run 'digital-me install --runtime brain-host' to switch)`,
  );
  const tomlFragment = buildCodexMcpConfig({
    nodeBin: codexStable.nodePath,
    proxyBinPath: codexStable.binPath,
    openclawHome,
    agentId: "codex",
    brainUrl: brainCaller?.brainUrl,
    brainTokenFile: brainCaller?.brainTokenFile,
  });
  const tomlTarget = path.join(codexDir, "config.toml");
  const tomlExisting = existsSync(tomlTarget)
    ? readFileSync(tomlTarget, "utf-8")
    : "";
  let tomlMerged = mergeMcpServer(tomlExisting, tomlFragment);
  // [shell_environment_policy.set] gives the commands Codex runs through its
  // shell tool the same two variables (merged; other keys in that table are
  // kept). It does NOT reach hook processes — the hooks get the pair from the
  // digital-me-brain.env sidecar written next to them below.
  if (brainCaller) {
    try {
      tomlMerged = mergeShellEnvPolicySet(tomlMerged, brainHookEnv(brainCaller));
      console.log(`     codex shell env: [shell_environment_policy.set] → brain-host at ${brainCaller.brainUrl}`);
    } catch (err) {
      console.error(
        `[WARN] codex shell env: could not merge [shell_environment_policy.set] (${err instanceof Error ? err.message : String(err)}). ` +
          `Set DIGITAL_ME_BRAIN_URL and DIGITAL_ME_BRAIN_TOKEN_FILE there by hand if commands Codex runs should reach brain-host (the hooks use the sidecar).`,
      );
    }
  }
  writeFileSync(tomlTarget, tomlMerged, "utf-8");
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
  // Codex runs hooks with its own process environment, which carries no
  // DIGITAL_ME_BRAIN_URL (config.toml's policy table included), so the hooks
  // read the pair from digital-me-brain.env next to them. Removed when
  // brain-host is not configured, so they never point at a removed brain-host.
  const sidecarNote = describeBrainSidecar(syncBrainSidecar(targetHooksDir, brainCaller));
  if (sidecarNote) console.log(`     codex hooks: ${sidecarNote}`);
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
      `(mcp openclaw-brain → ${codexStable.binPath}); ` +
      `${CODEX_HOOK_NAMES.length} hooks + hooks.json wired`,
  );
}

/**
 * Register the openclaw-brain MCP server with Claude Code's CLI registry
 * via `claude mcp add`. Idempotent — if a server with the same name
 * exists, remove it first (which also drops any DIGITAL_ME_BRAIN_TOKEN an
 * earlier registration carried). With `brainCaller` the registration's env
 * gets DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN_FILE (the path, never
 * the secret) so the proxy Claude Code spawns talks to brain-host.
 */
function installClaudeCodeMcp(brainCaller: BrainCallerEnv | undefined): void {
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
  const env: Record<string, string> = {
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_AGENT_ID: "claude-code",
    ...(brainCaller
      ? {
          DIGITAL_ME_BRAIN_URL: brainCaller.brainUrl,
          DIGITAL_ME_BRAIN_TOKEN_FILE: brainCaller.brainTokenFile,
        }
      : {}),
  };
  // Install at user scope so the server is available across all
  // projects, not just the current cwd's project-local scope.
  const args: string[] = ["mcp", "add", "openclaw-brain", "-s", "user"];
  for (const [k, v] of Object.entries(env)) {
    args.push("-e", `${k}=${v}`);
  }
  // Never bake a worktree path or a version-pinned interpreter into
  // ~/.claude.json — it outlives this process (see stable-registration.ts).
  const stable = stabilizeRegistration(process.execPath, BRAIN_MCP_PROXY_BIN);
  for (const note of stable.notes) {
    console.log(`     claude-code MCP: ${note}`);
  }
  args.push("--", stable.nodePath, stable.binPath);
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
    `[OK] claude-code MCP: registered openclaw-brain → ${stable.binPath}`,
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
  // Source checkout → editable install from the local package (developer
  // mode). npm-installed CLI (no source tree) → install the published
  // package from PyPI instead; same module, same console script.
  const repoRoot = resolveRepoRoot();
  let pipTarget: readonly string[];
  if (repoRoot) {
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
    pipTarget = ["-e", `${packagePath}[dev]`];
  } else {
    console.log(
      "install dream-cycle: no source checkout detected — installing the " +
        "published digital-me-dream-cycle package from PyPI.",
    );
    pipTarget = ["digital-me-dream-cycle"];
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

  // pip install the package (editable from source, or from PyPI — see
  // pipTarget above). The [dev] extras include pytest so source users can
  // run the bundled test suite if they want.
  const venvPip = path.join(venvDir, "bin", "pip");
  console.log(`install dream-cycle: pip install ${pipTarget.join(" ")} ...`);
  const pipResult = spawnSync(
    venvPip,
    ["install", ...pipTarget],
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
    env: brainChildEnv(home, wikiRoot),
  });
  if (wfResult.status !== 0) {
    console.error(
      `install dream-cycle: workflow import returned exit ${wfResult.status ?? "?"}. ` +
        `The venv is ready, but workflows aren't imported. ` +
        `Common causes: the brain endpoint is unreachable — with brain-host, set DIGITAL_ME_BRAIN_URL (+ DIGITAL_ME_BRAIN_TOKEN_FILE if the token is not at the default path); ` +
        `with the openclaw gateway, it is not running or the auth token is missing in ~/.openclaw/openclaw.json. ` +
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
 * Run the digest's hermetic smoke gate via the given venv python. Verifies the
 * publisher contract still holds (schema present, validator agrees, fail-open
 * floor postable, `content`-keyed blocks accepted) — the invariants whose
 * silent violation caused the recurring 7am outages. Best-effort + non-fatal:
 * returns the exit code and prints the smoke's own diagnostics; callers decide
 * how loudly to react. Skips (returns 0) when the digest isn't installed.
 */
function runDigestSmoke(venvPython: string, home?: string): number {
  if (!existsSync(venvPython)) return 0; // digest not installed — nothing to check
  const r = spawnSync(venvPython, ["-m", "digest.smoke"], {
    stdio: "inherit",
    ...(home ? { env: brainChildEnv(home) } : {}),
  });
  return r.status ?? 1;
}

/**
 * Install the daily-digest Python sibling package.
 *
 * The digest SHARES the dream-cycle venv (~/.venvs/dream-cycle): it reuses
 * dream-cycle's brain client to register its workflow, and its optional
 * inline-summary fallback imports dream_cycle. So this ensures that venv +
 * dream_cycle exist (installing dream-cycle first if needed), then pip-installs
 * the digest package into it and registers the bundled digest workflow +
 * 7am schedule with the brain — making `digital-me install --runtime digest`
 * a one-stop setup with no manual workflow_import.
 */
function installDigest(home: string, wikiRoot?: string): number {
  const venvDir = path.join(home, ".venvs", DREAM_CYCLE_VENV_DIRNAME);
  const venvPython = path.join(venvDir, "bin", "python3");

  // Shared-venv prerequisite: the digest reuses dream-cycle's brain client and
  // (optionally) its inline engine. If the venv isn't there yet, stand up
  // dream-cycle first — idempotent, so this is safe when both are requested.
  if (!existsSync(venvPython)) {
    console.log(
      "install digest: dream-cycle venv not found — installing dream-cycle " +
        "first (the digest shares its venv).",
    );
    const dcRc = installDreamCycle(home, wikiRoot);
    if (dcRc !== 0) {
      console.error(
        "install digest: prerequisite dream-cycle install failed; aborting.",
      );
      return dcRc;
    }
  }

  // Source checkout → editable install; npm-installed CLI → PyPI package.
  const repoRoot = resolveRepoRoot();
  let pipTarget: readonly string[];
  if (repoRoot) {
    const packagePath = path.join(repoRoot, "packages", "services", "digest");
    if (!existsSync(path.join(packagePath, "pyproject.toml"))) {
      console.error(
        `install digest: package not found at ${packagePath}. Expected pyproject.toml.`,
      );
      return 2;
    }
    pipTarget = ["-e", `${packagePath}[dev]`];
  } else {
    console.log(
      "install digest: no source checkout detected — installing the " +
        "published digital-me-digest package from PyPI.",
    );
    pipTarget = ["digital-me-digest"];
  }

  const venvPip = path.join(venvDir, "bin", "pip");
  console.log(`install digest: pip install ${pipTarget.join(" ")} ...`);
  const pipResult = spawnSync(venvPip, ["install", ...pipTarget], {
    stdio: "inherit",
  });
  if (pipResult.error || pipResult.status !== 0) {
    console.error(
      `install digest: pip install failed (exit ${pipResult.status ?? "?"}).`,
    );
    return pipResult.status ?? 1;
  }

  // Smoke-check the console script registered correctly.
  const consoleScript = path.join(venvDir, "bin", "digital-me-digest");
  const smokeResult = spawnSync(consoleScript, ["--help"], { encoding: "utf-8" });
  if (smokeResult.status !== 0) {
    console.error(
      `install digest: console script smoke-test failed ` +
        `(exit ${smokeResult.status ?? "?"}). Install may be incomplete.`,
    );
    return smokeResult.status ?? 1;
  }

  // Register the bundled digest workflow + 7am schedule with the brain.
  const installWorkflowsArgs = ["-m", "digest.install_workflows"];
  if (wikiRoot) {
    installWorkflowsArgs.push("--wiki-root", wikiRoot);
  }
  console.log(`install digest: importing bundled workflow into the brain ...`);
  const wfResult = spawnSync(venvPython, installWorkflowsArgs, {
    stdio: "inherit",
    env: brainChildEnv(home, wikiRoot),
  });
  if (wfResult.status !== 0) {
    console.error(
      `install digest: workflow import returned exit ${wfResult.status ?? "?"}. ` +
        `The venv is ready, but the workflow isn't imported. ` +
        `Common causes: openclaw gateway not running, or auth token missing. ` +
        `Re-run later with: ${venvPython} -m digest.install_workflows`,
    );
  }

  // Self-verify the publisher contract is intact (hermetic — no brain/LLM/post).
  // A failure here means the digest can't reliably publish; surface it loudly.
  runDigestSmoke(venvPython, home);

  console.log(
    `\n[OK] installed digest:\n` +
      `       python:    ${venvPython}\n` +
      `       script:    ${consoleScript}\n` +
      `       wiki root: ${wikiRoot ?? "(default; pass --wiki-root to override)"}\n` +
      `\n` +
      `Before the first real post, set your chat channel (no default ships):\n` +
      `  • config.yaml →  digest:\n` +
      `                     discord_channel: <channel:ID or target>\n` +
      `                     channel_platform: discord   # or 'slack', etc.\n` +
      `    or env:  DIGITAL_ME_DIGEST_CHANNEL=... DIGITAL_ME_DIGEST_PLATFORM=slack\n` +
      `  • The digest is delivered at 07:00 daily (schedule 'daily-activity-digest').\n` +
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
    // The dashboard runs from the source workspace (its install dir is a
    // symlink into the checkout), so an npm-installed CLI genuinely cannot
    // set it up. Skip with guidance instead of failing the whole setup.
    console.log(
      "[SKIP] dashboard: requires a source checkout (the dashboard serves " +
        "from the repo workspace). To add it:\n" +
        "         git clone https://github.com/Amyssjj/digital-me.git ~/digital-me-os\n" +
        "         cd ~/digital-me-os && pnpm install && pnpm build\n" +
        "         pnpm dm install --runtime dashboard",
    );
    return 0;
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
    const wfResult = spawnSync(dcVenvPython, wfArgs, { stdio: "inherit", env: brainChildEnv(home, wikiRoot) });
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
    // The plugin runs inside the Hermes gateway process, whose env never has
    // DIGITAL_ME_BRAIN_URL (only the MCP stanza's `env:` does), so it reads
    // the pair from digital-me-brain.env beside __init__.py — written when
    // brain-host resolves, removed otherwise. Same detection as the MCP stanza.
    const brain = resolveBrainCallerEnv(
      process.env,
      resolveBrainHostServiceConfig(home, process.env, process.execPath),
      readTokenFileIfExists,
    );
    const sidecarNote = describeBrainSidecar(syncBrainSidecar(targetDir, brain));
    console.log(
      `[OK] hermes plugin: copied ${HERMES_RECALL_PLUGIN_NAME} → ${targetDir}`,
    );
    if (sidecarNote) console.log(`     hermes plugin: ${sidecarNote}`);
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
  // ~/.hermes/config.yaml is persistent user config: harden the same way as
  // claude-code. Hermes was found in 2026-09 still pointing at a worktree
  // deleted months earlier, pinned to a since-broken Cellar node.
  const hermesStable = stabilizeRegistration(process.execPath, BRAIN_MCP_PROXY_BIN);
  for (const note of hermesStable.notes) {
    console.log(`     hermes MCP: ${note}`);
  }
  // Backend for the proxy Hermes spawns: same detection as codex / claude-code.
  // The stanza's `env:` in ~/.hermes/config.yaml carries DIGITAL_ME_BRAIN_URL +
  // DIGITAL_ME_BRAIN_TOKEN_FILE (the path, never the secret) when the
  // brain-host token file exists; otherwise the proxy stays on the gateway.
  const hermesBrainCfg = resolveBrainHostServiceConfig(home, process.env, hermesStable.nodePath);
  const hermesBrain = resolveBrainCallerEnv(process.env, hermesBrainCfg, readTokenFileIfExists);
  console.log(
    hermesBrain
      ? `     hermes MCP: proxy env → brain-host at ${hermesBrain.brainUrl} (token file ${hermesBrain.brainTokenFile})`
      : `     hermes MCP: proxy env → openclaw gateway (no brain-host token at ${hermesBrainCfg.tokenFile}; run 'digital-me install --runtime brain-host' to switch)`,
  );
  const args = [
    "mcp",
    "add",
    "openclaw-brain",
    "--command",
    hermesStable.nodePath,
    // `hermes mcp add --help`: "--args ... must be the last option". With
    // --args before --env, argparse's REMAINDER swallowed the env flags into
    // the args list, so the proxy was launched with `--env OPENCLAW_HOME=...`
    // as positional arguments and NO environment at all (config showed
    // `env: None`). Keep --env first and --args strictly last.
    "--env",
    ...buildHermesMcpEnv({ openclawHome, agentId: "hermes", brain: hermesBrain }),
    "--args",
    hermesStable.binPath,
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
    `[OK] hermes MCP: registered openclaw-brain → ${hermesStable.binPath}`,
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
        `Add the wiki + tastes dirs to the memory-search block's extraPaths ` +
        `in ${mem.configPath} manually (memory.search on openclaw >= 2026.7.1, ` +
        `agents.defaults.memorySearch before — the schemas are strict, so the ` +
        `wrong one is rejected).`,
    );
  } else if (mem.added.length > 0) {
    console.log(
      `[OK] memory_search will index ${mem.added.length} new path(s) ` +
        `(${mem.added.join(", ")}) → ${mem.configPath}`,
    );
  } else {
    console.log(`     memory_search already indexes the wiki + tastes trees.`);
  }
  if (mem.ok && mem.seededLocalFallback) {
    console.log(
      `[OK] memory_search embeddings: no provider configured — seeded ` +
        `fallback: "local" (openclaw's keyless bundled embedder) so the index ` +
        `builds without an API key. Override under ` +
        `${mem.layout === "namespaced" ? "memory.search" : "agents.defaults.memorySearch"} ` +
        `in ${mem.configPath}.`,
    );
  }
  if (mem.ok && mem.json5Rewritten) {
    console.log(
      `     note: ${mem.configPath} contained JSON5 syntax (comments, trailing ` +
        `commas, …); it was rewritten as plain JSON — the same normalization ` +
        `openclaw's own config writer applies.`,
    );
  }

  console.log(
    `     Restart openclaw (gateway daemon) for the plugins to load and the\n` +
      `     memory index to pick up the wiki + tastes trees (indexing resumes\n` +
      `     asynchronously after restart).\n` +
      `     Then: 'digital-me doctor' should show all checks green.`,
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
  // Prerequisite: something for the adapters to connect to. brain-host is the
  // hub (and is installed first when it is part of this invocation); a legacy
  // openclaw gateway is accepted too. Neither brain-host itself nor the
  // openclaw plugin needs the gate.
  const ordered = orderRuntimesHubFirst(runtimes);
  const gated = runtimesNeedingBrain(ordered);
  if (!skipOpenclawCheck && gated.length > 0 && !ordered.includes("brain-host")) {
    const endpoint = detectBrainEndpoint({ home, env: process.env, fileExists: existsSync, which });
    if (endpoint.kind === "none") {
      console.error(noBrainEndpointMessage("the requested runtimes", brainHostTokenFileOf({ home, env: process.env })));
      return 2;
    }
  }
  let exit = 0;
  for (const r of ordered) {
    if (r === "claude-code") installClaudeCode(home);
    else if (r === "codex") installCodex(home);
    else if (r === "hermes") installHermes(home);
    else if (r === "openclaw") {
      const rc = await installOpenclaw(home, extensionsDir, wikiRoot);
      if (rc !== 0) exit = rc;
    } else if (r === "dream-cycle") {
      const rc = installDreamCycle(home, wikiRoot);
      if (rc !== 0) exit = rc;
    } else if (r === "digest") {
      const rc = installDigest(home, wikiRoot);
      if (rc !== 0) exit = rc;
    } else if (r === "brain-host") {
      const rc = await installBrainHost(home, noService);
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

  // Post-update smoke gate. An openclaw update re-materializes the worker/
  // overlay layer, which historically desynced the digest's summarizer→
  // publisher contract and silently broke the 7am cron. Catch a regression
  // HERE, at update time, instead of at 7am. Best-effort + non-fatal: the
  // digest may not be installed, and a digest issue must never fail an openclaw
  // update — but it must be LOUD when it happens.
  if (result.status !== "failed" && !opts.dryRun) {
    // When this machine is enrolled in the update sweep (health-sweep/profiles/
    // update.json in the source checkout + the global motus-sweep engine), run
    // the FULL gate: every registered pipeline smoke + contract pin, one verdict,
    // trustworthy exit codes (the update profile has no critique lane). Falls
    // back to the original single digest smoke when not enrolled, so a plain
    // OSS install behaves exactly as before.
    const sweepRepoRoot = resolveRepoRoot();
    const sweepCli = path.join(home, ".agents", "skills", "motus-sweep", "bin", "cli.mjs");
    const updateProfile = sweepRepoRoot
      ? path.join(sweepRepoRoot, "health-sweep", "profiles", "update.json")
      : null;
    if (updateProfile && existsSync(updateProfile) && existsSync(sweepCli)) {
      const sweep = spawnSync(
        "node",
        [sweepCli, "run", "update", "--repo", sweepRepoRoot!, "--note", "post-update gate (digital-me update)"],
        { stdio: "inherit" },
      );
      if ((sweep.status ?? 1) !== 0) {
        console.error(
          "\n[WARN] post-update sweep NOT green — one or more dependent pipelines " +
            "may be broken (see the sweep verdict above; report in " +
            "health-sweep/scorecard-update.md). The openclaw update itself succeeded.",
        );
      }
    } else {
      const digestVenvPython = path.join(
        home,
        ".venvs",
        DREAM_CYCLE_VENV_DIRNAME,
        "bin",
        "python3",
      );
      if (runDigestSmoke(digestVenvPython, home) !== 0) {
        console.error(
          "\n[WARN] post-update digest smoke FAILED — the daily digest may not " +
            "publish (see [digest-smoke] lines above). The openclaw update itself " +
            "succeeded. Repair with `digital-me install --runtime digest`, then " +
            "confirm with `python -m digest.smoke`.",
        );
      }
    }
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
  ensureWikiGitignore(wikiRoot);
  console.log(
    `[OK] init wiki dir at ${wikiRoot}: ${created} file(s) created, ${skipped} already present`,
  );
  return 0;
}

/**
 * `.data/` (brain.db, brain-host.token, .env with provider keys) must never
 * reach a wiki repo's remote. New roots get a full .gitignore from the plan;
 * existing ones get the missing entries merged in — never overwritten.
 */
function ensureWikiGitignore(wikiRoot: string): void {
  const file = path.join(wikiRoot, ".gitignore");
  if (!existsSync(file)) return; // planWikiInit created it, or the root is not a repo the user cares about
  const merged = ensureGitignoreEntries(readFileSync(file, "utf-8"));
  if (merged !== null) {
    writeFileSync(file, merged, "utf-8");
    console.log(`[OK] ${file}: added .data/ (brain.db, token, provider keys) to the ignore list`);
  }
}

/**
 * openclaw is an optional runtime (one of the agents the brain serves), not a
 * prerequisite. Detect a real install via the binary on PATH or its
 * config/data home (~/.openclaw) so setup can install the gateway plugin
 * where it applies and the doctor can skip openclaw rows where it does not.
 */
function isOpenclawInstalled(home: string): boolean {
  return probeOpenclawInstalled({ home, env: process.env, fileExists: existsSync, which });
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
  if (skipOpenclawCheck) {
    console.log(
      "[NOTE] --skip-openclaw-check is deprecated and has no effect: openclaw is no longer a prerequisite " +
        "(brain-host is the hub and setup installs it). The flag is accepted for existing scripts.",
    );
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

  // 2b. The hub. brain-host serves memory_search + the orchestrator on
  // :18791 and owns the scheduler tick; it goes in BEFORE the adapters so
  // their registrations bake its URL + token-file path in (see
  // resolveBrainCallerEnv). Its scheduler is ON here: setup is the one
  // place we know no other host ticks this brain.db — unless an openclaw
  // gateway plugin is present, in which case the plugin defers to
  // brain-host on its own (it checks for the token file).
  const brainHostRc = await installBrainHost(home, false, { scheduler: "on", wikiRoot });
  if (brainHostRc !== 0) {
    if (isOpenclawInstalled(home)) {
      console.log(
        `[WARN] brain-host install returned exit ${brainHostRc}. Adapters will fall back to the openclaw ` +
          `gateway (legacy hub). Fix it later with: digital-me install --runtime brain-host`,
      );
    } else {
      console.error(
        `[STOP] brain-host install returned exit ${brainHostRc} and no openclaw gateway is present — ` +
          `the adapters would have nothing to connect to. Fix the error above, then re-run digital-me setup.`,
      );
      return brainHostRc;
    }
  }
  console.log("");

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
      "[SKIP] --minimal: skipping the dream-cycle Python venv + dashboard build + digest.\n" +
        "       Add them later with:  digital-me install --runtime dream-cycle" +
        "  and  digital-me install --runtime dashboard" +
        "  and  digital-me install --runtime digest",
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

    // digest shares the dream-cycle venv, so it must install AFTER dream-cycle.
    const digestRc = installDigest(home, wikiRoot);
    if (digestRc !== 0) {
      console.log(
        `[WARN] digest install returned exit ${digestRc}. setup will continue ` +
          `but the daily digest won't post until this is fixed. ` +
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
    try {
      openclawInstallRc = await installOpenclaw(home, extensionsDirArg, wikiRoot);
    } catch (err) {
      // A thrown install (e.g. missing bundled assets) must not kill the
      // rest of setup with a raw stack — report and let the doctor flag it.
      openclawInstallRc = 1;
      console.error(
        `[FAIL] install openclaw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.log(
      `[SKIP] openclaw not detected — it is an optional runtime. If you add it later, run:\n` +
        `       digital-me install --runtime openclaw`,
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
  const doctorRuntimes: RuntimeId[] = ["brain-host", ...(detection.runtimes as RuntimeId[])];
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
  const setupEnvFile = resolveBrainHostServiceConfig(home, { ...process.env, DIGITAL_ME_WIKI_ROOT: wikiRoot }, which("node") ?? "node").envFile;
  console.log(`Next:`);
  console.log(`  • Put your provider key in ${setupEnvFile}  (one line: GEMINI_API_KEY=...).`);
  console.log(`    brain-host loads it for memory_search + every nightly worker; the doctor checks it there.`);
  console.log(`  • Review ${wikiRoot}/config.yaml (auto-created; sources pre-filled from detected CLIs).`);
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
  const toPath = toArg ?? resolveBrainDbPath({ env: process.env, home, exists: existsSync }).path;
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

// ─── brain-db: move brain.db to its canonical home ─────────────────────────

/**
 * `digital-me brain-db migrate [--dry-run]`. The planner (brain-db.ts)
 * decides from the shared contracts rule; this does the copy with SQLite's
 * `VACUUM INTO` (a consistent, compacted single-file snapshot that does not
 * need the -wal/-shm sidecars) and refuses while brain-host is serving the
 * legacy file, since a live writer would diverge from the copy.
 */
async function brainDbCommand(args: readonly string[]): Promise<number> {
  const action = args[0] ?? "migrate";
  const dryRun = args.includes("--dry-run");
  if (action !== "migrate") {
    console.error(`brain-db: unknown action '${action}'. Usage: digital-me brain-db migrate [--dry-run]`);
    return 2;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    console.error("brain-db: HOME / USERPROFILE not set");
    return 2;
  }
  const plan = planBrainDbMigration({ env: process.env, home, exists: existsSync });
  console.log(`brain-db: ${plan.message}`);
  if (plan.action !== "migrate") return plan.action === "explicit-env" ? 2 : 0;
  if (dryRun) {
    console.log(`[dry-run] would VACUUM INTO ${plan.to} from ${plan.from}; nothing written.`);
    return 0;
  }
  const nodeBin = which("node") ?? "node";
  const cfg = resolveBrainHostServiceConfig(home, process.env, nodeBin);
  if (await pollBrainHost(cfg.port, 1500)) {
    console.error(
      `brain-db: brain-host is serving on :${cfg.port} — stop it first so the copy cannot diverge:\n` +
        `  digital-me service brain-host uninstall\n` +
        `then re-run this command and finish with 'digital-me install --runtime brain-host'.`,
    );
    return 1;
  }
  mkdirSync(path.dirname(plan.to), { recursive: true });
  const { DatabaseSync: SqliteDatabase } = requireSqlite();
  const source = new SqliteDatabase(plan.from!, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${plan.to.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  const copied = new SqliteDatabase(plan.to, { readOnly: true });
  let goals: number;
  try {
    goals = Number((copied.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number }).n);
  } finally {
    copied.close();
  }
  console.log(`[OK] brain.db copied to ${plan.to} (${goals} goals). The legacy file was left in place.`);
  console.log("Next, so every reader picks the canonical path up:");
  for (const step of postMigrationSteps({
    brainHostInstalled: existsSync(cfg.tokenFile),
    dashboardInstalled: existsSync(dashboardInstallDir(home)),
    openclawInstalled: isOpenclawInstalled(home),
  })) {
    console.log(`  • ${step}`);
  }
  return 0;
}

function printHelp(): void {
  console.log(
    [
      "digital-me — install, doctor, and orchestrate the digital-me ecosystem.",
      "",
      "Usage:",
      "  digital-me setup [--wiki-root <path>] [--minimal]",
      "    One-shot: detect CLIs, init wiki dir, install brain-host (the hub:",
      "    memory_search + orchestrator on :18791, scheduler on), install the",
      "    adapters pointed at it, link the `digital-me` command onto PATH,",
      "    doctor. openclaw is optional — its plugin is installed only where",
      "    openclaw is present. --minimal skips the heavy optional services",
      "    (dream-cycle Python venv + dashboard build + digest).",
      "",
      "  digital-me init [--wiki-root <path>]",
      "    Scaffold wiki/, inbox/, .cache/, config.example.yaml.",
      "",
      "  digital-me doctor [--runtime <id>...]",
      "    Diagnose the environment.",
      "",
      "  digital-me install --runtime <id> [--runtime <id>...] [--no-service]",
      "    --runtime brain-host links the brain host, writes its token file,",
      "    builds the retrieval index (GEMINI_API_KEY from <wiki-root>/.data/.env,",
      "    or the legacy ~/.openclaw/.env) and installs the always-on service.",
      "    DIGITAL_ME_BRAIN_SCHEDULER=on|off sets its scheduler tick (default on",
      "    when no other host ticks brain.db). Adapters need a brain endpoint:",
      "    brain-host (installed first when listed) or a legacy openclaw gateway.",
      "    Install a specific runtime adapter. For --runtime dashboard, also",
      "    sets up an always-on service (launchd/systemd) so the dashboard",
      "    survives closing the terminal + reboot; --no-service skips that.",
      "",
      "  digital-me dashboard [--port <n>] [--no-open]",
      "    Launch the OA dashboard: open it in your browser if it's already",
      "    serving; otherwise start the always-on service first. --no-open",
      "    prints the URL instead of opening a browser.",
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
      "  digital-me brain-db migrate [--dry-run]",
      "    Move brain.db from the legacy ~/.openclaw/data/ location to its",
      "    canonical home <wiki-root>/.data/brain.db (SQLite VACUUM INTO — a",
      "    consistent snapshot). Refuses while brain-host is serving it; prints",
      "    the re-install steps every reader needs afterwards.",
      "",
      "  digital-me dream-cycle [args...]",
      "    Run the dream-cycle knowledge distillation pipeline. All args",
      "    after `dream-cycle` pass through to `python3 -m dream_cycle.run`.",
      "",
      "  digital-me dream-cycle import-workflow <path>",
      "    Import a workflow.json into the brain (brain-host, or a legacy gateway).",
      "",
      "  digital-me dream-cycle --via-agents [args...]",
      "    Run dream-cycle via brain-orchestrator spawn-dispatch instead of",
      "    inline-Python LLM. Requires an imported workflow + a running brain.",
      "",
      "Runtimes:",
      "  claude-code   5 hooks + digital-me skill into ~/.claude/",
      "  codex         CODEX.md + openclaw-brain MCP into ~/.codex/",
      "  hermes        SOUL.md digital-me protocol into ~/.hermes/",
      "  openclaw      (optional) gateway plugin — see @digital-me/runtime-openclaw README",
      "  brain-host    the hub: retriever + orchestrator service on :18791 (installed by setup)",
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

/**
 * `digital-me dashboard [--port <n>] [--no-open]` — launch the OA dashboard.
 * Already serving → open the browser. Installed but down → start the
 * always-on service (which HTTP-verifies), then open. Not installed →
 * exit 2 with install guidance. All decisions live in dashboard-command.ts.
 */
async function dashboardCommand(argv: readonly string[]): Promise<number> {
  const args = parseDashboardArgs(argv);
  if (args.help) {
    console.log(DASHBOARD_COMMAND_USAGE);
    return 0;
  }
  if (args.invalid !== undefined) {
    console.error(`dashboard: unknown or invalid argument: ${args.invalid}`);
    console.error(DASHBOARD_COMMAND_USAGE);
    return 2;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    console.error("dashboard: HOME / USERPROFILE not set");
    return 2;
  }
  const port = resolveDashboardPort(home, process.env, args.port);
  // Quick single-window probe — is something already serving the dashboard?
  const serving = await pollDashboard(port, 2000);
  const plan = planDashboardLaunch({
    serving,
    installDirExists: existsSync(dashboardInstallDir(home)),
    port,
  });
  if (plan.kind === "not-installed") {
    console.error(plan.hint);
    return 2;
  }
  if (plan.kind === "start-service") {
    console.log(`dashboard: not serving on :${port} yet — starting the always-on service ...`);
    const rc = await setupDashboardService(home);
    if (rc !== 0) return rc;
  }
  if (args.noOpen) {
    console.log(`[OK] dashboard serving at ${plan.url}`);
    return 0;
  }
  const opener = browserOpenCommand(process.platform, plan.url);
  if (!opener) {
    console.log(`[OK] dashboard serving at ${plan.url} (no browser opener on '${process.platform}' — open it manually)`);
    return 0;
  }
  const r = spawnSync(opener.cmd, opener.args as string[], { stdio: "ignore" });
  if (r.status !== 0) {
    console.log(`[OK] dashboard serving at ${plan.url} (browser open failed — open it manually)`);
    return 0;
  }
  console.log(`[OK] opened ${plan.url}`);
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
  if (target === "brain-host") {
    if (action === "install") return setupBrainHostService(home);
    if (action === "uninstall" || action === "remove") return removeBrainHostService(home);
    if (action === "status") return brainHostServiceStatus(home);
    console.error(`service brain-host: unknown action '${action}'. Use install | uninstall | status.`);
    return 2;
  }
  if (target !== "dashboard") {
    console.error(
      `service: unknown target '${target ?? ""}'. ` +
        `Usage: digital-me service <dashboard|brain-host> <install|uninstall|status>`,
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

// ─── brain-host: install + always-on service ──────────────────────────────

/**
 * `digital-me install --runtime brain-host`: link the stable install dir at
 * the brain-host package, build it (source checkout) or use the pre-bundled
 * copy the npm artifact ships, make sure the bearer token file exists, build
 * the retrieval index, and (unless --no-service) install the service.
 *
 * Scheduler tick: an explicit DIGITAL_ME_BRAIN_SCHEDULER wins; otherwise ON
 * on a machine with no openclaw gateway (nothing else can tick brain.db) and
 * OFF where openclaw is installed, because a gateway that has not yet been
 * restarted onto the current plugin template may still be ticking — exactly
 * one process may tick a brain.db.
 */
async function installBrainHost(
  home: string,
  noService: boolean,
  opts: { readonly scheduler?: "on" | "off"; readonly wikiRoot?: string } = {},
): Promise<number> {
  const packagePath = resolveBrainHostPackagePath();
  if (!packagePath) {
    console.error(
      "install brain-host: package not found — neither a source checkout (packages/services/brain-host) " +
        "nor the npm bundle's assets/brain-host. Reinstall the CLI (`npm install -g digital-me`) or clone " +
        "https://github.com/Amyssjj/digital-me.git, `pnpm install && pnpm build`, then `pnpm dm install --runtime brain-host`.",
    );
    return 2;
  }
  const repoRoot = resolveRepoRoot();
  const nodeBin = which("node");
  if (!nodeBin) {
    console.error("install brain-host: node not on PATH.");
    return 2;
  }
  const envForCfg = opts.wikiRoot ? { ...process.env, DIGITAL_ME_WIKI_ROOT: opts.wikiRoot } : process.env;
  const explicitScheduler = (process.env.DIGITAL_ME_BRAIN_SCHEDULER ?? "").toLowerCase();
  const scheduler: "on" | "off" =
    explicitScheduler === "on" || explicitScheduler === "off"
      ? explicitScheduler
      : (opts.scheduler ?? (isOpenclawInstalled(home) ? "off" : "on"));
  const cfg = resolveBrainHostServiceConfig(home, envForCfg, nodeBin, { scheduler });
  if (scheduler === "off" && explicitScheduler === "" && opts.scheduler === undefined) {
    console.log(
      "install brain-host: scheduler tick left OFF because an openclaw gateway is installed and may still tick brain.db. " +
        "Once the gateway runs the current digital-me-brain plugin (it defers to brain-host by itself), enable the tick with:\n" +
        "  DIGITAL_ME_BRAIN_SCHEDULER=on digital-me service brain-host install",
    );
  }
  ensureWikiGitignore(cfg.wikiRoot);

  mkdirSync(path.dirname(cfg.workingDir), { recursive: true });
  if (existsSync(cfg.workingDir)) {
    // Repoint if the symlink targets another checkout (worktree → main, …).
    let current = "";
    try {
      current = readlinkSync(cfg.workingDir);
    } catch {
      // Not a symlink — treated as a mismatch, same as `readlink` printing nothing.
    }
    if (current !== packagePath) {
      rmSync(cfg.workingDir, { recursive: false, force: true });
    }
  }
  if (!existsSync(cfg.workingDir)) {
    console.log(`install brain-host: linking ${cfg.workingDir} -> ${packagePath}`);
    const ln = spawnSync("ln", ["-s", packagePath, cfg.workingDir], { stdio: "inherit" });
    if (ln.status !== 0) return ln.status ?? 1;
  }

  const pnpmBin = repoRoot ? which("pnpm") : undefined;
  if (repoRoot && pnpmBin) {
    console.log("install brain-host: pnpm --filter @digital-me/brain-host... build");
    const build = spawnSync(pnpmBin, ["--filter", "@digital-me/brain-host...", "build"], { cwd: repoRoot, stdio: "inherit" });
    if (build.status !== 0) {
      console.error(`install brain-host: build failed (exit ${build.status ?? "?"}).`);
      return build.status ?? 1;
    }
  } else if (!repoRoot) {
    console.log(`install brain-host: using the pre-bundled service shipped with the CLI (${packagePath})`);
  }

  if (!existsSync(cfg.tokenFile)) {
    mkdirSync(path.dirname(cfg.tokenFile), { recursive: true });
    writeFileSync(cfg.tokenFile, randomBytes(24).toString("hex") + "\n", { encoding: "utf-8", mode: 0o600 });
    console.log(`install brain-host: wrote bearer token to ${cfg.tokenFile}`);
  }

  console.log("install brain-host: building the retrieval index ...");
  const idx = spawnSync(
    nodeBin,
    [`--env-file-if-exists=${cfg.envFile}`, path.join(cfg.workingDir, "bin", "brain-host.mjs"), "index"],
    { stdio: "inherit", env: { ...process.env, DIGITAL_ME_WIKI_ROOT: cfg.wikiRoot } },
  );
  if (idx.status !== 0) {
    console.error(
      "install brain-host: index build failed (is GEMINI_API_KEY set in " + cfg.envFile + "?). " +
        "The service will start but memory_search stays unavailable until `brain-host index` succeeds.",
    );
  }

  if (noService) {
    console.log("install brain-host: skipped always-on service (--no-service). Enable later with 'digital-me service brain-host install'.");
    return 0;
  }
  const sc = await setupBrainHostService(home, { scheduler, wikiRoot: opts.wikiRoot });
  if (sc !== 0) {
    console.error("install brain-host: service did not complete; retry with 'digital-me service brain-host install'.");
  }
  return sc;
}

/**
 * Where the brain-host package lives: the workspace package in a source
 * checkout, else the pre-bundled copy `scripts/build-cli-bundle.mjs` stages
 * under the npm artifact's assets/brain-host (single-file bin, workspace deps
 * inlined). undefined when neither exists.
 */
function resolveBrainHostPackagePath(): string | undefined {
  const repoRoot = resolveRepoRoot();
  if (repoRoot) {
    const pkg = path.join(repoRoot, "packages", "services", "brain-host");
    return existsSync(path.join(pkg, "bin", "brain-host.mjs")) ? pkg : undefined;
  }
  // npm artifact: this file is <npm-root>/bin/digital-me.js and the bundle
  // stages the service at <npm-root>/assets/brain-host (see build-cli-bundle).
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "brain-host");
  return existsSync(path.join(bundled, "bin", "brain-host.mjs")) ? bundled : undefined;
}

async function pollBrainHost(port: number, totalMs: number): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleepMs(500);
  }
  return false;
}

async function setupBrainHostService(
  home: string,
  opts: { readonly scheduler?: "on" | "off"; readonly wikiRoot?: string } = {},
): Promise<number> {
  const platform = servicePlatform();
  if (!platform) {
    console.log(`service brain-host: no supported service manager on '${process.platform}'.`);
    return 0;
  }
  const nodeBin = which("node");
  if (!nodeBin) {
    console.error("service brain-host: node not on PATH.");
    return 2;
  }
  const envForCfg = opts.wikiRoot ? { ...process.env, DIGITAL_ME_WIKI_ROOT: opts.wikiRoot } : process.env;
  const cfg = resolveBrainHostServiceConfig(home, envForCfg, nodeBin, opts.scheduler ? { scheduler: opts.scheduler } : {});
  if (!existsSync(path.join(cfg.workingDir, "bin", "brain-host.mjs"))) {
    console.error(`service brain-host: install dir missing (${cfg.workingDir}). Run 'digital-me install --runtime brain-host' first.`);
    return 2;
  }
  if (!existsSync(cfg.tokenFile)) {
    console.error(`service brain-host: token file missing (${cfg.tokenFile}). Run 'digital-me install --runtime brain-host' first.`);
    return 2;
  }
  const unitPath = brainHostServiceUnitPath(home, platform);
  mkdirSync(path.dirname(unitPath), { recursive: true });
  mkdirSync(path.dirname(cfg.stdoutLog), { recursive: true });
  writeFileSync(unitPath, buildBrainHostServiceUnit(cfg, platform), "utf-8");
  console.log(`service brain-host: wrote ${unitPath} (scheduler ${cfg.scheduler})`);

  if (platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    const target = `${domain}/${cfg.label}`;
    spawnSync("launchctl", ["bootout", target], { stdio: "ignore" });
    await waitForLaunchdGone(target, 10000);
    let boot = spawnSync("launchctl", ["bootstrap", domain, unitPath], { encoding: "utf-8" });
    for (let attempt = 0; attempt < 3 && boot.status !== 0 && isTransientBootstrapError(boot.stderr, boot.status); attempt++) {
      await waitForLaunchdGone(target, 5000);
      await sleepMs(1500);
      boot = spawnSync("launchctl", ["bootstrap", domain, unitPath], { encoding: "utf-8" });
    }
    if (boot.status !== 0) {
      console.error(`service brain-host: launchctl bootstrap failed: ${(boot.stderr ?? "").trim()}`);
      return boot.status ?? 1;
    }
    spawnSync("launchctl", ["kickstart", "-k", target], { stdio: "ignore" });
  } else {
    spawnSync("systemctl", ["--user", "stop", `${cfg.label}.service`], { stdio: "ignore" });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    const en = spawnSync("systemctl", ["--user", "enable", "--now", `${cfg.label}.service`], { encoding: "utf-8" });
    if (en.status !== 0) {
      console.error(`service brain-host: systemctl enable failed: ${en.stderr ?? ""}`.trim());
      return en.status ?? 1;
    }
  }

  process.stdout.write(`service brain-host: verifying http://127.0.0.1:${cfg.port}/health ...`);
  const ok = await pollBrainHost(cfg.port, 30000);
  console.log(ok ? " OK" : " (not responding yet)");
  if (!ok) {
    const holder = portHolder(cfg.port);
    console.error(
      holder
        ? `service brain-host: port ${cfg.port} is already in use by ${holder}.`
        : `service brain-host: loaded but not serving on :${cfg.port} yet — check ${platform === "darwin" ? cfg.stderrLog : `journalctl --user -u ${cfg.label}`}.`,
    );
    return 1;
  }
  console.log(
    `[OK] brain-host is always-on at ${brainHostInvokeUrl(cfg)} (scheduler ${cfg.scheduler}).\n` +
      `     Point callers at it with:\n` +
      `       export DIGITAL_ME_BRAIN_URL=${brainHostInvokeUrl(cfg)}\n` +
      `     (the bearer token is read from ${cfg.tokenFile}; set DIGITAL_ME_BRAIN_TOKEN_FILE only if you move it —\n` +
      `      never export the secret itself). Re-run 'digital-me install --runtime claude-code|codex|hermes' to bake\n` +
      `      the URL + token-file path into each client's registration.`,
  );
  return 0;
}

function removeBrainHostService(home: string): number {
  const platform = servicePlatform();
  if (!platform) return 0;
  const unitPath = brainHostServiceUnitPath(home, platform);
  if (platform === "darwin") {
    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${BRAIN_HOST_SERVICE_LABEL}`], { stdio: "ignore" });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", `${BRAIN_HOST_SERVICE_LABEL}.service`], { stdio: "ignore" });
  }
  if (existsSync(unitPath)) {
    rmSync(unitPath);
    console.log(`service brain-host: removed ${unitPath}`);
  }
  if (platform === "linux") spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  console.log("[OK] brain-host service removed.");
  return 0;
}

function brainHostServiceStatus(home: string): number {
  const platform = servicePlatform();
  if (!platform) {
    console.log(`service brain-host: no supported service manager on ${process.platform}.`);
    return 0;
  }
  const unitPath = brainHostServiceUnitPath(home, platform);
  console.log(`unit file: ${existsSync(unitPath) ? unitPath : "(not installed)"}`);
  const r =
    platform === "darwin"
      ? spawnSync("launchctl", ["list", BRAIN_HOST_SERVICE_LABEL], { encoding: "utf-8" })
      : spawnSync("systemctl", ["--user", "status", `${BRAIN_HOST_SERVICE_LABEL}.service`], { encoding: "utf-8" });
  console.log((r.stdout || r.stderr || "(not loaded)").trim());
  return 0;
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
  // Expected marker = what this host's config entitles the plugin to register.
  // Derived from the same grant the plugin reads, so a missing
  // allowConversationAccess shows up here as a divergence rather than as a
  // recall outage nobody notices.
  const expected = ((): string | null => {
    const cfgPath = resolveOpenclawConfigPath(home, process.env);
    if (!existsSync(cfgPath)) return null;
    try {
      return expectedRecallAckMode(JSON5.parse(readFileSync(cfgPath, "utf-8")));
    } catch {
      return null;
    }
  })();
  const logPath = resolveGatewayLog(process.env, home);
  if (!logPath) {
    console.log(
      "deploy openclaw: no gateway log found — restart succeeded but cannot verify the live marker yet. " +
        "Marker will confirm on the first agent turn after the gateway emits its log.",
    );
    return true;
  }
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
          `deploy openclaw: DIVERGENCE — live marker (${live}) != expected (${expected}). ` +
            `The host registered a different set of ack hooks than the config entitles. ` +
            `If 'agent_end' is missing live, plugins.entries.digital-me-recall.hooks` +
            `.allowConversationAccess is not being honoured — run ` +
            `scripts/verify_openclaw_hooks.sh.`,
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
  // `dashboard` launches the OA dashboard (start if needed + open browser).
  // Owns its own flags (--port/--no-open), so route before the flag parser.
  if (process.argv[2] === "dashboard") {
    return dashboardCommand(process.argv.slice(3));
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
  if (cmd === "brain-db") return brainDbCommand(process.argv.slice(3));
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
