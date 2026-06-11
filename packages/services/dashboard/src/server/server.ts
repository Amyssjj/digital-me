import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
// NOTE: imports point to the .mc siblings during the §0 → §F migration window.
// The legacy endpoints below will be deleted incrementally in §D-§F as each
// view is rewritten; §G's final pass collapses .mc duplicates into canonical
// filenames once nothing imports the legacy modules anymore.
import { fetchDashboardData } from "./data.mc.js";
import { getGoals, getGoalMetrics, getAllGoalMetrics, getImprovements, getFeedback, getInsights, getCronRunsSummary, getCronRunsPerJob, getRecentTraces, getTraceById, getIssuesSummary, getIssuesTimeSeries, getTeamHealthTimeSeries, getAutomationOpportunitiesTimeSeries, getKanbanData, getLayerHealth, getWorkflowsForMechanism, getKnowledgeRows, getValidationRows } from "./db.js";
import { getSystemStatus, loadSkillsConfig } from "./drift-status.mc.js";
import { initBrainClient } from "./brain-client.mc.js";

// NUX scope-down §C: new minimal metrics router for the 4-chart Metrics view.
// Mounted alongside the legacy routes during the §C-§F transition window.
import { buildMetricsRouter } from "./metrics-routes.js";
// NUX scope-down §D + §E: mechanism workflows + kanban (share inclusion rule).
import { buildKanbanRouter, buildMechanismRouter } from "./mechanism-routes.js";
// Delivery view: unified agent-activity feed, read live from the brain DB.
import { buildActivityFeedRouter } from "./activity-feed.js";

const app = express();
// No CORS middleware on purpose: the SPA is served same-origin from this app,
// and the Vite dev server proxies /api here (see vite.config.ts), so no
// cross-origin requests exist. A `cors()` wildcard would let any website the
// browser visits read this unauthenticated personal-data API.
app.use(express.json());

// ── Cutover resilience for legacy SQLite endpoints ──
// db.ts still reads goal_metrics / issues / daily_agent_activity / etc. Those
// tables don't exist in the new canonical dashboard.db (the schema cutover
// dropped them; db.ts is being rewritten in §B-§G). Until then, a stale
// frontend, a bookmarked URL, or an external monitor hitting these routes
// would get a hard 500 and spew error logs. Normalize "no such table" into an
// empty 200 so the cutover degrades gracefully instead of looking broken.
function isMissingTableError(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}
function legacyJson<T>(
  res: express.Response,
  tag: string,
  fallback: unknown,
  compute: () => T | Promise<T>,
): void {
  Promise.resolve()
    .then(compute)
    .then((data) => res.json(data))
    .catch((err) => {
      if (isMissingTableError(err)) {
        console.warn(`[${tag}] legacy table missing post-cutover — returning empty payload`);
        res.json(fallback);
        return;
      }
      console.error(`[${tag}]`, err);
      res.status(500).json({ error: `Failed: ${tag}` });
    });
}

// Canonical dashboard DB path. Honors $DASHBOARD_DB for dev (matches the
// Python intake side in dashboard_intake/__init__.py).
//
// Default lives at ~/digital-me/.data/dashboard.db — the single
// digital-me-owned root, with hidden .data/ for machine-managed binaries
// alongside the user-edited wiki/ and tastes/ trees.
//
// Auto-migrate legacy path on boot: if ~/.local/share/digital-me/dashboard/
// data/system_monitor.db exists and the new canonical path doesn't, move
// it. One-shot, idempotent — only fires the first time a server upgrades
// past this commit.
const HOME = process.env["HOME"] ?? "";
const DEFAULT_DB_PATH = path.join(HOME, "digital-me", ".data", "dashboard.db");
const LEGACY_DB_PATH = path.join(
  HOME, ".local", "share", "digital-me", "dashboard", "data", "system_monitor.db",
);
const DASHBOARD_DB_PATH = process.env["DASHBOARD_DB"] ?? DEFAULT_DB_PATH;

