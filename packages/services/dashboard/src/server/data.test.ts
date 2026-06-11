import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDashboardData,
  detectStatus,
  humanCron,
  parseAgentRoster,
  parseCronJobs,
  parseMemoryFile,
} from "./data.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-data-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("humanCron", () => {
  it("returns the raw expression for non-5-field input", () => {
    expect(humanCron("invalid")).toBe("invalid");
    expect(humanCron("* * * *")).toBe("* * * *");
  });

  it("formats `*/N * * * *` as `Every N min`", () => {
    expect(humanCron("*/15 * * * *")).toBe("Every 15 min");
  });

  it("formats `min */N * * *` as `Every N hr`", () => {
    expect(humanCron("0 */2 * * *")).toBe("Every 2 hr");
  });

  it("formats daily-style schedules with timezone label", () => {
    expect(humanCron("30 9 * * *", "America/Los_Angeles")).toBe(
      "Daily at 9:30 (Los_Angeles)",
    );
  });

  it("formats daily-style schedules without tz", () => {
    expect(humanCron("0 6 * * *")).toBe("Daily at 6:00");
  });

  it("formats specific-weekday schedules", () => {
    expect(humanCron("0 9 * * 1")).toBe("Mon at 9:00");
    expect(humanCron("0 9 * * 5")).toBe("Fri at 9:00");
  });

  it("falls through to raw dow when out of range", () => {
    expect(humanCron("0 9 * * 9")).toBe("9 at 9:00");
  });

  it("uses the entire tz string when it contains no slash", () => {
    expect(humanCron("0 9 * * *", "UTC")).toBe("Daily at 9:00 (UTC)");
  });
});

describe("detectStatus", () => {
  it("returns 'completed' for done/approved/shipped/merged/fixed keywords", () => {
    expect(detectStatus("Approved and merged")).toBe("completed");
    expect(detectStatus("Shipped today")).toBe("completed");
    expect(detectStatus("Fixed the bug")).toBe("completed");
    expect(detectStatus("Completed")).toBe("completed");
  });

  it("returns 'blocked' for blocker keywords", () => {
    expect(detectStatus("blocked on review")).toBe("blocked");
    expect(detectStatus("Build failed")).toBe("blocked");
    expect(detectStatus("got an error")).toBe("blocked");
  });

  it("returns 'pending' for pending/awaiting keywords", () => {
    expect(detectStatus("Pending review")).toBe("pending");
    expect(detectStatus("Awaiting owner")).toBe("pending");
    expect(detectStatus("TBD next week")).toBe("pending");
  });

  it("returns 'active' for anything else", () => {
    expect(detectStatus("Working on it")).toBe("active");
    expect(detectStatus("")).toBe("active");
  });
});

