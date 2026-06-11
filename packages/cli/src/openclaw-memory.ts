import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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

/** Pure merge: ensure `agents.defaults.memorySearch.extraPaths` contains every
 *  path in `paths` (deduped, append-only). Returns the mutated config and the
 *  list of paths that were newly added (empty ⇒ already present). */
export function mergeMemoryExtraPaths(
  cfg: Record<string, unknown>,
  paths: readonly string[],
): { cfg: Record<string, unknown>; added: string[] } {
  const root = cfg && typeof cfg === "object" ? cfg : {};
  const agents = (root.agents ??= {}) as Record<string, unknown>;
  const defaults = (agents.defaults ??= {}) as Record<string, unknown>;
  const ms = (defaults.memorySearch ??= {}) as Record<string, unknown>;
  const existing: string[] = Array.isArray(ms.extraPaths)
    ? (ms.extraPaths.filter((x) => typeof x === "string") as string[])
    : [];
  const seen = new Set(existing);
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

export interface EnsureMemoryResult {
  configPath: string;
  added: string[];
  ok: boolean;
  error?: string;
}

/** Read the openclaw config (or start fresh), append the wiki + tastes dirs to
 *  memorySearch.extraPaths, and write it back. Idempotent: a second run adds
 *  nothing. A malformed existing config is left untouched and reported. */
export function ensureOpenclawMemoryPaths(
  home: string,
  wikiRoot: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: MemoryPathIO = NODE_IO,
): EnsureMemoryResult {
  const configPath = resolveOpenclawConfigPath(home, env);
  const paths = digitalMeKnowledgePaths(home, wikiRoot, env);

  let cfg: Record<string, unknown> = {};
  if (io.exists(configPath)) {
    try {
      const parsed = JSON.parse(io.read(configPath));
      if (parsed && typeof parsed === "object") cfg = parsed as Record<string, unknown>;
    } catch (e) {
      return { configPath, added: [], ok: false, error: (e as Error).message };
    }
  }

  const { cfg: merged, added } = mergeMemoryExtraPaths(cfg, paths);
  if (added.length === 0) return { configPath, added, ok: true };

  io.mkdirp(path.dirname(configPath));
  io.write(configPath, JSON.stringify(merged, null, 2) + "\n");
  return { configPath, added, ok: true };
}
