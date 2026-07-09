/**
 * recall-hooks.ts — pure functions used by digital-me-recall's four hooks.
 *
 * Hook A (Boot Context) — loadBootContext: protocol + active policies
 * Hook B (Per-Turn Recall) — formatRecallInjection: turn search hits + graph
 *                            expansion into appendSystemContext text
 * Hook C (Per-Tool Route) — parseRouteFrontmatter, buildRouteIndex,
 *                           matchRouteConditions, formatRouteInjection
 * Hook D (Observability) — buildTraceRecord for brain.db inserts
 *
 * All functions are pure (or take I/O via injected functions). The
 * plugin entry handles registration, fs access, and DB writes.
 */

import { extractFrontmatterText, parseRelatedField } from "./wiki-graph.js";

// ─── Hook A — Boot Context ──────────────────────────────────────────────

export interface BootContextSources {
  /** Verbatim digital-me protocol text. Required. */
  digitalMeProtocol: string;
  /** Path to ~/digital-me/_INDEX.md — read for ACTIVE POLICIES section. */
  activePoliciesPath?: string;
  /** Optional dir of `.md` files whose contents are concatenated and injected. */
  protocolsDir?: string;
}

export interface BootContextFsAccess {
  readFile: (path: string) => string | null;
  existsSync: (path: string) => boolean;
  readdirSync: (path: string) => string[];
}

/**
 * Extract the ACTIVE POLICIES section from _INDEX.md. The dream_cycle
 * writes the section between three `===` fences; we capture from the
 * first through the third (inclusive). Fail-closed: returns null if
 * the structure differs.
 */
export function extractActivePolicies(indexText: string): string | null {
  const lines = indexText.split("\n");
  const fenceRe = /^=+$/;
  const out: string[] = [];
  let fence = 0;
  for (const line of lines) {
    if (fenceRe.test(line)) {
      fence++;
      if (fence === 1 || fence === 3) out.push(line);
      if (fence === 3) break;
      continue;
    }
    if (fence >= 1 && fence < 3) out.push(line);
  }
  if (fence < 3 || out.length === 0) return null;
  return out.join("\n").trim();
}

/**
 * Build the boot-context injection string. Concatenates:
 *  1. Digital-me protocol (always)
 *  2. ACTIVE POLICIES extracted from _INDEX.md (when present + parseable)
 *  3. Shared protocols (all `.md` files in protocolsDir, concatenated)
 *
 * Each section is wrapped in an XML-like tag so downstream agents can
 * reason about provenance.
 */
export function loadBootContext(
  sources: BootContextSources,
  fs: BootContextFsAccess,
): string {
  const parts: string[] = [];

  parts.push("<digital-me-protocol>");
  parts.push(sources.digitalMeProtocol.trim());
  parts.push("</digital-me-protocol>");

  if (sources.activePoliciesPath && fs.existsSync(sources.activePoliciesPath)) {
    const indexText = fs.readFile(sources.activePoliciesPath);
    if (indexText) {
      const policies = extractActivePolicies(indexText);
      if (policies) {
        parts.push("");
        parts.push("<active-policies>");
        parts.push(policies);
        parts.push("</active-policies>");
      }
    }
  }

  if (sources.protocolsDir && fs.existsSync(sources.protocolsDir)) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(sources.protocolsDir).filter((n) => n.endsWith(".md")).sort();
    } catch {
      // dir disappeared between exists check and read — skip
    }
    const protocolBodies: string[] = [];
    for (const name of files) {
      const body = fs.readFile(`${sources.protocolsDir}/${name}`);
      if (body && body.trim()) protocolBodies.push(body.trim());
    }
    if (protocolBodies.length > 0) {
      parts.push("");
      parts.push("<shared-protocols>");
      parts.push(protocolBodies.join("\n\n---\n\n"));
      parts.push("</shared-protocols>");
    }
  }

  return parts.join("\n");
}

// ─── Hook B — Per-Turn Recall ───────────────────────────────────────────

export interface RecallHit {
  /** Wiki entry's relative path (e.g. "tools/foo.md") or absolute. */
  path: string;
  /** Optional title; falls back to deriving from frontmatter or filename. */
  title?: string;
  /** Markdown body to inject. */
  body: string;
  /** Optional score from the upstream search; used only for display order. */
  score?: number;
}

