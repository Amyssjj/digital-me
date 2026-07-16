/**
 * Express router for the "Remote MCP clients" panel.
 *
 * Mounted at /api/remote-clients by server.ts. One endpoint:
 *
 *   GET /api/remote-clients?days=N&limit=M
 *     → { clients: RemoteClientRow[], window_days, generated_at, error? }
 *
 * The router owns two side-effecting inputs the query module stays pure over:
 *   1. the clock — `days` becomes `sinceMs = now - days*86400_000`
 *   2. the orchestrator roster — `openclaw agents list --json`, the same
 *      command the agent-card grid uses (data.ts). Injected as `listRosterIds`
 *      so tests supply a stub instead of shelling out.
 *
 * brain.db is opened readonly per request (better-sqlite3 open is ~1ms). A read
 * failure (brain.db absent, table missing, openclaw CLI unavailable) degrades
 * to `{ clients: [], error }` with HTTP 200 — the panel renders an empty state
 * rather than 500-ing the whole view, matching the dashboard's "start even when
 * the brain is unreachable" stance.
 */

import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { Router } from "express";

import { queryRemoteClients } from "./remote-clients.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 14;
const MAX_DAYS = 3650; // matches the "All time" date-range preset
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function parsePositiveInt(
  raw: unknown,
  fallback: number,
  max: number,
): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** Roster-id source: the orchestrator agents already shown as cards. Returns a
 *  Set of ids to exclude; an empty set (CLI missing / parse failure) means the
 *  panel over-shows rather than hides — a safer degraded mode. */
export type ListRosterIds = () => Set<string>;

/** Default roster fetch — mirrors data.ts's `openclaw agents list --json`. */
export function defaultListRosterIds(): Set<string> {
  const ids = new Set<string>();
  let raw: string;
  try {
    raw = execSync("openclaw agents list --json 2>/dev/null", {
      timeout: 15000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return ids;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ids;
  }
  const list =
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { agents?: unknown[] }).agents)
      ? (parsed as { agents: unknown[] }).agents
      : Array.isArray(parsed)
        ? (parsed as unknown[])
        : [];
  for (const entry of list) {
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") ids.add(id);
  }
  return ids;
}

/**
 * Build the remote-clients router.
 *
 * @param brainDbPath   Absolute path to brain.db (the traces store).
 * @param listRosterIds Roster-id source; defaults to the openclaw CLI.
 * @param now           Clock injection for deterministic tests.
 */
export function buildRemoteClientsRouter(
  brainDbPath: string,
  listRosterIds: ListRosterIds = defaultListRosterIds,
  now: () => number = Date.now,
): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const days = parsePositiveInt(req.query.days, DEFAULT_DAYS, MAX_DAYS);
    const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const sinceMs = now() - days * MS_PER_DAY;

    let db: Database.Database | null = null;
    try {
      const rosterAgentIds = [...listRosterIds()];
      db = new Database(brainDbPath, { readonly: true, fileMustExist: true });
      const clients = queryRemoteClients(db, {
        rosterAgentIds,
        sinceMs,
        limit,
      });
      res.json({
        clients,
        window_days: days,
        generated_at: new Date(now()).toISOString(),
      });
    } catch (err) {
      res.json({
        clients: [],
        window_days: days,
        generated_at: new Date(now()).toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      db?.close();
    }
  });

  return router;
}
