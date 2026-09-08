/**
 * `digital-me doctor` — check that the digital-me ecosystem is wired up
 * correctly. Pure data layer: returns a structured DoctorReport that the
 * binary serializes to text. All I/O (fs.exists, process spawn) is
 * injected so the diagnostics are testable.
 *
 * Checks (a partial list — extend as Phase 8.5 dogfood surfaces gaps):
 *   1. `DIGITAL_ME_WIKI_ROOT` is set and the directory exists.
 *   2. The openclaw config file is readable.
 *   3. Each enabled runtime has its hook scripts / templates installed.
 *   4. The brain MCP proxy is on PATH.
 *   5. The memory index is actually wired: the wiki + tastes dirs exist, both
 *      sit in openclaw's memory-search `extraPaths` (`memory.search` on
 *      >= 2026.7.1, `agents.defaults.memorySearch` before), and the
 *      embedding config can build an index on this machine (openclaw's
 *      default provider is `openai`, which silently indexes nothing without
 *      an API key — the #1 "memory_search finds nothing" fresh-install trap).
 */

import JSON5 from "json5";
import {
  CONVERSATION_HOOK_PLUGIN_IDS,
  KEY_OPTIONAL_EMBEDDING_PROVIDERS,
  detectMemorySearchLayout,
  digitalMeKnowledgePaths,
  resolveOpenclawConfigPath,
} from "./openclaw-memory.js";

export type CheckResult =
  | { readonly ok: true; readonly label: string; readonly note?: string }
  | { readonly ok: false; readonly label: string; readonly reason: string };

export type DoctorReport = {
  readonly checks: readonly CheckResult[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
  };
};

export type DoctorDeps = {
  readonly fileExists: (path: string) => boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly which: (cmd: string) => string | undefined;
  /**
   * Read a file as UTF-8. Optional — when undefined, checks that need file
   * CONTENT (the memory-index wiring group) report themselves as skipped
   * rather than failing, mirroring the execCommand convention below.
   */
  readonly readFile?: (path: string) => string;
  /**
   * Absolute path to the brain-mcp-proxy bin file (resolved by the caller
   * from @digital-me/brain-mcp-proxy's BIN_PATH export). The doctor checks
   * the file exists. Optional — when undefined the check is skipped.
   */
  readonly brainMcpProxyBinPath?: string;
  /**
   * Spawn a child process and capture its result. Optional — when
   * undefined, checks that need it (python version, dream_cycle import)
   * are reported as "skipped" rather than failing.
   */
  readonly execCommand?: (
    cmd: string,
    args: readonly string[],
  ) => { readonly status: number; readonly stdout: string; readonly stderr: string };
  /**
   * Absolute path of the digital-me-os repo root, when the CLI is
   * running from a source checkout (as opposed to an npm-installed
   * global). When set, install hints inline `<repoRoot>/packages/.../`
   * so the user can copy-paste; when unset, hints fall back to the
   * `<digital-me-os-repo>` placeholder.
   */
  readonly repoRoot?: string;
  /**
   * Provenance of every workflow template in the brain, for the
   * template-drift check. Optional — when undefined the check reports
   * itself as skipped, matching the execCommand/readFile convention.
   *
   * Kept as an injected reader rather than a DB handle so this module
   * stays free of sqlite: the caller owns opening the brain.
   */
  readonly workflowProvenance?: () => readonly WorkflowProvenance[];
  /** sha256 of a file's raw bytes; undefined when unreadable. */
  readonly hashFile?: (path: string) => string | undefined;
};

/** One template's link back to the file it was imported from. */
export type WorkflowProvenance = {
  readonly id: string;
  readonly sourcePath?: string;
  readonly sourceHash?: string;
  readonly importedAt?: number;
};

export type RuntimeId =
  | "claude-code"
  | "codex"
  | "hermes"
  | "openclaw"
  | "dream-cycle"
  | "dashboard"
  | "digest";

/** What each runtime expects to find on disk. */
export const RUNTIME_EXPECTATIONS: Readonly<
  Record<RuntimeId, ReadonlyArray<string>>
