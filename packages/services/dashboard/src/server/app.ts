/**
 * Express app factory for the dashboard server.
 *
 * Builds the whole HTTP surface — host guard, the /api/* routers and the SPA
 * — from injected dependencies, without binding a port or opening a brain
 * connection. server.ts is the composition root that supplies the live
 * dependencies and calls listen(); app.test.ts builds the same app against
 * temp DBs and fakes and exercises it over real HTTP.
 */

import path from "node:path";
import express, { type Express } from "express";

import { buildActivityFeedRouter } from "./activity-feed.js";
import { buildBrainKanbanRouter, queryWorkflowRunStats, withBrainDb } from "./brain-kanban.js";
import { isLoopbackHost } from "./host-guard.js";
import { buildMechanismRouter, type WorkflowListSource } from "./mechanism-routes.js";
import { buildMetricsRouter } from "./metrics-routes.js";
import { buildRemoteClientsRouter, type ListRosterIds } from "./remote-clients-routes.js";
import { buildSearchRouter, type MemorySearchFn } from "./search.js";

export type DashboardAppDeps = {
  /** dashboard.db — metrics + activity-feed snapshot tables. */
  readonly dashboardDbPath: string;
  /** brain.db — kanban, workflow run stats, remote-client traces. */
  readonly brainDbPath: string;
  /** Vite build output holding index.html + assets. */
  readonly distPath: string;
  /** Brain workflow templates (brain client `workflowList`). */
  readonly workflowList: WorkflowListSource;
  /** Brain ranked search (brain client `memorySearch`). */
  readonly memorySearch: MemorySearchFn;
  /** Roots a search hit's markdown preview may be read from. */
  readonly contentRoots: readonly string[];
  /** Orchestrator roster ids excluded from the remote-clients panel. */
  readonly listRosterIds: ListRosterIds;
};

export function createDashboardApp(deps: DashboardAppDeps): Express {
  const app = express();

  // DNS-rebinding guard — MUST be the first middleware, before body parsing
  // and every route. This API is unauthenticated and its only perimeter is
  // loopback binding + no CORS. DNS rebinding defeats that perimeter unless
  // the Host header is validated too: a site the browser visits can re-resolve
  // its hostname to 127.0.0.1 and read this personal-data API under its own
  // origin. Legit local clients (browser → localhost, Vite proxy → 127.0.0.1)
  // always send a loopback Host. See host-guard.ts for the full rationale.
  app.use((req, res, next) => {
    if (!isLoopbackHost(req.headers.host)) {
      res.status(403).json({ error: "forbidden host" });
      return;
    }
    next();
  });
  // No CORS middleware on purpose: the SPA is served same-origin from this
  // app, and the Vite dev server proxies /api here (see vite.config.ts). A
  // `cors()` wildcard would let any website read this unauthenticated API.
  app.use(express.json());

  // Metrics view: the 4 metric charts (dashboard.db).
  app.use("/api/metrics", buildMetricsRouter(deps.dashboardDbPath));

  // Delivery view: unified agent-activity feed. The stream_activity intake
  // step owns the brain → `activity` row mapping (dashboard.db).
  app.use("/api/activity-feed", buildActivityFeedRouter(deps.dashboardDbPath));

  // Mechanism view: eligibility-filtered workflows. Run counts / success rate
  // / latest run come from brain.db — the brain's workflow_list carries none.
  app.use(
    "/api/mechanism",
    buildMechanismRouter({
      workflowList: deps.workflowList,
      runStats: () => withBrainDb(deps.brainDbPath, queryWorkflowRunStats),
    }),
  );

  // Kanban board: read-only SQL over brain.db.
  app.use("/api/kanban", buildBrainKanbanRouter(deps.brainDbPath));

  // Remote MCP clients: external CLIs that reach the brain over HTTP leave a
  // footprint only in brain.db `traces`, never in the orchestrator roster.
  app.use("/api/remote-clients", buildRemoteClientsRouter(deps.brainDbPath, deps.listRosterIds));

  // Feed search: ranked knowledge search with containment-checked previews.
  app.use(
    "/api/search",
    buildSearchRouter({ memorySearch: deps.memorySearch, contentRoots: deps.contentRoots }),
  );

  // Unknown API paths are a JSON 404, never the SPA shell.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use(express.static(deps.distPath));

  // SPA fallback: index.html for any other GET, so client-side routes survive
  // a reload. Path-less middleware rather than `app.get("*")`: Express 5's
  // path-to-regexp rejects a bare "*" at registration time.
  const indexFile = path.join(deps.distPath, "index.html");
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    res.sendFile(indexFile, (err) => {
      if (err) {
        // Dev mode: the Vite dev server (see VITE_PORT) serves the SPA and
        // proxies /api here, so dist/ may not exist yet.
        res.status(404).json({
          error: "frontend bundle not built",
          hint:
            "Run `pnpm build` from packages/services/dashboard, or visit " +
            "the Vite dev server (see VITE_PORT) directly.",
          looked_at: indexFile,
        });
      }
    });
  });

  return app;
}
