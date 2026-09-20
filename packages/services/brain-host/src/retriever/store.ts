/**
 * SQLite index store (node:sqlite). One file holds everything: entries with
 * their entry vector, sections with their vectors, an FTS5 table over entry
 * text, and a `meta` table carrying embedding provenance.
 */

import type { DatabaseSync } from "node:sqlite";
import type { EntryDoc } from "./corpus.js";
import { fromBlob, toBlob } from "./vec.js";

export type Provenance = { readonly provider: string; readonly model: string; readonly dims: number };

export type EntryRow = {
  readonly path: string;
  readonly relPath: string;
  readonly corpus: string;
  readonly title: string;
  readonly domain: string;
  readonly tags: string;
  readonly hash: string;
};

export type SectionRow = {
  readonly id: number;
  readonly path: string;
  readonly heading: string;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
};

export type VecRow = { readonly path: string; readonly vec: Float32Array; readonly sectionId?: number };

export type FtsHit = { readonly path: string; readonly rank: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
  path TEXT PRIMARY KEY, rel_path TEXT NOT NULL, corpus TEXT NOT NULL, title TEXT NOT NULL,
  domain TEXT NOT NULL, tags TEXT NOT NULL, hash TEXT NOT NULL, entry_text TEXT NOT NULL, vec BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL REFERENCES entries(path) ON DELETE CASCADE,
  heading TEXT NOT NULL, text TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sections_path ON sections(path);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(path UNINDEXED, title, tags, body, tokenize='porter unicode61');
`;

export class IndexStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(SCHEMA);
  }

  getProvenance(): Provenance | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='provenance'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Provenance) : null;
  }

  setProvenance(p: Provenance): void {
    this.db
      .prepare("INSERT INTO meta(key,value) VALUES('provenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(p));
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /** path → content hash for every indexed entry. */
  hashes(): Map<string, string> {
    const rows = this.db.prepare("SELECT path, hash FROM entries").all() as { path: string; hash: string }[];
    return new Map(rows.map((r) => [r.path, r.hash]));
  }

  upsertEntry(doc: EntryDoc, entryVec: Float32Array, sectionVecs: readonly Float32Array[]): void {
    const tx = () => {
      this.db.prepare("DELETE FROM sections WHERE path=?").run(doc.path);
      this.db.prepare("DELETE FROM entries_fts WHERE path=?").run(doc.path);
      this.db
        .prepare(
          `INSERT INTO entries(path,rel_path,corpus,title,domain,tags,hash,entry_text,vec) VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET rel_path=excluded.rel_path, corpus=excluded.corpus, title=excluded.title,
           domain=excluded.domain, tags=excluded.tags, hash=excluded.hash, entry_text=excluded.entry_text, vec=excluded.vec`,
        )
        .run(doc.path, doc.relPath, doc.corpus, doc.title, doc.domain, doc.tags.join(", "), doc.hash, doc.entryText, toBlob(entryVec));
      const ins = this.db.prepare("INSERT INTO sections(path,heading,text,start_line,end_line,vec) VALUES(?,?,?,?,?,?)");
      doc.sections.forEach((s, i) => {
        ins.run(doc.path, s.heading, s.text, s.startLine, s.endLine, toBlob(sectionVecs[i]!));
      });
      this.db
        .prepare("INSERT INTO entries_fts(path,title,tags,body) VALUES(?,?,?,?)")
        .run(doc.path, doc.title, doc.tags.join(" "), doc.fullText);
    };
    this.db.exec("BEGIN");
    try {
      tx();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  deleteEntries(paths: readonly string[]): void {
    const del = this.db.prepare("DELETE FROM entries WHERE path=?");
    const delFts = this.db.prepare("DELETE FROM entries_fts WHERE path=?");
    for (const p of paths) {
      del.run(p);
      delFts.run(p);
    }
  }

  clear(): void {
    this.db.exec("DELETE FROM sections; DELETE FROM entries; DELETE FROM entries_fts; DELETE FROM meta;");
  }

  entryVectors(): VecRow[] {
    const rows = this.db.prepare("SELECT path, vec FROM entries").all() as { path: string; vec: Uint8Array }[];
    return rows.map((r) => ({ path: r.path, vec: fromBlob(r.vec) }));
  }

  sectionVectors(): VecRow[] {
    const rows = this.db.prepare("SELECT id, path, vec FROM sections").all() as { id: number; path: string; vec: Uint8Array }[];
    return rows.map((r) => ({ path: r.path, vec: fromBlob(r.vec), sectionId: r.id }));
  }

  getEntry(path: string): EntryRow | null {
    const r = this.db
      .prepare("SELECT path, rel_path, corpus, title, domain, tags, hash FROM entries WHERE path=?")
      .get(path) as { path: string; rel_path: string; corpus: string; title: string; domain: string; tags: string; hash: string } | undefined;
    return r ? { path: r.path, relPath: r.rel_path, corpus: r.corpus, title: r.title, domain: r.domain, tags: r.tags, hash: r.hash } : null;
  }

  getSection(id: number): SectionRow | null {
    const r = this.db
      .prepare("SELECT id, path, heading, text, start_line, end_line FROM sections WHERE id=?")
      .get(id) as { id: number; path: string; heading: string; text: string; start_line: number; end_line: number } | undefined;
    return r ? { id: r.id, path: r.path, heading: r.heading, text: r.text, startLine: r.start_line, endLine: r.end_line } : null;
  }

  firstSection(path: string): SectionRow | null {
    const r = this.db
      .prepare("SELECT id, path, heading, text, start_line, end_line FROM sections WHERE path=? ORDER BY start_line LIMIT 1")
      .get(path) as { id: number; path: string; heading: string; text: string; start_line: number; end_line: number } | undefined;
    return r ? { id: r.id, path: r.path, heading: r.heading, text: r.text, startLine: r.start_line, endLine: r.end_line } : null;
  }

  /** FTS5 bm25 ranking; `match` must already be a valid FTS5 query string. */
  ftsSearch(match: string, limit: number): FtsHit[] {
    try {
      const rows = this.db
        .prepare("SELECT path, bm25(entries_fts, 4.0, 2.0, 1.0) AS rank FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?")
        .all(match, limit) as { path: string; rank: number }[];
      return rows.map((r) => ({ path: r.path, rank: r.rank }));
    } catch {
      return [];
    }
  }

  stats(): { entries: number; sections: number; byCorpus: Record<string, number> } {
    const entries = (this.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
    const sections = (this.db.prepare("SELECT COUNT(*) AS n FROM sections").get() as { n: number }).n;
    const rows = this.db.prepare("SELECT corpus, COUNT(*) AS n FROM entries GROUP BY corpus").all() as { corpus: string; n: number }[];
    const byCorpus: Record<string, number> = {};
    for (const r of rows) byCorpus[r.corpus] = r.n;
    return { entries, sections, byCorpus };
  }
}
