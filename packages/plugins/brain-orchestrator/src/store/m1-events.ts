/**
 * m1_events store — canonical sink for the M1 universal event protocol.
 *
 * Every emitter (claude-code, hermes, openclaw) writes the same event
 * shape through the `m1_event_record` MCP tool, which lands here. The
 * scorer reads these rows and computes `application_rate` rollups.
 *
 * See wiki: infrastructure/m1-universal-event-protocol.md
 *
 * SCHEMA NOTE — IDEMPOTENT INGEST:
 * The `event_id` column is PRIMARY KEY. Emitters generate stable IDs
 * (typically `<session_id>::<turn_id>::<event_type>::<entries_hash>`)
 * and retry on failure. Brain uses `INSERT OR IGNORE`, so retries are
 * safe and emitter-side WAL trimming is unnecessary.
 *
 * SCHEMA NOTE — KINDS:
 * v1 emits five event types: session_start, knowledge_surfaced,
 * assistant_ack, session_snapshot, session_end. Unknown kinds are
 * accepted (forward-compat) but the scorer ignores them.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migrations.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** v1 event types. Unknown values are accepted but ignored by the scorer. */
export type M1EventType =
  | "session_start"
  | "knowledge_surfaced"
  | "assistant_ack"
  | "session_snapshot"
  | "session_end";

export const M1_EVENT_TYPES_V1: ReadonlySet<M1EventType> = new Set<M1EventType>([
  "session_start",
  "knowledge_surfaced",
  "assistant_ack",
  "session_snapshot",
  "session_end",
]);

export type M1AckSignal =
  | "explicit_path"
  | "title_match"
  | "no_applicable"
  | "no_acknowledgement";

/**
 * A surfaced wiki entry. Carried on `knowledge_surfaced` events; the
 * subset that was acted is carried again on `assistant_ack`.
 */
export type M1Entry = {
  readonly path: string;
  readonly title?: string;
  readonly score?: number;
  readonly source?: string; // "memory_search" | "wiki_inject" | "route_hashmap"
};

export type M1EventRecord = {
  /** Stable client-generated id used for INSERT OR IGNORE dedup. */
  readonly eventId: string;
  readonly schemaVersion: number; // 1 today
  readonly metric: string; // "m1_application_rate"
  readonly runtime: string; // "claude-code" | "hermes" | "openclaw"
  readonly agentId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly eventType: M1EventType | string;
  readonly entries?: ReadonlyArray<M1Entry>;
  readonly ackSignal?: M1AckSignal | string;
  /** Epoch ms. */
  readonly t: number;
  /** Additional payload — unparsed JSON object. */
  readonly extra?: Readonly<Record<string, unknown>>;
};

