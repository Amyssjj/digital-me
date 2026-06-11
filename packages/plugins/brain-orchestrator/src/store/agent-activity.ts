/**
 * agent_activity.* tool family. Daily per-agent rollups (sessions, prompt
 * byte breakdowns). Feeds the dashboard's team-health heatmap and per-agent
 * panels.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  AgentActivityPoint,
  AgentActivityQueryArgs,
  AgentActivityQueryResult,
  AgentActivityRecordArgs,
  PromptByteBreakdown,
} from "@digital-me/contracts";

export function initAgentActivitySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_agent_activity (
      agent_id            TEXT NOT NULL,
      date                TEXT NOT NULL,
      status              TEXT NOT NULL,
      sessions_count      INTEGER NOT NULL DEFAULT 0,
      agents_md_bytes     INTEGER NOT NULL DEFAULT 0,
      memory_md_bytes     INTEGER NOT NULL DEFAULT 0,
      soul_md_bytes       INTEGER NOT NULL DEFAULT 0,
      user_md_bytes       INTEGER NOT NULL DEFAULT 0,
      tools_md_bytes      INTEGER NOT NULL DEFAULT 0,
      heartbeat_md_bytes  INTEGER NOT NULL DEFAULT 0,
      total_prompt_bytes  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_activity_date ON daily_agent_activity(date);
  `);
}

type AgentActivityRow = {
  agent_id: string;
  date: string;
  status: string;
  sessions_count: number;
  agents_md_bytes: number;
  memory_md_bytes: number;
  soul_md_bytes: number;
  user_md_bytes: number;
  tools_md_bytes: number;
  heartbeat_md_bytes: number;
  total_prompt_bytes: number;
};

function rowToPoint(row: AgentActivityRow): AgentActivityPoint {
  const prompt_byte_breakdown: PromptByteBreakdown = {
    agents_md: row.agents_md_bytes,
    memory_md: row.memory_md_bytes,
    soul_md: row.soul_md_bytes,
    user_md: row.user_md_bytes,
    tools_md: row.tools_md_bytes,
    heartbeat_md: row.heartbeat_md_bytes,
    total: row.total_prompt_bytes,
  };
  return {
    agent_id: row.agent_id,
    date: row.date,
    status: row.status,
    sessions_count: row.sessions_count,
    prompt_byte_breakdown,
  };
}

function dateFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export type AgentActivityTools = {
  record(args: AgentActivityRecordArgs): void;
  query(args: AgentActivityQueryArgs): AgentActivityQueryResult;
};

export function createAgentActivityTools(deps: {
  db: DatabaseSync;
}): AgentActivityTools {
  const { db } = deps;

  const upsert = db.prepare(`
    INSERT INTO daily_agent_activity
      (agent_id, date, status, sessions_count,
       agents_md_bytes, memory_md_bytes, soul_md_bytes, user_md_bytes,
       tools_md_bytes, heartbeat_md_bytes, total_prompt_bytes)
    VALUES
      (@agent_id, @date, @status, @sessions_count,
       @agents_md, @memory_md, @soul_md, @user_md,
       @tools_md, @heartbeat_md, @total)
    ON CONFLICT(agent_id, date) DO UPDATE SET
      status = excluded.status,
      sessions_count = excluded.sessions_count,
      agents_md_bytes = excluded.agents_md_bytes,
      memory_md_bytes = excluded.memory_md_bytes,
      soul_md_bytes = excluded.soul_md_bytes,
      user_md_bytes = excluded.user_md_bytes,
      tools_md_bytes = excluded.tools_md_bytes,
      heartbeat_md_bytes = excluded.heartbeat_md_bytes,
      total_prompt_bytes = excluded.total_prompt_bytes
  `);

  function record(args: AgentActivityRecordArgs): void {
    const b = args.prompt_byte_breakdown;
    upsert.run({
      agent_id: args.agent_id,
      date: args.date,
      status: args.status,
      sessions_count: args.sessions_count,
      agents_md: b.agents_md,
      memory_md: b.memory_md,
      soul_md: b.soul_md,
      user_md: b.user_md,
      tools_md: b.tools_md,
      heartbeat_md: b.heartbeat_md,
      total: b.total,
    });
  }

  function query(args: AgentActivityQueryArgs): AgentActivityQueryResult {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (args.agent_id !== undefined) {
      clauses.push("agent_id = @agent_id");
      params.agent_id = args.agent_id;
    }
    if (args.since !== undefined) {
      clauses.push("date >= @since");
      params.since = dateFromEpochMs(args.since);
    }
    if (args.until !== undefined) {
      clauses.push("date <= @until");
      params.until = dateFromEpochMs(args.until);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT * FROM daily_agent_activity ${where}
         ORDER BY date ASC, agent_id ASC`,
      )
      .all(params) as AgentActivityRow[];
    return { activity: rows.map(rowToPoint) };
  }

  return { record, query };
}
