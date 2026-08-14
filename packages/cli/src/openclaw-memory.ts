import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import JSON5 from "json5";

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

/** Pure: when the config expresses NO embedding intent (no `provider`, no
 *  `fallback`, no `remote` block under memorySearch), seed
 *  `fallback: "local"` so a keyless fresh machine still builds an index —
 *  openclaw's default provider is `openai`, which needs an API key. Never
 *  touches an explicit choice (even `fallback: "none"`). Call after
 *  `mergeMemoryExtraPaths` (the memorySearch object is guaranteed then).
 *  Returns true when it seeded. */
export function seedKeylessEmbeddingFallback(cfg: Record<string, unknown>): boolean {
  const agents = cfg.agents as Record<string, unknown>;
  const defaults = agents.defaults as Record<string, unknown>;
  const ms = defaults.memorySearch as Record<string, unknown>;
  if (ms.provider !== undefined || ms.fallback !== undefined || ms.remote !== undefined) {
    return false;
  }
  ms.fallback = "local";
  return true;
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

  const { cfg: merged, added } = mergeMemoryExtraPaths(cfg, paths);
  const seeded = seedKeylessEmbeddingFallback(merged);
  if (added.length === 0 && !seeded) return { configPath, added, ok: true };

  io.mkdirp(path.dirname(configPath));
  io.write(configPath, JSON.stringify(merged, null, 2) + "\n");
  return {
    configPath,
    added,
    ok: true,
    seededLocalFallback: seeded,
    json5Rewritten: json5Only,
  };
}
