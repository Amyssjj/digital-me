import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import Database from "better-sqlite3";

import {
  buildRemoteClientsRouter,
  cachedRoster,
  defaultListRosterIds,
} from "./remote-clients-routes.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const execFileMock = vi.mocked(execFile);

type ExecCallback = (err: Error | null, out?: { stdout: string; stderr: string }) => void;

/** Make the mocked execFile answer like the real one does under promisify. */
function cliAnswers(stdout: string): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    (args[args.length - 1] as ExecCallback)(null, { stdout, stderr: "" });
  }) as unknown as typeof execFile);
}
function cliFails(err: Error): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    (args[args.length - 1] as ExecCallback)(err);
  }) as unknown as typeof execFile);
}

let tmpDir: string;
let dbPath: string;
let server: http.Server;
let base: string;

const NOW = 1_784_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function seedBrainDb(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE traces (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', task_id TEXT, goal_id TEXT,
      duration_ms INTEGER, t INTEGER NOT NULL
    );
    CREATE TABLE brain_agents (
      agent_id TEXT PRIMARY KEY, runtime TEXT NOT NULL, version TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      session_token TEXT NOT NULL, token_expires_at INTEGER NOT NULL
    );
  `);
  const tr = db.prepare(
    `INSERT INTO traces (id, agent_id, kind, t) VALUES (?, ?, ?, ?)`,
  );
  tr.run("t1", "coo", "tool_call", NOW - HOUR); // roster → excluded
  tr.run("t2", "codex-windows", "memory_search", NOW - HOUR);
  tr.run("t3", "claude-code-windows", "tool_call", NOW - 2 * DAY);
  tr.run("t4", "codex-windows", "tool_call", NOW - 40 * DAY); // out of 30d window
  db.prepare(
    `INSERT INTO brain_agents
       (agent_id, runtime, version, capabilities, first_seen_at, last_seen_at,
        session_token, token_expires_at)
     VALUES ('codex-windows', 'codex', 'gpt-5', '["wiki","tasks"]', 0, 0, 'x', 0)`,
  ).run();
  db.close();
}

/** Mount the router with a stubbed roster + fixed clock on an ephemeral port. */
async function listen(
  dbFile: string,
  roster: string[] = ["coo"],
): Promise<void> {
  const app = express();
  app.use(
    "/api/remote-clients",
    buildRemoteClientsRouter(dbFile, () => new Set(roster), () => NOW),
  );
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-clients-"));
  dbPath = path.join(tmpDir, "brain.db");
});

afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildRemoteClientsRouter", () => {
  it("returns non-roster clients within the window, roster excluded", async () => {
    seedBrainDb(dbPath);
    await listen(dbPath);

    const res = await fetch(`${base}/api/remote-clients?days=30`);
    const body = (await res.json()) as {
      clients: Array<{ agent_id: string; calls: number; runtime: string | null }>;
      window_days: number;
    };

    expect(res.status).toBe(200);
    expect(body.window_days).toBe(30);
    // coo excluded (roster); codex-windows out-of-window trace not counted.
    expect(body.clients.map((c) => c.agent_id)).toEqual([
      "codex-windows",
      "claude-code-windows",
    ]);
    const codex = body.clients.find((c) => c.agent_id === "codex-windows");
    expect(codex).toMatchObject({ calls: 1, runtime: "codex" });
  });

  it("honors the days window (40d includes the older codex trace)", async () => {
    seedBrainDb(dbPath);
    await listen(dbPath);

    const res = await fetch(`${base}/api/remote-clients?days=60`);
    const body = (await res.json()) as {
      clients: Array<{ agent_id: string; calls: number }>;
    };
    const codex = body.clients.find((c) => c.agent_id === "codex-windows");
    expect(codex?.calls).toBe(2);
  });

  it("respects the limit param", async () => {
    seedBrainDb(dbPath);
    await listen(dbPath);

    const res = await fetch(`${base}/api/remote-clients?days=30&limit=1`);
    const body = (await res.json()) as { clients: unknown[] };
    expect(body.clients).toHaveLength(1);
  });

  it("degrades to an empty payload with error when brain.db is missing", async () => {
    // Do not seed — dbPath doesn't exist; fileMustExist should surface an error.
    await listen(dbPath);

    const res = await fetch(`${base}/api/remote-clients?days=30`);
    const body = (await res.json()) as {
      clients: unknown[];
      error?: string;
    };

    expect(res.status).toBe(200);
    expect(body.clients).toEqual([]);
    expect(typeof body.error).toBe("string");
  });

  it("over-shows (empty roster) rather than hiding when the roster is empty", async () => {
    seedBrainDb(dbPath);
    await listen(dbPath, []); // roster fetch failed → empty set

    const res = await fetch(`${base}/api/remote-clients?days=30`);
    const body = (await res.json()) as {
      clients: Array<{ agent_id: string }>;
    };
    // With no roster to exclude, the orchestrator agent shows up too.
    expect(body.clients.map((c) => c.agent_id)).toContain("coo");
  });

  it("falls back to the default window on a missing/invalid days param", async () => {
    seedBrainDb(dbPath);
    await listen(dbPath);

    const res = await fetch(`${base}/api/remote-clients?days=oops`);
    const body = (await res.json()) as { window_days: number };
    expect(body.window_days).toBe(14); // DEFAULT_DAYS
  });

  it("stringifies a non-Error thrown while resolving the roster", async () => {
    const app = express();
    app.use(
      "/api/remote-clients",
      buildRemoteClientsRouter(
        dbPath,
        () => {
          throw "roster boom"; // non-Error → String(err) branch
        },
        () => NOW,
      ),
    );
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/api/remote-clients?days=30`);
    const body = (await res.json()) as { clients: unknown[]; error?: string };
    expect(body.clients).toEqual([]);
    expect(body.error).toBe("roster boom");
  });
});

