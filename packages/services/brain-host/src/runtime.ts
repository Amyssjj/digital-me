/**
 * Assembles a running retriever from config: opens the SQLite index, picks
 * the embedder, and exposes the tool deps + a health snapshot. Everything
 * that touches the filesystem or network is injectable so it is testable.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HostConfig } from "./config.js";
import { GeminiEmbedder, HashEmbedder, type Embedder } from "./retriever/embedder.js";
import { buildIndex, type BuildResult } from "./retriever/index-builder.js";
import { VectorCache } from "./retriever/search.js";
import { IndexStore } from "./retriever/store.js";
import { invokeTool, type ToolDeps, type ToolEnvelope } from "./tools.js";

export const VERSION = "0.1.0-pre";

export type OpenDb = (path: string) => DatabaseSync;

export type RuntimeOptions = {
  readonly config: HostConfig;
  readonly offline: boolean;
  readonly openDb: OpenDb;
  readonly embedder?: Embedder;
  readonly log?: (line: string) => void;
};

export class BrainHostRuntime {
  readonly store: IndexStore;
  readonly cache: VectorCache;
  readonly embedder: Embedder;
  readonly deps: ToolDeps;
  private readonly config: HostConfig;
  private readonly log: (line: string) => void;

  constructor(opts: RuntimeOptions) {
    this.config = opts.config;
    this.log = opts.log ?? (() => {});
    mkdirSync(dirname(opts.config.dbPath), { recursive: true });
    this.store = new IndexStore(opts.openDb(opts.config.dbPath));
    this.cache = new VectorCache(this.store);
    this.embedder = opts.embedder ?? selectEmbedder(opts.config, opts.offline);
    this.deps = {
      store: this.store,
      cache: this.cache,
      embedder: this.embedder,
      readableRoots: opts.config.roots.map((r) => r.dir),
      wikiRoot: opts.config.wikiRoot,
      version: VERSION,
    };
  }

  async index(force: boolean): Promise<BuildResult> {
    const result = await buildIndex({ roots: this.config.roots, store: this.store, embedder: this.embedder, force, log: this.log });
    this.cache.invalidate();
    return result;
  }

  invoke(tool: string, args: Record<string, unknown>): Promise<ToolEnvelope> {
    return invokeTool(this.deps, tool, args);
  }

  health(): Record<string, unknown> {
    return {
      version: VERSION,
      provenance: this.store.getProvenance(),
      lastIndexAt: this.store.getMeta("last_index_at"),
      ...this.store.stats(),
      dbPath: this.config.dbPath,
      wikiRoot: join(this.config.wikiRoot),
    };
  }
}

export function selectEmbedder(config: HostConfig, offline: boolean): Embedder {
  if (offline) return new HashEmbedder();
  if (config.geminiApiKey === undefined) {
    throw new Error("GEMINI_API_KEY is not set (pass --offline for the hash embedder, tests only)");
  }
  return new GeminiEmbedder({ apiKey: config.geminiApiKey, model: config.embedModel, dims: config.embedDims });
}
