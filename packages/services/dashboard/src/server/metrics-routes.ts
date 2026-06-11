/**
 * Express router for the 4 NUX scope-down metric endpoints.
 *
 * Mounted at /api/metrics/* by server.ts. Each route owns its DB
 * connection lifecycle so concurrent requests don't share state. The
 * read-only attribute is set explicitly — these endpoints never write.
 *
 * Endpoints:
 *   GET /api/metrics/sessions-by-agent?days=N
 *   GET /api/metrics/knowledge-taste-changes?days=N
 *   GET /api/metrics/application-rate?days=N
 *   GET /api/metrics/distribution[?topN=N]
 */

import Database from "better-sqlite3";
import { Router } from "express";

import {
  queryApplicationRate,
  queryDistribution,
  queryKnowledgeTasteChanges,
  querySessionsByAgent,
} from "./metrics-queries.js";

const DEFAULT_DAYS = 60;
const DEFAULT_TOP_N = 8;

function parseDays(raw: unknown, fallback: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 365) return fallback;
  return n;
}

/**
 * Build the metrics router. Caller passes the DB path so tests can
 * point at an isolated file. Connections open in read-only mode (the
 * intake side is the only writer).
 */
export function buildMetricsRouter(dbPath: string): Router {
  const router = Router();

  // Helper: open + close per request keeps WAL handling sane under
  // concurrent reads. better-sqlite3 connection open is ~1ms.
  const withDb = <T,>(fn: (db: Database.Database) => T): T => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  router.get("/sessions-by-agent", (req, res) => {
    try {
      const days = parseDays(req.query.days, DEFAULT_DAYS);
      const result = withDb((db) => querySessionsByAgent(db, days));
      res.json(result);
    } catch (err) {
      console.error("[/api/metrics/sessions-by-agent]", err);
      res.status(500).json({ error: "Failed to fetch sessions-by-agent" });
    }
  });

  router.get("/knowledge-taste-changes", (req, res) => {
    try {
      const days = parseDays(req.query.days, DEFAULT_DAYS);
      const result = withDb((db) => queryKnowledgeTasteChanges(db, days));
      res.json(result);
    } catch (err) {
      console.error("[/api/metrics/knowledge-taste-changes]", err);
      res.status(500).json({ error: "Failed to fetch knowledge-taste-changes" });
    }
  });

  router.get("/application-rate", (req, res) => {
    try {
      const days = parseDays(req.query.days, DEFAULT_DAYS);
      const result = withDb((db) => queryApplicationRate(db, days));
      res.json(result);
    } catch (err) {
      console.error("[/api/metrics/application-rate]", err);
      res.status(500).json({ error: "Failed to fetch application-rate" });
    }
  });

  router.get("/distribution", (req, res) => {
    try {
      const topN = parseDays(req.query.topN, DEFAULT_TOP_N);
      const result = withDb((db) => queryDistribution(db, topN));
      res.json(result);
    } catch (err) {
      console.error("[/api/metrics/distribution]", err);
      res.status(500).json({ error: "Failed to fetch distribution" });
    }
  });

  return router;
}
