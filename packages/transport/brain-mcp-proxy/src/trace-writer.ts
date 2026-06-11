/**
 * SQLite-backed TraceWriter for the brain MCP proxy.
 *
 * Writes one row per tool call to the brain.db `traces` table — the
 * canonical observability surface owned by `digital-me-brain`. This is
 * the universal chokepoint for openclaw-brain MCP traffic: every
 * memory_search/tasks/etc. call from Codex, Claude Code, Hermes lands
 * here before forwarding to the openclaw gateway.
 *
 * Errors are caught at the trace-writer-factory level and surfaced as
 * stderr warnings — the handler's recordTrace already wraps the call in
 * a try/catch, so an INSERT failure can never break the user-facing
 * tool response.
 *
 * Schema (created + maintained by digital-me-brain's TRACES_MIGRATIONS,
 * v700):
 *   traces (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT
 *           NULL, payload TEXT NOT NULL DEFAULT '{}', task_id TEXT,
 *           goal_id TEXT, duration_ms INTEGER, t INTEGER NOT NULL)
 *
 * The proxy writes `kind = 'mcp_tool_call'` rows. The payload JSON
 * carries the rest (toolName, query, hitCount, isError).
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { ToolCallTrace, TraceWriter } from "./handler.js";
import { PROXY_TRACE_KIND } from "./tools.js";

// node:sqlite is experimental — load via createRequire to satisfy TS.
const require = createRequire(import.meta.url);

type SqliteModule = typeof import("node:sqlite");

export interface CreateSqliteTraceWriterInput {
  /** Absolute path to brain.db. */
  brainDbPath: string;
  /** Stderr emitter for warnings (one-shot — repeated failures are throttled). */
  warn: (line: string) => void;
}

/**
 * Build a TraceWriter backed by brain.db. The DB connection is opened
 * lazily on first call so the proxy can start even if brain.db isn't
 * ready yet. Returns a no-op writer if the DB cannot be opened.
 */
export function createSqliteTraceWriter(
  input: CreateSqliteTraceWriterInput,
): TraceWriter {
  let db: import("node:sqlite").DatabaseSync | null = null;
  let openAttempted = false;
  let suppressedErrors = 0;
  const maxLoggedErrors = 3;

  const ensureOpen = (): import("node:sqlite").DatabaseSync | null => {
    if (db) return db;
    if (openAttempted) return null;
    openAttempted = true;
    try {
      const { DatabaseSync } = require("node:sqlite") as SqliteModule;
      db = new DatabaseSync(input.brainDbPath);
      // WAL/journal pragmas are owned by digital-me-brain — don't set
      // those here. busy_timeout is per-connection, though: without it a
      // WAL checkpoint by another writer makes our INSERT throw
      // SQLITE_BUSY immediately instead of waiting. Match the brain
      // plugin's 5s wait.
      db.exec("PRAGMA busy_timeout=5000");
    } catch (err) {
      input.warn(
        `brain-mcp-proxy: cannot open trace DB ${input.brainDbPath}: ${stringifyErr(err)}`,
      );
      db = null;
    }
    return db;
  };

  return (trace: ToolCallTrace) => {
    const conn = ensureOpen();
    if (!conn) return;
    try {
      const payload = JSON.stringify({
        toolName: trace.toolName,
        ...(trace.query !== undefined ? { query: trace.query } : {}),
        ...(trace.hitCount !== undefined ? { hitCount: trace.hitCount } : {}),
        isError: trace.isError,
      });
      conn
        .prepare(
          `INSERT INTO traces (id, agent_id, kind, payload, duration_ms, t)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomTraceId(),
          trace.agentId,
          PROXY_TRACE_KIND,
          payload,
          trace.durationMs,
          trace.completedAt,
        );
    } catch (err) {
      if (suppressedErrors < maxLoggedErrors) {
        input.warn(`brain-mcp-proxy: trace INSERT failed: ${stringifyErr(err)}`);
      }
      suppressedErrors++;
    }
  };
}

/** Default brain.db path: `~/.openclaw/data/brain.db` (mirrors digital-me-brain). */
export function defaultBrainDbPath(homedir: string): string {
  return path.join(homedir, ".openclaw", "data", "brain.db");
}

function randomTraceId(): string {
  return `trc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
