import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import {
  queryApplicationRate,
  queryDistribution,
  queryKnowledgeTasteChanges,
  querySessionsByAgent,
} from "./metrics-queries.js";
import { migrate } from "./migrate.js";

let tmpDir: string;
let dbPath: string;
let db: Database.Database;

/** ISO date `offset` days before today — the queries filter on
 *  `date >= date('now', '-N days')`, so seeds must be relative to now. */
function daysAgo(offset: number): string {
  const d = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-queries-"));
  dbPath = path.join(tmpDir, "dashboard.db");
  // Use the real migration so the tests exercise the actual 7-table schema.
  migrate(dbPath);
  db = new Database(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("querySessionsByAgent", () => {
  it("returns empty rows and agents on an empty DB", () => {
    const res = querySessionsByAgent(db, 30);
    expect(res.rows).toEqual([]);
    expect(res.agents).toEqual([]);
  });

  it("returns rows in the window, sorted, with a distinct sorted agent list", () => {
    const stmt = db.prepare(
      `INSERT INTO daa (agent_id, date, sessions, is_active) VALUES (?, ?, ?, ?)`,
    );
    stmt.run("zeta", daysAgo(1), 3, 1);
    stmt.run("alpha", daysAgo(1), 1, 0);
    stmt.run("alpha", daysAgo(2), 2, 1);
    stmt.run("old", daysAgo(90), 9, 1); // outside the 30-day window
    const res = querySessionsByAgent(db, 30);
    expect(res.rows).toEqual([
      { date: daysAgo(2), agent_id: "alpha", sessions: 2, is_active: 1 },
      { date: daysAgo(1), agent_id: "alpha", sessions: 1, is_active: 0 },
      { date: daysAgo(1), agent_id: "zeta", sessions: 3, is_active: 1 },
    ]);
    expect(res.agents).toEqual(["alpha", "zeta"]);
  });
});

describe("queryKnowledgeTasteChanges", () => {
  it("returns empty rows and domains on an empty DB", () => {
    const res = queryKnowledgeTasteChanges(db, 30);
    expect(res.rows).toEqual([]);
    expect(res.domains).toEqual([]);
  });

  it("scopes to the window and derives a distinct sorted domain list", () => {
    const stmt = db.prepare(
      `INSERT INTO knowledge_taste_changes (date, tree, domain, created, updated)
       VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run(daysAgo(1), "wiki", "youtube", 2, 1);
    stmt.run(daysAgo(1), "tastes", "design", 1, 0);
    stmt.run(daysAgo(3), "wiki", "design", 0, 4);
    stmt.run(daysAgo(120), "wiki", "ancient", 5, 5); // outside the window
    const res = queryKnowledgeTasteChanges(db, 30);
    expect(res.rows.map((r) => [r.date, r.tree, r.domain])).toEqual([
      [daysAgo(3), "wiki", "design"],
      [daysAgo(1), "tastes", "design"],
      [daysAgo(1), "wiki", "youtube"],
    ]);
    expect(res.domains).toEqual(["design", "youtube"]);
  });
});

describe("queryApplicationRate", () => {
  it("returns three empty series on an empty DB", () => {
    const res = queryApplicationRate(db, 30);
    expect(res.daily).toEqual([]);
    expect(res.by_domain).toEqual([]);
    expect(res.by_agent).toEqual([]);
  });

  it("returns daily rows plus per-domain/per-agent drilldowns with computed rates", () => {
    db.prepare(
      `INSERT INTO application_rate (date, tree, surfaced_unique, acted_unique, rate)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(daysAgo(1), "wiki", 4, 2, 0.5);
    db.prepare(
      `INSERT INTO application_rate (date, tree, surfaced_unique, acted_unique, rate)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(daysAgo(90), "wiki", 8, 8, 1); // outside the window
    const byDomain = db.prepare(
      `INSERT INTO application_rate_by_domain (date, tree, domain, surfaced_unique, acted_unique)
       VALUES (?, ?, ?, ?, ?)`,
    );
    byDomain.run(daysAgo(1), "wiki", "youtube", 4, 1);
    byDomain.run(daysAgo(1), "wiki", "exec", 0, 0); // surfaced 0 → NULL rate
    const byAgent = db.prepare(
      `INSERT INTO application_rate_by_agent (date, tree, agent_id, surfaced_unique, acted_unique)
       VALUES (?, ?, ?, ?, ?)`,
    );
    byAgent.run(daysAgo(1), "wiki", "claude-code", 2, 1);
    byAgent.run(daysAgo(1), "wiki", "podcast", 0, 0); // surfaced 0 → NULL rate

    const res = queryApplicationRate(db, 30);
    expect(res.daily).toEqual([
      { date: daysAgo(1), tree: "wiki", surfaced_unique: 4, acted_unique: 2, rate: 0.5 },
    ]);
    expect(res.by_domain).toEqual([
      { date: daysAgo(1), tree: "wiki", domain: "exec", surfaced_unique: 0, acted_unique: 0, rate: null },
      { date: daysAgo(1), tree: "wiki", domain: "youtube", surfaced_unique: 4, acted_unique: 1, rate: 0.25 },
    ]);
    expect(res.by_agent).toEqual([
      { date: daysAgo(1), tree: "wiki", agent_id: "claude-code", surfaced_unique: 2, acted_unique: 1, rate: 0.5 },
      { date: daysAgo(1), tree: "wiki", agent_id: "podcast", surfaced_unique: 0, acted_unique: 0, rate: null },
    ]);
  });
});

describe("queryDistribution", () => {
  function seedDistribution(rows: Array<[string, string, number]>): void {
    const stmt = db.prepare(
      `INSERT INTO knowledge_taste_distribution (tree, domain, total, as_of)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [tree, domain, total] of rows) stmt.run(tree, domain, total, daysAgo(0));
  }

  it("returns empty rows and top_domains on an empty DB", () => {
    const res = queryDistribution(db);
    expect(res.rows).toEqual([]);
    expect(res.top_domains).toEqual([]);
  });

  it("unions top-N-per-tree so taste-only domains keep an axis", () => {
    // Wiki dwarfs tastes: with a combined ranking, the taste-only domain
    // would be starved out of a small top-N. Per-tree ranking keeps it.
    seedDistribution([
      ["wiki", "youtube", 100],
      ["wiki", "exec", 90],
      ["wiki", "agents", 80],
      ["tastes", "storytelling", 3],
    ]);
    const res = queryDistribution(db, 2);
    // Top-2 wiki (youtube, exec) ∪ top-2 tastes (storytelling), ordered by
    // max(wiki, tastes) descending.
    expect(res.top_domains).toEqual(["youtube", "exec", "storytelling"]);
    expect(res.rows).toHaveLength(4);
  });

  it("accumulates totals per (tree, domain) and orders axes by max across trees", () => {
    seedDistribution([
      ["wiki", "design", 10],
      ["tastes", "design", 50], // max(design) = 50 → leads
      ["wiki", "youtube", 30],
    ]);
    const res = queryDistribution(db);
    expect(res.top_domains).toEqual(["design", "youtube"]);
    // Raw rows come back ordered by domain then tree.
    expect(res.rows.map((r) => [r.tree, r.domain, r.total])).toEqual([
      ["tastes", "design", 50],
      ["wiki", "design", 10],
      ["wiki", "youtube", 30],
    ]);
  });

  it("orders taste-only domains when the wiki tree is empty", () => {
    // Both comparator positions must handle a domain absent from a tree's
    // totals map (missing wiki entry → 0).
    seedDistribution([
      ["tastes", "storytelling", 5],
      ["tastes", "design", 9],
    ]);
    const res = queryDistribution(db);
    expect(res.top_domains).toEqual(["design", "storytelling"]);
  });

  it("defaults topN to 8 and truncates beyond it per tree", () => {
    seedDistribution(
      Array.from({ length: 10 }, (_, i): [string, string, number] => [
        "wiki",
        `domain-${String(i).padStart(2, "0")}`,
        100 - i,
      ]),
    );
    const res = queryDistribution(db);
    expect(res.top_domains).toHaveLength(8);
    expect(res.top_domains[0]).toBe("domain-00");
    expect(res.top_domains).not.toContain("domain-08");
    expect(res.top_domains).not.toContain("domain-09");
  });
});
