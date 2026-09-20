/**
 * Environment → configuration. Pure: takes an env record, returns a config.
 *
 *   DIGITAL_ME_WIKI_ROOT     default ~/digital-me      (contains wiki/ and tastes/)
 *   DIGITAL_ME_RETRIEVAL_DB  default <wiki-root>/.data/retrieval.db
 *   DIGITAL_ME_BRAIN_TOKEN   bearer token for /tools/invoke (required to serve)
 *   DIGITAL_ME_BRAIN_TOKEN_FILE  read the token from this file when the var is unset
 *                            (default <wiki-root>/.data/brain-host.token)
 *   DIGITAL_ME_BRAIN_PORT    default 18791
 *   DIGITAL_ME_BRAIN_HOST    default 127.0.0.1
 *   GEMINI_API_KEY           embedding provider key (required unless --offline)
 *   DIGITAL_ME_EMBED_MODEL   default gemini-embedding-001
 *   DIGITAL_ME_EMBED_DIMS    default 768
 *   DIGITAL_ME_BRAIN_DB      default <OPENCLAW_HOME or ~/.openclaw>/data/brain.db
 *   DIGITAL_ME_BRAIN_SCHEDULER  on|off (default off — one ticker per brain.db)
 *   DIGITAL_ME_TICK_MS       default 60000
 *   DIGITAL_ME_STALL_MS      default 3600000
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HostConfig = {
  readonly wikiRoot: string;
  /** brain.db path (goals, tasks, traces, …). Default: <OPENCLAW_HOME or ~/.openclaw>/data/brain.db until the Phase 3 move. */
  readonly brainDbPath: string;
  /** Scheduler tick on/off. OFF by default: exactly one host may tick a brain.db. */
  readonly schedulerEnabled: boolean;
  readonly tickIntervalMs: number;
  readonly stallThresholdMs: number;
  readonly roots: { dir: string; corpus: "wiki" | "tastes" }[];
  readonly dbPath: string;
  readonly token: string | undefined;
  readonly tokenFile: string;
  readonly port: number;
  readonly host: string;
  readonly geminiApiKey: string | undefined;
  readonly embedModel: string;
  readonly embedDims: number;
};

export const DEFAULT_PORT = 18791;

export function loadConfig(
  env: Record<string, string | undefined>,
  home: string = homedir(),
  readFile: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): HostConfig {
  const wikiRoot = expandHome(env.DIGITAL_ME_WIKI_ROOT ?? join(home, "digital-me"), home);
  const tokenFile = expandHome(env.DIGITAL_ME_BRAIN_TOKEN_FILE ?? join(wikiRoot, ".data", "brain-host.token"), home);
  const port = Number.parseInt(env.DIGITAL_ME_BRAIN_PORT ?? "", 10);
  const dims = Number.parseInt(env.DIGITAL_ME_EMBED_DIMS ?? "", 10);
  const openclawHome = expandHome(env.OPENCLAW_HOME ?? join(home, ".openclaw"), home);
  return {
    wikiRoot,
    brainDbPath: expandHome(env.DIGITAL_ME_BRAIN_DB ?? join(openclawHome, "data", "brain.db"), home),
    schedulerEnabled: (env.DIGITAL_ME_BRAIN_SCHEDULER ?? "off").toLowerCase() === "on",
    tickIntervalMs: positiveInt(env.DIGITAL_ME_TICK_MS, 60_000),
    stallThresholdMs: positiveInt(env.DIGITAL_ME_STALL_MS, 60 * 60 * 1000),
    roots: [
      { dir: join(wikiRoot, "wiki"), corpus: "wiki" },
      { dir: join(wikiRoot, "tastes"), corpus: "tastes" },
    ],
    dbPath: expandHome(env.DIGITAL_ME_RETRIEVAL_DB ?? join(wikiRoot, ".data", "retrieval.db"), home),
    token: env.DIGITAL_ME_BRAIN_TOKEN || readTokenFile(tokenFile, readFile),
    tokenFile,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    host: env.DIGITAL_ME_BRAIN_HOST || "127.0.0.1",
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    embedModel: env.DIGITAL_ME_EMBED_MODEL || "gemini-embedding-001",
    embedDims: Number.isFinite(dims) && dims > 0 ? dims : 768,
  };
}

function readTokenFile(path: string, readFile: (path: string) => string): string | undefined {
  try {
    return readFile(path).trim() || undefined;
  } catch {
    return undefined;
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}