describe("parseMemoryFile", () => {
  it("returns an empty array when the file does not exist", () => {
    const items = parseMemoryFile({
      filePath: path.join(tmpDir, "missing.md"),
      agentId: "a",
      agentName: "Agent",
      agentEmoji: "🤖",
      date: "2026-05-15",
    });
    expect(items).toEqual([]);
  });

  it("extracts a basic section into a work item", () => {
    const f = path.join(tmpDir, "memory.md");
    fs.writeFileSync(
      f,
      "## Build pipeline\n- Refactored runner\n- Added tests\n",
    );
    const items = parseMemoryFile({
      filePath: f,
      agentId: "agent",
      agentName: "Agent",
      agentEmoji: "🤖",
      date: "2026-05-15",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "agent-2026-05-15-0",
      title: "Build pipeline",
      agent: "agent",
      agentName: "Agent",
      agentEmoji: "🤖",
      date: "2026-05-15",
    });
    expect(items[0]!.summary).toContain("Refactored runner");
  });

  it("strips ** markers from the title", () => {
    const f = path.join(tmpDir, "m.md");
    fs.writeFileSync(f, "## **Important** Task\n- did stuff\n");
    const items = parseMemoryFile({
      filePath: f,
      agentId: "a",
      agentName: "A",
      agentEmoji: "🤖",
      date: "2026-05-15",
    });
    expect(items[0]!.title).toBe("Important Task");
  });

  it("skips meta-sections (daily digest, reflection, etc.)", () => {
    const f = path.join(tmpDir, "m.md");
    fs.writeFileSync(
      f,
      "## Daily Digest\n- some\n## Real Task\n- did the thing\n## Reflection\n- thinking\n",
    );
    const items = parseMemoryFile({
      filePath: f,
      agentId: "a",
      agentName: "A",
      agentEmoji: "🤖",
      date: "2026-05-15",
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Real Task");
  });

  it("classifies status using the section's full text", () => {
    const f = path.join(tmpDir, "m.md");
    fs.writeFileSync(
      f,
      "## Bug Fix\n- fixed the bug\n## Stuck Item\n- blocked on legal\n",
    );
    const items = parseMemoryFile({
      filePath: f,
      agentId: "a",
      agentName: "A",
      agentEmoji: "🤖",
      date: "2026-05-15",
    });
    expect(items.find((i) => i.title === "Bug Fix")!.status).toBe("completed");
    expect(items.find((i) => i.title === "Stuck Item")!.status).toBe("blocked");
  });

  it("limits the summary to the first three bullets", () => {
    const f = path.join(tmpDir, "m.md");
    fs.writeFileSync(
      f,
      "## Task\n- one\n- two\n- three\n- four\n- five\n",
    );
    const items = parseMemoryFile({
      filePath: f,
      agentId: "a",
      agentName: "A",
      agentEmoji: "🤖",
      date: "2026-05-15",
    });
    expect(items[0]!.summary).toContain("one");
    expect(items[0]!.summary).toContain("two");
    expect(items[0]!.summary).toContain("three");
    expect(items[0]!.summary).not.toContain("four");
  });

  it("emits an empty summary when there are no bullets", () => {
    const f = path.join(tmpDir, "m.md");
    fs.writeFileSync(f, "## Title only\n");
    const items = parseMemoryFile({
      filePath: f,
      agentId: "a",
      agentName: "A",
      agentEmoji: "🤖",
      date: "2026-05-15",
    });
    expect(items[0]!.summary).toBe("");
  });

  it("ignores bullets that appear before any section title", () => {
    const f = path.join(tmpDir, "m.md");
    fs.writeFileSync(f, "- floating bullet\n## Title\n- a\n");
    const items = parseMemoryFile({
      filePath: f,
      agentId: "a",
      agentName: "A",
      agentEmoji: "🤖",
      date: "2026-05-15",
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toContain("a");
    expect(items[0]!.summary).not.toContain("floating");
  });
});

describe("parseAgentRoster", () => {
  it("returns an empty map when the exec returns null", () => {
    const exec = vi.fn(() => null);
    const map = parseAgentRoster({ exec, teamRoot: tmpDir });
    expect(map.size).toBe(0);
    expect(exec).toHaveBeenCalledWith("openclaw agents list --json 2>/dev/null");
  });

  it("returns an empty map when the JSON is invalid", () => {
    const exec = vi.fn(() => "not json");
    expect(parseAgentRoster({ exec, teamRoot: tmpDir }).size).toBe(0);
  });

  it("returns an empty map when the JSON is the wrong shape", () => {
    const exec = vi.fn(() => JSON.stringify({ unrelated: "data" }));
    expect(parseAgentRoster({ exec, teamRoot: tmpDir }).size).toBe(0);
  });

  it("parses agents from a wrapper object {agents: [...]}", () => {
    const ws = path.join(tmpDir, "clawd-a1");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, "IDENTITY.md"), "**Role:** Test Role");
    const exec = vi.fn(() =>
      JSON.stringify({
        agents: [
          {
            id: "a1",
            identityName: "Agent One",
            identityEmoji: "🛠",
            workspace: ws,
          },
        ],
      }),
    );
    const map = parseAgentRoster({ exec, teamRoot: tmpDir });
    expect(map.size).toBe(1);
    expect(map.get("a1")).toEqual({
      name: "Agent One",
      emoji: "🛠",
      role: "Test Role",
      workspace: ws,
    });
  });

  it("parses agents from a bare array", () => {
    const exec = vi.fn(() => JSON.stringify([{ id: "a2", name: "Two" }]));
    const map = parseAgentRoster({ exec, teamRoot: tmpDir });
    expect(map.get("a2")?.name).toBe("Two");
  });

  it("falls back to teamRoot/clawd-<id> when no workspace is given", () => {
    const exec = vi.fn(() => JSON.stringify([{ id: "a3" }]));
    const map = parseAgentRoster({ exec, teamRoot: tmpDir });
    expect(map.get("a3")?.workspace).toBe(path.join(tmpDir, "clawd-a3"));
  });

  it("uses defaults when name/emoji are missing", () => {
    const exec = vi.fn(() => JSON.stringify([{ id: "a4" }]));
    const map = parseAgentRoster({ exec, teamRoot: tmpDir });
    expect(map.get("a4")?.name).toBe("a4");
    expect(map.get("a4")?.emoji).toBe("🤖");
    expect(map.get("a4")?.role).toBe("");
  });

  it("reads role from IDENTITY.md when present", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    fs.writeFileSync(
      path.join(ws, "IDENTITY.md"),
      "Some preamble\n**Role:** Big Boss\nMore text",
    );
    const exec = vi.fn(() =>
      JSON.stringify([{ id: "boss", workspace: ws }]),
    );
    const map = parseAgentRoster({ exec, teamRoot: tmpDir });
    expect(map.get("boss")?.role).toBe("Big Boss");
  });

  it("returns empty role when IDENTITY.md has no Role line", () => {
    const ws = path.join(tmpDir, "ws2");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, "IDENTITY.md"), "no role here");
    const exec = vi.fn(() =>
      JSON.stringify([{ id: "a", workspace: ws }]),
    );
    const map = parseAgentRoster({ exec, teamRoot: tmpDir });
    expect(map.get("a")?.role).toBe("");
  });

  it("falls back to empty role when IDENTITY.md read throws", () => {
    const ws = path.join(tmpDir, "ws3");
    fs.mkdirSync(ws);
    // Make IDENTITY.md a directory so readFile throws EISDIR.
    fs.mkdirSync(path.join(ws, "IDENTITY.md"));
    const exec = vi.fn(() =>
      JSON.stringify([{ id: "a", workspace: ws }]),
    );
    const map = parseAgentRoster({ exec, teamRoot: tmpDir });
    expect(map.get("a")?.role).toBe("");
  });

  it("skips agents whose id is missing or empty", () => {
    const exec = vi.fn(() =>
      JSON.stringify([
        { id: "" },
        { workspace: "/whatever" },
        { id: "real" },
      ]),
    );
    const map = parseAgentRoster({ exec, teamRoot: tmpDir });
    expect([...map.keys()]).toEqual(["real"]);
  });
});