> = {
  "claude-code": [
    "$HOME/.claude/hooks/dm_memory_search_inject.sh",
    "$HOME/.claude/hooks/brain_route_inject.sh",
    "$HOME/.claude/hooks/dm_handoff_reminder.sh",
    "$HOME/.claude/hooks/dm_session_extract.sh",
    "$HOME/.claude/hooks/analyze_brain_inject.py",
    "$HOME/.claude/skills/digital-me/SKILL.md",
  ],
  codex: [
    "$HOME/.codex/CODEX.md",
    "$HOME/.codex/config.toml",
    "$HOME/.codex/hooks.json",
    "$HOME/.codex/hooks/dm_memory_search_inject.sh",
    "$HOME/.codex/hooks/dm_application_rate.sh",
    "$HOME/.codex/hooks/dm_m1_emit.py",
  ],
  hermes: ["$HOME/.hermes/SOUL.md"],
  // dream-cycle is a Python sibling package. After `digital-me install
  // --runtime dream-cycle`, these files mark the venv as set up.
  "dream-cycle": [
    "$HOME/.venvs/dream-cycle/bin/python3",
    "$HOME/.venvs/dream-cycle/bin/digital-me-dream-cycle",
  ],
  // openclaw runtime install is verified by the presence of the
  // digital-me-brain plugin in the CANONICAL state-dir extensions folder
  // (~/.openclaw/extensions — highest load precedence, build/checkout immune),
  // NOT the old ~/openclaw/extensions overlay (lowest precedence, shadowed by
  // the build's dist/extensions). The actual openclaw config (openclaw.json —
  // NOT config.json) is checked separately above via the openclawCandidates
  // fallback list. Stale shadow copies are flagged by runOpenclawShadowCheck.
  openclaw: ["$HOME/.openclaw/extensions/digital-me-brain/index.mjs"],
  // dashboard is a Node service (Vite + Express). After `digital-me install
  // --runtime dashboard`, the install symlink under ~/.local/share/...
  // points at the workspace package (which carries node_modules + dist).
  // The sqlite DB lives under ~/digital-me/.data/ (collapsed root, NOT
  // next to the package) and is populated by the dashboard-intake
  // workflow registered at install time.
  // Markers the dashboard install actually produces:
  //   - dist/index.html — the Vite-built client. The SERVER runs via
  //     `tsx src/server/server.ts` (no compiled server bundle exists), and it
  //     serves this built client from dist/ — so dist/index.html is the real
  //     "is it installed + built" marker. (The previous dist/server/server.js
  //     expectation checked for a file the build NEVER produces, so it FAILed
  //     on every correct install.)
  //   - ~/digital-me/.data/dashboard.json — the discovery file written
  //     unconditionally at the end of a successful install.
  //   - ~/digital-me/.data/dashboard.db — the migrated SQLite store.
  dashboard: [
    "$HOME/.local/share/digital-me/dashboard/dist/index.html",
    "$HOME/digital-me/.data/dashboard.json",
    "$HOME/digital-me/.data/dashboard.db",
  ],
  // digest is a Python sibling package that SHARES the dream-cycle venv (it
  // reuses dream-cycle's brain client for workflow registration, and its
  // optional inline-summary fallback imports dream_cycle). After
  // `digital-me install --runtime digest`, the console script in that shared
  // venv marks it as set up.
  digest: ["$HOME/.venvs/dream-cycle/bin/digital-me-digest"],
};

