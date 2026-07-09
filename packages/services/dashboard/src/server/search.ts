/**
 * Feed search — ranked knowledge search over the brain's memory_search tool.
 *
 * GET /api/search?q=<query>[&corpus=wiki|memory|all][&limit=N]
 *
 * The brain does the ranking (hybrid vector + text score); this module owns
 * everything around it:
 *
 *   • normalizing the tool's loose result shape into typed hits
 *   • deriving a human title (frontmatter `title:` > filename slug)
 *   • resolving each hit's raw path — often a `../../..`-relative artifact of
 *     the brain's index root — back to a real file INSIDE an allow-listed
 *     content root, so the preview panel can render the full markdown
 *   • never reading outside those roots (the resolver is containment-checked;
 *     a hostile `../../etc/passwd` path degrades to a null preview, not a read)
 *
 * The response items mirror the Feed's attachment shape (title/path/markdown)
 * so the frontend renders results with the exact same post + preview design.
 */

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";

export type SearchCorpus = "wiki" | "memory" | "all";

const SEARCH_CORPORA: readonly SearchCorpus[] = ["wiki", "memory", "all"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Preview payload cap — a runaway file must not balloon the response. */
const MAX_MARKDOWN_BYTES = 256 * 1024;

export function coerceCorpus(raw: unknown): SearchCorpus {
  return typeof raw === "string" && (SEARCH_CORPORA as readonly string[]).includes(raw)
    ? (raw as SearchCorpus)
    : "all";
}

export function coerceLimit(raw: unknown): number {
  const parsed = typeof raw === "string" ? parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_LIMIT ? parsed : DEFAULT_LIMIT;
}

/** One hit as the memory_search tool reports it (after defensive parsing). */
export interface RawSearchHit {
  readonly path: string;
  readonly snippet: string;
  readonly score: number | null;
}

/** Defensively extract hits from the tool's response. Tolerates a missing /
 *  non-array `results`, non-object entries, and absent fields — a malformed
 *  upstream payload degrades to an empty result list, not a 500. */
export function normalizeSearchResults(raw: unknown): RawSearchHit[] {
  if (typeof raw !== "object" || raw === null) return [];
  const results = (raw as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  const hits: RawSearchHit[] = [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== "string" || e.path.length === 0) continue;
    hits.push({
      path: e.path,
      snippet: typeof e.snippet === "string" ? e.snippet : "",
      score: typeof e.score === "number" ? e.score : null,
    });
  }
  return hits;
}

/** Human title for a hit: the frontmatter `title:` line when the snippet
 *  carries one, else the filename slug de-kebabed ("taste-flat-tree" →
 *  "Taste flat tree"). */
export function titleForHit(snippet: string, rawPath: string): string {
  const m = /^title:\s*(.+)$/m.exec(snippet);
  if (m) {
    const t = m[1]!.trim().replace(/^['"]|['"]$/g, "").trim();
    if (t.length > 0) return t;
  }
  const base = path.basename(rawPath).replace(/\.mdx?$/i, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  return words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : rawPath;
}

/** Display path: strip the brain-index-relative `../` prefix noise so the UI
 *  shows "wiki/dashboard/foo.md", not "../../../../Users/…/foo.md". */
export function displayPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/");
  // Prefer the path from a well-known content tree marker onwards.
  for (const marker of ["wiki/", "tastes/", "memory/", "inbox/"]) {
    const idx = normalized.lastIndexOf(`/${marker}`);
    if (idx >= 0) return normalized.slice(idx + 1);
    if (normalized.startsWith(marker)) return normalized;
  }
  // Otherwise drop any leading ../ churn and absolute prefix.
  const stripped = normalized.replace(/^(\.\.\/)+/, "");
  return stripped.startsWith("/") ? path.basename(stripped) : stripped;
}

/** True when `candidate` sits inside `root` (lexically — after resolution). */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve a hit's raw path to a readable absolute path inside one of the
 * allow-listed content roots, or null. Tries, per root:
 *   1. the raw path taken as absolute
 *   2. the raw path resolved against the root (handles plain "memory/x.md")
 *   3. marker-based recovery: the substring from "/<root basename>/" onward
 *      re-anchored at the root (handles "../../../Users/…/digital-me/wiki/x.md"
 *      regardless of how deep the brain's index dir was)
 * Every candidate is containment-checked, so `../` escapes resolve to null.
 */
export function resolveContentPath(
  rawPath: string,
  roots: readonly string[],
  fileExists: (p: string) => boolean = (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
): string | null {
  const normalized = rawPath.replace(/\\/g, "/");
  for (const root of roots) {
    const candidates: string[] = [];
    if (path.isAbsolute(normalized)) candidates.push(path.resolve(normalized));
    candidates.push(path.resolve(root, normalized));
    const marker = `/${path.basename(root)}/`;
    const idx = normalized.lastIndexOf(marker);
    if (idx >= 0) {
      candidates.push(path.resolve(root, normalized.slice(idx + marker.length)));
    }
    for (const candidate of candidates) {
      if (isInsideRoot(root, candidate) && fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/** Read a resolved file for the preview panel; size-capped, error-tolerant. */
export function loadMarkdown(
  absPath: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8"),
): string | null {
  try {
    const content = readFile(absPath);
    return content.length > MAX_MARKDOWN_BYTES
      ? content.slice(0, MAX_MARKDOWN_BYTES)
      : content;
  } catch {
    return null;
  }
}

/** One ranked result, shaped like a Feed attachment (+ rank/score) so the
 *  frontend reuses the post + preview design unchanged. */
export interface SearchResultItem {
  readonly id: string;
  readonly rank: number;
  readonly title: string;
  readonly path: string;
  readonly score: number | null;
  readonly snippet: string;
  readonly markdown: string | null;
}

export interface SearchResponse {
  readonly query: string;
  readonly corpus: SearchCorpus;
  readonly results: readonly SearchResultItem[];
}

export type MemorySearchFn = (
  query: string,
  opts: { readonly corpus: SearchCorpus; readonly limit: number },
) => Promise<unknown>;

export interface SearchRouterDeps {
  /** Calls the brain's memory_search tool; returns its raw (parsed) payload. */
  readonly memorySearch: MemorySearchFn;
  /** Allow-listed roots the preview loader may read from. */
  readonly contentRoots: readonly string[];
  /** Test seams — default to real fs. */
  readonly fileExists?: (p: string) => boolean;
  readonly readFile?: (p: string) => string;
}

/** Pure assembly: raw tool payload → ranked, preview-hydrated response. */
export function buildSearchResponse(
  query: string,
  corpus: SearchCorpus,
  raw: unknown,
  deps: Pick<SearchRouterDeps, "contentRoots" | "fileExists" | "readFile">,
): SearchResponse {
  const results = normalizeSearchResults(raw).map((hit, i) => {
    const resolved = deps.fileExists
      ? resolveContentPath(hit.path, deps.contentRoots, deps.fileExists)
      : resolveContentPath(hit.path, deps.contentRoots);
    return {
      id: `${displayPath(hit.path)}#${i + 1}`,
      rank: i + 1,
      title: titleForHit(hit.snippet, hit.path),
      path: displayPath(hit.path),
      score: hit.score,
      snippet: hit.snippet,
      markdown: resolved === null ? null : loadMarkdown(resolved, deps.readFile),
    };
  });
  return { query, corpus, results };
}

/** Router for GET /api/search?q=…&corpus=…&limit=…. */
export function buildSearchRouter(deps: SearchRouterDeps): Router {
  const router = Router();
  router.get("/", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length === 0) {
      res.status(400).json({ error: "Missing query — pass ?q=<search terms>" });
      return;
    }
    const corpus = coerceCorpus(req.query.corpus);
    const limit = coerceLimit(req.query.limit);
    deps
      .memorySearch(q, { corpus, limit })
      .then((raw) => res.json(buildSearchResponse(q, corpus, raw, deps)))
      .catch((err) => {
        console.error("[/api/search]", err);
        // 502: the dashboard is fine, the brain upstream isn't reachable.
        res.status(502).json({ error: "memory_search unavailable — is the openclaw brain running?" });
      });
  });
  return router;
}
