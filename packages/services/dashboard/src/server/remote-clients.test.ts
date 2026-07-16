import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { queryRemoteClients } from "./remote-clients.js";

let db: Database.Database;

/** Fixed clock so windows are deterministic. 2026-07-16T00:00:00Z-ish. */
const NOW = 1_784_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Create the brain.db tables this module reads (mirrors trace-writer.ts +
 *  the agents store schema). */
function createSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE traces (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', task_id TEXT, goal_id TEXT,
      duration_ms INTEGER, t INTEGER NOT NULL
    );
    CREATE TABLE brain_agents (
      agent_id TEXT PRIMARY KEY, runtime TEXT NOT NULL, version TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      session_token TEXT NOT NULL, token_expires_at INTEGER NOT NULL
    );
  `);
}

let traceSeq = 0;
function insertTrace(
  d: Database.Database,
  agentId: string,
  kind: string,
  t: number,
): void {
  d.prepare(
    `INSERT INTO traces (id, agent_id, kind, t) VALUES (?, ?, ?, ?)`,
  ).run(`tr-${traceSeq++}`, agentId, kind, t);
}

function insertAgent(
  d: Database.Database,
  agentId: string,
  runtime: string,
  version: string | null,
  capabilities: string[],
): void {
  d.prepare(
    `INSERT INTO brain_agents
       (agent_id, runtime, version, capabilities, first_seen_at, last_seen_at,
        session_token, token_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    runtime,
    version,
    JSON.stringify(capabilities),
    NOW - 5 * DAY,
    NOW,
    "tok",
    NOW + DAY,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  traceSeq = 0;
});

afterEach(() => {
  db.close();
});

describe("queryRemoteClients", () => {
  it("excludes orchestrator-roster agents", () => {
    insertTrace(db, "coo", "tool_call", NOW - HOUR);
    insertTrace(db, "codex-windows", "tool_call", NOW - HOUR);

    const rows = queryRemoteClients(db, {
      rosterAgentIds: ["coo", "main", "podcast"],
    });

    expect(rows.map((r) => r.agent_id)).toEqual(["codex-windows"]);
  });

  it("enriches identified clients from brain_agents", () => {
    insertTrace(db, "codex-windows", "memory_search", NOW - HOUR);
    insertAgent(db, "codex-windows", "codex", "gpt-5", [
      "wiki",
      "memory",
      "tasks",
    ]);

    const [row] = queryRemoteClients(db, { rosterAgentIds: [] });

    expect(row).toMatchObject({
      agent_id: "codex-windows",
      runtime: "codex",
      version: "gpt-5",
      capabilities: ["wiki", "memory", "tasks"],
      identified: true,
    });
  });

  it("keeps unidentified clients (traces with no brain_agents row)", () => {
    insertTrace(db, "unknown:mcp", "tool_call", NOW - HOUR);

    const [row] = queryRemoteClients(db, { rosterAgentIds: [] });

    expect(row).toMatchObject({
      agent_id: "unknown:mcp",
      runtime: null,
      version: null,
      capabilities: [],
      identified: false,
    });
  });

  it("aggregates call count + kind breakdown + first/last active", () => {
    insertTrace(db, "claude-code-windows", "tool_call", NOW - 3 * HOUR);
    insertTrace(db, "claude-code-windows", "tool_call", NOW - 2 * HOUR);
    insertTrace(db, "claude-code-windows", "memory_search", NOW - HOUR);

    const [row] = queryRemoteClients(db, { rosterAgentIds: [] });

    expect(row.calls).toBe(3);
    expect(row.kinds).toEqual({ tool_call: 2, memory_search: 1 });
    expect(row.first_active).toBe(new Date(NOW - 3 * HOUR).toISOString());
    expect(row.last_active).toBe(new Date(NOW - HOUR).toISOString());
  });

  it("filters traces before sinceMs", () => {
    insertTrace(db, "codex-windows", "tool_call", NOW - 40 * DAY); // out of window
    insertTrace(db, "codex-windows", "tool_call", NOW - 2 * DAY); // in window

    const [row] = queryRemoteClients(db, {
      rosterAgentIds: [],
      sinceMs: NOW - 30 * DAY,
    });

    expect(row.calls).toBe(1);
    expect(row.first_active).toBe(new Date(NOW - 2 * DAY).toISOString());
  });

  it("drops a client whose only traces fall outside the window", () => {
    insertTrace(db, "codex-windows", "tool_call", NOW - 40 * DAY);

    const rows = queryRemoteClients(db, {
      rosterAgentIds: [],
      sinceMs: NOW - 30 * DAY,
    });

    expect(rows).toEqual([]);
  });

  it("sorts by last-active desc, then calls, then id; respects limit", () => {
    insertTrace(db, "b-newest", "k", NOW - HOUR);
    insertTrace(db, "a-older", "k", NOW - 5 * HOUR);
    insertTrace(db, "c-older", "k", NOW - 5 * HOUR);
    insertTrace(db, "c-older", "k", NOW - 6 * HOUR); // 2 calls → outranks a-older

    const rows = queryRemoteClients(db, { rosterAgentIds: [], limit: 2 });

    expect(rows.map((r) => r.agent_id)).toEqual(["b-newest", "c-older"]);
  });

  it("returns empty when every traced agent is in the roster", () => {
    insertTrace(db, "coo", "k", NOW - HOUR);
    expect(queryRemoteClients(db, { rosterAgentIds: ["coo"] })).toEqual([]);
  });

  function seedCapabilities(raw: string): void {
    insertTrace(db, "codex-windows", "k", NOW - HOUR);
    db.prepare(
      `INSERT INTO brain_agents
         (agent_id, runtime, version, capabilities, first_seen_at, last_seen_at,
          session_token, token_expires_at)
       VALUES ('codex-windows', 'codex', NULL, ?, 0, 0, 'tok', 0)`,
    ).run(raw);
  }

  it("tolerates malformed (unparseable) capabilities JSON", () => {
    seedCapabilities("not-json");
    const [row] = queryRemoteClients(db, { rosterAgentIds: [] });
    expect(row.capabilities).toEqual([]);
    expect(row.identified).toBe(true);
  });

  it("ignores valid-but-non-array capabilities JSON", () => {
    seedCapabilities('{"wiki":true}');
    const [row] = queryRemoteClients(db, { rosterAgentIds: [] });
    expect(row.capabilities).toEqual([]);
  });

  it("drops non-string entries from the capabilities array", () => {
    seedCapabilities('["wiki", 123, "tasks"]');
    const [row] = queryRemoteClients(db, { rosterAgentIds: [] });
    expect(row.capabilities).toEqual(["wiki", "tasks"]);
  });
});