export function runDoctor(
  deps: DoctorDeps,
  enabledRuntimes: readonly RuntimeId[],
): DoctorReport {
  const checks: CheckResult[] = [];

  // Wiki root
  const wikiRoot = deps.env.DIGITAL_ME_WIKI_ROOT;
  if (!wikiRoot) {
    checks.push({
      ok: false,
      label: "DIGITAL_ME_WIKI_ROOT",
      reason: "Env var not set. Export it to your wiki directory.",
    });
  } else if (!deps.fileExists(expand(deps.env, wikiRoot))) {
    checks.push({
      ok: false,
      label: "DIGITAL_ME_WIKI_ROOT",
      reason: `Path does not exist: ${wikiRoot}`,
    });
  } else {
    checks.push({
      ok: true,
      label: "DIGITAL_ME_WIKI_ROOT",
      note: wikiRoot,
    });
  }

  // openclaw config (canonical path first, then legacy fallbacks)
  const openclawCandidates = [
    deps.env.DIGITAL_ME_OPENCLAW_CONFIG,
    "$HOME/.openclaw/openclaw.json",
    "$HOME/.openclaw/config.json",
    "$HOME/.clawdbot/openclaw.json",
  ].filter((p): p is string => !!p);
  const foundOpenclaw = openclawCandidates
    .map((p) => expand(deps.env, p))
    .find((p) => deps.fileExists(p));
  if (foundOpenclaw) {
    checks.push({
      ok: true,
      label: "openclaw config",
      note: foundOpenclaw,
    });
  } else {
    checks.push({
      ok: false,
      label: "openclaw config",
      reason: `Not found at any of: ${openclawCandidates.join(", ")}`,
    });
  }

  // brain MCP proxy bin
  //
  // We no longer require it to be on $PATH — `digital-me install --runtime
  // codex|claude-code` writes the absolute path of brain-mcp-proxy.mjs into
  // each client's config, so no global install needed. The doctor just
  // verifies the proxy bin file exists at the path we'd install.
  //
  // The path is resolved via `BRAIN_MCP_PROXY_BIN` from @digital-me/brain-mcp-proxy
  // — but doctor stays in pure-data layer, so we accept the path as a dep.
  const proxyBinPath = deps.brainMcpProxyBinPath;
  if (proxyBinPath && deps.fileExists(proxyBinPath)) {
    checks.push({
      ok: true,
      label: "brain-mcp-proxy bin",
      note: proxyBinPath,
    });
  } else if (proxyBinPath) {
    checks.push({
      ok: false,
      label: "brain-mcp-proxy bin",
      reason: `Not found at ${proxyBinPath}. Re-run \`pnpm --filter @digital-me/brain-mcp-proxy build\` from the digital-me-os repo.`,
    });
  } else {
    // No path provided by the caller — treat as "unknown, not a failure"
    checks.push({
      ok: true,
      label: "brain-mcp-proxy bin",
      note: "(skipped — caller did not provide BRAIN_MCP_PROXY_BIN)",
    });
  }

  // dream-cycle: python3 >= 3.11 + the dream_cycle module is importable.
  // Run these whenever dream-cycle was requested OR its venv exists. On a
  // node-only machine that deliberately skipped it (`setup --minimal`), a
  // missing python3 is reported as a skip-note, not a FAIL — otherwise the
  // exact configuration --minimal exists for ends with a red doctor.
  checks.push(
    ...runDreamCycleChecks(deps, enabledRuntimes.includes("dream-cycle")),
  );

  // Per-runtime expectations
  for (const runtime of enabledRuntimes) {
    for (const expected of RUNTIME_EXPECTATIONS[runtime]) {
      const resolved = expand(deps.env, expected);
      const ok = deps.fileExists(resolved);
      checks.push(
        ok
          ? {
              ok: true,
              label: `${runtime}: ${expected}`,
            }
          : {
              ok: false,
              label: `${runtime}: ${expected}`,
              reason: `Missing — run 'digital-me install --runtime ${runtime}'.`,
            },
      );
    }
  }

  // openclaw: flag stale SHADOW copies that can override the canonical
  // state-dir install. Load precedence is
  // ~/.openclaw/extensions ▸ ~/openclaw/dist/extensions ▸ ~/openclaw/extensions,
  // so a leftover copy in either lower dir is a latent landmine — it silently
  // takes over if the state-dir copy is ever removed, and the dist/extensions
  // one is a stale build artifact. Deploy ONLY to the state dir.
  if (enabledRuntimes.includes("openclaw")) {
    checks.push(...runMemoryIndexChecks(deps));
    checks.push(...runOpenclawShadowCheck(deps));
  }

  if (enabledRuntimes.includes("dream-cycle")) {
    checks.push(...runWorkflowDriftChecks(deps));
  }

  const passed = checks.filter((c) => c.ok).length;
  return {
    checks,
    summary: {
      total: checks.length,
      passed,
      failed: checks.length - passed,
    },
  };
}

/**
 * The lower-precedence openclaw extension locations where a stale digital-me-*
 * copy can shadow (or, on state-dir removal, override) the canonical
 * `~/.openclaw/extensions` install. Keyed by the entry filename each location
 * uses: the stock build compiles to `index.js`; the overlay carries `index.mjs`.
 */
export const OPENCLAW_SHADOW_LOCATIONS: readonly {
  readonly path: string;
  readonly what: string;
}[] = [
  {
    path: "$HOME/openclaw/dist/extensions/digital-me-brain/index.js",
    what: "stock-build output (dist/extensions) — stale, higher precedence than the overlay",
  },
  {
    path: "$HOME/openclaw/dist/extensions/digital-me-recall/index.js",
    what: "stock-build output (dist/extensions) — stale, higher precedence than the overlay",
  },
  {
    path: "$HOME/openclaw/extensions/digital-me-brain/index.mjs",
    what: "overlay (~/openclaw/extensions) — lowest precedence, never loads",
  },
  {
    path: "$HOME/openclaw/extensions/digital-me-recall/index.mjs",
    what: "overlay (~/openclaw/extensions) — lowest precedence, never loads",
  },
];

/**
 * Flag stale shadow copies of the digital-me plugins that sit in lower-precedence
 * openclaw extension dirs. Pure/data-layer: uses deps.fileExists only.
 */
