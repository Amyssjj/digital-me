import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import JSON5 from "json5";
import {
  isAtLeastOpenclawVersion,
  MEMORY_SEARCH_NAMESPACE_MIN_VERSION,
} from "@digital-me/runtime-openclaw";

/**
 * Install-time wiring that makes openclaw's `memory_search` auto-index the
 * digital-me knowledge trees — the **wiki** AND the **tastes** tree — so that
 * captured knowledge and distilled taste principles both surface in recall
 * (and therefore in the dashboard Feed's "applied" stream).
 *
 * openclaw indexes whatever absolute dirs are listed under
 * `agents.defaults.memorySearch.extraPaths` in its config (default
 * `~/.openclaw/openclaw.json`). The installer appends the two trees there
 * idempotently, preserving any other memorySearch settings (provider, key, …).
 *
 * Three fresh-install traps this module defuses (each one shipped as a
 * "memory_search finds nothing" bug report before it was handled here):
 *
 *  1. openclaw parses its config as **JSON5** (src/config/io.ts uses the
 *     `json5` package), so comments / trailing commas are legal there. We
 *     must parse the same dialect or a hand-annotated config silently
 *     aborts the wiring. Writes stay plain 2-space JSON — exactly what
 *     openclaw's own `writeConfigFile` emits when *it* rewrites the config.
 *  2. The gateway indexes + watches only extraPaths dirs that EXIST when it
 *     starts; missing ones are skipped and never re-attached until the next
 *     restart. So the wiki + tastes dirs are created here, before the user
 *     restarts the gateway.
 *  3. openclaw's default embedding provider is `openai` (remote, key
 *     required). A fresh machine with no key would build no index at all —
 *     so when the config expresses no embedding intent, we seed
 *     `fallback: "local"` (openclaw's bundled keyless embedder).
 */

/** Tiered openclaw config path:
 *  $DIGITAL_ME_OPENCLAW_CONFIG > $OPENCLAW_HOME/openclaw.json > ~/.openclaw/openclaw.json. */
