/**
 * Brain agents store — port of upstream task-orchestrator/src/store.ts
 * `brain_agents` table for agent-identity registration.
 *
 * Each row is one agent (CLI runtime, sub-runtime, dashboard, dream-cycle
 * worker, etc.) that has identified itself to the brain. The session token
 * is a rolling credential; the dashboard surfaces this for at-a-glance
 * "who has talked to the brain recently" attribution.
 *
 * upsert is implemented as SELECT-then-INSERT-or-UPDATE rather than
 * INSERT ... ON CONFLICT so the `created` flag is unambiguous (useful for
 * lifecycle logging and onboarding flows).
 */

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migrations.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type BrainAgentRecord = {
  readonly agentId: string;
  readonly runtime: string;
  readonly version?: string;
  readonly capabilities: readonly string[];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly sessionToken: string;
  readonly tokenExpiresAt: number;
};

// ── Schema migration ──────────────────────────────────────────────────────

const AGENTS_VERSION = 500;

export const AGENTS_MIGRATIONS: readonly Migration[] = [
  {
    version: AGENTS_VERSION,
    description: "v500: brain_agents identity table",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS brain_agents (
          agent_id         TEXT PRIMARY KEY,
          runtime          TEXT NOT NULL,
          version          TEXT,
          capabilities     TEXT NOT NULL DEFAULT '[]',
          first_seen_at    INTEGER NOT NULL,
          last_seen_at     INTEGER NOT NULL,
          session_token    TEXT NOT NULL,
          token_expires_at INTEGER NOT NULL
        );
      `);
    },
  },
];

// ── Row mapping ────────────────────────────────────────────────────────────

type AgentRow = {
  agent_id: string;
  runtime: string;
  version: string | null;
  capabilities: string;
  first_seen_at: number;
  last_seen_at: number;
  session_token: string;
  token_expires_at: number;
};

function jsonParseOr<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToAgent(row: AgentRow): BrainAgentRecord {
  return {
    agentId: row.agent_id,
    runtime: row.runtime,
    version: row.version ?? undefined,
    capabilities: jsonParseOr<readonly string[]>(row.capabilities, []),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    sessionToken: row.session_token,
    tokenExpiresAt: row.token_expires_at,
  };
}

// ── Public factory ─────────────────────────────────────────────────────────

export type AgentsStore = {
  /** Insert if new or refresh runtime/version/capabilities/token. */
  upsert(params: {
    readonly agentId: string;
    readonly runtime: string;
    readonly version?: string;
    readonly capabilities?: readonly string[];
    readonly sessionToken: string;
    readonly tokenExpiresAt: number;
  }): { readonly created: boolean };
  get(agentId: string): BrainAgentRecord | undefined;
  listAll(): BrainAgentRecord[];
};

export function createAgentsStore(deps: {
  db: DatabaseSync;
  now?: () => number;
}): AgentsStore {
  const { db, now = () => Date.now() } = deps;

  const selectExisting = db.prepare(
    "SELECT agent_id FROM brain_agents WHERE agent_id = ?",
  );
  const insertStmt = db.prepare(`
    INSERT INTO brain_agents
      (agent_id, runtime, version, capabilities, first_seen_at, last_seen_at,
       session_token, token_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE brain_agents
       SET runtime = ?, version = ?, capabilities = ?,
           last_seen_at = ?, session_token = ?, token_expires_at = ?
     WHERE agent_id = ?
  `);
  const selectById = db.prepare(
    "SELECT * FROM brain_agents WHERE agent_id = ?",
  );
  const selectAll = db.prepare(
    "SELECT * FROM brain_agents ORDER BY last_seen_at DESC",
  );

  function upsert(params: {
    readonly agentId: string;
    readonly runtime: string;
    readonly version?: string;
    readonly capabilities?: readonly string[];
    readonly sessionToken: string;
    readonly tokenExpiresAt: number;
  }): { readonly created: boolean } {
    const t = now();
    const existing = selectExisting.get(params.agentId) as
      | { agent_id: string }
      | undefined;
    if (existing) {
      updateStmt.run(
        params.runtime,
        params.version ?? null,
        JSON.stringify(params.capabilities ?? []),
        t,
        params.sessionToken,
        params.tokenExpiresAt,
        params.agentId,
      );
      return { created: false };
    }
    insertStmt.run(
      params.agentId,
      params.runtime,
      params.version ?? null,
      JSON.stringify(params.capabilities ?? []),
      t,
      t,
      params.sessionToken,
      params.tokenExpiresAt,
    );
    return { created: true };
  }

  function get(agentId: string): BrainAgentRecord | undefined {
    const row = selectById.get(agentId) as AgentRow | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  function listAll(): BrainAgentRecord[] {
    return (selectAll.all() as AgentRow[]).map(rowToAgent);
  }

  return { upsert, get, listAll };
}