describe("default roster wiring", () => {
  afterEach(() => execFileMock.mockReset());

  it("excludes the openclaw roster when no roster source is injected", async () => {
    seedBrainDb(dbPath);
    cliAnswers(JSON.stringify([{ id: "coo" }]));
    const app = express();
    app.use("/api/remote-clients", buildRemoteClientsRouter(dbPath));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/api/remote-clients?days=3650`);
    const body = (await res.json()) as { clients: Array<{ agent_id: string }> };
    expect(body.clients.map((c) => c.agent_id)).not.toContain("coo");
    expect(body.clients.map((c) => c.agent_id)).toContain("codex-windows");
  });

  it("awaits an async roster source", async () => {
    seedBrainDb(dbPath);
    const app = express();
    app.use(
      "/api/remote-clients",
      buildRemoteClientsRouter(dbPath, async () => new Set(["codex-windows"]), () => NOW),
    );
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const body = (await (await fetch(`${base}/api/remote-clients?days=30`)).json()) as {
      clients: Array<{ agent_id: string }>;
    };
    expect(body.clients.map((c) => c.agent_id)).toEqual(["coo", "claude-code-windows"]);
  });
});

describe("defaultListRosterIds", () => {
  afterEach(() => execFileMock.mockReset());

  it("runs the openclaw CLI without a shell and parses { agents: [...] }, skipping blanks", async () => {
    cliAnswers(
      JSON.stringify({
        agents: [{ id: "coo" }, { id: "" }, { name: "no-id" }, { id: "main" }],
      }),
    );
    expect(await defaultListRosterIds()).toEqual(new Set(["coo", "main"]));
    expect(execFileMock).toHaveBeenCalledWith(
      "openclaw",
      ["agents", "list", "--json"],
      { timeout: 15000, encoding: "utf-8" },
      expect.any(Function),
    );
  });

  it("parses ids from a bare array payload", async () => {
    cliAnswers(JSON.stringify([{ id: "a1" }, { id: "a2" }]));
    expect(await defaultListRosterIds()).toEqual(new Set(["a1", "a2"]));
  });

  it("returns an empty set for a non-array/agentless object", async () => {
    cliAnswers(JSON.stringify({ unrelated: 1 }));
    expect((await defaultListRosterIds()).size).toBe(0);
  });

  it("returns an empty set on unparseable output", async () => {
    cliAnswers("not json");
    expect((await defaultListRosterIds()).size).toBe(0);
  });

  it("returns an empty set when the openclaw CLI fails", async () => {
    cliFails(new Error("spawn openclaw ENOENT"));
    expect((await defaultListRosterIds()).size).toBe(0);
  });
});

describe("cachedRoster", () => {
  it("shares one in-flight fetch, then serves the cached roster for 10 minutes", async () => {
    let t = 0;
    const fetchIds = vi.fn(async () => new Set(["coo"]));
    const roster = cachedRoster(fetchIds, () => t);

    const [a, b] = await Promise.all([roster(), roster()]);
    expect(a).toEqual(new Set(["coo"]));
    expect(b).toBe(a);
    expect(fetchIds).toHaveBeenCalledTimes(1);

    t += 10 * 60 * 1000 - 1;
    expect(roster()).toBe(a); // still cached — returned synchronously
    expect(fetchIds).toHaveBeenCalledTimes(1);

    t += 1;
    await roster();
    expect(fetchIds).toHaveBeenCalledTimes(2);
  });

  it("retries an empty roster after a minute", async () => {
    let t = 0;
    const fetchIds = vi.fn(async () => new Set<string>());
    const roster = cachedRoster(fetchIds, () => t);

    await roster();
    t += 59_999;
    await roster();
    expect(fetchIds).toHaveBeenCalledTimes(1);
    t += 1;
    await roster();
    expect(fetchIds).toHaveBeenCalledTimes(2);
  });

  it("uses the wall clock by default", async () => {
    const roster = cachedRoster(async () => new Set(["x"]));
    const first = await roster();
    expect(roster()).toBe(first);
  });
});
