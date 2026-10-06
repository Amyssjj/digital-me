/**
 * The search path's embedder: a decorator that keeps the query-embedding
 * call from setting memory_search's tail latency. Per-prompt recall hooks
 * give a whole search 4-12 s, but a Gemini call that meets 429s backs off
 * for seconds and one whose connection stalls never returns (2026-10-02:
 * 11 of 300 searches took over 12 s, the worst 42 s). So:
 *
 *  - query vectors are LRU-cached (the Hermes recall plugin re-sends the same
 *    user message before every LLM call of a turn), and concurrent identical
 *    queries share one request;
 *  - a caller waits at most `deadlineMs`, then gets EmbedUnavailableError
 *    (search answers lexical-only), while the request runs on within
 *    `budgetMs` so a late vector still lands in the cache for the next ask;
 *  - each HTTP attempt is capped at `attemptTimeoutMs`, so one stalled
 *    connection costs a retry, not the whole deadline.
 *
 * Document embeddings (indexing) pass straight through: no latency budget.
 */

import { errorMessage } from "../errors.js";
import { EmbedUnavailableError, type EmbedOptions, type EmbedTask, type Embedder } from "./embedder.js";

export type QueryEmbeddingCacheOptions = {
  /** Cached query vectors (768 float32 each ≈ 3 KB). */
  readonly capacity?: number;
  /** How long one search waits for its query vector before going lexical-only. */
  readonly deadlineMs?: number;
  /** How long the shared request may keep retrying after every caller gave up. */
  readonly budgetMs?: number;
  /** Per-HTTP-attempt cap; a query embed normally answers in 0.2-0.5 s. */
  readonly attemptTimeoutMs?: number;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
};

export type QueryEmbeddingStats = {
  readonly size: number;
  readonly capacity: number;
  readonly deadlineMs: number;
  readonly inflight: number;
  readonly hits: number;
  readonly misses: number;
  readonly coalesced: number;
  readonly deadlineMisses: number;
  readonly lateFills: number;
  readonly failures: number;
};

/** Under the tightest consumer: the Hermes recall plugin's 4 s request timeout. */
export const DEFAULT_QUERY_DEADLINE_MS = 3_500;
const DEFAULT_CAPACITY = 512;
const DEFAULT_BUDGET_MS = 15_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 1_500;

export class QueryEmbeddingCache implements Embedder {
  readonly provider: string;
  readonly model: string;
  readonly dims: number;
  private readonly capacity: number;
  private readonly deadlineMs: number;
  private readonly budgetMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  /** Map iteration order is insertion order, so the first key is the least recently used. */
  private readonly vectors = new Map<string, Float32Array>();
  private readonly inflight = new Map<string, Promise<Float32Array>>();
  private readonly counts = { hits: 0, misses: 0, coalesced: 0, deadlineMisses: 0, lateFills: 0, failures: 0 };

  constructor(
    private readonly inner: Embedder,
    opts: QueryEmbeddingCacheOptions = {},
  ) {
    this.provider = inner.provider;
    this.model = inner.model;
    this.dims = inner.dims;
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_QUERY_DEADLINE_MS;
    this.budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  embed(texts: readonly string[], task: EmbedTask, opts?: EmbedOptions): Promise<Float32Array[]> {
    if (task === "document") return this.inner.embed(texts, task, opts);
    return Promise.all(texts.map((text) => this.embedQuery(text)));
  }

  stats(): QueryEmbeddingStats {
    return { size: this.vectors.size, capacity: this.capacity, deadlineMs: this.deadlineMs, inflight: this.inflight.size, ...this.counts };
  }

  private embedQuery(text: string): Promise<Float32Array> {
    const cached = this.vectors.get(text);
    if (cached !== undefined) {
      this.counts.hits++;
      this.vectors.delete(text);
      this.vectors.set(text, cached);
      return Promise.resolve(cached);
    }
    let request = this.inflight.get(text);
    if (request === undefined) {
      this.counts.misses++;
      request = this.request(text);
    } else {
      this.counts.coalesced++;
    }
    return this.waitAtMost(request);
  }

  /** One provider request for `text`, shared by every concurrent caller and cached on success. */
  private request(text: string): Promise<Float32Array> {
    const started = this.now();
    const request = this.inner
      .embed([text], "query", { signal: AbortSignal.timeout(this.budgetMs), attemptTimeoutMs: this.attemptTimeoutMs })
      .then(([vec]) => {
        const ms = this.now() - started;
        if (ms > this.deadlineMs) {
          this.counts.lateFills++;
          this.log(`query embedding landed after ${ms}ms, past the ${this.deadlineMs}ms deadline; cached for the next identical query`);
        }
        this.remember(text, vec!);
        return vec!;
      })
      .finally(() => this.inflight.delete(text));
    // Every caller may have stopped waiting already; recording the failure
    // here also keeps it from becoming an unhandled rejection.
    request.catch((err: unknown) => {
      this.counts.failures++;
      this.log(`query embedding failed after ${this.now() - started}ms: ${errorMessage(err)}`);
    });
    this.inflight.set(text, request);
    return request;
  }

  private async waitAtMost(request: Promise<Float32Array>): Promise<Float32Array> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.counts.deadlineMisses++;
        this.log(`query embedding missed its ${this.deadlineMs}ms deadline; the request runs on to fill the cache`);
        reject(new EmbedUnavailableError(`query embedding missed its ${this.deadlineMs}ms deadline`));
      }, this.deadlineMs);
    });
    try {
      return await Promise.race([request, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(text: string, vec: Float32Array): void {
    this.vectors.set(text, vec);
    if (this.vectors.size > this.capacity) this.vectors.delete(this.vectors.keys().next().value!);
  }
}
