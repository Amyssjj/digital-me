/**
 * Dashboard server entry point — the composition root. Resolves config,
 * opens the (lazy) brain connection, builds the app via createDashboardApp
 * and binds the loopback sockets. Everything with logic lives in tested
 * modules (config.ts, app.ts, brain-client.ts, brain-proxy-client.ts).
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDashboardApp } from "./app.js";
import { createBrainClient } from "./brain-client.js";
import { connectBrainProxy } from "./brain-proxy-client.js";
import { migrateLegacyDashboardDb, resolveDashboardConfig } from "./config.js";
import { cachedRoster, defaultListRosterIds } from "./remote-clients-routes.js";

const config = resolveDashboardConfig({
  env: process.env,
  home: process.env["HOME"] ?? "",
  exists: (p) => fs.existsSync(p),
});
migrateLegacyDashboardDb(config.legacyMigration);

// Brain MCP connection: connects lazily on first call and reconnects after
// the proxy child exits. Warmed here, non-blocking — the server starts (and
// the SQLite-backed views work) even when the brain is unavailable.
const brain = createBrainClient({
  clientFactory: () => connectBrainProxy(process.env),
  warn: (msg) => console.warn(msg),
});
void brain.init().then((r) => {
  if (!r.ok) console.warn(`[brain-client] brain unavailable (${r.error}); brain-backed routes will error until it is`);
});

// The orchestrator roster (`openclaw agents list`, ~12 s) sits behind a TTL
// cache and is warmed at boot so the first remote-clients load doesn't wait.
const listRosterIds = cachedRoster(defaultListRosterIds);
void listRosterIds();

const app = createDashboardApp({
  dashboardDbPath: config.dashboardDbPath,
  brainDbPath: config.brainDbPath,
  // src/server (tsx) and dist/server (compiled) both sit two levels below the
  // package root, where Vite writes dist/.
  distPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist"),
  workflowList: () => brain.workflowList(),
  memorySearch: (query, opts) => brain.memorySearch(query, opts),
  contentRoots: config.contentRoots,
  listRosterIds,
});

// Bind loopback only, on BOTH families: this server exposes the user's
// personal brain with no auth, so it must never be reachable off-host.
// 127.0.0.1 serves IPv4 clients (incl. the Vite dev proxy) and ::1 serves
// browsers that resolve "localhost" to IPv6; ::1 may fail on hosts with IPv6
// disabled, which is tolerated as long as one socket binds.
let announced = false;
for (const host of ["127.0.0.1", "::1"]) {
  const server = http.createServer(app);
  server.on("error", (err) => {
    console.warn(`[digital-me dashboard] could not bind ${host}:${config.port}: ${err.message}`);
  });
  server.listen(config.port, host, () => {
    if (!announced) {
      announced = true;
      console.log(`[digital-me dashboard] http://localhost:${config.port} (loopback only)`);
    }
  });
}