(function migrateLegacyDbIfNeeded() {
  if (process.env["DASHBOARD_DB"]) return; // explicit override — don't touch.
  if (!fs.existsSync(LEGACY_DB_PATH) || fs.existsSync(DEFAULT_DB_PATH)) return;
  try {
    fs.mkdirSync(path.dirname(DEFAULT_DB_PATH), { recursive: true });
    // Copy (don't move) so the legacy DB stays put as a rollback backup. Copy
    // WAL sidecars before the main DB so the new path is never in a state where
    // the DB exists without its companions (SQLite replays -wal on open).
    for (const suffix of ["-wal", "-shm"] as const) {
      const legacySidecar = LEGACY_DB_PATH + suffix;
      if (fs.existsSync(legacySidecar)) {
        fs.copyFileSync(legacySidecar, DEFAULT_DB_PATH + suffix);
      }
    }
    fs.copyFileSync(LEGACY_DB_PATH, DEFAULT_DB_PATH);
    console.log(
      `[digital-me dashboard] auto-migrated legacy DB: ${LEGACY_DB_PATH} -> ${DEFAULT_DB_PATH} ` +
        `(original kept as rollback backup at ${LEGACY_DB_PATH})`,
    );
  } catch (err) {
    console.error(
      `[digital-me dashboard] legacy DB auto-migration failed: ${(err as Error).message}. ` +
        `Set $DASHBOARD_DB to the path you want explicitly.`,
    );
  }
})();

// ── NUX §C: 4-metric router ──
app.use("/api/metrics", buildMetricsRouter(DASHBOARD_DB_PATH));

// ── NUX §D: Mechanism router (eligibility-filtered workflow list) ──
app.use("/api/mechanism", buildMechanismRouter());

// ── Delivery view: unified agent-activity feed ──
// Reads the `activity` snapshot table from dashboard.db (same producer/consumer
// split as the metrics endpoints); the stream_activity intake step owns the
// brain → row mapping. See activity-feed.ts + intake/.../stream_activity.py.
app.use("/api/activity-feed", buildActivityFeedRouter(DASHBOARD_DB_PATH));
// NUX §E note: buildKanbanRouter is exported but intentionally NOT mounted at
// /api/kanban. The legacy /api/kanban endpoint below returns a rich
// {goals, stats, pagination} shape that TaskKanban consumes; replacing it
// would require an 887-line component rewrite. Instead useKanban filters
// goals client-side via /api/mechanism/workflows. The simpler endpoint can be
// activated later if/when the frontend converges on the flat-tasks shape.
void buildKanbanRouter;

// ── Existing v1 endpoint ──
app.get("/api/dashboard", (_req, res) => {
  try { res.json(fetchDashboardData()); }
  catch (err) { console.error(err); res.status(500).json({ error: "Failed" }); }
});

// ── OA Dashboard endpoints ──

app.get("/api/goals", (_req, res) => {
  legacyJson(res, "/api/goals", { goals: [], overallHealth: 0, overallTrend: null, lastUpdated: new Date().toISOString() }, () => {
    const goals = getGoals();
    // Use healthScore (0-100 normalized) for overall, not raw values
    const scores = goals.map((g) => g.healthScore).filter((v): v is number => v !== null);
    const overallHealth = scores.length > 0
      ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
      : 0;

    const trends = goals.map((g) => g.trend).filter((t): t is number => t !== null);
    const overallTrend = trends.length > 0
      ? +(trends.reduce((a, b) => a + b, 0) / trends.length).toFixed(1)
      : null;

    return {
      goals,
      overallHealth,
      overallTrend,
      lastUpdated: new Date().toISOString(),
    };
  });
});

app.get("/api/goals/:goalId/metrics", (req, res) => {
  const days = parseInt(req.query.days as string) || 56;
  legacyJson(res, "/api/goals/:goalId/metrics", [], () => getGoalMetrics(req.params.goalId, days));
});

app.get("/api/goals/knowledge/rows", (req, res) => {
  const days = parseInt(req.query.days as string) || 56;
  legacyJson(res, "/api/goals/knowledge/rows", {}, () => getKnowledgeRows(days));
});

app.get("/api/goals/validation/rows", (req, res) => {
  const days = parseInt(req.query.days as string) || 56;
  legacyJson(res, "/api/goals/validation/rows", {}, () => getValidationRows(days));
});

app.get("/api/goal-details", (_req, res) => {
  const days = parseInt((_req.query as Record<string, string>).days) || 56;
  legacyJson(res, "/api/goal-details", { metrics: {} }, () => ({ metrics: getAllGoalMetrics(days) }));
});

app.get("/api/goals/:goalId/improvements", (req, res) => {
  legacyJson(res, "/api/goals/:goalId/improvements", [], () => getImprovements()[req.params.goalId] || []);
});

