/**
 * Embedding providers behind one interface. The store records the
 * provider/model/dimension provenance and refuses to search with a
 * mismatched embedder — loudly, as an error, never as empty results (the
 * openclaw failure mode this replaces).
 */

import { createHash } from "node:crypto";
import { errorMessage } from "../errors.js";
import { normalize } from "./vec.js";

export type EmbedTask = "document" | "query";

/**
 * Per-call limits. `signal` abandons the call: no further attempts, and the
 * in-flight one is aborted. `attemptTimeoutMs` caps each HTTP attempt, so a
 * stalled connection costs one retry instead of hanging the call.
 */
export type EmbedOptions = { readonly signal?: AbortSignal; readonly attemptTimeoutMs?: number };

export interface Embedder {
  readonly provider: string;
  readonly model: string;
  readonly dims: number;
  embed(texts: readonly string[], task: EmbedTask, opts?: EmbedOptions): Promise<Float32Array[]>;
}

/**
 * A transient embedding failure: the provider was rate-limited (429),
 * unavailable (5xx), unreachable or too slow, or the caller stopped waiting.
 * Search degrades to lexical-only on this. Any other error (a rejected key, a
 * malformed response) stays a plain Error and surfaces loudly.
 */
export class EmbedUnavailableError extends Error {
  override readonly name = "EmbedUnavailableError";
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export type GeminiEmbedderOptions = {
  readonly apiKey: string;
  readonly model?: string;
  readonly dims?: number;
  readonly fetch?: FetchLike;
  /** Backoff sleep; it may resolve early when `signal` aborts (the loop re-checks it). */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly batchSize?: number;
  readonly maxRetries?: number;
  readonly baseUrl?: string;
  /** Per-attempt timeout when the call sets none (default 30 s: an index batch of 100 texts). */
  readonly requestTimeoutMs?: number;
  /** Receives one line per retry (HTTP 429 / 5xx, timeout, network error), so throttling is visible in the log. */
  readonly log?: (line: string) => void;
};

const GEMINI_DEFAULT_MODEL = "gemini-embedding-001";
const GEMINI_DEFAULT_DIMS = 768;
const GEMINI_BATCH = 100;
const GEMINI_REQUEST_TIMEOUT_MS = 30_000;
const ABANDONED = "gemini embed abandoned: the caller stopped waiting";

type AttemptResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly retryable: boolean; readonly reason: string };

/**
 * Gemini `batchEmbedContents`. Uses task types RETRIEVAL_DOCUMENT /
 * RETRIEVAL_QUERY and a reduced output dimensionality (Matryoshka), which
 * the API documents as requiring client-side normalization — done here.
 */
export class GeminiEmbedder implements Embedder {
  readonly provider = "gemini";
  readonly model: string;
  readonly dims: number;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(opts: GeminiEmbedderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? GEMINI_DEFAULT_MODEL;
    this.dims = opts.dims ?? GEMINI_DEFAULT_DIMS;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? sleepUnlessAborted;
    this.batchSize = opts.batchSize ?? GEMINI_BATCH;
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.requestTimeoutMs = opts.requestTimeoutMs ?? GEMINI_REQUEST_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
  }

  async embed(texts: readonly string[], task: EmbedTask, opts: EmbedOptions = {}): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...(await this.embedBatch(batch, task, opts)));
    }
    return out;
  }

  private async embedBatch(batch: readonly string[], task: EmbedTask, opts: EmbedOptions): Promise<Float32Array[]> {
    const url = `${this.baseUrl}/models/${this.model}:batchEmbedContents`;
    const body = JSON.stringify({
      requests: batch.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        outputDimensionality: this.dims,
      })),
    });
    const timeoutMs = opts.attemptTimeoutMs ?? this.requestTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      const res = await this.post(url, body, timeoutMs, opts.signal);
      if (res.ok) return this.parse(res.text, batch.length);
      if (!res.retryable) throw new Error(`gemini embed failed: ${res.reason}`);
      if (attempt >= this.maxRetries) throw new EmbedUnavailableError(`gemini embed failed after ${attempt + 1} attempts: ${res.reason}`);
      const delay = 500 * 2 ** attempt;
      this.log(`gemini embed: ${res.reason} (attempt ${attempt + 1}/${this.maxRetries + 1}, ${task} x${batch.length}); retrying in ${delay}ms`);
      await this.sleep(delay, opts.signal);
      if (opts.signal?.aborted) throw new EmbedUnavailableError(ABANDONED);
    }
  }

  /** One HTTP attempt, bounded by `timeoutMs` and by the caller's signal. Only a caller abort throws. */
  private async post(url: string, body: string, timeoutMs: number, outer: AbortSignal | undefined): Promise<AttemptResult> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body,
        signal: outer ? AbortSignal.any([outer, timeout]) : timeout,
      });
      const text = await res.text();
      if (res.ok) return { ok: true, text };
      return { ok: false, retryable: res.status === 429 || res.status >= 500, reason: `HTTP ${res.status} ${oneLine(text, 300)}` };
    } catch (err) {
      if (outer?.aborted) throw new EmbedUnavailableError(ABANDONED);
      if (timeout.aborted) return { ok: false, retryable: true, reason: `timed out after ${timeoutMs}ms` };
      return { ok: false, retryable: true, reason: `network error: ${errorMessage(err)}` };
    }
  }

  private parse(text: string, expected: number): Float32Array[] {
    let parsed: { embeddings?: { values?: number[] }[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("gemini embed failed: response is not JSON");
    }
    const embeddings = parsed.embeddings ?? [];
    if (embeddings.length !== expected) {
      throw new Error(`gemini embed failed: expected ${expected} embeddings, got ${embeddings.length}`);
    }
    return embeddings.map((e) => {
      const values = e.values ?? [];
      if (values.length !== this.dims) {
        throw new Error(`gemini embed failed: expected ${this.dims} dims, got ${values.length}`);
      }
      return normalize(values);
    });
  }
}

/**
 * Deterministic, network-free embedder: hashed bag-of-words into a fixed
 * dimension. Used by tests and by `--offline` indexing smoke runs. Its
 * provenance is distinct so a real index can never be searched with it.
 */
export class HashEmbedder implements Embedder {
  readonly provider = "hash";
  readonly model = "bag-of-words-v1";
  readonly dims: number;

  constructor(dims = 256) {
    this.dims = dims;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const vec = new Float32Array(this.dims);
      for (const tok of tokenize(t)) {
        const h = createHash("md5").update(tok).digest();
        const idx = h.readUInt32LE(0) % this.dims;
        const sign = h[4]! & 1 ? 1 : -1;
        vec[idx] = vec[idx]! + sign;
      }
      return normalize(vec);
    });
  }
}

/** Collapse whitespace (provider error bodies are pretty-printed JSON) and cap the length. */
function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** `setTimeout` as a promise that resolves early when `signal` aborts. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}
