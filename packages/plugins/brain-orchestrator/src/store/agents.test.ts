import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import { AGENTS_MIGRATIONS, createAgentsStore } from "./agents.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "./migrations.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of AGENTS_MIGRATIONS) registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

describe("createAgentsStore.upsert", () => {
  it("inserts a new agent and reports created=true", () => {
    const clock = vi.fn(() => 1000);
    const store = createAgentsStore({ db, now: clock });
    const r = store.upsert({
      agentId: "a-1",
      runtime: "node",
      sessionToken: "tok-1",
      tokenExpiresAt: 5000,
    });
    expect(r).toEqual({ created: true });
    const a = store.get("a-1")!;
    expect(a.firstSeenAt).toBe(1000);
    expect(a.lastSeenAt).toBe(1000);
    expect(a.sessionToken).toBe("tok-1");
    expect(a.runtime).toBe("node");
    expect(a.version).toBeUndefined();
    expect(a.capabilities).toEqual([]);
  });

  it("persists optional fields on insert", () => {
    const store = createAgentsStore({ db });
    store.upsert({
      agentId: "a-1",
      runtime: "node",
      version: "22.5.0",
      capabilities: ["wiki", "tasks"],
      sessionToken: "tok-1",
      tokenExpiresAt: 5000,
    });
    const a = store.get("a-1")!;
    expect(a.version).toBe("22.5.0");
    expect(a.capabilities).toEqual(["wiki", "tasks"]);
  });

  it("updates an existing agent and reports created=false", () => {
    let t = 1000;
    const clock = vi.fn(() => t);
    const store = createAgentsStore({ db, now: clock });
    store.upsert({
      agentId: "a-1",
      runtime: "node",
      sessionToken: "tok-1",
      tokenExpiresAt: 5000,
    });
    t = 2000;
    const r = store.upsert({
      agentId: "a-1",
      runtime: "bun",
      version: "1.2.0",
      capabilities: ["wiki"],
      sessionToken: "tok-2",
      tokenExpiresAt: 6000,
    });
    expect(r).toEqual({ created: false });
    const a = store.get("a-1")!;
    expect(a.firstSeenAt).toBe(1000);
    expect(a.lastSeenAt).toBe(2000);
    expect(a.runtime).toBe("bun");
    expect(a.version).toBe("1.2.0");
    expect(a.capabilities).toEqual(["wiki"]);
    expect(a.sessionToken).toBe("tok-2");
    expect(a.tokenExpiresAt).toBe(6000);
  });

  it("clears version + capabilities on update when caller omits them", () => {
    const store = createAgentsStore({ db });
    store.upsert({
      agentId: "a-1",
      runtime: "node",
      version: "22.5.0",
      capabilities: ["wiki", "tasks"],
      sessionToken: "tok-1",
      tokenExpiresAt: 5000,
    });
    // Second upsert deliberately drops the optional fields.
    store.upsert({
      agentId: "a-1",
      runtime: "node",
      sessionToken: "tok-1",
      tokenExpiresAt: 5000,
    });
    const a = store.get("a-1")!;
    expect(a.version).toBeUndefined();
    expect(a.capabilities).toEqual([]);
  });

  it("defaults the clock to Date.now when none is provided", () => {
    const before = Date.now();
    const store = createAgentsStore({ db });
    store.upsert({
      agentId: "a-1",
      runtime: "node",
      sessionToken: "tok",
      tokenExpiresAt: 0,
    });
    const a = store.get("a-1")!;
    expect(a.firstSeenAt).toBeGreaterThanOrEqual(before);
    expect(a.lastSeenAt).toBeGreaterThanOrEqual(before);
  });
});

describe("createAgentsStore.get", () => {
  it("returns undefined for an unknown id", () => {
    const store = createAgentsStore({ db });
    expect(store.get("missing")).toBeUndefined();
  });
});

describe("createAgentsStore.listAll", () => {
  it("returns agents newest-first by last_seen_at", () => {
    let t = 100;
    const clock = vi.fn(() => t);
    const store = createAgentsStore({ db, now: clock });
    store.upsert({
      agentId: "a",
      runtime: "node",
      sessionToken: "t",
      tokenExpiresAt: 0,
    });
    t = 200;
    store.upsert({
      agentId: "b",
      runtime: "node",
      sessionToken: "t",
      tokenExpiresAt: 0,
    });
    t = 150;
    store.upsert({
      agentId: "c",
      runtime: "node",
      sessionToken: "t",
      tokenExpiresAt: 0,
    });
    const ids = store.listAll().map((a) => a.agentId);
    expect(ids).toEqual(["b", "c", "a"]);
  });

  it("returns empty when no agents are registered", () => {
    const store = createAgentsStore({ db });
    expect(store.listAll()).toEqual([]);
  });
});

describe("createAgentsStore — defensive JSON parsing", () => {
  it("falls back to [] when capabilities JSON is malformed", () => {
    const store = createAgentsStore({ db });
    store.upsert({
      agentId: "a-1",
      runtime: "node",
      capabilities: ["x"],
      sessionToken: "t",
      tokenExpiresAt: 0,
    });
    db.prepare(
      "UPDATE brain_agents SET capabilities = 'not-json' WHERE agent_id = ?",
    ).run("a-1");
    expect(store.get("a-1")!.capabilities).toEqual([]);
  });
});

describe("AGENTS_MIGRATIONS", () => {
  it("registers brain_agents at a stable version", () => {
    expect(AGENTS_MIGRATIONS).toHaveLength(1);
    expect(AGENTS_MIGRATIONS[0]!.version).toBeGreaterThan(0);
    expect(AGENTS_MIGRATIONS[0]!.description).toMatch(/brain_agents/i);
  });

  it("produces a usable brain_agents table when applied to a fresh DB", () => {
    const fresh = new DatabaseSync(":memory:");
    for (const m of AGENTS_MIGRATIONS) m.up(fresh);
    const cols = fresh
      .prepare("PRAGMA table_info(brain_agents)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("agent_id");
    expect(names).toContain("session_token");
    expect(names).toContain("capabilities");
    fresh.close();
  });
});
