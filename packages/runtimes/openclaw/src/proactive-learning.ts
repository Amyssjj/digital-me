/**
 * Proactive-learning rule engine — port of upstream openclaw's
 * `extensions/proactive-learning/index.ts`, refactored to be **fully
 * data-driven**: zero hardcoded domains, keywords, file patterns, or
 * agent names.
 *
 * The engine does two things:
 *   1. `matchDomains(prompt, recentMessages, config, agentId)` —
 *      pure function that returns the list of domain names whose
 *      keyword rules fired against the input.
 *   2. `loadDomainContext(domains, config, readFile)` — reads the
 *      configured files for each matched domain and concatenates
 *      them into a single block ready to inject as `prependContext`.
 *
 * Owner-specific YouTube domains, `yt_*.md` file patterns, manim tool
 * rewrites, and `targetAgents: ["youtube"]` defaults from upstream all
 * become user config. Open-source consumers ship empty defaults; the
 * digital-me CLI's installer (Phase 6) helps users author their config.
 *
 * Hook registration (`before_prompt_build`) lives in the openclaw plugin
 * entry — this file stays runtime-agnostic and testable in isolation.
 */

export type DomainRule = {
  /**
   * Substring keywords (case-insensitive). A domain matches when any of
   * its keywords appears in the prompt OR in the recent-messages window.
   * If empty, the domain never matches via keywords.
   */
  readonly keywords: readonly string[];
  /**
   * Files to inject when this domain matches. Paths are resolved by the
   * caller-supplied `readFile` callback (lets tests inject in-memory
   * fixtures and lets the prod runtime resolve under the wiki root).
   */
  readonly files: readonly string[];
  /**
   * If set, the rule only matches when the calling agent's id is in
   * this list. Undefined = applies to all agents.
   */
  readonly targetAgents?: readonly string[];
};

export type ProactiveLearningConfig = {
  /** Domain name → rule definition. */
  readonly domains: Readonly<Record<string, DomainRule>>;
  /** Max characters to inject per domain (truncate longer files). */
  readonly maxCharsPerDomain?: number;
};

export type MessageLike = {
  readonly role?: string;
  readonly content?:
    | string
    | ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
};

// ── Pure matching ─────────────────────────────────────────────────────────

/**
 * Return the sorted list of domain names whose keywords fire against the
 * prompt + recent messages. `agentId` filters out rules whose
 * `targetAgents` doesn't include the caller.
 */
export function matchDomains(
  prompt: string,
  recentMessages: readonly MessageLike[],
  config: ProactiveLearningConfig,
  agentId: string,
): readonly string[] {
  const haystack = (prompt + "\n" + extractRecentMessagesText(recentMessages))
    .toLowerCase();
  const matched: string[] = [];
  for (const [name, rule] of Object.entries(config.domains)) {
    if (rule.targetAgents && !rule.targetAgents.includes(agentId)) {
      continue;
    }
    for (const kw of rule.keywords) {
      if (kw.length > 0 && haystack.includes(kw.toLowerCase())) {
        matched.push(name);
        break;
      }
    }
  }
  return matched.sort();
}

export function extractRecentMessagesText(
  messages: readonly MessageLike[],
  count: number = 3,
): string {
  if (messages.length === 0) return "";
  const recent = messages.slice(-count);
  const lines: string[] = [];
  for (const msg of recent) {
    const role = msg.role ?? "unknown";
    const content = msg.content;
    if (typeof content === "string") {
      lines.push(`[${role}]: ${content}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "text" && typeof block.text === "string") {
          lines.push(`[${role}]: ${block.text}`);
        }
      }
    }
  }
  return lines.join("\n");
}

// ── File loading + injection ──────────────────────────────────────────────

export type ReadFileFn = (relPath: string) => string | undefined;

/**
 * For each matched domain, read its configured files via `readFile` and
 * concatenate them. Returns a single string ready to inject as
 * `prependContext`. Empty when no domain matched or all files are empty.
 *
 * The caller is responsible for path resolution — `readFile` typically
 * resolves relative to the wiki root, but tests substitute an in-memory
 * map. Missing files are silently skipped (don't poison the prompt).
 */
export function loadDomainContext(
  domains: readonly string[],
  config: ProactiveLearningConfig,
  readFile: ReadFileFn,
): string {
  const maxChars = config.maxCharsPerDomain ?? 4000;
  const chunks: string[] = [];
  for (const name of domains) {
    const rule = config.domains[name];
    if (!rule) continue;
    const parts: string[] = [];
    for (const f of rule.files) {
      const content = readFile(f);
      if (!content) continue;
      const truncated =
        content.length > maxChars
          ? `${content.slice(0, maxChars)}\n…[truncated at ${maxChars} chars]`
          : content;
      parts.push(`# Source: ${f}\n${truncated}`);
    }
    if (parts.length > 0) {
      chunks.push(`## Domain: ${name}\n${parts.join("\n\n")}`);
    }
  }
  if (chunks.length === 0) return "";
  return [
    "<proactive-learnings>",
    "Reference these accumulated learnings when relevant:",
    "",
    chunks.join("\n\n"),
    "</proactive-learnings>",
  ].join("\n");
}

/**
 * One-step entry point: match + load. Returns the injection string
 * (empty when nothing matched). Most callers want this; `matchDomains`
 * + `loadDomainContext` are exported separately for callers that want
 * to introspect the matched domain list (e.g. for telemetry).
 */
export function buildInjection(
  prompt: string,
  recentMessages: readonly MessageLike[],
  agentId: string,
  config: ProactiveLearningConfig,
  readFile: ReadFileFn,
): string {
  const matched = matchDomains(prompt, recentMessages, config, agentId);
  if (matched.length === 0) return "";
  return loadDomainContext(matched, config, readFile);
}
