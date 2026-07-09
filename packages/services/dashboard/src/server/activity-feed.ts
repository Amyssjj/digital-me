/**
 * Delivery view — unified agent-activity feed (read side).
 *
 * Reads the `activity` snapshot table from dashboard.db, exactly like the four
 * metric endpoints read their snapshot tables. The brain → feed-row mapping
 * (joining learning_captured traces to the learnings table, parsing
 * knowledge_surfaced m1 events, filtering non-cron goals) lives ENTIRELY in the
 * `stream_activity` intake step, which owns the coupling to the brain's schema
 * and writes flat rows here. Consequences:
 *
 *   • The dashboard server + frontend stay schema-agnostic — a brain refactor
 *     touches one Python ETL step, not the request path.
 *   • The feed is offline-resilient: it serves the last snapshot even when the
 *     brain is unreachable. Freshness tracks the intake cadence (~1 min), not
 *     a live DB read.
 *
 * This is the same producer/consumer split the other metrics use; see
 * server/migrate.ts (schema) and intake/dashboard_intake/stream_activity.py
 * (producer).
 */

import Database from "better-sqlite3";
import { Router } from "express";

export type ActivityKind = "captured" | "applied" | "workflow" | "taste";

/** One learning carried by a feed event — separately previewable in the Feed.
 *  An applied event that recalled N learnings has N of these; a captured one
 *  has a single entry. `markdown` is the snapshotted `.md` the preview renders. */
export interface ActivityAttachment {
  readonly title: string;
  readonly path: string | null;
  readonly markdown: string | null;
}

export interface ActivityItem {
  /** Source-event id (trace / m1 event / goal id). */
  readonly id: string;
  /** ISO-8601 timestamp. */
  readonly ts: string;
  /** Who did it — runtime agent for captured/applied, originator for workflow. */
  readonly agent_id: string;
  readonly activity: ActivityKind;
  /** Headline line of the feed item. */
  readonly title: string;
  /** Secondary "tweet body" — reasoning, recalled paths, etc. */
  readonly description: string | null;
  /** Short tag shown as a chip (learning kind, "recalled", goal type). */
  readonly meta: string | null;
  /** Per-learning attachments (null for workflow / legacy rows). */
  readonly attachments: readonly ActivityAttachment[] | null;
}

export interface ActivityFeedResult {
  readonly items: readonly ActivityItem[];
  readonly latest_ts: string | null;
}

/** Feed filter. "all" returns every stream chronologically; the others scope
 *  to one activity type (applied events are high-frequency and otherwise
 *  crowd captured/workflow out of the newest-`limit` window). */
export type ActivityFilter = "all" | ActivityKind;

const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "captured", "applied", "workflow", "taste"];

export function coerceFilter(raw: unknown): ActivityFilter {
  return typeof raw === "string" && (ACTIVITY_FILTERS as readonly string[]).includes(raw)
    ? (raw as ActivityFilter)
    : "all";
}

interface ActivityRow {
  id: string;
  ts: string;
  agent_id: string;
  activity: ActivityKind;
  title: string;
  description: string | null;
  meta: string | null;
  attachments: string | null;
}

/** Parse the stored `attachments` JSON defensively — a malformed or non-array
 *  value degrades to null rather than failing the whole feed request. */
function parseAttachments(raw: string | null): ActivityAttachment[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out = parsed
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .map((a) => ({
      title: typeof a.title === "string" ? a.title : "",
      path: typeof a.path === "string" ? a.path : null,
      markdown: typeof a.markdown === "string" ? a.markdown : null,
    }));
  return out.length > 0 ? out : null;
}

function toItem(r: ActivityRow): ActivityItem {
  return {
    id: r.id,
    ts: r.ts,
    agent_id: r.agent_id,
    activity: r.activity,
    title: r.title,
    description: r.description,
    meta: r.meta,
    attachments: parseAttachments(r.attachments),
  };
}

export function queryActivityFeed(
  db: Database.Database,
  opts: { readonly limit?: number; readonly filter?: ActivityFilter } = {},
): ActivityFeedResult {
  const limit = opts.limit && opts.limit > 0 && opts.limit <= 500 ? opts.limit : 100;
  const filter = opts.filter ?? "all";

  const rows = (
    filter === "all"
      ? db
          .prepare(
            `SELECT id, ts, agent_id, activity, title, description, meta, attachments
               FROM activity
              ORDER BY ts DESC
              LIMIT ?`,
          )
          .all(limit)
      : db
          .prepare(
            `SELECT id, ts, agent_id, activity, title, description, meta, attachments
               FROM activity
              WHERE activity = ?
              ORDER BY ts DESC
              LIMIT ?`,
          )
          .all(filter, limit)
  ) as ActivityRow[];

  return {
    items: rows.map(toItem),
    // rows[0] is undefined on an empty feed → null; identical to the
    // length-guarded form but without an unreachable fallback arm.
    latest_ts: rows[0]?.ts ?? null,
  };
}

/** Router for GET /api/activity-feed?limit=N&kind=all|captured|applied|workflow.
 *  Mirrors buildMetricsRouter: opens a read-only dashboard.db connection per
 *  request (better-sqlite3 open is ~1ms; keeps WAL handling sane). */
export function buildActivityFeedRouter(dbPath: string): Router {
  const router = Router();
  const withDb = <T,>(fn: (db: Database.Database) => T): T => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  router.get("/", (req, res) => {
    try {
      const raw = req.query.limit;
      const parsed = typeof raw === "string" ? parseInt(raw, 10) : Number.NaN;
      const limit = Number.isFinite(parsed) && parsed > 0 && parsed <= 500 ? parsed : 100;
      const filter = coerceFilter(req.query.kind);
      res.json(withDb((db) => queryActivityFeed(db, { limit, filter })));
    } catch (err) {
      console.error("[/api/activity-feed]", err);
      res.status(500).json({ error: "Failed to fetch activity feed" });
    }
  });
  return router;
}