app.get("/api/improvements", (_req, res) => {
  legacyJson(res, "/api/improvements", {}, () => getImprovements());
});

// ── G3: Team Health ──
app.get("/api/team-health", (req, res) => {
  const days = parseInt((req.query as Record<string, string>).days) || 45;
  legacyJson(res, "/api/team-health", { agents: [], dates: [], heatmap: {}, dailyActive: [], agentSummary: [], timeSeries: [], agentBars: [] }, () => getTeamHealthTimeSeries(days));
});

// ── G2: Automation Opportunities ──
app.get("/api/automation-opportunities", (req, res) => {
  const days = parseInt((req.query as Record<string, string>).days) || 60;
  legacyJson(res, "/api/automation-opportunities", { timeSeries: [], totals: { detected: 0, resolved: 0, pending: 0, awaitingReview: 0, conversionRate: 0 } }, () => getAutomationOpportunitiesTimeSeries(days));
});

// ── G2: Issues endpoints ──
app.get("/api/issues/summary", (_req, res) => {
  legacyJson(res, "/api/issues/summary", { byReporter: [], total: 0, closed: 0, fixRate: 0 }, () => getIssuesSummary());
});

app.get("/api/issues/timeseries", (req, res) => {
  const days = parseInt((req.query as Record<string, string>).days) || 30;
  legacyJson(res, "/api/issues/timeseries", { reporters: [], data: [] }, () => getIssuesTimeSeries(days));
});

app.get("/api/feedback", (_req, res) => {
  legacyJson(res, "/api/feedback", [], () => getFeedback());
});

app.get("/api/insights", (_req, res) => {
  legacyJson(res, "/api/insights", [], () => getInsights());
});

// ── Cron Runs (per-slot tracking) ──

app.get("/api/cron-runs/summary", async (_req, res) => {
  const days = parseInt((_req.query as Record<string, string>).days) || 30;
  legacyJson(res, "/api/cron-runs/summary", [], async () => {
    const summary = getCronRunsSummary(days);
    const perJob = await getCronRunsPerJob(days);

    // Group per-job data by date
    const jobsByDate: Record<string, Array<{ name: string; total: number; success: number; failed: number; missed: number; rate: number }>> = {};
    for (const row of perJob) {
      if (!jobsByDate[row.date]) jobsByDate[row.date] = [];
      jobsByDate[row.date].push({
        name: row.cron_name,
        total: row.total_slots,
        success: row.success_count,
        failed: row.failed_count,
        missed: row.missed_count,
        rate: row.success_rate,
      });
    }

    // Merge into summary
    return summary.map((s) => ({
      ...s,
      jobs: jobsByDate[s.date] || [],
    }));
  });
});

// ── Workflow (View 3) endpoints ──

// GET /api/system-status — skills + drift checks + system health
app.get("/api/system-status", (_req, res) => {
  try {
    const status = getSystemStatus();
    res.json(status);
  } catch (err) {
    console.error("[/api/system-status]", err);
    res.status(500).json({ error: "Failed to fetch system status" });
  }
});

// GET /api/workflows — LEGACY redirect (returns system-status format)
app.get("/api/workflows", (_req, res) => {
  try {
    const status = getSystemStatus();
    const config = loadSkillsConfig();
    // Backwards compat: wrap in workflows format so old UI doesn't break during transition
    res.json({
      workflows: [],
      systemHealth: status.overallHealth,
      totalDriftIssues: status.drift.length,
      checkedAt: status.checkedAt,
      skills: config.skills,
      drift: status.drift,
    });
  } catch (err) {
    console.error("[/api/workflows]", err);
    res.status(500).json({ error: "Failed to fetch workflows" });
  }
});
// ── Workflow Templates for Mechanism View ──
app.get("/api/workflows-v2", async (_req, res) => {
  try {
    res.json(await getWorkflowsForMechanism());
  } catch (err) {
    console.error("[/api/workflows-v2]", err);
    res.status(500).json({ error: "Failed to fetch workflow templates" });
  }
});

// ── Layer Health (evergreen goals) ──
app.get("/api/layer-health", async (_req, res) => {
  try {
    const data = await getLayerHealth();
    res.json(data);
  } catch (err) {
    console.error("[/api/layer-health]", err);
    res.status(500).json({ error: "Failed to fetch layer health" });
  }
});

