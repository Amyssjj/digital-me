/**
 * wiki-graph.ts — follow `related:` frontmatter edges between wiki entries.
 *
 * Used by digital-me-recall's Hook B to expand memory_search hits via the
 * wiki's `related:` graph, so an entry that's only loosely-relevant by
 * semantic match can still surface its tightly-related neighbors.
 *
 * Pure functions — no I/O. The caller injects a `loadEntry` function
 * that reads wiki files from disk (or a mock in tests).
 */

export interface WikiEntry {
  /** Relative path under the wiki root (e.g. "tools/foo.md"). */
  relPath: string;
  /** Parsed frontmatter — `related:` is the only field we currently consume. */
  frontmatter: { related?: string[] };
  /** Markdown body, optional (only needed if the caller wants to inject content). */
  body?: string;
}

/**
 * Parse the YAML frontmatter block out of a wiki markdown file. Only
 * extracts the `related:` field — we don't need a full YAML parser.
 *
 * Recognized formats for `related:`:
 *   related: []                              → []
 *   related: [a/b.md, c/d.md]                → ["a/b.md", "c/d.md"]
 *   related:
 *     - a/b.md
 *     - c/d.md                               → ["a/b.md", "c/d.md"]
 */
export function parseRelatedField(frontmatterText: string): string[] {
  // Match `related:` followed by either an inline array or list-form.
  const inlineMatch = frontmatterText.match(/^related:\s*\[([^\]]*)\]\s*$/m);
  if (inlineMatch && inlineMatch[1] !== undefined) {
    return inlineMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter((s) => s.length > 0);
  }
  // List form: a sequence of `  - <path>` lines after `related:`.
  const listStart = frontmatterText.match(/^related:\s*$/m);
  if (listStart && listStart.index !== undefined) {
    const after = frontmatterText.slice(
      listStart.index + listStart[0].length + 1,
    );
    const lines = after.split("\n");
    const out: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*-\s+['"]?([^'"\n]+?)['"]?\s*$/);
      if (m && m[1] !== undefined) out.push(m[1].trim());
      else if (line.trim() && !line.match(/^\s/)) break; // end of block
    }
    return out;
  }
  return [];
}

/**
 * Extract just the frontmatter text (between the leading ---/--- block).
 * Returns null if no frontmatter present.
 */
export function extractFrontmatterText(fileText: string): string | null {
  const m = fileText.match(/^---\n([\s\S]*?)\n---/);
  return m && m[1] !== undefined ? m[1] : null;
}

/**
 * Breadth-first walk the `related:` graph starting from `seeds`. Returns
 * a list of WikiEntries reached, in insertion order (seeds first, then
 * 1-hop, then 2-hop, etc.). Deduplicated by relPath.
 *
 * `loadEntry(relPath)` should return a WikiEntry or null if the path is
 * unresolvable (broken link, missing file). Broken links are silently
 * skipped.
 *
 * `maxDepth=0` returns just the seeds (no expansion). `maxDepth=1` adds
 * 1-hop neighbors. Recommended default: 1.
 */
export function expandViaGraph(
  seeds: WikiEntry[],
  loadEntry: (relPath: string) => WikiEntry | null,
  maxDepth: number,
  maxNodes = 50,
): WikiEntry[] {
  const seen = new Set<string>();
  const out: WikiEntry[] = [];
  for (const s of seeds) {
    if (!seen.has(s.relPath)) {
      seen.add(s.relPath);
      out.push(s);
    }
  }
  if (maxDepth <= 0) return out;

  let frontier: WikiEntry[] = out.slice();
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: WikiEntry[] = [];
    for (const node of frontier) {
      const related = node.frontmatter.related ?? [];
      for (const rel of related) {
        if (seen.has(rel)) continue;
        if (out.length >= maxNodes) return out;
        const loaded = loadEntry(rel);
        if (!loaded) continue;
        seen.add(rel);
        out.push(loaded);
        next.push(loaded);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return out;
}
