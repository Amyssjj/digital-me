import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateLegacyDashboardDb, resolveDashboardConfig } from "./config.js";

const HOME = "/home/u";
const none = () => false;

describe("resolveDashboardConfig", () => {
  it("defaults every path under the digital-me root and the port to 3458", () => {
    const cfg = resolveDashboardConfig({ env: {}, home: HOME, exists: none });
    expect(cfg.dashboardDbPath).toBe("/home/u/digital-me/.data/dashboard.db");
    expect(cfg.brainDbPath).toBe("/home/u/digital-me/.data/brain.db");
    expect(cfg.port).toBe(3458);
    expect(cfg.contentRoots).toEqual(["/home/u/digital-me", "/home/u/.openclaw/workspace"]);
    expect(cfg.legacyMigration).toEqual({
      from: "/home/u/.local/share/digital-me/dashboard/data/system_monitor.db",
      to: "/home/u/digital-me/.data/dashboard.db",
    });
  });

  it("honors $DASHBOARD_DB and then skips the legacy migration", () => {
    const cfg = resolveDashboardConfig({ env: { DASHBOARD_DB: "/x/d.db" }, home: HOME, exists: none });
    expect(cfg.dashboardDbPath).toBe("/x/d.db");
    expect(cfg.legacyMigration).toBeNull();
  });

  it("prefers $BRAIN_DB, then $OPENCLAW_DATA_DIR, then the shared brain.db rule", () => {
    const at = (env: NodeJS.ProcessEnv) => resolveDashboardConfig({ env, home: HOME, exists: none }).brainDbPath;
    expect(at({ BRAIN_DB: "/b/brain.db", OPENCLAW_DATA_DIR: "/o" })).toBe("/b/brain.db");
    expect(at({ OPENCLAW_DATA_DIR: "/o" })).toBe("/o/brain.db");
    expect(at({ DIGITAL_ME_BRAIN_DB: "/c/brain.db" })).toBe("/c/brain.db");
  });

  it("takes $DASHBOARD_PORT over $PORT and ignores unparseable values", () => {
    const port = (env: NodeJS.ProcessEnv) => resolveDashboardConfig({ env, home: HOME, exists: none }).port;
    expect(port({ DASHBOARD_PORT: "4000", PORT: "5000" })).toBe(4000);
    expect(port({ DASHBOARD_PORT: "", PORT: "5000" })).toBe(5000);
    expect(port({ PORT: "0" })).toBe(0);
    expect(port({ DASHBOARD_PORT: "abc" })).toBe(3458);
    expect(port({ DASHBOARD_PORT: "-1" })).toBe(3458);
  });

  it("roots the openclaw workspace at $OPENCLAW_HOME when set", () => {
    const cfg = resolveDashboardConfig({ env: { OPENCLAW_HOME: "/oc" }, home: HOME, exists: none });
    expect(cfg.contentRoots).toEqual(["/home/u/digital-me", "/oc/workspace"]);
  });
});

describe("migrateLegacyDashboardDb", () => {
  let dir: string;
  let from: string;
  let to: string;
  const log = { info: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-config-"));
    from = path.join(dir, "legacy", "system_monitor.db");
    to = path.join(dir, "digital-me", ".data", "dashboard.db");
    fs.mkdirSync(path.dirname(from), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when migration is disabled", () => {
    migrateLegacyDashboardDb(null, log);
    migrateLegacyDashboardDb(null); // default logger
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("does nothing when there is no legacy DB", () => {
    migrateLegacyDashboardDb({ from, to }, log);
    expect(fs.existsSync(to)).toBe(false);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("never overwrites an existing canonical DB", () => {
    fs.writeFileSync(from, "legacy");
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, "current");
    migrateLegacyDashboardDb({ from, to }, log);
    expect(fs.readFileSync(to, "utf8")).toBe("current");
  });

  it("copies the DB and its WAL sidecars, keeping the legacy file as a backup", () => {
    fs.writeFileSync(from, "main");
    fs.writeFileSync(`${from}-wal`, "wal");
    migrateLegacyDashboardDb({ from, to }, log);
    expect(fs.readFileSync(to, "utf8")).toBe("main");
    expect(fs.readFileSync(`${to}-wal`, "utf8")).toBe("wal");
    expect(fs.existsSync(`${to}-shm`)).toBe(false);
    expect(fs.existsSync(from)).toBe(true);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("auto-migrated legacy DB"));
  });

  it("logs and carries on when the copy fails", () => {
    fs.writeFileSync(from, "main");
    // A file where the target's parent directory should be makes mkdir fail.
    fs.writeFileSync(path.join(dir, "digital-me"), "not a directory");
    migrateLegacyDashboardDb({ from, to }, log);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("legacy DB auto-migration failed"));
  });
});