export function runOpenclawShadowCheck(deps: DoctorDeps): CheckResult[] {
  const found = OPENCLAW_SHADOW_LOCATIONS.filter((loc) =>
    deps.fileExists(expand(deps.env, loc.path)),
  );
  if (found.length === 0) {
    return [
      {
        ok: true,
        label: "openclaw: no shadow plugin copies",
        note: "only the canonical ~/.openclaw/extensions install present",
      },
    ];
  }
  return found.map((loc) => ({
    ok: false,
    label: `openclaw shadow copy: ${expand(deps.env, loc.path)}`,
    reason:
      `Stale ${loc.what}. It can override the canonical ` +
      `~/.openclaw/extensions install. Remove it, then re-run ` +
      `'digital-me install --runtime openclaw'.`,
  }));
}

// ── Memory-index wiring checks ────────────────────────────────────────────
//
// "memory_search finds nothing" on a fresh install has three distinct causes,
// each individually green under the file-existence checks above: the wiki +
// tastes dirs don't exist yet (the gateway only indexes extraPaths dirs that
// exist at startup), the dirs aren't in extraPaths at all, or the embedding
// config can't build an index (openclaw defaults to the `openai` provider,
// which needs an API key). One check per cause, so a red doctor names the
// exact repair.

const KNOWLEDGE_DIRS_LABEL = "openclaw: knowledge dirs";
const MEMORY_PATHS_LABEL = "openclaw: memory_search extraPaths";
const EMBEDDINGS_LABEL = "openclaw: memory embeddings";
const HOOK_GRANT_LABEL = "openclaw: conversation-hook access";

/**
 * The failure this check exists for is invisible everywhere else: openclaw
 * silently DROPS a conversation typed hook when a non-bundled plugin has not
 * set `hooks.allowConversationAccess: true` — a warn diagnostic and an early
 * return, so the plugin still loads, still registers its tools, and still
 * reports healthy. Only the hooks are gone. On openclaw >= 2026.8.1 that set
 * includes `before_prompt_build`, i.e. the whole wiki-recall path; `agent_end`
 * (the M1 application-ack) has been gated for longer.
 *
 * Exported for direct unit testing.
 */
export function runConversationHookGrantCheck(
  cfg: Record<string, unknown>,
  configPath: string,
): CheckResult {
  const entries = asObject(asObject(cfg.plugins).entries);
  const ungranted = CONVERSATION_HOOK_PLUGIN_IDS.filter(
    (id) => asObject(asObject(entries[id]).hooks).allowConversationAccess !== true,
  );
  if (ungranted.length === 0) {
    return {
      ok: true,
      label: HOOK_GRANT_LABEL,
      note: `granted for ${CONVERSATION_HOOK_PLUGIN_IDS.join(", ")}`,
    };
  }
  return {
    ok: false,
    label: HOOK_GRANT_LABEL,
    reason:
      `${ungranted.join(", ")} lack plugins.entries.<id>.hooks.allowConversationAccess=true ` +
      `in ${configPath}. openclaw silently drops their before_prompt_build / agent_end ` +
      `hooks — recall injection and the M1 ack go to zero with no error. Run ` +
      `'digital-me install --runtime openclaw' (idempotent), then restart the gateway.`,
  };
}

/** Coerce an unknown JSON node to an object, or {} when it isn't one. */
function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asTrimmedString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/**
 * Verify the memory index is actually wired end-to-end: knowledge dirs on
 * disk, both dirs listed in the memory-search block's `extraPaths` (whichever
 * layout this host uses), and
 * an embedding config that can index without manual surgery. Pure/data-layer.
 */