/**
 * Build the `appendSystemContext` text from recall hits. Caps total
 * length to avoid runaway prompt growth. Output is wrapped in a
 * `<recalled-knowledge>` tag so agents can attribute provenance.
 *
 * 2026-05-22 (M1 calibration): added closing ACTION-REQUIRED line
 * that forces the agent to name which entry it's applying. Mirrors the
 * Claude-Code-side hook's behaviour so OpenClaw native agents get the
 * same engagement nudge.
 */
export function formatRecallInjection(
  hits: RecallHit[],
  maxChars = 8000,
): string {
  if (hits.length === 0) return "";
  const sections: string[] = ["<recalled-knowledge>"];
  let used = 0;
  for (const hit of hits) {
    const title = hit.title ?? hit.path;
    const block = `## ${title}\n\n${hit.body.trim()}`;
    if (used + block.length > maxChars) break;
    sections.push(block);
    used += block.length;
  }
  if (sections.length === 1) return ""; // only the open tag — no hits fit
  sections.push("</recalled-knowledge>");
  sections.push(
    "[Digital Me] protocol — BEGIN your reply with a line that starts `[Digital Me]`. " +
      "If one or more entries above apply, write `[Digital Me] applying <entry slug or title>` and use their content. " +
      "If none apply, write `[Digital Me] no applicable wiki entries` and proceed. " +
      "This prefix marks knowledge-application start and is tracked as M1 (application_rate); skipping it is a protocol violation. " +
      "Entries already shown earlier in this session are filtered out — anything here is new context worth one explicit acknowledgment.",
  );
  return sections.join("\n\n");
}

// ─── M1 ack parsing — [Digital Me] application-start marker ──────────────

export type AckSignal =
  | "explicit_path"
  | "title_match"
  | "no_applicable"
  | "no_acknowledgement";

/** A surfaced wiki entry, as carried on knowledge_surfaced events. */
export interface AckEntry {
  path: string;
  title?: string;
  score?: number | null;
  source?: string;
}

export interface ParsedAck {
  ackSignal: AckSignal;
  actedEntries: AckEntry[];
}

const NO_APPLICABLE_PATTERNS: readonly string[] = [
  "no applicable wiki entries",
  "no applicable entries",
  "no applicable wiki entry",
  "none of the entries above",
  "none apply",
  "no relevant wiki",
  "no relevant entries",
];

