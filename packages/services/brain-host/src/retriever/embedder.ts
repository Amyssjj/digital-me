/**
 * Embedding providers behind one interface. The store records the
 * provider/model/dimension provenance and refuses to search with a
 * mismatched embedder — loudly, as an error, never as empty results (the
 * openclaw failure mode this replaces).
 */

import { createHash } from "node:crypto";
import { normalize } from "./vec.js";

export type EmbedTask = "document" | "query";

export interface Embedder {
  readonly provider: string;
  readonly model: string;
  readonly dims: number;
  embed(texts: readonly string[], task: EmbedTask): Promise<Float32Array[]>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export type GeminiEmbedderOptions = {
  readonly apiKey: string;
  readonly model?: string;
  readonly dims?: number;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly batchSize?: number;
  readonly maxRetries?: number;
  readonly baseUrl?: string;
};

const GEMINI_DEFAULT_MODEL = "gemini-embedding-001";
const GEMINI_DEFAULT_DIMS = 768;
const GEMINI_BATCH = 100;

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
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly baseUrl: string;

  constructor(opts: GeminiEmbedderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? GEMINI_DEFAULT_MODEL;
    this.dims = opts.dims ?? GEMINI_DEFAULT_DIMS;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.batchSize = opts.batchSize ?? GEMINI_BATCH;
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  async embed(texts: readonly string[], task: EmbedTask): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...(await this.embedBatch(batch, task)));
    }
    return out;
  }

  private async embedBatch(batch: readonly string[], task: EmbedTask): Promise<Float32Array[]> {
    const url = `${this.baseUrl}/models/${this.model}:batchEmbedContents`;
    const body = JSON.stringify({
      requests: batch.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        outputDimensionality: this.dims,
      })),
    });
    return this.attempt(url, body, batch.length, 0);
  }

  private async attempt(url: string, body: string, expected: number, attempt: number): Promise<Float32Array[]> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body,
    });
    const text = await res.text();
    if (res.ok) return this.parse(text, expected);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= this.maxRetries) {
      throw new Error(`gemini embed failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    await this.sleep(500 * 2 ** attempt);
    return this.attempt(url, body, expected, attempt + 1);
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

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}