export function runMemoryIndexChecks(deps: DoctorDeps): CheckResult[] {
  const checks: CheckResult[] = [];
  const home = deps.env.HOME ?? deps.env.USERPROFILE ?? "";
  const configPath = resolveOpenclawConfigPath(home, deps.env);
  const knowledgePaths = digitalMeKnowledgePaths(home, undefined, deps.env);

  const missingDirs = knowledgePaths.filter((d) => !deps.fileExists(d));
  if (missingDirs.length === 0) {
    checks.push({
      ok: true,
      label: KNOWLEDGE_DIRS_LABEL,
      note: knowledgePaths.join(", "),
    });
  } else {
    checks.push({
      ok: false,
      label: KNOWLEDGE_DIRS_LABEL,
      reason:
        `Missing ${missingDirs.join(", ")} — run 'digital-me setup' (or ` +
        `'digital-me install --runtime openclaw') to create them. The openclaw ` +
        `gateway only indexes extraPaths dirs that exist at startup, so a dir ` +
        `created later stays unindexed until the next gateway restart.`,
    });
  }

  if (!deps.fileExists(configPath)) {
    checks.push({
      ok: false,
      label: MEMORY_PATHS_LABEL,
      reason:
        `${configPath} not found — run 'digital-me install --runtime openclaw' ` +
        `to wire the wiki + tastes index.`,
    });
    checks.push({
      ok: true,
      label: EMBEDDINGS_LABEL,
      note: "(skipped — openclaw config not found)",
    });
    return checks;
  }
  if (!deps.readFile) {
    checks.push({
      ok: true,
      label: MEMORY_PATHS_LABEL,
      note: "(skipped — caller did not provide readFile)",
    });
    checks.push({
      ok: true,
      label: EMBEDDINGS_LABEL,
      note: "(skipped — caller did not provide readFile)",
    });
    return checks;
  }

  let cfg: Record<string, unknown>;
  try {
    // openclaw parses this file as JSON5 (comments + trailing commas are
    // legal there) — mirror its dialect so a hand-annotated config the
    // gateway reads fine isn't reported broken here.
    cfg = asObject(JSON5.parse(deps.readFile(configPath)));
  } catch (err) {
    checks.push({
      ok: false,
      label: MEMORY_PATHS_LABEL,
      reason:
        `${configPath} could not be read as JSON5 ` +
        `(${err instanceof Error ? err.message : String(err)}). Fix it, then ` +
        `re-run 'digital-me install --runtime openclaw'.`,
    });
    checks.push({
      ok: true,
      label: EMBEDDINGS_LABEL,
      note: "(skipped — openclaw config unreadable)",
    });
    return checks;
  }

  // openclaw moved this block from `agents.defaults.memorySearch` to
  // `memory.search` in 2026.7.1. Read whichever layout the config uses and
  // name that one in any failure, so the repair hint points at a key that
  // actually exists on this host.
  const layout = detectMemorySearchLayout(cfg) ?? "legacy";
  const msKey =
    layout === "namespaced" ? "memory.search" : "agents.defaults.memorySearch";
  const ms =
    layout === "namespaced"
      ? asObject(asObject(cfg.memory).search)
      : asObject(asObject(asObject(cfg.agents).defaults).memorySearch);
  const extraPaths = Array.isArray(ms.extraPaths)
    ? ms.extraPaths.filter((x): x is string => typeof x === "string")
    : [];
  const missingPaths = knowledgePaths.filter((p) => !extraPaths.includes(p));
  if (missingPaths.length === 0) {
    checks.push({
      ok: true,
      label: MEMORY_PATHS_LABEL,
      note: `wiki + tastes wired in ${configPath} (${msKey})`,
    });
  } else {
    checks.push({
      ok: false,
      label: MEMORY_PATHS_LABEL,
      reason:
        `${msKey}.extraPaths is missing ` +
        `${missingPaths.join(", ")} — run 'digital-me install --runtime openclaw' ` +
        `(idempotent), then restart the openclaw gateway.`,
    });
  }

  checks.push(runConversationHookGrantCheck(cfg, configPath));

  checks.push(runEmbeddingsCheck(deps.env, ms, msKey));
  return checks;
}

/**
 * Effective-embeddings viability. openclaw defaults the memory embedding
 * provider to `openai` (remote, key required): with that IMPLICIT default and
 * no detectable key, the index silently never builds — that exact case FAILs.
 * An explicit provider choice is trusted (openclaw's own `openclaw doctor`
 * validates keys/endpoints end-to-end); key-optional providers (`local`,
 * `ollama`, `lmstudio`) — as primary or fallback — always pass. Exported for
 * direct unit testing.
 */
export function runEmbeddingsCheck(
  env: Readonly<Record<string, string | undefined>>,
  memorySearch: Readonly<Record<string, unknown>>,
  /** Config key the block lives under on THIS host, for the repair hint. */
  msKey: string = "agents.defaults.memorySearch",
): CheckResult {
  const provider = asTrimmedString(memorySearch.provider);
  const fallback = asTrimmedString(memorySearch.fallback);
  if (provider && KEY_OPTIONAL_EMBEDDING_PROVIDERS.has(provider)) {
    return {
      ok: true,
      label: EMBEDDINGS_LABEL,
      note: `provider=${provider} (runs without an API key)`,
    };
  }
  if (fallback && KEY_OPTIONAL_EMBEDDING_PROVIDERS.has(fallback)) {
    return {
      ok: true,
      label: EMBEDDINGS_LABEL,
      note:
        `provider=${provider ?? "openai (default)"}, fallback=${fallback} — ` +
        `index builds even without an API key`,
    };
  }
  if (provider) {
    return {
      ok: true,
      label: EMBEDDINGS_LABEL,
      note:
        `provider=${provider} — key not verified here; ` +
        `'openclaw doctor' validates embeddings end-to-end`,
    };
  }
  const remoteApiKey = asTrimmedString(asObject(memorySearch.remote).apiKey);
  if (remoteApiKey ?? asTrimmedString(env.OPENAI_API_KEY)) {
    return {
      ok: true,
      label: EMBEDDINGS_LABEL,
      note: "provider=openai (default), API key detected",
    };
  }
  return {
    ok: false,
    label: EMBEDDINGS_LABEL,
    reason:
      "memory_search embeddings default to the 'openai' provider but no API key " +
      `was found ($OPENAI_API_KEY / ${msKey}.remote.apiKey) — ` +
      "the wiki + tastes index will NOT build. Re-run 'digital-me install " +
      "--runtime openclaw' (seeds the keyless fallback: 'local'), or set " +
      `${msKey}.provider + key. 'openclaw doctor' validates ` +
      "embeddings end-to-end.",
  };
}

