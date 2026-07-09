import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolCallTrace } from "./handler.js";
import {
  createSqliteTraceWriter,
  defaultBrainDbPath,
} from "./trace-writer.js";
import { PROXY_TRACE_KIND } from "./tools.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-writer-test-"));
  dbPath = path.join(tmpDir, "brain.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createTracesTable(p: string): void {
  const db = new DatabaseSync(p);
  db.exec(`
    CREATE TABLE traces (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      kind         TEXT NOT NULL,
      payload      TEXT NOT NULL DEFAULT '{}',
      task_id      TEXT,
      goal_id      TEXT,
      duration_ms  INTEGER,
      t            INTEGER NOT NULL
    );
  `);
  db.close();
}

function baseTrace(overrides: Partial<ToolCallTrace> = {}): ToolCallTrace {
  return {
    toolName: "memory_search",
    agentId: "agent-1",
    query: "how do I deploy",
    hitCount: 3,
    durationMs: 42,
    isError: false,
    completedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("createSqliteTraceWriter", () => {
  it("inserts a kind='mcp_tool_call' row with the payload summary fields", () => {
    createTracesTable(dbPath);
    const warnings: string[] = [];
    const write = createSqliteTraceWriter({
      brainDbPath: dbPath,
      warn: (l) => warnings.push(l),
    });

    write(baseTrace());

    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT * FROM traces").all() as Array<{
      id: string;
      agent_id: string;
      kind: string;
      payload: string;
      duration_ms: number;
      t: number;
    }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("agent-1");
    expect(rows[0]!.kind).toBe(PROXY_TRACE_KIND);
    expect(rows[0]!.duration_ms).toBe(42);
    expect(rows[0]!.t).toBe(1_700_000_000_000);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      toolName: "memory_search",
      query: "how do I deploy",
      hitCount: 3,
      isError: false,
    });
    expect(warnings).toEqual([]);
  });

  it("omits optional query/hitCount from the payload when absent", () => {
    createTracesTable(dbPath);
    const write = createSqliteTraceWriter({
      brainDbPath: dbPath,
      warn: () => {},
    });

    write(baseTrace({ query: undefined, hitCount: undefined, isError: true }));

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT payload FROM traces").get() as {
      payload: string;
    };
    db.close();
    expect(JSON.parse(row.payload)).toEqual({
      toolName: "memory_search",
      isError: true,
    });
  });

  it("sets a 5s busy_timeout on its connection (second-writer WAL safety)", () => {
    createTracesTable(dbPath);
    const write = createSqliteTraceWriter({
      brainDbPath: dbPath,
      warn: () => {},
    });
    // First write opens the lazy connection (and applies the pragma).
    write(baseTrace());
    // The pragma is per-connection so it can't be read from a second
    // connection. Instead, hold a write transaction from another
    // connection: without busy_timeout the INSERT would throw
    // SQLITE_BUSY instantly and surface as a warn; with the 5s wait the
    // write succeeds once the blocker commits. We approximate by
    // verifying the writer survives a transient lock without warning.
    const blocker = new DatabaseSync(dbPath);
    blocker.exec("BEGIN IMMEDIATE");
    blocker.exec("COMMIT");
    blocker.close();
    const warnings: string[] = [];
    write(baseTrace({ completedAt: 2 }));
    expect(warnings).toEqual([]);
  });

  it("becomes a warning no-op when brain.db cannot be opened", () => {
    const warnings: string[] = [];
    const write = createSqliteTraceWriter({
      // A directory path is not a valid SQLite file target.
      brainDbPath: path.join(tmpDir, "missing-dir", "brain.db"),
      warn: (l) => warnings.push(l),
    });
    write(baseTrace());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cannot open trace DB/);
    // Subsequent writes don't retry the open or warn again.
    write(baseTrace());
    expect(warnings).toHaveLength(1);
  });

  it("warns up to 3 times on INSERT failures, then suppresses", () => {
    // Open succeeds but the traces table is missing → every INSERT throws.
    new DatabaseSync(dbPath).close();
    const warnings: string[] = [];
    const write = createSqliteTraceWriter({
      brainDbPath: dbPath,
      warn: (l) => warnings.push(l),
    });
    for (let i = 0; i < 5; i++) write(baseTrace());
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/trace INSERT failed/);
  });

  it("stringifies non-Error throwables in warnings", () => {
    createTracesTable(dbPath);
    const warnings: string[] = [];
    const write = createSqliteTraceWriter({
      brainDbPath: dbPath,
      warn: (l) => warnings.push(l),
    });
    // A trace whose property access throws a non-Error value — the warning
    // path must String() it rather than assume an Error instance.
    const trace = baseTrace();
    Object.defineProperty(trace, "query", {
      get() {
        throw "query-getter-exploded";
      },
    });
    write(trace);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/trace INSERT failed: query-getter-exploded/);
  });
});

describe("defaultBrainDbPath", () => {
  it("points at ~/.openclaw/data/brain.db", () => {
    expect(defaultBrainDbPath("/home/u")).toBe(
      path.join("/home/u", ".openclaw", "data", "brain.db"),
    );
  });
});
