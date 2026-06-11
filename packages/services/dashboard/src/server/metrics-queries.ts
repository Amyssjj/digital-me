/**
 * Read-side queries for the 4 NUX scope-down metrics.
 *
 * One query function per endpoint. Each owns its joins so the frontend
 * receives a chart-ready shape and the SQL detail stays server-side
 * (per §C: "backend owns the joins so the frontend stays dumb when
 * schema evolves").
 *
 * The 4 metrics → 4 backing tables:
 *   1. sessions-by-agent          ← daa
 *   2. knowledge-taste-changes    ← knowledge_taste_changes
 *   3. application-rate           ← application_rate + _by_domain + _by_agent
 *   4. distribution               ← knowledge_taste_distribution
 *
 * Schema is owned by `migrate.ts`. The Python intake modules populate
 * the rows. This module only reads.
 */

import Database from "better-sqlite3";

export type Tree = "wiki" | "tastes";

// ── Metric 1: sessions × active agents ────────────────────────────────────

export type SessionsByAgentRow = {
  readonly date: string;
  readonly agent_id: string;
  readonly sessions: number;
  readonly is_active: 0 | 1;
};

export type SessionsByAgentResult = {
  /** One row per (date, agent_id). The frontend pivots client-side. */
  readonly rows: readonly SessionsByAgentRow[];
  /** Sorted list of distinct agents seen in the window (stable color
   *  assignment + a deterministic legend). */
  readonly agents: readonly string[];
};

export function querySessionsByAgent(
  db: Database.Database,
  days: number,
): SessionsByAgentResult {
  const rows = db.prepare(
    `SELECT date, agent_id, sessions, is_active
       FROM daa
      WHERE date >= date('now', ?)
      ORDER BY date ASC, agent_id ASC`,
  ).all(`-${days} days`) as SessionsByAgentRow[];

  const agents = Array.from(new Set(rows.map((r) => r.agent_id))).sort();
  return { rows, agents };
}

// ── Metric 2: knowledge + taste changes ───────────────────────────────────

export type KnowledgeTasteChangeRow = {
  readonly date: string;
  readonly tree: Tree;
  readonly domain: string;
  readonly created: number;
  readonly updated: number;
};

export type KnowledgeTasteChangesResult = {
  readonly rows: readonly KnowledgeTasteChangeRow[];
  readonly domains: readonly string[];
};

export function queryKnowledgeTasteChanges(
  db: Database.Database,
  days: number,
): KnowledgeTasteChangesResult {
  const rows = db.prepare(
    `SELECT date, tree, domain, created, updated
       FROM knowledge_taste_changes
      WHERE date >= date('now', ?)
      ORDER BY date ASC, tree ASC, domain ASC`,
  ).all(`-${days} days`) as KnowledgeTasteChangeRow[];

  const domains = Array.from(new Set(rows.map((r) => r.domain))).sort();
  return { rows, domains };
}

// ── Metric 3: application rate (with drilldowns) ──────────────────────────

export type AppRateRow = {
  readonly date: string;
  readonly tree: Tree;
  readonly surfaced_unique: number;
  readonly acted_unique: number;
  readonly rate: number | null;
};

export type AppRateByDomainRow = AppRateRow & { readonly domain: string };
export type AppRateByAgentRow = AppRateRow & { readonly agent_id: string };

export type ApplicationRateResult = {
  /** Top-line per (date, tree). Backs the two chart axes. */
  readonly daily: readonly AppRateRow[];
  /** Per-domain breakdown for tooltip drilldown. */
  readonly by_domain: readonly AppRateByDomainRow[];
  /** Per-agent breakdown for tooltip drilldown. */
  readonly by_agent: readonly AppRateByAgentRow[];
};

export function queryApplicationRate(
  db: Database.Database,
  days: number,
): ApplicationRateResult {
  const since = `-${days} days`;
  const daily = db.prepare(
    `SELECT date, tree, surfaced_unique, acted_unique, rate
       FROM application_rate
      WHERE date >= date('now', ?)
      ORDER BY date ASC, tree ASC`,
  ).all(since) as AppRateRow[];

  const by_domain = db.prepare(
    `SELECT date, tree, domain, surfaced_unique, acted_unique,
            CASE WHEN surfaced_unique > 0
                 THEN CAST(acted_unique AS REAL) / surfaced_unique
                 ELSE NULL END AS rate
       FROM application_rate_by_domain
      WHERE date >= date('now', ?)
      ORDER BY date ASC, tree ASC, domain ASC`,
  ).all(since) as AppRateByDomainRow[];

  const by_agent = db.prepare(
    `SELECT date, tree, agent_id, surfaced_unique, acted_unique,
            CASE WHEN surfaced_unique > 0
                 THEN CAST(acted_unique AS REAL) / surfaced_unique
                 ELSE NULL END AS rate
       FROM application_rate_by_agent
      WHERE date >= date('now', ?)
      ORDER BY date ASC, tree ASC, agent_id ASC`,
  ).all(since) as AppRateByAgentRow[];

  return { daily, by_domain, by_agent };
}

// ── Metric 4: distribution (radar) ────────────────────────────────────────

export type DistributionRow = {
  readonly tree: Tree;
  readonly domain: string;
  readonly total: number;
  readonly as_of: string;
};

export type DistributionResult = {
  /** Raw per (tree, domain) snapshot rows. */
  readonly rows: readonly DistributionRow[];
  /** Top domains for the radar's axes. Union of top-N-per-tree so every
   *  taste-only domain (e.g. `storytelling`) is guaranteed an axis even
   *  when wiki dwarfs it on combined totals. Ordered by max(wiki, tastes)
   *  per domain, descending, so the largest axes anchor the top of the
   *  radar. */
  readonly top_domains: readonly string[];
};

export function queryDistribution(
  db: Database.Database,
  topN = 8,
): DistributionResult {
  const rows = db.prepare(
    `SELECT tree, domain, total, as_of
       FROM knowledge_taste_distribution
      ORDER BY domain ASC, tree ASC`,
  ).all() as DistributionRow[];

  // Rank each tree independently and union the results. Combining
  // wiki+tastes BEFORE ranking would let one tree starve the other
  // (e.g. wiki 459 vs tastes 32 → only 1 of 4 taste-only domains makes
  // the top-8 combined list, leaving 3 taste domains invisible on the
  // radar even though they exist on disk).
  const wikiTotals = new Map<string, number>();
  const tastesTotals = new Map<string, number>();
  for (const r of rows) {
    const m = r.tree === "wiki" ? wikiTotals : tastesTotals;
    m.set(r.domain, (m.get(r.domain) ?? 0) + r.total);
  }
  const topPerTree = (m: Map<string, number>): string[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([domain]) => domain);
  const unioned = new Set<string>([
    ...topPerTree(wikiTotals),
    ...topPerTree(tastesTotals),
  ]);
  // Sort the union by max(wiki, tastes) so visually-dominant axes lead.
  const top_domains = [...unioned].sort((a, b) => {
    const aMax = Math.max(wikiTotals.get(a) ?? 0, tastesTotals.get(a) ?? 0);
    const bMax = Math.max(wikiTotals.get(b) ?? 0, tastesTotals.get(b) ?? 0);
    return bMax - aMax;
  });
  return { rows, top_domains };
}