/**
 * Render a DoctorReport into a human-readable string for terminal output.
 * One line per check; trailing summary line.
 */
export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    if (c.ok) {
      const note = c.note ? ` (${c.note})` : "";
      lines.push(`[OK]   ${c.label}${note}`);
    } else {
      lines.push(`[FAIL] ${c.label} — ${c.reason}`);
    }
  }
  const { total, passed, failed } = report.summary;
  lines.push("");
  lines.push(`Summary: ${passed}/${total} passed, ${failed} failed.`);
  return lines.join("\n");
}

function expand(
  env: Readonly<Record<string, string | undefined>>,
  s: string,
): string {
  return s
    .replace(/\$HOME/g, env.HOME ?? "$HOME")
    .replace(/\$\{HOME\}/g, env.HOME ?? "$HOME");
}

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 11;

/** Return [major, minor] from a `python3 --version` string, or null. */
export function parsePythonVersion(output: string): [number, number] | null {
  const m = output.match(/Python\s+(\d+)\.(\d+)/);
  if (!m) return null;
  // The `\d+` captures guarantee parseInt yields a (finite or not) number,
  // never NaN — so no NaN guard is needed here.
  const major = Number.parseInt(m[1]!, 10);
  const minor = Number.parseInt(m[2]!, 10);
  return [major, minor];
}

function runDreamCycleChecks(
  deps: DoctorDeps,
  requested: boolean,
): CheckResult[] {
  const checks: CheckResult[] = [];
  // Prefer the dream-cycle venv's python3 when it exists (set up by
  // `digital-me install --runtime dream-cycle`); fall back to system
  // python3 on PATH. This way users who installed via the canonical
  // path get a green doctor without having to add the venv to PATH
  // first.
  const venvPython = expand(deps.env, "$HOME/.venvs/dream-cycle/bin/python3");
  const installed = deps.fileExists(venvPython);
  // Not installed and not asked for: a node-only machine (e.g. `setup
  // --minimal`). Report as informational skips, not failures.
  if (!installed && !requested) {
    const note =
      "(skipped — dream-cycle not installed; add it with " +
      "'digital-me install --runtime dream-cycle')";
    checks.push(
      { ok: true, label: "dream-cycle: python3", note },
      { ok: true, label: "dream-cycle: dream_cycle module", note },
    );
    return checks;
  }
  const python = installed ? venvPython : deps.which("python3");
  if (!python) {
    checks.push({
      ok: false,
      label: "dream-cycle: python3",
      reason: "python3 not on PATH (need >= 3.11). Install Python.",
    });
    // No point in the dream_cycle import check if python3 itself is missing.
    checks.push({
      ok: false,
      label: "dream-cycle: dream_cycle module",
      reason: "skipped — python3 missing",
    });
    return checks;
  }

  if (!deps.execCommand) {
    checks.push({
      ok: true,
      label: "dream-cycle: python3",
      note: `${python} (version check skipped — caller did not provide execCommand)`,
    });
    checks.push({
      ok: true,
      label: "dream-cycle: dream_cycle module",
      note: "(skipped — caller did not provide execCommand)",
    });
    return checks;
  }

  const versionResult = deps.execCommand(python, ["--version"]);
  // python prints version to stdout on 3.4+, stderr on older builds.
  const versionOutput =
    versionResult.stdout.trim() || versionResult.stderr.trim();
  const parsed = parsePythonVersion(versionOutput);
  if (versionResult.status !== 0 || !parsed) {
    checks.push({
      ok: false,
      label: "dream-cycle: python3",
      reason: `'${python} --version' failed (exit ${versionResult.status}): ${
        versionOutput || "(no output)"
      }`,
    });
  } else {
    const [maj, min] = parsed;
    const okVersion =
      maj > MIN_PYTHON_MAJOR ||
      (maj === MIN_PYTHON_MAJOR && min >= MIN_PYTHON_MINOR);
    if (okVersion) {
      checks.push({
        ok: true,
        label: "dream-cycle: python3",
        note: `${python} (${maj}.${min})`,
      });
    } else {
      checks.push({
        ok: false,
        label: "dream-cycle: python3",
        reason: `${python} reports ${maj}.${min}; need >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}.`,
      });
    }
  }

  const importResult = deps.execCommand(python, [
    "-c",
    "import dream_cycle; print(dream_cycle.__file__ or '')",
  ]);
  const moduleImported = importResult.status === 0;
  if (moduleImported) {
    const loc = importResult.stdout.trim();
    checks.push({
      ok: true,
      label: "dream-cycle: dream_cycle module",
      note: loc || "importable",
    });
  } else {
    checks.push({
      ok: false,
      label: "dream-cycle: dream_cycle module",
      reason: buildModuleNotImportableReason(deps, python),
    });
  }

  // LLM auth — depends on both python3 + dream_cycle importable + a
  // readable config.yaml. Anything missing → skip rather than fail; the
  // upstream check has already surfaced the underlying problem.
  if (moduleImported) {
    checks.push(runLlmAuthCheck(deps, python));
  } else {
    checks.push({
      ok: true,
      label: "dream-cycle: LLM auth",
      note: "(skipped — dream_cycle module not importable)",
    });
  }

  return checks;
}