export function resolveOpenclawConfigPath(
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (env.DIGITAL_ME_OPENCLAW_CONFIG) return env.DIGITAL_ME_OPENCLAW_CONFIG;
  const stateDir = env.OPENCLAW_HOME ?? path.join(home, ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

/** The two knowledge dirs to index: `<root>/wiki` and `<root>/tastes`, where
 *  the data root is the wikiRoot arg, else $DIGITAL_ME_WIKI_ROOT, else
 *  ~/digital-me (matching the installer's resolution elsewhere). */
export function digitalMeKnowledgePaths(
  home: string,
  wikiRoot: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const root = wikiRoot ?? env.DIGITAL_ME_WIKI_ROOT ?? path.join(home, "digital-me");
  return [path.join(root, "wiki"), path.join(root, "tastes")];
}

/** Embedding providers openclaw can run without an API key (mirrors
 *  `isKeyOptionalMemoryProvider` in openclaw's doctor-memory-search). */
export const KEY_OPTIONAL_EMBEDDING_PROVIDERS: ReadonlySet<string> = new Set([
  "local",
  "ollama",
  "lmstudio",
]);

/**
 * The two config layouts openclaw has used for the memory-search block.
 *
 *  - `legacy`     — `agents.defaults.memorySearch` (openclaw < 2026.7.1)
 *  - `namespaced` — `memory.search`                (openclaw >= 2026.7.1)
 *
 * This is a HARD cutover. Both schemas are `.strict()` and openclaw's loader
 * THROWS on an unknown key, so the wrong layout does not degrade to "corpus
 * unindexed" — it stops the gateway from starting. Never write both.
 */
export type MemorySearchLayout = "legacy" | "namespaced";

/** Which layout a config already uses, or undefined when it has neither. */
export function detectMemorySearchLayout(
  cfg: Record<string, unknown>,
): MemorySearchLayout | undefined {
  const legacy = (cfg.agents as Record<string, unknown> | undefined)?.defaults as
    | Record<string, unknown>
    | undefined;
  if (legacy?.memorySearch !== undefined) return "legacy";
  const memory = cfg.memory as Record<string, unknown> | undefined;
  if (memory?.search !== undefined) return "namespaced";
  return undefined;
}

/**
 * Pick the layout to write. An existing block always wins — moving it is a
 * migration, never a side effect of wiring paths. With no existing block the
 * host version decides, and an unknown host defaults to `namespaced` (current
 * openclaw); a fresh install on an old host is the rarer case and is still
 * repairable, whereas silently writing the legacy key on a new host is not.
 */
export function resolveMemorySearchLayout(
  cfg: Record<string, unknown>,
  hostVersion: string | undefined,
): MemorySearchLayout {
  const existing = detectMemorySearchLayout(cfg);
  if (existing) return existing;
  const isNew = isAtLeastOpenclawVersion(hostVersion, MEMORY_SEARCH_NAMESPACE_MIN_VERSION);
  return isNew === false ? "legacy" : "namespaced";
}

/** Get-or-create the memory-search object at `layout`'s location. */
function memorySearchBlock(
  cfg: Record<string, unknown>,
  layout: MemorySearchLayout,
): Record<string, unknown> {
  if (layout === "legacy") {
    const agents = (cfg.agents ??= {}) as Record<string, unknown>;
    const defaults = (agents.defaults ??= {}) as Record<string, unknown>;
    return (defaults.memorySearch ??= {}) as Record<string, unknown>;
  }
  const memory = (cfg.memory ??= {}) as Record<string, unknown>;
  return (memory.search ??= {}) as Record<string, unknown>;
}

/**
 * Move the memory-search block to `target`, preserving every sub-key. All six
 * sub-keys digital-me writes or preserves (`enabled`, `extraPaths`,
 * `provider`, `fallback`, `model`, `remote`) exist in both versions'
 * `MemorySearchSchema`, so the move is lossless for our shape. Returns
 * `migrated: false` when the config is already on `target` or has no block.
 */
export function migrateMemorySearchLayout(
  cfg: Record<string, unknown>,
  target: MemorySearchLayout,
): { cfg: Record<string, unknown>; migrated: boolean; from?: MemorySearchLayout } {
  const from = detectMemorySearchLayout(cfg);
  if (!from || from === target) return { cfg, migrated: false };

  let block: Record<string, unknown>;
  if (from === "legacy") {
    const defaults = (cfg.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    block = defaults.memorySearch as Record<string, unknown>;
    delete defaults.memorySearch;
  } else {
    const memory = cfg.memory as Record<string, unknown>;
    block = memory.search as Record<string, unknown>;
    delete memory.search;
    // An empty `memory: {}` is schema-valid, but leaving it is noise.
    if (Object.keys(memory).length === 0) delete cfg.memory;
  }

  if (target === "legacy") {
    const agents = (cfg.agents ??= {}) as Record<string, unknown>;
    const defaults = (agents.defaults ??= {}) as Record<string, unknown>;
    defaults.memorySearch = block;
  } else {
    const memory = (cfg.memory ??= {}) as Record<string, unknown>;
    memory.search = block;
  }
  return { cfg, migrated: true, from };
}

/** Pure merge: ensure the memory-search block's `extraPaths` contains every
 *  path in `paths` (deduped, append-only). Returns the mutated config and the
 *  list of paths that were newly added (empty ⇒ already present). */
export function mergeMemoryExtraPaths(
  cfg: Record<string, unknown>,
  paths: readonly string[],
  layout: MemorySearchLayout = "legacy",
): { cfg: Record<string, unknown>; added: string[] } {
  const root = cfg && typeof cfg === "object" ? cfg : {};
  const ms = memorySearchBlock(root, layout);
  // openclaw >= 2026.7.1 also accepts `{path, pattern}` entries here; ours are
  // plain strings, and a foreign object entry must survive untouched.
  const existing: unknown[] = Array.isArray(ms.extraPaths) ? [...ms.extraPaths] : [];
  const seen = new Set(existing.filter((x): x is string => typeof x === "string"));
  const added: string[] = [];
  for (const p of paths) {
    if (!seen.has(p)) {
      existing.push(p);
      seen.add(p);
      added.push(p);
    }
  }
  ms.extraPaths = existing;
  return { cfg: root, added };
}

/** Pure: when the config expresses NO embedding intent (no `provider`, no
 *  `fallback`, no `remote` block under memory search), seed
 *  `fallback: "local"` so a keyless fresh machine still builds an index —
 *  openclaw's default provider is `openai`, which needs an API key. Never
 *  touches an explicit choice (even `fallback: "none"`). Call after
 *  `mergeMemoryExtraPaths` (the block is guaranteed then).
 *  Returns true when it seeded. */
export function seedKeylessEmbeddingFallback(
  cfg: Record<string, unknown>,
  layout: MemorySearchLayout = "legacy",
): boolean {
  const ms = memorySearchBlock(cfg, layout);
  if (ms.provider !== undefined || ms.fallback !== undefined || ms.remote !== undefined) {
    return false;
  }
  ms.fallback = "local";
  return true;
}

/**
 * Pure: grant every plugin in `pluginIds` conversation-hook access.
 *
 * openclaw drops a "conversation" typed hook at registration when a
 * NON-BUNDLED plugin has not opted in — a warn diagnostic and an early
 * `return`, no error, no failed load, no missing tool. digital-me's plugins
 * are always non-bundled (`Origin: global`), and the gated set grew to
 * include `before_prompt_build` in 2026.8.1, which is the entire recall
 * injection path. `agent_end` (the M1 application-ack) has been gated for
 * longer still.
 *
 * The key is accepted by every openclaw version in our supported range, so
 * this is granted unconditionally rather than behind a host-version check.
 * Only ever writes `true`; an explicit `false` set by the operator is left
 * alone, because that is a deliberate opt-out.
 */
export function mergeHookGrants(
  cfg: Record<string, unknown>,
  pluginIds: readonly string[],
): { cfg: Record<string, unknown>; granted: string[] } {
  const plugins = (cfg.plugins ??= {}) as Record<string, unknown>;
  const entries = (plugins.entries ??= {}) as Record<string, unknown>;
  const granted: string[] = [];
  for (const id of pluginIds) {
    const entry = (entries[id] ??= {}) as Record<string, unknown>;
    const hooks = (entry.hooks ??= {}) as Record<string, unknown>;
    if (hooks.allowConversationAccess === undefined) {
      hooks.allowConversationAccess = true;
      granted.push(id);
    }
  }
  return { cfg, granted };
}

/** Injectable filesystem seam so the wiring is unit-testable without disk. */
export interface MemoryPathIO {
  exists(p: string): boolean;
  read(p: string): string;
  write(p: string, data: string): void;
  mkdirp(p: string): void;
}

const NODE_IO: MemoryPathIO = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, "utf-8"),
  write: (p, data) => writeFileSync(p, data, "utf-8"),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
};

/**
 * Plugin ids that need conversation-hook access (see {@link mergeHookGrants}).
 *
 * ONLY digital-me-recall. It is the sole plugin that registers typed hooks at
 * all — digital-me-brain registers tools via `api.registerTool` and no hooks,
 * so granting it conversation access would hand out a capability it never
 * exercises and make `digital-me doctor` fail on a permission nothing needs.
 * Least privilege: extend this list only when a plugin actually registers a
 * hook from openclaw's conversation set.
 */
export const CONVERSATION_HOOK_PLUGIN_IDS: readonly string[] = ["digital-me-recall"];

/** Minimal shape of the spawn seam used to probe the CLI. */
export type VersionSpawn = (
  cmd: string,
  args: readonly string[],
  opts: { encoding: "utf-8"; timeout: number },
) => { status: number | null; stdout?: string };

/**
 * Run `openclaw --version` and return raw stdout, or undefined.
 *
 * Never throws: an absent binary, a non-zero exit, or a timeout all resolve to
 * undefined so the caller falls through to the next version signal rather than
 * failing the install.
 */
export function probeOpenclawVersion(
  spawn: VersionSpawn = spawnSync as unknown as VersionSpawn,
): string | undefined {
  try {
    const res = spawn("openclaw", ["--version"], { encoding: "utf-8", timeout: 20_000 });
    return res.status === 0 ? res.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** Pull a `YYYY.M.PATCH` out of `openclaw --version` output ("OpenClaw 2026.8.1 (abc123)"). */
export function parseOpenclawVersionOutput(out: string | undefined): string | undefined {
  if (!out) return undefined;
  const m = /\b(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(out);
  return m ? m[1] : undefined;
}

/**
 * Best-effort read of the openclaw version this machine will actually run.
 *
 * Order matters, most-authoritative first:
 *  1. The SOURCE checkout's package.json — that file IS the binary the
 *     `openclaw` shim executes, so it is right even mid-update, when the
 *     config's stamp still says the old version.
 *  2. `openclaw --version` — covers npm-global installs with no checkout.
 *  3. `meta.lastTouchedVersion` — the gateway's own stamp; a good signal for
 *     an existing install, stale only if the binary moved without a run.
 *
 * Returns undefined when none resolve. Callers MUST treat that as "unknown"
 * and must not let it silently choose a config layout — picking wrong makes
 * openclaw reject the whole config and refuse to start.
 */
export function detectOpenclawHostVersion(
  home: string,
  cfg: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: Pick<MemoryPathIO, "exists" | "read"> = NODE_IO,
  probe: () => string | undefined = probeOpenclawVersion,
): string | undefined {
  const repoDir = env.OPENCLAW_REPO ?? path.join(home, "openclaw");
  const pkgPath = path.join(repoDir, "package.json");
  try {
    if (io.exists(pkgPath)) {
      const v = (JSON.parse(io.read(pkgPath)) as { version?: unknown }).version;
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {
    // Fall through to the next signal.
  }
  const probed = parseOpenclawVersionOutput(probe());
  if (probed) return probed;
  const meta = cfg.meta as Record<string, unknown> | undefined;
  const stamped = meta?.lastTouchedVersion;
  return typeof stamped === "string" && stamped.trim() ? stamped.trim() : undefined;
}

export interface EnsureMemoryResult {
  configPath: string;
  added: string[];
  ok: boolean;
  error?: string;
  /** Which layout the memory-search block was written to. */
  layout?: MemorySearchLayout;
  /** Set when the block was moved between layouts to match the running host. */
  migratedLayoutFrom?: MemorySearchLayout;
  /** Plugin ids newly granted `hooks.allowConversationAccess`. */
  hookGrants?: string[];
  /** true when `fallback: "local"` was seeded because the config had no
   *  embedding configuration at all (see seedKeylessEmbeddingFallback). */
  seededLocalFallback?: boolean;
  /** true when the existing config needed openclaw's JSON5 dialect to parse
   *  (comments, trailing commas, …) and the rewrite flattened it to plain
   *  JSON — the same normalization openclaw's own config writer applies. */
  json5Rewritten?: boolean;
}

/** Read the openclaw config (or start fresh), append the wiki + tastes dirs to
 *  memorySearch.extraPaths, create those dirs, and write the config back.
 *  Idempotent: a second run adds nothing. A malformed existing config is left
 *  untouched and reported. */
export function ensureOpenclawMemoryPaths(
  home: string,
  wikiRoot: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: MemoryPathIO = NODE_IO,
  probe: () => string | undefined = probeOpenclawVersion,
): EnsureMemoryResult {
  const configPath = resolveOpenclawConfigPath(home, env);
  const paths = digitalMeKnowledgePaths(home, wikiRoot, env);

  // The gateway indexes + watches only dirs that exist at startup — missing
  // extraPaths entries are silently skipped until the NEXT restart. Create
  // both trees now so the restart right after install picks them up.
  for (const p of paths) io.mkdirp(p);

  let cfg: Record<string, unknown> = {};
  let json5Only = false;
  if (io.exists(configPath)) {
    const raw = io.read(configPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // openclaw itself parses this file as JSON5 (comments, trailing
      // commas, unquoted keys are all legal there) — accept the same
      // dialect instead of aborting the wiring on a hand-annotated config.
      try {
        parsed = JSON5.parse(raw);
        json5Only = true;
      } catch (e) {
        return { configPath, added: [], ok: false, error: (e as Error).message };
      }
    }
    if (parsed && typeof parsed === "object") cfg = parsed as Record<string, unknown>;
  }

  // Which layout does the RUNNING host demand? A block already in the config
  // normally wins, but when the host has crossed the 2026.7.1 cutover the
  // block must move — leaving it costs more than an unindexed corpus, it
  // makes openclaw reject the whole config and refuse to start.
  const hostVersion = detectOpenclawHostVersion(home, cfg, env, io, probe);
  const hostWantsNamespaced = isAtLeastOpenclawVersion(
    hostVersion,
    MEMORY_SEARCH_NAMESPACE_MIN_VERSION,
  );
  const layout: MemorySearchLayout =
    hostWantsNamespaced === undefined
      ? resolveMemorySearchLayout(cfg, hostVersion)
      : hostWantsNamespaced
        ? "namespaced"
        : "legacy";
  const { migrated, from } = migrateMemorySearchLayout(cfg, layout);

  const { cfg: merged, added } = mergeMemoryExtraPaths(cfg, paths, layout);
  const seeded = seedKeylessEmbeddingFallback(merged, layout);
  const { granted } = mergeHookGrants(merged, CONVERSATION_HOOK_PLUGIN_IDS);
  if (added.length === 0 && !seeded && !migrated && granted.length === 0) {
    // Nothing to write. Still report the shape fields so callers can read
    // `layout` / `hookGrants` uniformly instead of special-casing the no-op.
    return { configPath, added, ok: true, layout, hookGrants: granted };
  }

  io.mkdirp(path.dirname(configPath));
  io.write(configPath, JSON.stringify(merged, null, 2) + "\n");
  return {
    configPath,
    added,
    ok: true,
    layout,
    migratedLayoutFrom: migrated ? from : undefined,
    hookGrants: granted,
    seededLocalFallback: seeded,
    json5Rewritten: json5Only,
  };
}
