/**
 * Environment → configuration. Pure: takes an env record, returns a config.
 *
 *   DIGITAL_ME_WIKI_ROOT     default ~/digital-me      (contains wiki/ and tastes/)
 *   DIGITAL_ME_RETRIEVAL_DB  default <wiki-root>/.data/retrieval.db
 *   DIGITAL_ME_BRAIN_TOKEN   bearer token for /tools/invoke (required to serve)
 *   DIGITAL_ME_BRAIN_PORT    default 18791
 *   DIGITAL_ME_BRAIN_HOST    default 127.0.0.1
 *   GEMINI_API_KEY           embedding provider key (required unless --offline)
 *   DIGITAL_ME_EMBED_MODEL   default gemini-embedding-001
 *   DIGITAL_ME_EMBED_DIMS    default 768
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type HostConfig = {
  readonly wikiRoot: string;
  readonly roots: { dir: string; corpus: "wiki" | "tastes" }[];
  readonly dbPath: string;
  readonly token: string | undefined;
  readonly port: number;
  readonly host: string;
  readonly geminiApiKey: string | undefined;
  readonly embedModel: string;
  readonly embedDims: number;
};

export const DEFAULT_PORT = 18791;

export function loadConfig(env: Record<string, string | undefined>, home: string = homedir()): HostConfig {
  const wikiRoot = expandHome(env.DIGITAL_ME_WIKI_ROOT ?? join(home, "digital-me"), home);
  const port = Number.parseInt(env.DIGITAL_ME_BRAIN_PORT ?? "", 10);
  const dims = Number.parseInt(env.DIGITAL_ME_EMBED_DIMS ?? "", 10);
  return {
    wikiRoot,
    roots: [
      { dir: join(wikiRoot, "wiki"), corpus: "wiki" },
      { dir: join(wikiRoot, "tastes"), corpus: "tastes" },
    ],
    dbPath: expandHome(env.DIGITAL_ME_RETRIEVAL_DB ?? join(wikiRoot, ".data", "retrieval.db"), home),
    token: env.DIGITAL_ME_BRAIN_TOKEN || undefined,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    host: env.DIGITAL_ME_BRAIN_HOST || "127.0.0.1",
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    embedModel: env.DIGITAL_ME_EMBED_MODEL || "gemini-embedding-001",
    embedDims: Number.isFinite(dims) && dims > 0 ? dims : 768,
  };
}

export function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}