function normaliseForMatch(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Strip trailing decorations from a wiki entry's title so LLM responses don't
 * need to quote them verbatim. Mirrors the hermes plugin's `_title_stem`.
 * Returns "" when the stem is too short (<5 chars) to be a confident match.
 */
function titleStem(title: string): string {
  let norm = normaliseForMatch(title);
  for (const sep of [" (", " — ", " - ", ": ", " | "]) {
    const i = norm.indexOf(sep);
    if (i > 0) {
      norm = norm.slice(0, i).trim();
      break;
    }
  }
  return norm.length >= 5 ? norm : "";
}

/**
 * Parse an assistant reply for the `[Digital Me]` application-start marker
 * and resolve which surfaced entries it acknowledges. This is OpenClaw's
 * analogue of the hermes `_parse_ack` and the claude-code Stop-hook scan, so
 * the M1 ack signal is computed identically across runtimes.
 *
 * Conservative — prefers false negatives (a paraphrased citation missed) to
 * false positives, EXCEPT that the bare presence of the `[Digital Me]`
 * prefix (when not an explicit decline) always counts as an acknowledgment:
 * if it names no matchable entry, the top-1 surfaced entry is attributed so
 * the marker still registers application start without inflating the acted
 * set to the whole surfaced universe.
 *
 * Returns one of explicit_path | title_match | no_applicable |
 * no_acknowledgement. The first three are the signals the M1 scorer counts.
 */
export function parseDigitalMeAck(
  responseText: string,
  surfacedEntries: ReadonlyArray<AckEntry>,
): ParsedAck {
  if (!surfacedEntries || surfacedEntries.length === 0) {
    return { ackSignal: "no_acknowledgement", actedEntries: [] };
  }
  const norm = normaliseForMatch(responseText || "");
  if (!norm) return { ackSignal: "no_acknowledgement", actedEntries: [] };

  const hasPrefix = norm.includes("[digital me]");

  // Signal 1: explicit "no applicable" disclaimer (counts as ack, acted=[]).
  for (const pat of NO_APPLICABLE_PATTERNS) {
    if (norm.includes(pat)) {
      return { ackSignal: "no_applicable", actedEntries: [] };
    }
  }

  // Signals 2 + 3: entries with a path-substring or title-substring match.
  const acted: AckEntry[] = [];
  let sawPathMatch = false;
  for (const e of surfacedEntries) {
    const rawPath = (e.path || "").toLowerCase();
    const slug = rawPath.includes("/")
      ? rawPath.slice(rawPath.lastIndexOf("/") + 1)
      : rawPath;
    const slugNoExt = slug.endsWith(".md") ? slug.slice(0, -3) : slug;
    const pathMatch =
      (rawPath.length > 10 && norm.includes(rawPath)) ||
      (slugNoExt.length > 6 && norm.includes(slugNoExt));
    const stem = e.title ? titleStem(e.title) : "";
    const titleMatch = stem.length > 0 && norm.includes(stem);
    if (pathMatch || titleMatch) {
      acted.push(e);
      if (pathMatch) sawPathMatch = true;
    }
  }

  if (acted.length > 0) {
    return {
      ackSignal: sawPathMatch ? "explicit_path" : "title_match",
      actedEntries: acted,
    };
  }

  // Prefix present but named nothing matchable and didn't decline → still an
  // acknowledgment; attribute the top-1 (inlined) surfaced entry.
  const top = surfacedEntries[0];
  if (hasPrefix && top) {
    return { ackSignal: "title_match", actedEntries: [top] };
  }

  return { ackSignal: "no_acknowledgement", actedEntries: [] };
}

// ─── Top-hit body inliner (M1 parity with Claude-Code hook, 2026-05-22) ────

/**
 * Read a wiki entry off local disk for inlining as `hit.body`. Strips the
 * YAML frontmatter and truncates to `maxChars`. Pure I/O is injected via
 * the `readFile` and `existsSync` deps so this stays testable.
 *
 * Returns null when the file can't be located/read — caller falls back to
 * the upstream search's snippet.
 */
export interface WikiBodyReader {
  readFile: (path: string) => string | null;
  existsSync: (path: string) => boolean;
}

export function readWikiBody(
  hitPath: string,
  wikiRoot: string,
  reader: WikiBodyReader,
  maxChars = 2000,
): string | null {
  if (!hitPath) return null;
  // Per NUX scope-down §A: tastes live alongside wiki under the same parent
  // (~/digital-me/{wiki,tastes}/). Hits may carry either prefix; resolve
  // both to absolute paths under the parent dir.
  //
  // hitPath may be absolute, '../..-style relative, or 'foo/bar.md'.
  // Normalize to a path relative to ~/digital-me/.
  let rel: string;
  let treePrefix: "wiki" | "tastes" | null = null;
  if (hitPath.includes("/wiki/")) {
    // `?? hitPath` only narrows TS's index type — split() after a successful
    // includes() always yields ≥2 parts, so [1] is never undefined at runtime.
    /* v8 ignore next */
    rel = hitPath.split("/wiki/")[1] ?? hitPath;
    treePrefix = "wiki";
  } else if (hitPath.includes("/tastes/")) {
    // Same TS-narrowing-only fallback as the /wiki/ arm above.
    /* v8 ignore next */
    rel = hitPath.split("/tastes/")[1] ?? hitPath;
    treePrefix = "tastes";
  } else if (hitPath.startsWith("wiki/")) {
    rel = hitPath.slice("wiki/".length);
    treePrefix = "wiki";
  } else if (hitPath.startsWith("tastes/")) {
    rel = hitPath.slice("tastes/".length);
    treePrefix = "tastes";
  } else if (hitPath.startsWith("memory/")) {
    // per-agent memory files live outside the shared wiki dir; skip.
    return null;
  } else if (hitPath.startsWith("/")) {
    return null;
  } else {
    rel = hitPath;
    treePrefix = "wiki"; // backcompat default
  }
  // wikiRoot points at ~/digital-me/wiki for backcompat; the tastes tree
  // sits at the same parent. Resolve both via the parent dir.
  const parent = wikiRoot.endsWith("/wiki") ? wikiRoot.slice(0, -"/wiki".length) : wikiRoot;
  const abs = treePrefix === "tastes" ? `${parent}/tastes/${rel}` : `${wikiRoot}/${rel}`;
  if (!reader.existsSync(abs)) return null;
  const text = reader.readFile(abs);
  if (!text) return null;
  // Strip frontmatter (everything between the first two '---' lines).
  const parts = text.split(/^---$/m);
  const body = (parts.length >= 3 ? parts.slice(2).join("---") : text).trim();
  if (!body) return null;
  return body.length > maxChars ? body.slice(0, maxChars) + "…" : body;
}

/**
 * Apply M1 hygiene to raw hits BEFORE handing to formatRecallInjection:
 *   1. score-gate: drop hits below minScore
 *   2. dedup: drop hits whose path is in the session-scoped `seen` set
 *   3. top-1 body upgrade: replace the first hit's `body` with the
 *      file-read body (full Rule + body, up to bodyMaxChars), if available
 * Mutates `seen` (adds surviving hit paths).
 *
 * Returns the filtered/augmented hits array. May be empty.
 */
export function applyRecallHygiene(input: {
  hits: RecallHit[];
  seen: Set<string>;
  minScore?: number;
  bodyMaxChars?: number;
  wikiRoot?: string;
  reader?: WikiBodyReader;
}): RecallHit[] {
  const minScore = input.minScore ?? 0.4;
  const bodyMaxChars = input.bodyMaxChars ?? 2000;

  const filtered: RecallHit[] = [];
  for (const h of input.hits) {
    if (!h || !h.path) continue;
    if (typeof h.score === "number" && h.score < minScore) continue;
    if (input.seen.has(h.path)) continue;
    filtered.push(h);
  }
  if (filtered.length === 0) return [];

  // Top-1 body upgrade: replace snippet with full file body when readable.
  if (input.wikiRoot && input.reader) {
    const top = filtered[0]!;
    const full = readWikiBody(top.path, input.wikiRoot, input.reader, bodyMaxChars);
    if (full) {
      filtered[0] = { ...top, body: full };
    }
  }

  // Record paths into the dedup set AFTER we've committed to inject them.
  for (const h of filtered) input.seen.add(h.path);
  return filtered;
}

// ─── Hook C — Per-Tool Route ────────────────────────────────────────────

export interface RouteRule {
  /** Tool id the route fires on (e.g. "exec", "run_command"). */
  toolName: string;
  /** Verbatim condition string after the tool name, e.g. `params.command contains "ffmpeg"`. May be empty (tool-only route). */
  conditions: string;
  /** Rule text from the wiki entry, used for the injection. */
  rule: string;
  /** Path of the wiki file the route came from, for debug logging. */
  filePath: string;
  /** Title from the wiki entry. */
  title?: string;
}

/**
 * Parse a wiki frontmatter `route:` field. The field is a single string
 * with grammar:
 *   tool=<name>[, params.<field> contains "<v1>"[ OR "<v2>"...]]
 *
 * Returns null if the field is missing or malformed.
 */
export function parseRouteFrontmatter(
  frontmatterText: string,
): { toolName: string; conditions: string } | null {
  const m = frontmatterText.match(/^route:\s*(.+?)\s*$/m);
  if (!m || m[1] === undefined) return null;
  let value: string = m[1];
  // Strip MATCHING surrounding quotes (YAML quoted scalar). Conservative —
  // only strip when both endpoints share the same quote char, so a route
  // like `tool=exec, params.command contains "ffmpeg"` (which ends in `"`
  // but doesn't start with one) is left untouched.
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    value = value.slice(1, -1);
  }
  const toolMatch = value.match(/^tool=([A-Za-z_][A-Za-z0-9_]*)/);
  if (!toolMatch || toolMatch[1] === undefined) return null;
  const toolName: string = toolMatch[1];
  const conditions = value.slice(toolMatch[0].length).replace(/^,\s*/, "").trim();
  return { toolName, conditions };
}