// Detect whether `python` belongs to an "externally-managed" environment
// per PEP 668. The marker is an `EXTERNALLY-MANAGED` file alongside the
// stdlib config — Homebrew, Debian, recent Ubuntu, and Fedora all ship it
// and reject system-wide `pip install`. Cheap, deterministic, no install
// side effect.
const EXTERNALLY_MANAGED_PROBE: readonly string[] = [
  "-c",
  "import sysconfig, os, sys; sys.stdout.write('true' if os.path.isfile(os.path.join(sysconfig.get_paths()['stdlib'], 'EXTERNALLY-MANAGED')) else 'false')",
];

function venvRecipe(packagePath: string): string {
  return [
    "  python3 -m venv ~/.venvs/dream-cycle",
    `  ~/.venvs/dream-cycle/bin/pip install -e ${packagePath}`,
    '  export PATH="$HOME/.venvs/dream-cycle/bin:$PATH"',
  ].join("\n");
}

/** Build a tailored "Not importable" hint based on the user's Python
 * environment. Differentiates between PEP 668 (Homebrew/Debian/etc.),
 * missing pip, and a working pip that just needs the install command.
 * Inlines the absolute repo path when available so the recipe is
 * copy-paste-and-go. Exported for direct unit testing. */
export function buildModuleNotImportableReason(
  deps: DoctorDeps,
  python: string,
): string {
  const packagePath = deps.repoRoot
    ? `${deps.repoRoot}/packages/services/dream-cycle`
    : "<digital-me-os-repo>/packages/services/dream-cycle";

  if (!deps.execCommand) {
    return (
      `Not importable. Install with \`pip install -e ${packagePath}\`. ` +
      `(Diagnostic probes skipped — caller did not provide execCommand.)`
    );
  }
  const extMgrProbe = deps.execCommand(python, EXTERNALLY_MANAGED_PROBE);
  const externallyManaged =
    extMgrProbe.status === 0 && extMgrProbe.stdout.trim() === "true";
  if (externallyManaged) {
    return (
      `${python} is externally-managed (PEP 668; standard on Homebrew, Debian, ` +
      `recent Ubuntu). System-wide pip installs are blocked — use a venv:\n` +
      venvRecipe(packagePath)
    );
  }
  const pipCheck = deps.execCommand(python, ["-m", "pip", "--version"]);
  if (pipCheck.status !== 0) {
    return (
      `pip not available via \`${python} -m pip\`. ` +
      `Install pip for this Python OR use a venv:\n` +
      venvRecipe(packagePath)
    );
  }
  return (
    "Not importable. Install with:\n" +
    `  ${python} -m pip install -e ${packagePath}`
  );
}

/** LLM-auth check for the active dream-cycle engine. Exported for direct
 * unit testing (runDoctor only reaches it when execCommand is provided). */
