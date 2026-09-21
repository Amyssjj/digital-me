/**
 * Incremental index build: scan the corpus, embed only entries whose content
 * hash changed, drop entries whose files disappeared, and stamp provenance.
 */

import type { CorpusRoot, EntryDoc } from "./corpus.js";
import { scanCorpus } from "./corpus.js";
import type { Embedder } from "./embedder.js";
import type { IndexStore } from "./store.js";

export type BuildOptions = {
  readonly roots: readonly CorpusRoot[];
  readonly store: IndexStore;
  readonly embedder: Embedder;
  readonly force?: boolean;
  readonly log?: (line: string) => void;
  readonly scan?: (roots: readonly CorpusRoot[]) => EntryDoc[];
};

export type BuildResult = {
  readonly scanned: number;
  readonly embedded: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly vectors: number;
  /** Monotonic counter bumped on every build; the serving process's vector cache keys on it. */
  readonly generation: number;
};

/** meta key: bumped by every buildIndex, read by VectorCache to detect an out-of-process re-index. */
export const INDEX_GENERATION_KEY = "index_generation";

export class ProvenanceMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `index was built with ${expected} but this embedder is ${actual}; ` +
        `re-index with --force (search refuses to run against a mismatched index)`,
    );
    this.name = "ProvenanceMismatchError";
  }
}

export function provenanceLabel(p: { provider: string; model: string; dims: number }): string {
  return `${p.provider}/${p.model}@${p.dims}`;
}

export async function buildIndex(opts: BuildOptions): Promise<BuildResult> {
  const { store, embedder } = opts;
  const log = opts.log ?? (() => {});
  const existing = store.getProvenance();
  const mine = { provider: embedder.provider, model: embedder.model, dims: embedder.dims };
  if (existing && provenanceLabel(existing) !== provenanceLabel(mine)) {
    if (!opts.force) throw new ProvenanceMismatchError(provenanceLabel(existing), provenanceLabel(mine));
    log(`provenance changed (${provenanceLabel(existing)} → ${provenanceLabel(mine)}): clearing index`);
    store.clear();
  } else if (opts.force) {
    store.clear();
  }

  const docs = (opts.scan ?? scanCorpus)(opts.roots);
  const known = store.hashes();
  const seen = new Set<string>();
  const todo: EntryDoc[] = [];
  for (const doc of docs) {
    seen.add(doc.path);
    if (known.get(doc.path) !== doc.hash) todo.push(doc);
  }
  const removed = [...known.keys()].filter((p) => !seen.has(p));
  store.deleteEntries(removed);
  log(`scanned ${docs.length} entries: ${todo.length} to embed, ${docs.length - todo.length} unchanged, ${removed.length} removed`);

  let vectors = 0;
  const BATCH_DOCS = 40;
  for (let i = 0; i < todo.length; i += BATCH_DOCS) {
    const batch = todo.slice(i, i + BATCH_DOCS);
    const texts: string[] = [];
    for (const doc of batch) {
      texts.push(doc.entryText);
      for (const s of doc.sections) texts.push(`${doc.title}\n${s.heading}\n${s.text}`.slice(0, 2400));
    }
    const vecs = await embedder.embed(texts, "document");
    let cursor = 0;
    for (const doc of batch) {
      const entryVec = vecs[cursor++]!;
      const sectionVecs = vecs.slice(cursor, cursor + doc.sections.length);
      cursor += doc.sections.length;
      store.upsertEntry(doc, entryVec, sectionVecs);
    }
    vectors += texts.length;
    log(`embedded ${Math.min(i + BATCH_DOCS, todo.length)}/${todo.length}`);
  }
  store.setProvenance(mine);
  store.setMeta("last_index_at", new Date().toISOString());
  const generation = Number(store.getMeta(INDEX_GENERATION_KEY) ?? "0") + 1;
  store.setMeta(INDEX_GENERATION_KEY, String(generation));
  return { scanned: docs.length, embedded: todo.length, unchanged: docs.length - todo.length, removed: removed.length, vectors, generation };
}
