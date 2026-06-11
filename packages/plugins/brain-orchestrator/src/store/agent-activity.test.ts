import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
// Vite/vitest doesn't recognize experimental node:sqlite as a builtin
// (`module.builtinModules` excludes it); use createRequire so Node's loader
// resolves it at runtime instead of letting Vite try to bundle.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import { createAgentActivityTools, initAgentActivitySchema } from "./agent-activity.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initAgentActivitySchema(db);
});

afterEach(() => {
  db.close();
});

const baseBreakdown = {
  agents_md: 1000,
  memory_md: 2000,
  soul_md: 500,
  user_md: 300,
  tools_md: 200,
  heartbeat_md: 100,
  total: 4100,
};

describe("agent_activity.record", () => {
  it("inserts a row with the prompt byte breakdown", () => {
    const tools = createAgentActivityTools({ db });
    tools.record({
      agent_id: "coo",
      date: "2026-05-15",
      status: "active",
      sessions_count: 5,
      prompt_byte_breakdown: baseBreakdown,
    });
    const row = db
      .prepare("SELECT * FROM daily_agent_activity WHERE agent_id = 'coo'")
      .get() as {
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
    expect(row).toMatchObject({
      date: "2026-05-15",
      status: "active",
      sessions_count: 5,
      agents_md_bytes: 1000,
      memory_md_bytes: 2000,
      soul_md_bytes: 500,
      user_md_bytes: 300,
      tools_md_bytes: 200,
      heartbeat_md_bytes: 100,
      total_prompt_bytes: 4100,
    });
  });

  it("upserts on (agent_id, date) — same key replaces the row", () => {
    const tools = createAgentActivityTools({ db });
    tools.record({
      agent_id: "coo",
      date: "2026-05-15",
      status: "active",
      sessions_count: 1,
      prompt_byte_breakdown: baseBreakdown,
    });
    tools.record({
      agent_id: "coo",
      date: "2026-05-15",
      status: "active",
      sessions_count: 5,
      prompt_byte_breakdown: baseBreakdown,
    });
    const rows = db
      .prepare("SELECT sessions_count FROM daily_agent_activity")
      .all() as { sessions_count: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessions_count).toBe(5);
  });
});

describe("agent_activity.query", () => {
  function seed(): void {
    const tools = createAgentActivityTools({ db });
    for (const agent of ["coo", "cto"]) {
      for (let i = 13; i <= 15; i++) {
        tools.record({
          agent_id: agent,
          date: `2026-05-${i}`,
          status: i === 15 ? "active" : "idle",
          sessions_count: i,
          prompt_byte_breakdown: baseBreakdown,
        });
      }
    }
  }

  it("returns all rows by default in (date ASC, agent_id ASC) order", () => {
    seed();
    const tools = createAgentActivityTools({ db });
    const out = tools.query({});
    expect(out.activity).toHaveLength(6);
    expect(out.activity[0]).toMatchObject({ date: "2026-05-13", agent_id: "coo" });
    expect(out.activity[1]).toMatchObject({ date: "2026-05-13", agent_id: "cto" });
  });

  it("filters by agent_id", () => {
    seed();
    const tools = createAgentActivityTools({ db });
    const out = tools.query({ agent_id: "cto" });
    expect(out.activity.every((a) => a.agent_id === "cto")).toBe(true);
    expect(out.activity).toHaveLength(3);
  });

  it("filters by since / until", () => {
    seed();
    const tools = createAgentActivityTools({ db });
    const since = new Date("2026-05-14T00:00:00Z").getTime();
    const until = new Date("2026-05-14T23:59:59Z").getTime();
    const out = tools.query({ since, until });
    expect(out.activity.every((a) => a.date === "2026-05-14")).toBe(true);
  });

  it("returns rows with the full prompt_byte_breakdown reconstructed", () => {
    seed();
    const tools = createAgentActivityTools({ db });
    const out = tools.query({});
    expect(out.activity[0]!.prompt_byte_breakdown).toEqual(baseBreakdown);
  });
});
