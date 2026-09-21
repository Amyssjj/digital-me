/**
 * Corpus scanner: turns the wiki and tastes trees into retrieval documents.
 *
 * The ENTRY is the retrieval unit. Each markdown file becomes one
 * `EntryDoc` with an entry-level text (title + domain + tags + the sections
 * that state the knowledge) and one `Section` per `## heading`, each with
 * its line range so a hit can point at the exact lines.
 *
 * Index pages (`_INDEX.md`, `_OVERVIEW.md`, anything starting with `_`) are
 * skipped: they are navigation, never the answer, and they were 62% of the
 * openclaw index's top-1 hits on 2026-09-19.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type Section = {
  readonly heading: string;
  readonly text: string;
  readonly startLine: number; // 1-based, inclusive (the heading line)
  readonly endLine: number; // 1-based, inclusive
};

export type EntryDoc = {
  /** Absolute path on disk. */
  readonly path: string;
  /** `wiki/<domain>/<file>.md` or `tastes/<...>.md`, forward slashes. */
  readonly relPath: string;
  readonly corpus: "wiki" | "tastes";
  readonly title: string;
  readonly domain: string;
  readonly tags: readonly string[];
  readonly sections: readonly Section[];
  /** What gets embedded as the entry vector and indexed for full text. */
  readonly entryText: string;
  readonly fullText: string;
  /** sha256 of the file contents; drives incremental re-indexing. */
  readonly hash: string;
};

export type CorpusRoot = { readonly dir: string; readonly corpus: "wiki" | "tastes" };

/** Sections whose text belongs in the entry vector, per corpus. */
const ENTRY_SECTIONS: Record<"wiki" | "tastes", readonly string[]> = {
  wiki: ["rule", "apply when"],
  tastes: ["principle", "discriminator", "fire signature"],
};

const ENTRY_TEXT_MAX_CHARS = 2400;

export function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith("_") || name.startsWith(".")) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".md")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

export function parseFrontmatter(text: string): { fields: Record<string, string>; bodyStartLine: number } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { fields: {}, bodyStartLine: 1 };
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") return { fields, bodyStartLine: i + 2 };
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) {
      key = m[1]!;
      fields[key] = m[2]!.trim();
    } else if (key !== null && /^\s*-\s+/.test(line)) {
      // YAML block list continuation: `- item`
      const item = line.replace(/^\s*-\s+/, "").trim();
      fields[key] = fields[key] === "" ? item : `${fields[key]}, ${item}`;
    }
  }
  return { fields: {}, bodyStartLine: 1 };
}

/** `[a, b]` / `a, b` / `'a'` → ["a", "b"] */
export function parseList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter((s) => s !== "");
}

export function splitSections(lines: readonly string[], bodyStartLine: number): Section[] {
  const sections: Section[] = [];
  let current: { heading: string; start: number; buf: string[] } | null = null;
  const flush = (end: number): void => {
    if (current === null) return;
    sections.push({
      heading: current.heading,
      text: current.buf.join("\n").trim(),
      startLine: current.start,
      endLine: end,
    });
  };
  for (let i = bodyStartLine - 1; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush(i);
      current = { heading: m[1]!, start: i + 1, buf: [] };
    } else if (current !== null) {
      current.buf.push(line);
    }
  }
  flush(lines.length);
  return sections.filter((s) => s.text !== "");
}

export function buildEntryDoc(root: CorpusRoot, filePath: string, text: string): EntryDoc {
  const { fields, bodyStartLine } = parseFrontmatter(text);
  const lines = text.split("\n");
  const sections = splitSections(lines, bodyStartLine);
  const rel = relative(root.dir, filePath).split(sep).join("/");
  const relPath = `${root.corpus}/${rel}`;
  const domain = parseList(fields.domain)[0] ?? (rel.includes("/") ? rel.split("/")[0]! : root.corpus);
  const tags = parseList(fields.tags);
  const title = (fields.title ?? "").replace(/^['"]|['"]$/g, "") || titleFromFilename(rel);
  const wanted = ENTRY_SECTIONS[root.corpus];
  const chosen = sections.filter((s) => wanted.some((w) => s.heading.toLowerCase().startsWith(w)));
  const body = (chosen.length > 0 ? chosen : sections).map((s) => s.text).join("\n\n");
  const header = [title, `domain: ${domain}`, tags.length > 0 ? `tags: ${tags.join(", ")}` : ""]
    .filter((s) => s !== "")
    .join("\n");
  const entryText = `${header}\n\n${body}`.slice(0, ENTRY_TEXT_MAX_CHARS);
  return {
    path: filePath,
    relPath,
    corpus: root.corpus,
    title,
    domain,
    tags,
    sections,
    entryText,
    fullText: lines.slice(bodyStartLine - 1).join("\n"),
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

function titleFromFilename(rel: string): string {
  const base = rel.split("/").pop()!.replace(/\.md$/, "");
  return base.replace(/[-_]+/g, " ");
}

export function scanCorpus(roots: readonly CorpusRoot[]): EntryDoc[] {
  const docs: EntryDoc[] = [];
  for (const root of roots) {
    for (const file of listMarkdownFiles(root.dir)) {
      docs.push(buildEntryDoc(root, file, readFileSync(file, "utf-8")));
    }
  }
  return docs;
}