describe("parseCronJobs", () => {
  const agentMap = new Map([
    ["coo", { name: "COO", emoji: "🏗", role: "Ops", workspace: "/x" }],
  ]);

  it("returns [] when the exec returns null", () => {
    const exec = vi.fn(() => null);
    expect(parseCronJobs({ exec, agentMap })).toEqual([]);
  });

  it("returns [] when the JSON is invalid", () => {
    const exec = vi.fn(() => "not json");
    expect(parseCronJobs({ exec, agentMap })).toEqual([]);
  });

  it("returns [] when the JSON is the wrong shape", () => {
    const exec = vi.fn(() => JSON.stringify({ wat: 1 }));
    expect(parseCronJobs({ exec, agentMap })).toEqual([]);
  });

  it("parses a basic job from {jobs: [...]}", () => {
    const exec = vi.fn(() =>
      JSON.stringify({
        jobs: [
          {
            id: "job1",
            name: "nightly",
            agentId: "coo",
            schedule: { expr: "0 2 * * *", tz: "America/Los_Angeles" },
            description: "Run the thing",
            state: { lastRunAtMs: 1715000000000, lastRunStatus: "ok", nextRunAtMs: 1715600000000 },
          },
        ],
      }),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "nightly",
      description: "Run the thing",
      schedule: "0 2 * * *",
      scheduleHuman: "Daily at 2:00 (Los_Angeles)",
      owner: "coo",
      ownerEmoji: "🏗",
      lastRunStatus: "success",
      isRunning: false,
    });
    expect(out[0]!.lastRun).toMatch(/^2024-/);
    expect(out[0]!.nextRun).toMatch(/^2024-/);
  });

  it("parses a bare array of jobs", () => {
    const exec = vi.fn(() =>
      JSON.stringify([
        { name: "j", schedule: { expr: "0 1 * * *" }, state: {} },
      ]),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out).toHaveLength(1);
  });

  it("derives description from payload.message when not explicitly set", () => {
    const exec = vi.fn(() =>
      JSON.stringify([
        {
          name: "j",
          schedule: { expr: "0 1 * * *" },
          state: {},
          payload: { message: "Short msg" },
        },
      ]),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out[0]!.description).toBe("Short msg");
  });

  it("truncates long payload.message to 117 chars + ellipsis", () => {
    const long = "x".repeat(200);
    const exec = vi.fn(() =>
      JSON.stringify([
        {
          name: "j",
          schedule: { expr: "0 1 * * *" },
          state: {},
          payload: { message: long },
        },
      ]),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out[0]!.description).toBe("x".repeat(117) + "...");
  });

  it("normalizes newlines in payload message", () => {
    const exec = vi.fn(() =>
      JSON.stringify([
        {
          name: "j",
          schedule: { expr: "0 1 * * *" },
          state: {},
          payload: { message: "line1\nline2" },
        },
      ]),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out[0]!.description).toBe("line1 line2");
  });

  it("marks lastRunStatus=failure when neither lastRunStatus nor lastStatus is 'ok'", () => {
    const exec = vi.fn(() =>
      JSON.stringify([
        {
          name: "j",
          schedule: { expr: "0 1 * * *" },
          state: { lastRunAtMs: 1715000000000 },
        },
      ]),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out[0]!.lastRunStatus).toBe("failure");
    expect(out[0]!.isRunning).toBe(true); // lastRunAtMs set, no status -> running
  });

  it("accepts state.lastStatus as the success indicator", () => {
    const exec = vi.fn(() =>
      JSON.stringify([
        {
          name: "j",
          schedule: { expr: "0 1 * * *" },
          state: { lastRunAtMs: 1, lastStatus: "ok" },
        },
      ]),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out[0]!.lastRunStatus).toBe("success");
  });

  it("returns owner emoji default 🤖 when the agent isn't in the map", () => {
    const exec = vi.fn(() =>
      JSON.stringify([
        {
          name: "j",
          agentId: "unknown",
          schedule: { expr: "0 1 * * *" },
          state: {},
        },
      ]),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out[0]!.ownerEmoji).toBe("🤖");
  });

  it("uses j.id when j.name is missing, schedule.cron when expr is missing", () => {
    const exec = vi.fn(() =>
      JSON.stringify([
        { id: "fallback-id", schedule: { cron: "0 1 * * *" }, state: {} },
      ]),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out[0]!.name).toBe("fallback-id");
    expect(out[0]!.schedule).toBe("0 1 * * *");
  });

  it("emits empty name and expr when both are missing", () => {
    const exec = vi.fn(() => JSON.stringify([{ state: {} }]));
    const out = parseCronJobs({ exec, agentMap });
    expect(out[0]!.name).toBe("");
    expect(out[0]!.schedule).toBe("");
  });

  it("emits empty timestamps when state.lastRunAtMs / nextRunAtMs are missing", () => {
    const exec = vi.fn(() =>
      JSON.stringify([{ name: "j", schedule: {}, state: {} }]),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out[0]!.lastRun).toBe("");
    expect(out[0]!.nextRun).toBe("");
  });

  it("handles a job entry with no state field at all", () => {
    const exec = vi.fn(() =>
      JSON.stringify([{ name: "j", schedule: { expr: "0 1 * * *" } }]),
    );
    const out = parseCronJobs({ exec, agentMap });
    expect(out[0]!.lastRunStatus).toBe("failure");
    expect(out[0]!.isRunning).toBe(false);
  });
});