export type M1EventQueryFilters = {
  readonly runtime?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly eventType?: string;
  readonly since?: number; // epoch ms
  readonly until?: number; // epoch ms (exclusive)
  readonly limit?: number;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

// ── Schema migration ──────────────────────────────────────────────────────

/**
 * v710 — m1_events table.
 *
 * Versions chosen above the v700 traces table so a fresh install applies
 * traces first (the scorer's rollup tables it touches via foreign keys
 * are in v700-era schemas).
 */
const M1_EVENTS_VERSION = 710;

export const M1_EVENTS_MIGRATIONS: readonly Migration[] = [
  {
    version: M1_EVENTS_VERSION,
    description: "v710: m1_events table (universal M1 protocol sink)",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS m1_events (
          event_id        TEXT PRIMARY KEY,
          schema_version  INTEGER NOT NULL DEFAULT 1,
          metric          TEXT NOT NULL DEFAULT 'm1_application_rate',
          runtime         TEXT NOT NULL,
          agent_id        TEXT NOT NULL,
          session_id      TEXT NOT NULL,
          turn_id         TEXT,
          event_type      TEXT NOT NULL,
          entries_json    TEXT NOT NULL DEFAULT '[]',
          ack_signal      TEXT,
          extra_json      TEXT NOT NULL DEFAULT '{}',
          t               INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_m1_events_runtime    ON m1_events(runtime);
        CREATE INDEX IF NOT EXISTS idx_m1_events_agent      ON m1_events(agent_id);
        CREATE INDEX IF NOT EXISTS idx_m1_events_session    ON m1_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_m1_events_session_turn ON m1_events(session_id, turn_id);
        CREATE INDEX IF NOT EXISTS idx_m1_events_t          ON m1_events(t);
        CREATE INDEX IF NOT EXISTS idx_m1_events_kind       ON m1_events(event_type);
      `);
    },
  },
];

// ── Row mapping ────────────────────────────────────────────────────────────

type M1EventRow = {
  event_id: string;
  schema_version: number;
  metric: string;
  runtime: string;
  agent_id: string;
  session_id: string;
  turn_id: string | null;
  event_type: string;
  entries_json: string;
  ack_signal: string | null;
  extra_json: string;
  t: number;
};

function jsonParseOr<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(row: M1EventRow): M1EventRecord {
  const entries = jsonParseOr<ReadonlyArray<M1Entry>>(row.entries_json, []);
  const extra = jsonParseOr<Record<string, unknown>>(row.extra_json, {});
  return {
    eventId: row.event_id,
    schemaVersion: row.schema_version,
    metric: row.metric,
    runtime: row.runtime,
    agentId: row.agent_id,
    sessionId: row.session_id,
    turnId: row.turn_id ?? undefined,
    eventType: row.event_type,
    entries,
    ackSignal: row.ack_signal ?? undefined,
    t: row.t,
    extra,
  };
}

// ── Public factory ─────────────────────────────────────────────────────────

export type M1EventsStore = {
  /**
   * Insert one event. Idempotent on `event_id` — duplicate inserts are
   * silently dropped. Returns whether the row was newly created.
   */
  create(event: M1EventRecord): { inserted: boolean };
  query(filters: M1EventQueryFilters): M1EventRecord[];
  /**
   * Pair `knowledge_surfaced` events with their immediately-following
   * `assistant_ack` (by `session_id` + `turn_id`). Used by the scorer.
   * Returns one row per surfaced event; `ack` is `undefined` when no
   * matching ack exists yet.
   */
  pairSurfacedWithAck(filters: {
    since: number;
    until?: number;
    runtime?: string;
  }): ReadonlyArray<{
    surfaced: M1EventRecord;
    ack?: M1EventRecord;
  }>;
};

export function createM1EventsStore(deps: { db: DatabaseSync }): M1EventsStore {
  const { db } = deps;

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO m1_events
      (event_id, schema_version, metric, runtime, agent_id, session_id,
       turn_id, event_type, entries_json, ack_signal, extra_json, t)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function create(event: M1EventRecord): { inserted: boolean } {
    const r = insertStmt.run(
      event.eventId,
      event.schemaVersion ?? 1,
      event.metric ?? "m1_application_rate",
      event.runtime,
      event.agentId,
      event.sessionId,
      event.turnId ?? null,
      event.eventType,
      JSON.stringify(event.entries ?? []),
      event.ackSignal ?? null,
      JSON.stringify(event.extra ?? {}),
      event.t,
    );
    // node:sqlite's RunResult.changes is 0 when the IGNORE'd dup row hit.
    return { inserted: (r.changes as number | bigint) > 0 };
  }

  function query(filters: M1EventQueryFilters): M1EventRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filters.runtime !== undefined) {
      clauses.push("runtime = ?");
      params.push(filters.runtime);
    }
    if (filters.agentId !== undefined) {
      clauses.push("agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.sessionId !== undefined) {
      clauses.push("session_id = ?");
      params.push(filters.sessionId);
    }
    if (filters.eventType !== undefined) {
      clauses.push("event_type = ?");
      params.push(filters.eventType);
    }
    if (filters.since !== undefined) {
      clauses.push("t >= ?");
      params.push(filters.since);
    }
    if (filters.until !== undefined) {
      clauses.push("t < ?");
      params.push(filters.until);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const sql = `SELECT * FROM m1_events ${where} ORDER BY t DESC LIMIT ?`;
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as M1EventRow[];
    return rows.map(rowToRecord);
  }

  function pairSurfacedWithAck(filters: {
    since: number;
    until?: number;
    runtime?: string;
  }) {
    // Self-join on (session_id, turn_id). LEFT JOIN so surfaced events
    // with no ack yet still appear (scorer treats them as "in flight").
    const clauses: string[] = ["s.event_type = 'knowledge_surfaced'", "s.t >= ?"];
    const params: (string | number)[] = [filters.since];
    if (filters.until !== undefined) {
      clauses.push("s.t < ?");
      params.push(filters.until);
    }
    if (filters.runtime !== undefined) {
      clauses.push("s.runtime = ?");
      params.push(filters.runtime);
    }
    const sql = `
      SELECT
        s.event_id        AS s_event_id,
        s.schema_version  AS s_schema_version,
        s.metric          AS s_metric,
        s.runtime         AS s_runtime,
        s.agent_id        AS s_agent_id,
        s.session_id      AS s_session_id,
        s.turn_id         AS s_turn_id,
        s.event_type      AS s_event_type,
        s.entries_json    AS s_entries_json,
        s.ack_signal      AS s_ack_signal,
        s.extra_json      AS s_extra_json,
        s.t               AS s_t,
        a.event_id        AS a_event_id,
        a.schema_version  AS a_schema_version,
        a.metric          AS a_metric,
        a.runtime         AS a_runtime,
        a.agent_id        AS a_agent_id,
        a.session_id      AS a_session_id,
        a.turn_id         AS a_turn_id,
        a.event_type      AS a_event_type,
        a.entries_json    AS a_entries_json,
        a.ack_signal      AS a_ack_signal,
        a.extra_json      AS a_extra_json,
        a.t               AS a_t
      FROM m1_events s
      LEFT JOIN m1_events a
        ON a.event_type = 'assistant_ack'
       AND a.session_id = s.session_id
       AND COALESCE(a.turn_id, '') = COALESCE(s.turn_id, '')
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.t DESC
      LIMIT ${MAX_LIMIT}
    `;
    type PairRow = Record<string, string | number | null>;
    const rows = db.prepare(sql).all(...params) as PairRow[];
    return rows.map((r) => {
      const surfaced: M1EventRecord = rowToRecord({
        event_id: r.s_event_id as string,
        schema_version: r.s_schema_version as number,
        metric: r.s_metric as string,
        runtime: r.s_runtime as string,
        agent_id: r.s_agent_id as string,
        session_id: r.s_session_id as string,
        turn_id: r.s_turn_id as string | null,
        event_type: r.s_event_type as string,
        entries_json: r.s_entries_json as string,
        ack_signal: r.s_ack_signal as string | null,
        extra_json: r.s_extra_json as string,
        t: r.s_t as number,
      });
      const ack: M1EventRecord | undefined =
        r.a_event_id == null
          ? undefined
          : rowToRecord({
              event_id: r.a_event_id as string,
              schema_version: r.a_schema_version as number,
              metric: r.a_metric as string,
              runtime: r.a_runtime as string,
              agent_id: r.a_agent_id as string,
              session_id: r.a_session_id as string,
              turn_id: r.a_turn_id as string | null,
              event_type: r.a_event_type as string,
              entries_json: r.a_entries_json as string,
              ack_signal: r.a_ack_signal as string | null,
              extra_json: r.a_extra_json as string,
              t: r.a_t as number,
            });
      return { surfaced, ack };
    });
  }

  return { create, query, pairSurfacedWithAck };
}
