import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";

import { buildMetricsRouter } from "./metrics-routes.js";
import { migrate } from "./migrate.js";

let tmpDir: string;
let dbPath: string;
let server: http.Server;
let base: string;

/** ISO date `offset` days before today (the routes' queries filter on
 *  `date >= date('now', '-N days')`). */
function daysAgo(offset: number): string {
  const d = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Mount the router against `dbFile` and listen on an ephemeral port.
 *  Same pattern as search.test.ts "buildSearchRouter (HTTP)". */
async function listen(dbFile: string): Promise<void> {
  const app = express();
  app.use("/api/metrics", buildMetricsRouter(dbFile));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-routes-"));
  dbPath = path.join(tmpDir, "dashboard.db");
  migrate(dbPath);
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedAll(): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO daa (agent_id, date, sessions, is_active) VALUES (?, ?, ?, ?)`,
  ).run("claude-code", daysAgo(1), 2, 1);
  db.prepare(
    `INSERT INTO daa (agent_id, date, sessions, is_active) VALUES (?, ?, ?, ?)`,
  ).run("ancient", daysAgo(120), 9, 1); // outside every default window
  db.prepare(
    `INSERT INTO knowledge_taste_changes (date, tree, domain, created, updated)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(daysAgo(1), "wiki", "youtube", 2, 1);
  db.prepare(
    `INSERT INTO application_rate (date, tree, surfaced_unique, acted_unique, rate)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(daysAgo(1), "wiki", 4, 2, 0.5);
  const dist = db.prepare(
    `INSERT INTO knowledge_taste_distribution (tree, domain, total, as_of)
     VALUES (?, ?, ?, ?)`,
  );
  dist.run("wiki", "youtube", 10, daysAgo(0));
  dist.run("wiki", "exec", 5, daysAgo(0));
  db.close();
}

describe("buildMetricsRouter (HTTP)", () => {
  it("GET /sessions-by-agent returns windowed rows with the agent list", async () => {
    seedAll();
    await listen(dbPath);
    const res = await fetch(`${base}/api/metrics/sessions-by-agent`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rows: Array<{ agent_id: string }>; agents: string[] };
    expect(json.rows).toEqual([
      { date: daysAgo(1), agent_id: "claude-code", sessions: 2, is_active: 1 },
    ]);
    expect(json.agents).toEqual(["claude-code"]);
  });

  it("GET /sessions-by-agent honors an explicit valid days window", async () => {
    seedAll();
    await listen(dbPath);
    const res = await fetch(`${base}/api/metrics/sessions-by-agent?days=365`);
    const json = (await res.json()) as { agents: string[] };
    // 365-day window now reaches the 120-day-old row too.
    expect(json.agents).toEqual(["ancient", "claude-code"]);
  });

  it("falls back to the default days on bogus/out-of-range values", async () => {
    seedAll();
    await listen(dbPath);
    for (const bad of ["abc", "0", "-3", "366"]) {
      const res = await fetch(`${base}/api/metrics/sessions-by-agent?days=${bad}`);
      const json = (await res.json()) as { agents: string[] };
      // Default 60-day window excludes the 120-day-old row.
      expect(json.agents).toEqual(["claude-code"]);
    }
  });

  it("GET /knowledge-taste-changes returns rows with the domain list", async () => {
    seedAll();
    await listen(dbPath);
    const res = await fetch(`${base}/api/metrics/knowledge-taste-changes`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rows: unknown[]; domains: string[] };
    expect(json.rows).toEqual([
      { date: daysAgo(1), tree: "wiki", domain: "youtube", created: 2, updated: 1 },
    ]);
    expect(json.domains).toEqual(["youtube"]);
  });

  it("GET /application-rate returns the three series", async () => {
    seedAll();
    await listen(dbPath);
    const res = await fetch(`${base}/api/metrics/application-rate`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { daily: unknown[]; by_domain: unknown[]; by_agent: unknown[] };
    expect(json.daily).toEqual([
      { date: daysAgo(1), tree: "wiki", surfaced_unique: 4, acted_unique: 2, rate: 0.5 },
    ]);
    expect(json.by_domain).toEqual([]);
    expect(json.by_agent).toEqual([]);
  });

  it("GET /distribution returns rows with top_domains, honoring topN", async () => {
    seedAll();
    await listen(dbPath);
    const all = (await (await fetch(`${base}/api/metrics/distribution`)).json()) as {
      rows: unknown[];
      top_domains: string[];
    };
    expect(all.top_domains).toEqual(["youtube", "exec"]);
    const top1 = (await (await fetch(`${base}/api/metrics/distribution?topN=1`)).json()) as {
      top_domains: string[];
    };
    expect(top1.top_domains).toEqual(["youtube"]);
    // Bogus topN falls back to the default of 8.
    const bogus = (await (await fetch(`${base}/api/metrics/distribution?topN=zzz`)).json()) as {
      top_domains: string[];
    };
    expect(bogus.top_domains).toEqual(["youtube", "exec"]);
  });

  it("500s on every endpoint when the DB path is unopenable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A path under a nonexistent directory can't be opened read-only.
      await listen(path.join(tmpDir, "missing-dir", "nope.db"));
      for (const ep of [
        "sessions-by-agent",
        "knowledge-taste-changes",
        "application-rate",
        "distribution",
      ]) {
        const res = await fetch(`${base}/api/metrics/${ep}`);
        expect(res.status).toBe(500);
        const json = (await res.json()) as { error: string };
        expect(json.error).toBe(`Failed to fetch ${ep}`);
      }
      expect(spy).toHaveBeenCalledTimes(4);
    } finally {
      spy.mockRestore();
    }
  });
});
