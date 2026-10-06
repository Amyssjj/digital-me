import { describe, expect, it, vi } from "vitest";
import { EmbedUnavailableError, GeminiEmbedder, HashEmbedder, tokenize, type FetchLike } from "./embedder.js";

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

/** A fetch that never answers: it only settles by rejecting when its signal aborts. */
const hangingFetch = (): { fetch: FetchLike; signals: (AbortSignal | undefined)[] } => {
  const signals: (AbortSignal | undefined)[] = [];
  const fetch: FetchLike = (_url, init) => {
    signals.push(init.signal);
    return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  };
  return { fetch, signals };
};

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

  it("backs off with a real timer when no sleep seam is given", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch([{ status: 503, body: "down" }, { status: 200, body: vecs(1, 2) }]);
      const pending = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: f.fetch }).embed(["a"], "query");
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toHaveLength(1);
      expect(f.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry client errors, and reports them as permanent", async () => {
    const f = fakeFetch([{ status: 400, body: "bad key" }]);
    const e = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: f.fetch, sleep: async () => {} });
    const err = await e.embed(["a"], "query").catch((x: unknown) => x);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EmbedUnavailableError);
    expect((err as Error).message).toMatch(/HTTP 400 bad key/);
    expect(f.calls).toHaveLength(1);
  });

  it("logs each retry with its cause, 429 bodies on one line, and reports exhaustion as transient", async () => {
    const logs: string[] = [];
    const quota = '{\n  "error": {\n    "code": 429,\n    "status": "RESOURCE_EXHAUSTED"\n  }\n}';
    const f = fakeFetch([{ status: 429, body: quota }, { status: 429, body: quota }]);
    const e = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: f.fetch, sleep: async () => {}, maxRetries: 1, log: (l) => logs.push(l) });
    const err = await e.embed(["a", "b"], "query").catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EmbedUnavailableError);
    expect((err as Error).message).toBe('gemini embed failed after 2 attempts: HTTP 429 { "error": { "code": 429, "status": "RESOURCE_EXHAUSTED" } }');
    expect(logs).toEqual(['gemini embed: HTTP 429 { "error": { "code": 429, "status": "RESOURCE_EXHAUSTED" } } (attempt 1/2, query x2); retrying in 500ms']);
  });

  it("times out a stalled attempt and retries it instead of hanging", async () => {
    const logs: string[] = [];
    const stall = hangingFetch();
    const ok = fakeFetch([{ status: 200, body: vecs(1, 2) }]);
    let n = 0;
    const fetch: FetchLike = (url, init) => (n++ === 0 ? stall.fetch(url, init) : ok.fetch(url, init));
    const e = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch, sleep: async () => {}, log: (l) => logs.push(l) });
    expect(await e.embed(["a"], "query", { attemptTimeoutMs: 20 })).toHaveLength(1);
    expect(logs).toEqual(["gemini embed: timed out after 20ms (attempt 1/5, query x1); retrying in 500ms"]);

    const always = hangingFetch();
    const slow = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: always.fetch, sleep: async () => {}, maxRetries: 1, requestTimeoutMs: 10 });
    await expect(slow.embed(["a"], "document")).rejects.toThrow(/after 2 attempts: timed out after 10ms/);
    expect(always.signals).toHaveLength(2);
  });

  it("retries network errors", async () => {
    const logs: string[] = [];
    const ok = fakeFetch([{ status: 200, body: vecs(1, 2) }]);
    let n = 0;
    const fetch: FetchLike = async (url, init) => {
      if (n++ === 0) throw new TypeError("fetch failed");
      return ok.fetch(url, init);
    };
    const e = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch, sleep: async () => {}, log: (l) => logs.push(l) });
    expect(await e.embed(["a"], "query")).toHaveLength(1);
    expect(logs).toEqual(["gemini embed: network error: fetch failed (attempt 1/5, query x1); retrying in 500ms"]);
  });

  it("stops at once when the caller's signal aborts mid-request, mid-backoff, or before the next attempt", async () => {
    const midRequest = new AbortController();
    const stall = hangingFetch();
    const pending = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: stall.fetch }).embed(["a"], "query", { signal: midRequest.signal });
    midRequest.abort();
    await expect(pending).rejects.toThrow(EmbedUnavailableError);
    await expect(pending).rejects.toThrow(/abandoned/);
    expect(stall.signals).toHaveLength(1);

    // The default backoff sleep wakes on abort instead of waiting out its 500 ms.
    const midSleep = new AbortController();
    const f = fakeFetch([{ status: 503, body: "down" }]);
    const started = Date.now();
    const sleeping = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: f.fetch }).embed(["a"], "query", { signal: midSleep.signal });
    setTimeout(() => midSleep.abort(), 10);
    await expect(sleeping).rejects.toThrow(/abandoned/);
    expect(Date.now() - started).toBeLessThan(400);
    expect(f.calls).toHaveLength(1);

    // An injected sleep that ignores the signal: the loop re-checks it before retrying.
    const late = new AbortController();
    const g = fakeFetch([{ status: 503, body: "down" }]);
    const e = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: g.fetch, sleep: async () => late.abort() });
    await expect(e.embed(["a"], "query", { signal: late.signal })).rejects.toThrow(/abandoned/);
    expect(g.calls).toHaveLength(1);
  });

  it("passes a timeout signal on every attempt, combined with the caller's when given", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const fetch: FetchLike = async (_url, init) => {
      seen.push(init.signal);
      return { ok: true, status: 200, text: async () => JSON.stringify(vecs(1, 2)) };
    };
    const e = new GeminiEmbedder({ apiKey: "k", dims: 2, fetch });
    const caller = new AbortController();
    await e.embed(["a"], "query");
    await e.embed(["a"], "query", { signal: caller.signal });
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s instanceof AbortSignal && !s.aborted)).toBe(true);
    caller.abort();
    expect(seen[0]!.aborted).toBe(false);
    expect(seen[1]!.aborted).toBe(true);
  });

  it("finishes the default backoff normally when the caller's signal never aborts", async () => {
    const f = fakeFetch([{ status: 503, body: "down" }, { status: 200, body: vecs(1, 2) }]);
    const caller = new AbortController();
    const out = await new GeminiEmbedder({ apiKey: "k", dims: 2, fetch: f.fetch }).embed(["a"], "query", { signal: caller.signal });
    expect(out).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
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