describe("buildDashboardData", () => {
  it("composes agents, work items, and cron jobs from the injected sources (today-dated memory triggers early return)", () => {
    const ws = path.join(tmpDir, "clawd-coo");
    fs.mkdirSync(ws);
    fs.mkdirSync(path.join(ws, "memory"));
    // The "now" we pass below is fixed; the memory filename must match it
    // so parseRecentMemory's first pass (today/yesterday) finds the file
    // and short-circuits without falling through to the readdir scan.
    fs.writeFileSync(
      path.join(ws, "memory", "2026-05-15.md"),
      "## Did stuff\n- alpha\n",
    );

    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list")) {
        return JSON.stringify([
          { id: "coo", name: "COO", workspace: ws },
        ]);
      }
      if (cmd.includes("sessions")) {
        return JSON.stringify([
          {
            agentId: "coo",
            ageMs: 5_000,
            updatedAt: "2026-05-15T12:00:00Z",
          },
        ]);
      }
      if (cmd.includes("cron list")) {
        return JSON.stringify([
          { name: "n", agentId: "coo", schedule: { expr: "0 1 * * *" }, state: {} },
        ]);
      }
      return null;
    });

    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T12:34:56Z"),
    });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      id: "coo",
      name: "COO",
      activeSessions: 1,
      lastActive: "2026-05-15T12:00:00.000Z",
    });
    expect(result.workItems.length).toBeGreaterThanOrEqual(1);
    expect(result.cronJobs).toHaveLength(1);
    expect(result.lastUpdated).toBe("2026-05-15T12:34:56.000Z");
  });

  it("handles a workspace without memory dir gracefully (workItems empty)", () => {
    const ws = path.join(tmpDir, "clawd-empty");
    fs.mkdirSync(ws);
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "empty", workspace: ws }]);
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T00:00:00Z"),
    });
    expect(result.workItems).toEqual([]);
  });

  it("walks backward through memory dir when today/yesterday have nothing", () => {
    const ws = path.join(tmpDir, "clawd-back");
    fs.mkdirSync(ws);
    fs.mkdirSync(path.join(ws, "memory"));
    // Old dated file from a week ago.
    fs.writeFileSync(
      path.join(ws, "memory", "2026-05-01.md"),
      "## Past work\n- stuff\n",
    );
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "back", workspace: ws }]);
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T00:00:00Z"),
    });
    expect(result.workItems.length).toBeGreaterThanOrEqual(1);
    expect(result.workItems[0]!.date).toBe("2026-05-01");
  });

  it("skips non-date filenames when scanning memory dir", () => {
    const ws = path.join(tmpDir, "clawd-mix");
    fs.mkdirSync(ws);
    fs.mkdirSync(path.join(ws, "memory"));
    fs.writeFileSync(
      path.join(ws, "memory", "README.md"),
      "## Should be ignored\n",
    );
    fs.writeFileSync(
      path.join(ws, "memory", "notes.txt"),
      "## Also ignored\n",
    );
    fs.writeFileSync(
      path.join(ws, "memory", "2026-04-30.md"),
      "## Real entry\n- bullet\n",
    );
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "mix", workspace: ws }]);
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T00:00:00Z"),
    });
    expect(result.workItems.map((i) => i.title)).toContain("Real entry");
    expect(result.workItems.map((i) => i.title)).not.toContain(
      "Should be ignored",
    );
  });

  it("defaults active sessions to 0 when no sessions returned", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "a", workspace: ws }]);
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T00:00:00Z"),
    });
    expect(result.agents[0]!.activeSessions).toBe(0);
    expect(result.agents[0]!.lastActive).toBe("");
  });

  it("treats sessions older than 30 minutes as not active but uses their updatedAt", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "a", workspace: ws }]);
      if (cmd.includes("sessions"))
        return JSON.stringify([
          { agentId: "a", ageMs: 60 * 60 * 1000, updatedAt: "2026-05-15T10:00:00Z" },
        ]);
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T11:00:00Z"),
    });
    expect(result.agents[0]!.activeSessions).toBe(0);
    expect(result.agents[0]!.lastActive).toBe("2026-05-15T10:00:00.000Z");
  });

  it("returns empty session counts on bad sessions JSON", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "a", workspace: ws }]);
      if (cmd.includes("sessions")) return "not-json";
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T00:00:00Z"),
    });
    expect(result.agents[0]!.activeSessions).toBe(0);
  });

  it("handles sessions returning a wrapper object {sessions: [...]}", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "a", workspace: ws }]);
      if (cmd.includes("sessions"))
        return JSON.stringify({
          sessions: [
            { agentId: "a", ageMs: 100, updatedAt: "2026-05-15T11:00:00Z" },
          ],
        });
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    expect(result.agents[0]!.activeSessions).toBe(1);
  });

  it("does not crash on a present-but-invalid session timestamp (D1)", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "a", workspace: ws }]);
      if (cmd.includes("sessions"))
        return JSON.stringify({
          sessions: [{ agentId: "a", ageMs: 100, updatedAt: "not-a-date" }],
        });
      return null;
    });
    // Pre-fix this threw RangeError: Invalid time value, failing the whole payload.
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T12:00:00Z"),
    });
    expect(result.agents[0]!.activeSessions).toBe(1);
    expect(result.agents[0]!.lastActive).toBe("");
  });

  it("returns empty for sessions with the wrong outer shape", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "a", workspace: ws }]);
      if (cmd.includes("sessions")) return JSON.stringify({ wat: 1 });
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T00:00:00Z"),
    });
    expect(result.agents[0]!.activeSessions).toBe(0);
  });

  it("handles a session entry whose agentId is missing (lumps under empty key)", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "a", workspace: ws }]);
      if (cmd.includes("sessions"))
        return JSON.stringify([{ ageMs: 100, updatedAt: "2026-05-15T10:00:00Z" }]);
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T00:00:00Z"),
    });
    // Agent has zero sessions; the orphan session was bucketed under ""
    expect(result.agents[0]!.activeSessions).toBe(0);
  });

  it("handles a session entry whose ageMs is missing (treats as Infinity, never active)", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "a", workspace: ws }]);
      if (cmd.includes("sessions"))
        return JSON.stringify([
          { agentId: "a", updatedAt: "2026-05-15T10:00:00Z" },
        ]);
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T11:00:00Z"),
    });
    expect(result.agents[0]!.activeSessions).toBe(0);
    expect(result.agents[0]!.lastActive).toBe("2026-05-15T10:00:00.000Z");
  });

  it("handles a session entry whose updatedAt is missing (treats as empty string)", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes("agents list"))
        return JSON.stringify([{ id: "a", workspace: ws }]);
      if (cmd.includes("sessions"))
        return JSON.stringify([
          // No updatedAt field — should fall through to empty string.
          { agentId: "a", ageMs: 100 },
        ]);
      return null;
    });
    const result = buildDashboardData({
      exec,
      teamRoot: tmpDir,
      now: () => new Date("2026-05-15T00:00:00Z"),
    });
    expect(result.agents[0]!.activeSessions).toBe(1);
    expect(result.agents[0]!.lastActive).toBe("");
  });

  it("continues past an agent whose memory dir readdir throws", () => {
    const ws = path.join(tmpDir, "clawd-throws");
    fs.mkdirSync(ws);
    fs.mkdirSync(path.join(ws, "memory"));

    // Force readdirSync to throw exactly once during the fallback scan.
    const spy = vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw new Error("simulated readdir failure");
    });
    try {
      const exec = vi.fn((cmd: string) => {
        if (cmd.includes("agents list"))
          return JSON.stringify([{ id: "throws", workspace: ws }]);
        return null;
      });
      const result = buildDashboardData({
        exec,
        teamRoot: tmpDir,
        now: () => new Date("2026-05-15T00:00:00Z"),
      });
      // No items, but no crash.
      expect(result.workItems).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
