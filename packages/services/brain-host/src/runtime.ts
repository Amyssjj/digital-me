/**
 * Assembles a running retriever from config: opens the SQLite index, picks
 * the embedder, and exposes the tool deps + a health snapshot. Everything
 * that touches the filesystem or network is injectable so it is testable.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HostConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import type { ExecRunArgs, ExecRunResult } from "./exec-run.js";
import { openBrainDb, Orchestrator, type Logger } from "./orchestrator.js";
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
  /** Mount the brain-orchestrator tools from brain.db (serve mode). */
  readonly orchestrator?: boolean;
  /** Test seam: replaces the exec runner used by the orchestrator's dispatcher. */
  readonly execRun?: (args: ExecRunArgs) => Promise<ExecRunResult>;
};

export class BrainHostRuntime {
  readonly store: IndexStore;
  readonly cache: VectorCache;
  readonly embedder: Embedder;
  readonly deps: ToolDeps;
  readonly orchestrator: Orchestrator | null;
  private readonly config: HostConfig;
  private readonly log: (line: string) => void;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private lastRefresh: { at: string; result?: BuildResult; error?: string } | null = null;

  constructor(opts: RuntimeOptions) {
    this.config = opts.config;
    this.log = opts.log ?? (() => {});
    mkdirSync(dirname(opts.config.dbPath), { recursive: true });
    this.store = new IndexStore(opts.openDb(opts.config.dbPath));
    this.cache = new VectorCache(this.store);
    this.embedder = opts.embedder ?? selectEmbedder(opts.config, opts.offline);
    const orchLog: Logger = (level, msg) => this.log(`[${level}] orchestrator: ${msg}`);
    this.orchestrator = opts.orchestrator
      ? new Orchestrator({
          db: openBrainDb(opts.config.brainDbPath, opts.openDb),
          wikiRoot: opts.config.wikiRoot,
          log: orchLog,
          stallThresholdMs: opts.config.stallThresholdMs,
          ...(opts.execRun ? { execRun: opts.execRun } : {}),
        })
      : null;
    this.deps = {
      store: this.store,
      cache: this.cache,
      embedder: this.embedder,
      readableRoots: opts.config.roots.map((r) => r.dir),
      wikiRoot: opts.config.wikiRoot,
      version: VERSION,
      ...(this.orchestrator ? { extraTools: this.orchestrator.tools } : {}),
    };
    if (this.orchestrator && opts.config.schedulerEnabled) {
      this.orchestrator.startScheduler(opts.config.tickIntervalMs);
    }
  }

  /**
   * Start the periodic incremental re-index (serve mode). Cheap when nothing
   * changed (hash scan only); embeds only new/changed entries. Idempotent.
   */
  startIndexRefresh(setTimer: typeof setInterval = setInterval): void {
    if (this.refreshTimer !== null || this.config.indexRefreshMs <= 0) return;
    this.refreshTimer = setTimer(() => {
      void this.refreshIndex();
    }, this.config.indexRefreshMs);
    this.refreshTimer.unref();
    this.log(`index refresh every ${this.config.indexRefreshMs}ms`);
  }

  /** One incremental re-index; never overlaps itself; errors are logged, not thrown. */
  async refreshIndex(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const result = await this.index(false);
      this.lastRefresh = { at: new Date().toISOString(), result };
      if (result.embedded > 0 || result.removed > 0) {
        this.log(`index refresh: ${result.embedded} embedded, ${result.removed} removed, ${result.scanned} total (generation ${result.generation})`);
      }
    } catch (err) {
      const message = errorMessage(err);
      this.lastRefresh = { at: new Date().toISOString(), error: message };
      this.log(`index refresh failed: ${message}`);
    } finally {
      this.refreshing = false;
    }
  }

  /** Stop background work (scheduler, index refresh). Safe to call twice. */
  close(clearTimer: typeof clearInterval = clearInterval): void {
    this.orchestrator?.stopScheduler();
    if (this.refreshTimer !== null) {
      clearTimer(this.refreshTimer);
      this.refreshTimer = null;
    }
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
      indexGeneration: this.store.getMeta("index_generation"),
      indexRefresh: { everyMs: this.config.indexRefreshMs, active: this.refreshTimer !== null, last: this.lastRefresh },
      orchestrator: this.orchestrator ? { brainDb: this.config.brainDbPath, ...this.orchestrator.status() } : null,
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
