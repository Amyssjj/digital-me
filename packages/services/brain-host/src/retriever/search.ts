/**
 * Hybrid search: entry vectors + section vectors (rolled up to their entry)
 * + FTS5 bm25, fused with reciprocal-rank fusion. One hit per entry; the best
 * section supplies the line range and snippet.
 *
 * Output shape matches what the recall plugin, the proxy normalizers and the
 * dashboard already consume from openclaw's memory_search.
 *
 * Score contract: `score` is a 0..1 relevance (the best cosine similarity of
 * the entry or its best section against the query) — the same scale the
 * openclaw gateway emitted and the one every recall hook gates on
 * (MIN_SCORE 0.4). Results are ORDERED by `fusedScore`, the reciprocal-rank
 * fusion sum (~0.05 max), which is exposed for diagnostics only; gating on it
 * would drop every hit.
 */

import type { Embedder } from "./embedder.js";
import { tokenize } from "./embedder.js";
import { INDEX_GENERATION_KEY, ProvenanceMismatchError, provenanceLabel } from "./index-builder.js";
import type { IndexStore } from "./store.js";
import { dot, topK } from "./vec.js";

export type SearchHit = {
  readonly path: string;
  readonly relPath: string;
  readonly title: string;
  readonly corpus: string;
  readonly startLine: number;
  readonly endLine: number;
  /** 0..1 relevance (== vectorScore); what recall hooks gate on. */
  readonly score: number;
  /** Reciprocal-rank-fusion sum the results are ordered by (~0.05 max). */
  readonly fusedScore: number;
  readonly vectorScore: number;
  readonly textScore: number;
  readonly snippet: string;
  readonly source: "memory";
  readonly citation: string;
};

export type SearchResponse = {
  readonly results: SearchHit[];
  readonly provider: string;
  readonly model: string;
  readonly count: number;
  readonly query: string;
};

export type SearchOptions = { readonly limit?: number; readonly corpus?: string };

const RRF_K = 60;
const CANDIDATES = 50;
const SNIPPET_CHARS = 400;
export const DEFAULT_LIMIT = 6;
export const MAX_LIMIT = 50;

/**
 * Cache of vectors in memory. It keys on the store's `index_generation` meta,
 * so a re-index by ANY process (the serving brain-host's own refresh, or a
 * `brain-host index` run from the CLI) is picked up on the next search without
 * a restart. One cheap meta read per search.
 */
export class VectorCache {
  private entries: { path: string; vec: Float32Array }[] | null = null;
  private sections: { path: string; vec: Float32Array; sectionId: number }[] | null = null;
  private generation: string | null = null;

  constructor(private readonly store: IndexStore) {}

  invalidate(): void {
    this.entries = null;
    this.sections = null;
    this.generation = null;
  }

  /** Drop cached vectors when the on-disk index generation moved. */
  private refresh(): void {
    const current = this.store.getMeta(INDEX_GENERATION_KEY);
    if (current !== this.generation) {
      this.entries = null;
      this.sections = null;
      this.generation = current;
    }
  }

  entryVecs(): { path: string; vec: Float32Array }[] {
    this.refresh();
    this.entries ??= this.store.entryVectors();
    return this.entries;
  }

  sectionVecs(): { path: string; vec: Float32Array; sectionId: number }[] {
    this.refresh();
    this.sections ??= this.store.sectionVectors().map((r) => ({ path: r.path, vec: r.vec, sectionId: r.sectionId! }));
    return this.sections;
  }
}

/** Turn free text into a safe FTS5 query: quoted tokens joined by OR. */
export function toFtsQuery(query: string): string {
  const toks = [...new Set(tokenize(query))].slice(0, 24);
  return toks.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export function clampLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

export async function search(
  store: IndexStore,
  cache: VectorCache,
  embedder: Embedder,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const prov = store.getProvenance();
  const mine = { provider: embedder.provider, model: embedder.model, dims: embedder.dims };
  if (prov === null) throw new Error("index is empty: run `brain-host index` first");
  if (provenanceLabel(prov) !== provenanceLabel(mine)) {
    throw new ProvenanceMismatchError(provenanceLabel(prov), provenanceLabel(mine));
  }
  const limit = clampLimit(opts.limit);
  const [qvec] = await embedder.embed([query], "query");

  // 1. entry-vector ranking
  const entries = cache.entryVecs();
  const entryScores = entries.map((e) => dot(e.vec, qvec!));
  const entryRank = topK(entryScores, CANDIDATES).map((i) => entries[i]!.path);

  // 2. section-vector ranking, rolled up to the entry (best section wins)
  const sections = cache.sectionVecs();
  const sectionScores = sections.map((s) => dot(s.vec, qvec!));
  const bestSection = new Map<string, { sectionId: number; score: number }>();
  const sectionRank: string[] = [];
  for (const i of topK(sectionScores, CANDIDATES * 3)) {
    const s = sections[i]!;
    if (!bestSection.has(s.path)) {
      bestSection.set(s.path, { sectionId: s.sectionId, score: sectionScores[i]! });
      sectionRank.push(s.path);
    }
  }

  // 3. lexical ranking
  const fts = toFtsQuery(query);
  const ftsRank = fts === "" ? [] : store.ftsSearch(fts, CANDIDATES).map((h) => h.path);

  // 4. reciprocal-rank fusion
  const fused = new Map<string, number>();
  const add = (ranked: readonly string[], weight: number): void => {
    ranked.forEach((p, r) => fused.set(p, (fused.get(p) ?? 0) + weight / (RRF_K + r + 1)));
  };
  add(entryRank, 1.0);
  add(sectionRank.slice(0, CANDIDATES), 0.8);
  add(ftsRank, 0.8);

  // Map preserves first-seen order and Array.sort is stable, so ties are deterministic.
  const ordered = [...fused.entries()].sort((a, b) => b[1] - a[1]);
  const vecByPath = new Map(entries.map((e, i) => [e.path, entryScores[i]!]));
  const ftsPos = new Map(ftsRank.map((p, i) => [p, i]));

  const results: SearchHit[] = [];
  for (const [path, fusedScore] of ordered) {
    const entry = store.getEntry(path);
    if (entry === null) continue;
    if (opts.corpus && opts.corpus !== "all" && opts.corpus !== "memory" && entry.corpus !== opts.corpus) continue;
    const best = bestSection.get(path);
    const section = (best ? store.getSection(best.sectionId) : null) ?? store.firstSection(path);
    const startLine = section?.startLine ?? 1;
    const endLine = section?.endLine ?? 1;
    const snippet = (section ? `${section.heading}: ${section.text}` : entry.title).slice(0, SNIPPET_CHARS);
    const vectorScore = round(Math.max(vecByPath.get(path)!, best?.score ?? 0));
    results.push({
      path,
      relPath: entry.relPath,
      title: entry.title,
      corpus: entry.corpus,
      startLine,
      endLine,
      score: vectorScore,
      fusedScore: round(fusedScore),
      vectorScore,
      textScore: ftsPos.has(path) ? round(1 / (1 + ftsPos.get(path)!)) : 0,
      snippet,
      source: "memory",
      citation: `${entry.relPath}#L${startLine}-L${endLine}`,
    });
    if (results.length >= limit) break;
  }
  return { results, provider: embedder.provider, model: embedder.model, count: results.length, query };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
