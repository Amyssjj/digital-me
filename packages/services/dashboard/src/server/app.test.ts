import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AGENTS_MIGRATIONS,
  GOALS_MIGRATIONS,
  TASKS_MIGRATIONS,
  TRACES_MIGRATIONS,
} from "@digital-me/brain-orchestrator";

import { createDashboardApp, type DashboardAppDeps } from "./app.js";
import { migrate } from "./migrate.js";

// Boot smoke test for the whole HTTP surface. It builds the real app — every
// router server.ts mounts — against temp SQLite DBs and serves it over real
// HTTP, so a route that can't be registered (e.g. Express 5 rejecting
// `app.get("*")` at startup) or a router that can't read its DB fails CI here
// instead of on the user's machine.

const INDEX_HTML = "<!doctype html><html><body><div id=\"root\"></div></body></html>";

let tmpDir: string;
let deps: DashboardAppDeps;
const memorySearch = vi.fn<DashboardAppDeps["memorySearch"]>();
const workflowList = vi.fn<DashboardAppDeps["workflowList"]>();

async function serve(appDeps: DashboardAppDeps): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(createDashboardApp(appDeps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-app-"));

  // dashboard.db through the dashboard's own migration (the intake schema).
  const dashboardDbPath = path.join(tmpDir, "dashboard.db");
  migrate(dashboardDbPath);

  // brain.db through brain-orchestrator's migrations — the schema brain-host writes.
  const brainDbPath = path.join(tmpDir, "brain.db");
  const brainDb = new DatabaseSync(brainDbPath);
  for (const m of [...GOALS_MIGRATIONS, ...TASKS_MIGRATIONS, ...TRACES_MIGRATIONS, ...AGENTS_MIGRATIONS]) {
    m.up(brainDb);
  }
  brainDb.close();

  const distPath = path.join(tmpDir, "dist");
  fs.mkdirSync(distPath);
  fs.writeFileSync(path.join(distPath, "index.html"), INDEX_HTML);

  deps = {
    dashboardDbPath,
    brainDbPath,
    distPath,
    workflowList,
    memorySearch,
    contentRoots: [tmpDir],
    listRosterIds: () => new Set<string>(),
  };
  ({ base, close } = await serve(deps));
});

afterAll(async () => {
  await close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${url}`);
  expect(res.headers.get("content-type")).toMatch(/application\/json/);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("createDashboardApp: SPA", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("serves index.html for a deep client-side route", async () => {
    const res = await fetch(`${base}/mechanism/some/deep/route?tab=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("does not answer non-GET requests with the SPA shell", async () => {
    const res = await fetch(`${base}/somewhere`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<div id=\"root\">");
  });

  it("answers a JSON 404 when the frontend bundle is not built", async () => {
    const dev = await serve({ ...deps, distPath: path.join(tmpDir, "no-dist") });
    try {
      const res = await fetch(`${dev.base}/metrics`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; looked_at: string };
      expect(body.error).toBe("frontend bundle not built");
      expect(body.looked_at).toBe(path.join(tmpDir, "no-dist", "index.html"));
    } finally {
      await dev.close();
    }
  });
});

describe("createDashboardApp: /api routers", () => {
  it.each([
    "/api/metrics/sessions-by-agent?days=7",
    "/api/metrics/knowledge-taste-changes?days=7",
    "/api/metrics/application-rate?days=7",
    "/api/metrics/distribution",
  ])("GET %s reads dashboard.db", async (url) => {
    const { status, body } = await getJson(url);
    expect(status).toBe(200);
    expect(body).not.toHaveProperty("error");
  });

  it("GET /api/activity-feed reads dashboard.db", async () => {
    const { status, body } = await getJson("/api/activity-feed?limit=10");
    expect(status).toBe(200);
    expect(body).toEqual({ items: [], latest_ts: null });
  });

  it("GET /api/mechanism/workflows joins brain templates with brain.db run stats", async () => {
    workflowList.mockResolvedValue([
      { id: "wf", name: "Three steps", steps: [{ name: "a" }, { name: "b" }, { name: "c" }] },
    ]);
    const { status, body } = await getJson("/api/mechanism/workflows");
    expect(status).toBe(200);
    expect(body["workflows"]).toEqual([expect.objectContaining({ id: "wf", totalRuns: 0 })]);
  });

  it("GET /api/kanban reads brain.db", async () => {
    const { status, body } = await getJson("/api/kanban?limit=5");
    expect(status).toBe(200);
    expect(body).toMatchObject({ goals: [] });
  });

  it("GET /api/remote-clients reads brain.db", async () => {
    const { status, body } = await getJson("/api/remote-clients?days=7");
    expect(status).toBe(200);
    expect(body).toMatchObject({ clients: [], window_days: 7 });
    expect(body).not.toHaveProperty("error");
  });

  it("GET /api/search calls the brain's memory_search", async () => {
    memorySearch.mockResolvedValue({ results: [{ path: "wiki/a.md", snippet: "# A\nbody", score: 0.9 }] });
    const { status, body } = await getJson("/api/search?q=hello&limit=5");
    expect(status).toBe(200);
    expect(memorySearch).toHaveBeenCalledWith("hello", { corpus: "all", limit: 5 });
    expect(body["results"]).toEqual([expect.objectContaining({ rank: 1, title: "A" })]);
  });

  it("answers unknown /api paths with a JSON 404, not the SPA shell", async () => {
    const { status, body } = await getJson("/api/dashboard");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not found" });
  });

  it("rejects a non-loopback Host header before any route runs", async () => {
    const { port } = new URL(base);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/api/metrics/distribution", headers: { host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on("error", reject);
    });
    expect(status).toBe(403);
  });
});