// ── Kanban Board (Task Orchestrator — via brain API) ──
app.get("/api/kanban", async (req, res) => {
  try {
    const query = req.query as Record<string, string>;
    const data = await getKanbanData({
      status: query.status || undefined,
      limit: query.limit ? parseInt(query.limit) : undefined,
      offset: query.offset ? parseInt(query.offset) : undefined,
      sort: query.sort || undefined,
      order: query.order || undefined,
      days: query.days ? parseInt(query.days) : undefined,
    });
    res.json(data);
  } catch (err) {
    console.error("[/api/kanban]", err);
    res.status(500).json({ error: "Failed to fetch kanban data" });
  }
});

// ── Traces (via brain API) ──
app.get("/api/traces", async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const limit = parseInt(req.query.limit as string) || 50;
    const traces = await getRecentTraces(days, limit);
    res.json({ traces, total: traces.length });
  } catch (err) {
    console.error("[/api/traces]", err);
    res.status(500).json({ error: "Failed to fetch traces" });
  }
});

app.get("/api/traces/:traceId", async (req, res) => {
  try {
    const trace = await getTraceById(req.params.traceId);
    if (!trace) {
      res.status(404).json({ error: "Trace not found" });
      return;
    }
    res.json(trace);
  } catch (err) {
    console.error("[/api/traces/:id]", err);
    res.status(500).json({ error: "Failed to fetch trace" });
  }
});

app.get("/api/workflow-status", (_req, res) => {
  try {
    const status = getSystemStatus();
    res.json({ statuses: [status], checkedAt: status.checkedAt });
  } catch (err) {
    console.error("[/api/workflow-status]", err);
    res.status(500).json({ error: "Failed to check system status" });
  }
});

// ── Serve frontend static files (production mode) ──
// __dirname resolves to .../packages/services/dashboard/src/server. The
// Vite build outputs to .../packages/services/dashboard/dist — that's
// two levels up from __dirname, not one. The old "../dist" path
// resolved to src/dist/index.html which doesn't exist, causing ENOENT
// on every non-API request in production mode.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, "..", "..", "dist");
app.use(express.static(distPath));

// SPA fallback — serve index.html for any non-API route.
// In DEV mode (vite dev server on $VITE_PORT proxying /api → here),
// dist/ doesn't exist yet and this returns 404 instead of ENOENT-crashing.
// Open the Vite dev URL directly when developing.
app.get("*", (_req, res) => {
  const indexFile = path.join(distPath, "index.html");
  res.sendFile(indexFile, (err) => {
    if (err) {
      res.status(404).json({
        error: "frontend bundle not built",
        hint:
          "Run `npm run build` from packages/services/dashboard, or visit " +
          "the Vite dev server (see VITE_PORT) directly.",
        looked_at: indexFile,
      });
    }
  });
});

// Initialize brain MCP connection (non-blocking — server starts even if brain is unavailable)
initBrainClient().catch(() => {});

// Port: honour $DASHBOARD_DB's sibling $DASHBOARD_PORT (the documented env
// contract), then $PORT (testing / conventional parity), else 3458 — distinct
// from the legacy mission-control server at :3456 so a fresh user can run the
// dashboard side-by-side without port juggling. Vite's dev proxy targets the
// same default (see vite.config.ts) so the zero-config path "just works".
const PORT_ENV = process.env["DASHBOARD_PORT"] || process.env["PORT"];
const PORT = PORT_ENV ? parseInt(PORT_ENV, 10) : 3458;

// Bind loopback only, on BOTH families. This server exposes the user's personal
// brain with no auth, so it must never be reachable off-host — the previous "::"
// wildcard bind also accepted LAN connections. We listen on two sockets sharing
// the same Express app: 127.0.0.1 for IPv4 clients (incl. the Vite dev proxy)
// and ::1 for browsers that resolve "localhost" to IPv6. Binding a single host
// can't cover both loopback families, and a single host reintroduces the
// localhost→::1 ECONNREFUSED footgun.
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
let announced = false;
for (const host of LOOPBACK_HOSTS) {
  const server = http.createServer(app);
  server.on("error", (err) => {
    // ::1 can fail on hosts with IPv6 disabled — tolerate as long as one binds.
    console.warn(
      `[digital-me dashboard] could not bind ${host}:${PORT}: ${(err as Error).message}`,
    );
  });
  server.listen(PORT, host, () => {
    if (!announced) {
      announced = true;
      console.log(`[digital-me dashboard] http://localhost:${PORT} (loopback only)`);
    }
  });
}
