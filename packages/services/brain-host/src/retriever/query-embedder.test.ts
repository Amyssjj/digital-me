import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedUnavailableError, type EmbedOptions, type EmbedTask, type Embedder } from "./embedder.js";
import { DEFAULT_QUERY_DEADLINE_MS, QueryEmbeddingCache } from "./query-embedder.js";

type Call = { texts: readonly string[]; task: EmbedTask; opts: EmbedOptions | undefined };

/** An embedder whose every call waits until the test settles it. */
function controlled() {
  const calls: (Call & { resolve: () => void; reject: (err: Error) => void })[] = [];
  const inner: Embedder = {
    provider: "fake",
    model: "m1",
    dims: 2,
    embed: (texts, task, opts) =>
      new Promise((resolve, reject) => {
        calls.push({ texts, task, opts, resolve: () => resolve(texts.map((t) => Float32Array.of(t.length, 1))), reject });
      }),
  };
  return { inner, calls };
}

/** An embedder that answers immediately and counts its calls. */
function instant() {
  const calls: Call[] = [];
  const inner: Embedder = {
    provider: "fake",
    model: "m1",
    dims: 2,
    embed: async (texts, task, opts) => {
      calls.push({ texts, task, opts });
      return texts.map((t) => Float32Array.of(t.length, 1));
    },
  };
  return { inner, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("QueryEmbeddingCache", () => {
  it("forwards provenance and passes document embeds straight through", async () => {
    const { inner, calls } = instant();
    const q = new QueryEmbeddingCache(inner);
    expect([q.provider, q.model, q.dims]).toEqual(["fake", "m1", 2]);
    const opts = { attemptTimeoutMs: 5 };
    await q.embed(["d1", "d1"], "document", opts);
    await q.embed(["d1"], "document");
    expect(calls.map((c) => [c.texts, c.task, c.opts])).toEqual([
      [["d1", "d1"], "document", opts],
      [["d1"], "document", undefined],
    ]);
    expect(q.stats()).toEqual({
      size: 0,
      capacity: 512,
      deadlineMs: DEFAULT_QUERY_DEADLINE_MS,
      inflight: 0,
      hits: 0,
      misses: 0,
      coalesced: 0,
      deadlineMisses: 0,
      lateFills: 0,
      failures: 0,
    });
  });

  it("caches query vectors and bounds each request with a budget signal and a per-attempt timeout", async () => {
    const { inner, calls } = instant();
    const q = new QueryEmbeddingCache(inner, { budgetMs: 9_000, attemptTimeoutMs: 700 });
    const [a] = await q.embed(["kanban"], "query");
    const [b] = await q.embed(["kanban"], "query");
    expect(b).toBe(a);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.texts).toEqual(["kanban"]);
    expect(calls[0]!.task).toBe("query");
    expect(calls[0]!.opts!.attemptTimeoutMs).toBe(700);
    expect(calls[0]!.opts!.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.opts!.signal!.aborted).toBe(false);
    expect(q.stats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });

  it("embeds each text of a multi-query call through the cache", async () => {
    const { inner, calls } = instant();
    const q = new QueryEmbeddingCache(inner);
    const out = await q.embed(["ab", "abc", "ab"], "query");
    expect(out.map((v) => v[0])).toEqual([2, 3, 2]);
    expect(calls.map((c) => c.texts[0])).toEqual(["ab", "abc"]);
    expect(q.stats()).toMatchObject({ misses: 2, coalesced: 1 });
  });

  it("shares one request between concurrent identical queries", async () => {
    const { inner, calls } = controlled();
    const q = new QueryEmbeddingCache(inner);
    const first = q.embed(["same prompt"], "query");
    const second = q.embed(["same prompt"], "query");
    expect(calls).toHaveLength(1);
    expect(q.stats()).toMatchObject({ inflight: 1, misses: 1, coalesced: 1 });
    calls[0]!.resolve();
    const [[a], [b]] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(q.stats()).toMatchObject({ inflight: 0, size: 1 });
  });

  it("evicts the least recently used vector past capacity", async () => {
    const { inner, calls } = instant();
    const q = new QueryEmbeddingCache(inner, { capacity: 2 });
    await q.embed(["a"], "query");
    await q.embed(["b"], "query");
    await q.embed(["a"], "query"); // a is now the most recent
    await q.embed(["c"], "query"); // evicts b
    await q.embed(["a"], "query");
    expect(calls).toHaveLength(3);
    await q.embed(["b"], "query");
    expect(calls.map((c) => c.texts[0])).toEqual(["a", "b", "c", "b"]);
    expect(q.stats()).toMatchObject({ size: 2, hits: 2, misses: 4 });
  });

  it("gives up waiting at the deadline, then caches the late answer for the next ask", async () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const logs: string[] = [];
    const { inner, calls } = controlled();
    const q = new QueryEmbeddingCache(inner, { deadlineMs: 3_000, log: (l) => logs.push(l), now: () => clock });
    const waiting = q.embed(["slow query"], "query");
    const outcome = waiting.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(3_000);
    const err = await outcome;
    expect(err).toBeInstanceOf(EmbedUnavailableError);
    expect((err as Error).message).toBe("query embedding missed its 3000ms deadline");
    expect(q.stats()).toMatchObject({ deadlineMisses: 1, inflight: 1 });

    clock += 5_200;
    calls[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(q.stats()).toMatchObject({ lateFills: 1, inflight: 0, size: 1 });
    const [vec] = await q.embed(["slow query"], "query");
    expect(Array.from(vec!)).toEqual([10, 1]);
    expect(calls).toHaveLength(1);
    expect(logs).toEqual([
      "query embedding missed its 3000ms deadline; the request runs on to fill the cache",
      "query embedding landed after 5200ms, past the 3000ms deadline; cached for the next identical query",
    ]);
  });

  it("does not report a late fill for an answer inside the deadline", async () => {
    const logs: string[] = [];
    const { inner, calls } = controlled();
    const q = new QueryEmbeddingCache(inner, { log: (l) => logs.push(l) });
    const pending = q.embed(["quick"], "query");
    calls[0]!.resolve();
    await pending;
    expect(logs).toEqual([]);
    expect(q.stats()).toMatchObject({ lateFills: 0, deadlineMisses: 0 });
  });

  it("propagates a failure to waiting callers, records it, and retries on the next ask", async () => {
    const logs: string[] = [];
    const { inner, calls } = controlled();
    const q = new QueryEmbeddingCache(inner, { log: (l) => logs.push(l) });
    const pending = q.embed(["q"], "query");
    calls[0]!.reject(new Error("gemini embed failed: HTTP 400 bad key"));
    await expect(pending).rejects.toThrow(/HTTP 400 bad key/);
    expect(q.stats()).toMatchObject({ failures: 1, inflight: 0, size: 0 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^query embedding failed after \d+ms: gemini embed failed: HTTP 400 bad key$/);
    void q.embed(["q"], "query").catch(() => {});
    expect(calls).toHaveLength(2);
  });

  it("logs nowhere by default", async () => {
    const { inner, calls } = controlled();
    const q = new QueryEmbeddingCache(inner);
    const pending = q.embed(["q"], "query");
    calls[0]!.reject(new Error("boom"));
    await expect(pending).rejects.toThrow("boom");
    expect(q.stats()).toMatchObject({ failures: 1 });
  });

  it("records a failure that lands after every caller stopped waiting, without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const { inner, calls } = controlled();
    const q = new QueryEmbeddingCache(inner, { deadlineMs: 100, log: (l) => logs.push(l) });
    const outcome = q.embed(["q"], "query").catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBeInstanceOf(EmbedUnavailableError);
    calls[0]!.reject(new EmbedUnavailableError("gemini embed failed after 5 attempts: HTTP 429"));
    await vi.advanceTimersByTimeAsync(0);
    expect(q.stats()).toMatchObject({ deadlineMisses: 1, failures: 1, inflight: 0 });
    expect(logs[1]).toMatch(/query embedding failed after \d+ms: gemini embed failed after 5 attempts: HTTP 429/);
  });
});
