/**
 * Where the brain's own files live, now that brain-host (not the openclaw
 * gateway) is the hub.
 *
 * Canonical home: `<DIGITAL_ME_WIKI_ROOT>/.data/` — brain.db, the bearer
 * token, the retrieval index and the provider-key env file all sit beside
 * the wiki they serve, on every platform, with no openclaw install required.
 *
 * Legacy home: `<OPENCLAW_HOME>/` — where the same files lived while the
 * openclaw plugin was the hub (`data/brain.db`, `.env`). An install that
 * predates the move keeps working untouched: the canonical path is preferred
 * only once it exists, so nothing silently switches to an empty database.
 *
 * One rule, mirrored by every TypeScript and Python reader (brain-host, the
 * proxy trace writer, the openclaw plugin templates, dream-cycle, digest):
 *
 *   1. explicit env var (`DIGITAL_ME_BRAIN_DB` / `DIGITAL_ME_ENV_FILE`)
 *   2. the canonical path, when it exists
 *   3. the legacy openclaw path, when it exists
 *   4. the canonical path (a fresh install creates it there)
 *
 * The Python twin lives in `dream_cycle/brain_paths.py` and
 * `digest/config.py`; keep the three in step.
 */

import path from "node:path";

export type BrainPathSource = "env" | "canonical" | "legacy-openclaw";

export interface ResolvedBrainPath {
  readonly path: string;
  readonly source: BrainPathSource;
}

export interface BrainPathDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** Existence probe, injected so the rule stays pure. */
  readonly exists: (p: string) => boolean;
}

/** `DIGITAL_ME_WIKI_ROOT` → legacy `DIGITAL_ME_HOME` → `~/digital-me`. */
export function wikiRootOf(env: BrainPathDeps["env"], home: string): string {
  return env.DIGITAL_ME_WIKI_ROOT ?? env.DIGITAL_ME_HOME ?? path.join(home, "digital-me");
}

/** `OPENCLAW_HOME` → `~/.openclaw` — only ever used for the legacy fallback. */
export function openclawHomeOf(env: BrainPathDeps["env"], home: string): string {
  return env.OPENCLAW_HOME ?? path.join(home, ".openclaw");
}

/** The canonical data dir: `<wiki-root>/.data`. */
export function brainDataDirOf(env: BrainPathDeps["env"], home: string): string {
  return path.join(wikiRootOf(env, home), ".data");
}

function resolveWithLegacy(
  deps: BrainPathDeps,
  envKey: "DIGITAL_ME_BRAIN_DB" | "DIGITAL_ME_ENV_FILE",
  canonical: string,
  legacy: string,
): ResolvedBrainPath {
  const explicit = (deps.env[envKey] ?? "").trim();
  if (explicit !== "") return { path: explicit, source: "env" };
  if (deps.exists(canonical)) return { path: canonical, source: "canonical" };
  if (deps.exists(legacy)) return { path: legacy, source: "legacy-openclaw" };
  return { path: canonical, source: "canonical" };
}

/**
 * brain.db: `DIGITAL_ME_BRAIN_DB` → `<wiki-root>/.data/brain.db` →
 * `<openclaw-home>/data/brain.db` → `<wiki-root>/.data/brain.db`.
 */
export function resolveBrainDbPath(deps: BrainPathDeps): ResolvedBrainPath {
  return resolveWithLegacy(
    deps,
    "DIGITAL_ME_BRAIN_DB",
    path.join(brainDataDirOf(deps.env, deps.home), "brain.db"),
    path.join(openclawHomeOf(deps.env, deps.home), "data", "brain.db"),
  );
}

/**
 * Provider-key env file (GEMINI_API_KEY, …), loaded by brain-host with node's
 * `--env-file-if-exists` and inherited by every worker it dispatches:
 * `DIGITAL_ME_ENV_FILE` → `<wiki-root>/.data/.env` → `<openclaw-home>/.env`
 * → `<wiki-root>/.data/.env`.
 */
export function resolveEnvFilePath(deps: BrainPathDeps): ResolvedBrainPath {
  return resolveWithLegacy(
    deps,
    "DIGITAL_ME_ENV_FILE",
    path.join(brainDataDirOf(deps.env, deps.home), ".env"),
    path.join(openclawHomeOf(deps.env, deps.home), ".env"),
  );
}
