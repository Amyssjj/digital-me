import { describe, expect, it } from "vitest";
import { GeminiEmbedder, HashEmbedder, tokenize, type FetchLike } from "./embedder.js";

function fakeFetch(responses: { status: number; body: unknown }[]): { fetch: FetchLike; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift() ?? { status: 500, body: "exhausted" };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)),
    };
  };
  return { fetch, calls };
}

const vecs = (n: number, dims: number) => ({ embeddings: Array.from({ length: n }, (_, i) => ({ values: Array.from({ length: dims }, (_, j) => (j === i % dims ? 2 : 0)) })) });

describe("GeminiEmbedder", () => {
  it("posts batches with task types and normalizes the result", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: vecs(2, 4) }, { status: 200, body: vecs(1, 4) }, { status: 200, body: vecs(1, 4) }]);
    const e = new GeminiEmbedder({ apiKey: "k", dims: 4, fetch, batchSize: 2, sleep: async () => {} });
    const out = await e.embed(["a", "b", "c"], "document");
    expect(out).toHaveLength(3);
    expect(out[0]![0]).toBeCloseTo(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/models/gemini-embedding-001:batchEmbedContents");
    const body = calls[0]!.body as { requests: { taskType: string; outputDimensionality: number }[] };
    expect(body.requests[0]!.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(body.requests[0]!.outputDimensionality).toBe(4);
    await e.embed(["q"], "query");
    expect((calls[2]!.body as { requests: { taskType: string }[] }).requests[0]!.taskType).toBe("RETRIEVAL_QUERY");
  });

  it("retries 429/5xx with backoff then succeeds, and gives up after maxRetries", async () => {
    const slept: number[] = [];
    const ok = fakeFetch([{ status: 429, body: "slow" }, { status: 503, body: "down" }, { status: 200, body: vecs(1, 2) }]);
    const e = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: ok.fetch, sleep: async (ms) => { slept.push(ms); }, maxRetries: 3 });
    expect(await e.embed(["a"], "query")).toHaveLength(1);
    expect(slept).toEqual([500, 1000]);

    const bad = fakeFetch([{ status: 500, body: "x" }, { status: 500, body: "y" }]);
    const e2 = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: bad.fetch, sleep: async () => {}, maxRetries: 1 });
    await expect(e2.embed(["a"], "query")).rejects.toThrow(/HTTP 500 y/);
  });

  it("does not retry client errors", async () => {
    const f = fakeFetch([{ status: 400, body: "bad key" }]);
    const e = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: f.fetch, sleep: async () => {} });
    await expect(e.embed(["a"], "query")).rejects.toThrow(/HTTP 400 bad key/);
    expect(f.calls).toHaveLength(1);
  });

  it("rejects malformed responses", async () => {
    const notJson = fakeFetch([{ status: 200, body: "<html>" }]);
    await expect(new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: notJson.fetch }).embed(["a"], "query")).rejects.toThrow(/not JSON/);
    const wrongCount = fakeFetch([{ status: 200, body: {} }]);
    await expect(new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: wrongCount.fetch }).embed(["a"], "query")).rejects.toThrow(/expected 1 embeddings, got 0/);
    const wrongDims = fakeFetch([{ status: 200, body: { embeddings: [{}] } }]);
    await expect(new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: wrongDims.fetch }).embed(["a"], "query")).rejects.toThrow(/expected 2 dims, got 0/);
  });

  it("uses defaults for model, dims, base url and global fetch", () => {
    const e = new GeminiEmbedder({ apiKey: "k" });
    expect(e.model).toBe("gemini-embedding-001");
    expect(e.dims).toBe(768);
    expect(e.provider).toBe("gemini");
  });
});

describe("HashEmbedder", () => {
  it("is deterministic, unit-length, and maps similar text closer than unrelated text", async () => {
    const e = new HashEmbedder(64);
    const [a, b, c] = await e.embed(["kanban range filter", "kanban range filters", "quantum chromodynamics lattice"], "document");
    const norm = Math.hypot(...Array.from(a!));
    expect(norm).toBeCloseTo(1);
    const dotp = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dotp(a!, b!)).toBeGreaterThan(dotp(a!, c!));
    expect(Array.from((await e.embed(["kanban range filter"], "query"))[0]!)).toEqual(Array.from(a!));
    expect(e.dims).toBe(64);
    expect(new HashEmbedder().dims).toBe(256);
  });
});

describe("tokenize", () => {
  it("lowercases, splits on non-word chars and drops single characters", () => {
    expect(tokenize("Kanban: range_filter, by a UPDATED-at!")).toEqual(["kanban", "range_filter", "by", "updated", "at"]);
  });
});
