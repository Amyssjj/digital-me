import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { withReadonlyDb } from "./sqlite-readonly.js";

let tmpDir: string;
let dbPath: string;

function seed(file: string): void {
  const db = new Database(file);
  db.exec("CREATE TABLE t (n INTEGER); INSERT INTO t (n) VALUES (1), (2), (3);");
  db.close();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-readonly-"));
  dbPath = path.join(tmpDir, "x.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("withReadonlyDb", () => {
  it("runs the callback on a read-only connection and closes it afterwards", () => {
    seed(dbPath);
    let handle: Database.Database | undefined;
    const sum = withReadonlyDb(dbPath, (db) => {
      handle = db;
      expect(db.readonly).toBe(true);
      expect(() => db.prepare("INSERT INTO t (n) VALUES (4)").run()).toThrow();
      return (db.prepare("SELECT SUM(n) AS s FROM t").get() as { s: number }).s;
    });
    expect(sum).toBe(6);
    expect(handle?.open).toBe(false);
  });

  it("closes the connection when the callback throws", () => {
    seed(dbPath);
    let handle: Database.Database | undefined;
    expect(() =>
      withReadonlyDb(dbPath, (db) => {
        handle = db;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(handle?.open).toBe(false);
  });

  it("with fileMustExist refuses a missing file instead of creating one", () => {
    expect(() => withReadonlyDb(dbPath, () => 1, { fileMustExist: true })).toThrow();
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("survives GC of finished statements while the connection is still open", () => {
    // The crash this guards against needs an affected native build (a
    // source-built better-sqlite3 on Homebrew Node 24.20, 2026-09-22), where
    // the unpinned pattern died within a few iterations. With the prebuilt
    // binary this proves the contract: forced GCs mid-request under the
    // helper, on the real addon, in a child process.
    seed(dbPath);
    const helper = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "sqlite-readonly.ts")).href;
    const script = path.join(tmpDir, "gc-stress.ts");
    fs.writeFileSync(
      script,
      [
        `import { withReadonlyDb } from ${JSON.stringify(helper)};`,
        "const gc = (globalThis as { gc?: () => void }).gc!;",
        "for (let i = 0; i < 150; i++) {",
        "  withReadonlyDb(process.argv[2]!, (db) => {",
        "    for (let j = 0; j < 6; j++) db.prepare('SELECT n FROM t').all();",
        "    const junk = Array.from({ length: 20000 }, (_, k) => ({ k }));",
        "    gc();",
        "    return junk.length;",
        "  });",
        "}",
        "console.log('survived');",
      ].join("\n"),
    );
    const run = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", script, dbPath], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(run.stderr).not.toMatch(/Assertion failed/);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("survived");
  }, 90_000);
});
