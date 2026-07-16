/**
 * Remote MCP clients — read side.
 *
 * The agent-roster grid (data.ts) enumerates `openclaw agents list`, i.e. the
 * orchestrator's own registered agents. But external MCP clients that reach the
 * brain over the Streamable-HTTP transport (a Windows Claude Code, a Codex CLI,
 * a second machine) are NOT orchestrator agents — they only ever leave a
 * footprint in the brain's `traces` table, attributed by the `X-Agent-Id`
 * header / `?agent_id=` query the transport resolves. So they show up nowhere
 * in the dashboard today.
 *
 * This module surfaces them: every `agent_id` seen in `traces` that isn't in
 * the orchestrator roster, aggregated to one row per client (call count, trace
 * kinds, first/last activity), and LEFT-JOINed to `brain_agents` for identity
 * enrichment (runtime / version / capabilities) when the client called
 * `agent_identify`. Clients that never identified (e.g. the `unknown:mcp`
 * fallback bucket) still appear — flagged `identified: false` — because they
 * are real, un-attributed MCP traffic worth seeing.
 *
 * Reads brain.db directly (readonly). The `traces_query` MCP tool returns raw
 * rows capped at 1000 with no aggregation, which would silently drop a
 * low-volume client (e.g. a Codex CLI with 9 lifetime calls) below the cap —
 * a GROUP BY in SQL is both exact and cheaper.
 */

import type Database from "better-sqlite3";

export type RemoteClientRow = {
  /** Attribution identity as recorded on the trace (transport-resolved). */
  readonly agent_id: string;
  /** Runtime from `brain_agents` (e.g. "claude-code", "codex"); null if the
   *  client never called agent_identify. */
  readonly runtime: string | null;
  /** Version string from `brain_agents` when identified. */
  readonly version: string | null;
  /** Declared capabilities from `brain_agents` when identified. */
  readonly capabilities: readonly string[];
  /** True when the client registered via agent_identify (present in
   *  brain_agents). False for the raw `traces`-only fallback buckets. */
  readonly identified: boolean;
  /** Trace count for this client inside the window. */
  readonly calls: number;
  /** ISO-8601 timestamp of the client's earliest trace in the window. */
  readonly first_active: string;
  /** ISO-8601 timestamp of the client's most recent trace in the window. */
  readonly last_active: string;
  /** Trace-kind → count breakdown inside the window. */
  readonly kinds: Readonly<Record<string, number>>;
};

export type QueryRemoteClientsOpts = {
  /** Orchestrator roster ids to exclude — the agents already shown as cards. */
  readonly rosterAgentIds: readonly string[];
  /** Only count traces with `t >= sinceMs`. Omit / undefined for all-time. */
  readonly sinceMs?: number;
  /** Max clients returned, sorted by last-active desc. Default 50. */
  readonly limit?: number;
};

type TraceKindRow = {
  readonly agent_id: string;
  readonly kind: string;
  readonly c: number;
  readonly min_t: number;
  readonly max_t: number;
};

type AgentIdentityRow = {
  readonly agent_id: string;
  readonly runtime: string;
  readonly version: string | null;
  readonly capabilities: string;
};

const DEFAULT_LIMIT = 50;

/** Parse a `brain_agents.capabilities` JSON blob into a string[], tolerating
 *  malformed / non-array payloads (returns []). */
function parseCapabilities(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}

/**
 * Aggregate the non-roster clients from brain.db `traces`, enriched from
 * `brain_agents`. Pure over its inputs (deterministic given `sinceMs`), so the
 * router owns the clock and tests pass an explicit window.
 */
export function queryRemoteClients(
  db: Database.Database,
  opts: QueryRemoteClientsOpts,
): RemoteClientRow[] {
  const since = opts.sinceMs ?? 0;
  const limit =
    typeof opts.limit === "number" && opts.limit > 0
      ? opts.limit
      : DEFAULT_LIMIT;
  const roster = new Set(opts.rosterAgentIds);

  // One row per (agent, kind): count + time bounds. Folded into per-agent
  // rows below so the kind breakdown and the totals come from one scan.
  const kindRows = db
    .prepare(
      `SELECT agent_id, kind, COUNT(*) AS c, MIN(t) AS min_t, MAX(t) AS max_t
         FROM traces
        WHERE t >= ?
        GROUP BY agent_id, kind`,
    )
    .all(since) as TraceKindRow[];

  // Identity map — LEFT JOIN done in JS so a client that never identified
  // still yields a row (identified: false).
  const identities = new Map<string, AgentIdentityRow>();
  for (const row of db
    .prepare(
      `SELECT agent_id, runtime, version, capabilities FROM brain_agents`,
    )
    .all() as AgentIdentityRow[]) {
    identities.set(row.agent_id, row);
  }

  type Acc = {
    calls: number;
    minT: number;
    maxT: number;
    kinds: Record<string, number>;
  };
  const byAgent = new Map<string, Acc>();
  for (const row of kindRows) {
    if (roster.has(row.agent_id)) continue;
    const acc = byAgent.get(row.agent_id) ?? {
      calls: 0,
      minT: row.min_t,
      maxT: row.max_t,
      kinds: {},
    };
    acc.calls += row.c;
    acc.minT = Math.min(acc.minT, row.min_t);
    acc.maxT = Math.max(acc.maxT, row.max_t);
    acc.kinds[row.kind] = (acc.kinds[row.kind] ?? 0) + row.c;
    byAgent.set(row.agent_id, acc);
  }

  const clients: RemoteClientRow[] = [];
  for (const [agent_id, acc] of byAgent) {
    const identity = identities.get(agent_id);
    clients.push({
      agent_id,
      runtime: identity?.runtime ?? null,
      version: identity?.version ?? null,
      capabilities: identity ? parseCapabilities(identity.capabilities) : [],
      identified: identity !== undefined,
      calls: acc.calls,
      first_active: new Date(acc.minT).toISOString(),
      last_active: new Date(acc.maxT).toISOString(),
      kinds: acc.kinds,
    });
  }

  // Most-recently-active first, then busiest, then a stable id tiebreak so the
  // ordering is deterministic for a fixed snapshot.
  clients.sort(
    (a, b) =>
      b.last_active.localeCompare(a.last_active) ||
      b.calls - a.calls ||
      a.agent_id.localeCompare(b.agent_id),
  );

  return clients.slice(0, limit);
}