/**
 * Build the toolName → RouteRule[] hashmap from a list of wiki entries.
 * Entries without a `route:` field are silently skipped.
 */
export function buildRouteIndex(
  wikiEntries: Array<{ filePath: string; text: string }>,
): Map<string, RouteRule[]> {
  const map = new Map<string, RouteRule[]>();
  for (const e of wikiEntries) {
    const fmText = extractFrontmatterText(e.text);
    if (!fmText) continue;
    const route = parseRouteFrontmatter(fmText);
    if (!route) continue;
    const titleMatch = fmText.match(/^title:\s*(.+)$/m);
    const title =
      titleMatch && titleMatch[1] !== undefined
        ? titleMatch[1].trim().replace(/^['"]|['"]$/g, "")
        : undefined;
    const rule = extractRuleSection(e.text);
    const rec: RouteRule = {
      toolName: route.toolName,
      conditions: route.conditions,
      rule,
      filePath: e.filePath,
      title,
    };
    const existing = map.get(route.toolName) ?? [];
    existing.push(rec);
    map.set(route.toolName, existing);
  }
  return map;
}

/** Pull the `## Rule` section body out of an entry, capping length. */
export function extractRuleSection(text: string, maxChars = 600): string {
  const m = text.match(/^##\s+Rule\s*\n([\s\S]*?)(?=\n##\s+|$)/m);
  if (!m || m[1] === undefined) return "";
  const trimmed = m[1].trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trimEnd() + "…";
}

/**
 * Evaluate route conditions against an actual tool call's params.
 * Conditions grammar (current support):
 *   ""                                           always matches
 *   params.X contains "V"                        single contains
 *   params.X contains "V1" OR "V2"               multi-value OR
 *   params.X OR params.Y                         existence check on either field
 *
 * Future extensions can add more operators without breaking the v1 grammar.
 */
export function matchRouteConditions(
  conditions: string,
  params: Record<string, unknown>,
): boolean {
  const c = conditions.trim();
  if (!c) return true;

  // `params.X OR params.Y` — existence check
  const orExistMatch = c.match(/^params\.(\w+)(?:\s+OR\s+params\.(\w+))+\s*$/);
  if (orExistMatch) {
    // `|| []` only narrows TS's null type — the anchored orExistMatch above
    // guarantees the global scan finds at least two params.X occurrences.
    /* v8 ignore next */
    const fields = c.match(/params\.(\w+)/g) || [];
    return fields.some((f) => {
      const name = f.slice("params.".length);
      const v = params[name];
      return v !== undefined && v !== null && v !== "";
    });
  }

  // `params.X contains "V1" [OR "V2"]...`
  const containsMatch = c.match(/^params\.(\w+)\s+contains\s+(.+)$/);
  if (containsMatch && containsMatch[1] !== undefined && containsMatch[2] !== undefined) {
    const field = containsMatch[1];
    const valueStr = (params[field] as string | undefined) ?? "";
    if (typeof valueStr !== "string") return false;
    const patterns: string[] = [];
    const quoteRe = /"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = quoteRe.exec(containsMatch[2])) !== null) {
      if (match[1] !== undefined) patterns.push(match[1]);
    }
    if (patterns.length === 0) return false;
    return patterns.some((p) => valueStr.includes(p));
  }

  // Unknown condition shape — fail closed (safer than over-firing)
  return false;
}

/**
 * Format a set of matched RouteRules into an appendSystemContext block
 * shown to the agent right before its tool call. Caps total length.
 */
export function formatRouteInjection(
  matched: RouteRule[],
  maxChars = 2000,
): string {
  if (matched.length === 0) return "";
  const sections: string[] = ["<routed-learnings>"];
  let used = 0;
  for (const r of matched) {
    const heading = r.title ? `### ${r.title}` : `### (untitled)`;
    const block = `${heading}\n${r.rule}`;
    if (used + block.length > maxChars) break;
    sections.push(block);
    used += block.length;
  }
  if (sections.length === 1) return "";
  sections.push("</routed-learnings>");
  return sections.join("\n\n");
}

// ─── Hook D — Observability ─────────────────────────────────────────────

export interface MemorySearchTrace {
  timestamp: string; // ISO 8601
  agentId: string;
  sessionKey: string;
  query: string;
  hitCount: number;
}

/**
 * Build the trace record to be inserted into the brain.db `traces` table.
 * Returns the structured record; caller does the SQLite insert (we keep
 * this module DB-free for testability).
 */
export function buildMemorySearchTrace(input: {
  agentId: string;
  sessionKey?: string;
  query: string;
  hitCount: number;
  now?: Date;
}): MemorySearchTrace {
  return {
    timestamp: (input.now ?? new Date()).toISOString(),
    agentId: input.agentId,
    sessionKey: input.sessionKey ?? "",
    query: input.query.slice(0, 500),
    hitCount: input.hitCount,
  };
}

// ─── Shared helpers exported for the plugin entry ───────────────────────

export { parseRelatedField, extractFrontmatterText } from "./wiki-graph.js";
