import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { main, migrate } from "./migrate.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  dbPath = path.join(tmpDir, "dashboard.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a DB that still carries a legacy (pre-NUX) table, so migrate()
 *  treats it as a real destructive cutover and snapshots first. */
function createLegacyDb(p: string): void {
  const db = new Database(p);
  db.exec(`CREATE TABLE issues (id TEXT PRIMARY KEY)`);
  db.exec(`INSERT INTO issues (id) VALUES ('i1')`);
  db.close();
}

describe("migrate — pre-cutover backup", () => {
  it("takes no backup on a fresh DB (no legacy tables present)", () => {
    const result = migrate(dbPath);
    expect(result.backupPath).toBeUndefined();
    expect(fs.existsSync(`${dbPath}.pre-cutover.bak`)).toBe(false);
  });

  it("snapshots a populated legacy DB before dropping (VACUUM INTO arm)", () => {
    createLegacyDb(dbPath);
    const result = migrate(dbPath);
    expect(result.backupPath).toBe(`${dbPath}.pre-cutover.bak`);
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    // The snapshot preserves the legacy table the migration dropped.
    const bak = new Database(result.backupPath!, { readonly: true });
    const rows = bak.prepare(`SELECT id FROM issues`).all() as Array<{ id: string }>;
    bak.close();
    expect(rows).toEqual([{ id: "i1" }]);
    const migrated = new Database(dbPath, { readonly: true });
    const tables = new Set(
      (migrated.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>).map((r) => r.name),
    );
    migrated.close();
    expect(tables.has("issues")).toBe(false);
    expect(tables.has("activity")).toBe(true);
  });

  it("keeps an earlier snapshot instead of overwriting it (already-exists arm)", () => {
    createLegacyDb(dbPath);
    const candidate = `${dbPath}.pre-cutover.bak`;
    fs.writeFileSync(candidate, "earlier snapshot", "utf-8");
    // Re-introduce a legacy table so this run is again a destructive cutover.
    const result = migrate(dbPath);
    expect(result.backupPath).toBe(candidate);
    // The pre-existing file is preserved, not clobbered by VACUUM INTO.
    expect(fs.readFileSync(candidate, "utf-8")).toBe("earlier snapshot");
  });

  it("skips the backup probe entirely with keepLegacy", () => {
    createLegacyDb(dbPath);
    const result = migrate(dbPath, { keepLegacy: true });
    expect(result.backupPath).toBeUndefined();
    // Legacy table survives (DROP_LEGACY skipped).
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`SELECT id FROM issues`).all();
    db.close();
    expect(rows).toHaveLength(1);
  });
});

describe("main (CLI entry)", () => {
  it("prints usage and exits 2 when the db-path argument is missing", async () => {
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    await main(["node", "migrate.ts"], log, error, exit);
    expect(error).toHaveBeenCalledWith("usage: tsx migrate.ts <db-path>");
    expect(exit).toHaveBeenCalledWith(2);
    expect(log).not.toHaveBeenCalled();
  });

  it("migrates the given path and reports drop/create counts", async () => {
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    await main(["node", "migrate.ts", dbPath], log, error, exit);
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    const lines = log.mock.calls.map((c) => c[0] as string);
    expect(lines[0]).toBe(`migrate: ${dbPath}`);
    // Fresh DB → no backup line.
    expect(lines.some((l) => l.includes("backup:"))).toBe(false);
    expect(lines.some((l) => l.includes("dropped:"))).toBe(true);
    expect(lines.some((l) => l.includes("created:"))).toBe(true);
  });

  it("reports the backupPath line when a cutover snapshot was taken", async () => {
    createLegacyDb(dbPath);
    const log = vi.fn();
    await main(["node", "migrate.ts", dbPath], log, vi.fn(), vi.fn());
    const lines = log.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes(`backup:  ${dbPath}.pre-cutover.bak`))).toBe(true);
  });
});
