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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Router } from "express";

import { queryRemoteClients } from "./remote-clients.js";

const execFileAsync = promisify(execFile);

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
 *  panel over-shows rather than hides — a safer degraded mode. May be sync
 *  (test stubs) or async (the openclaw CLI). */
export type ListRosterIds = () => Set<string> | Promise<Set<string>>;

/** Ids from `openclaw agents list --json` output: `{ agents: [...] }` or a
 *  bare array. Unparseable output yields an empty set. */
function parseRosterIds(raw: string): Set<string> {
  const ids = new Set<string>();
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

/** Default roster fetch — mirrors data.ts's `openclaw agents list --json`.
 *  Async on purpose: the CLI boots the whole openclaw runtime (~12 s on a
 *  loaded host), and the previous execSync froze every dashboard request for
 *  that long on each panel poll. */
export async function defaultListRosterIds(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync("openclaw", ["agents", "list", "--json"], {
      timeout: 15000,
      encoding: "utf-8",
    });
    return parseRosterIds(stdout);
  } catch {
    return new Set();
  }
}

const ROSTER_TTL_MS = 10 * 60 * 1000;
const EMPTY_ROSTER_TTL_MS = 60 * 1000;

/**
 * Wrap a roster fetch with a TTL cache and single-flight: concurrent panel
 * polls share one CLI run, a good roster is reused for 10 min (the roster is
 * edited by hand, rarely), and an empty one — usually a failed fetch — is
 * retried after 1 min.
 */
export function cachedRoster(
  fetchIds: () => Promise<Set<string>>,
  now: () => number = Date.now,
): ListRosterIds {
  let cached: { ids: Set<string>; expiresAt: number } | null = null;
  let inFlight: Promise<Set<string>> | null = null;
  return () => {
    if (cached && now() < cached.expiresAt) return cached.ids;
    if (!inFlight) {
      inFlight = fetchIds().then((ids) => {
        cached = {
          ids,
          expiresAt: now() + (ids.size > 0 ? ROSTER_TTL_MS : EMPTY_ROSTER_TTL_MS),
        };
        inFlight = null;
        return ids;
      });
    }
    return inFlight;
  };
}

/**
 * Build the remote-clients router.
 *
 * @param brainDbPath   Absolute path to brain.db (the traces store).
 * @param listRosterIds Roster-id source; defaults to the openclaw CLI behind
 *                      a TTL cache.
 * @param now           Clock injection for deterministic tests.
 */
export function buildRemoteClientsRouter(
  brainDbPath: string,
  listRosterIds: ListRosterIds = cachedRoster(defaultListRosterIds),
  now: () => number = Date.now,
): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const days = parsePositiveInt(req.query.days, DEFAULT_DAYS, MAX_DAYS);
    const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const sinceMs = now() - days * MS_PER_DAY;

    let db: Database.Database | null = null;
    try {
      const rosterAgentIds = [...(await listRosterIds())];
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