export function runLlmAuthCheck(deps: DoctorDeps, python: string): CheckResult {
  if (!deps.execCommand) {
    return {
      ok: true,
      label: "dream-cycle: LLM auth",
      note: "(skipped — caller did not provide execCommand)",
    };
  }
  // Ask dream_cycle.config which env var the active engine wants. We pipe
  // engine + api_key_env so the TS side can check the env without parsing
  // YAML itself.
  const probe = deps.execCommand(python, [
    "-c",
    "from dream_cycle.config import load_config; " +
      "cfg = load_config(); " +
      "print(f'{cfg.engine}\\t{cfg.standalone.api_key_env}')",
  ]);
  if (probe.status !== 0) {
    const stderr = probe.stderr.trim();
    if (/FileNotFoundError|No such file/.test(stderr)) {
      return {
        ok: true,
        label: "dream-cycle: LLM auth",
        note: "(skipped — config.yaml not found; copy config.example.yaml → config.yaml in your wiki root and populate it)",
      };
    }
    return {
      ok: false,
      label: "dream-cycle: LLM auth",
      reason: `Failed to read config.yaml: ${stderr || "(no output)"}`,
    };
  }
  const [engine, envName] = probe.stdout.trim().split("\t");
  if (!engine || !envName) {
    return {
      ok: false,
      label: "dream-cycle: LLM auth",
      reason: `Could not parse engine/api_key_env from config.yaml (got '${probe.stdout.trim()}')`,
    };
  }
  // openclaw mode pulls the key from ~/.openclaw/openclaw.json, not env.
  // That file is checked separately by the existing `openclaw config`
  // doctor entry; here we just note the dependency.
  if (engine === "openclaw") {
    return {
      ok: true,
      label: "dream-cycle: LLM auth",
      note: `engine=openclaw (key read from ~/.openclaw/openclaw.json, see 'openclaw config' check)`,
    };
  }
  const value = deps.env[envName];
  if (value && value.length > 0) {
    return {
      ok: true,
      label: "dream-cycle: LLM auth",
      note: `engine=${engine}, $${envName} set`,
    };
  }
  return {
    ok: false,
    label: "dream-cycle: LLM auth",
    reason: `engine=${engine}: $${envName} is not set. Export it before running dream-cycle.`,
  };
}

/**
 * Workflow templates are copied into the brain at install and never re-read,
 * so an edit to a bundled file leaves the live template behind without any
 * error surfacing. The consequence is silent: a drifted prompt degrades the
 * step's output rather than failing it, and a degraded night is
 * indistinguishable from a quiet one in the digest.
 *
 * This compares the sha256 recorded at import against the file on disk now.
 * Deliberately narrow — it answers "has the source changed since import",
 * not "is the live template correct". A hand-edited live template with no
 * provenance is reported as unstamped, not as drifted, because we cannot
 * know what it should have been.
 */
export function runWorkflowDriftChecks(deps: DoctorDeps): CheckResult[] {
  const label = "dream-cycle: workflow template drift";
  if (!deps.workflowProvenance || !deps.hashFile) {
    return [
      { ok: true, label, note: "skipped (no brain reader wired)" },
    ];
  }

  let rows: readonly WorkflowProvenance[];
  try {
    rows = deps.workflowProvenance();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [{ ok: false, label, reason: `Could not read templates: ${msg}` }];
  }

  if (rows.length === 0) {
    return [{ ok: true, label, note: "no workflow templates imported" }];
  }

  const stamped = rows.filter((r) => r.sourcePath && r.sourceHash);
  if (stamped.length === 0) {
    // Every row predates the provenance migration. Not a failure: nothing is
    // known to be wrong, only unverifiable. Re-importing stamps them.
    return [
      {
        ok: true,
        label,
        note: `${rows.length} template(s) carry no provenance — re-import to stamp them`,
      },
    ];
  }

  const drifted: string[] = [];
  const missing: string[] = [];
  for (const r of stamped) {
    const path = r.sourcePath as string;
    if (!deps.fileExists(path)) {
      missing.push(`${r.id} (source gone: ${path})`);
      continue;
    }
    const now = deps.hashFile(path);
    if (now === undefined) {
      missing.push(`${r.id} (source unreadable: ${path})`);
      continue;
    }
    if (now !== r.sourceHash) drifted.push(r.id);
  }

  const out: CheckResult[] = [];
  if (drifted.length > 0) {
    out.push({
      ok: false,
      label,
      reason:
        `${drifted.join(", ")} differ(s) from the bundled file it was imported from. ` +
        `The live template is what actually runs. Re-import with ` +
        `importMode="upsert" to converge.`,
    });
  } else {
    out.push({
      ok: true,
      label,
      note: `${stamped.length} template(s) match their source`,
    });
  }
  if (missing.length > 0) {
    out.push({
      ok: false,
      label: `${label} (source file)`,
      reason: missing.join("; "),
    });
  }
  return out;
}
