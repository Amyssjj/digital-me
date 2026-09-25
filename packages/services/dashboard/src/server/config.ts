/**
 * Dashboard server configuration: DB paths, port, and knowledge roots,
 * resolved from the environment. Pure — the filesystem probe is injected —
 * so server.ts's bootstrap only wires the results together.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveBrainDbPath } from "@digital-me/contracts";

type DashboardConfig = {
  /** dashboard.db — the intake pipeline's snapshot tables. */
  readonly dashboardDbPath: string;
  /** brain.db — traces, goals and tasks written by brain-host / the proxy. */
  readonly brainDbPath: string;
  readonly port: number;
  /** Roots a search hit's markdown preview may be read from. */
  readonly contentRoots: readonly string[];
  /** Pre-rename dashboard.db location, auto-migrated when set (see below). */
  readonly legacyMigration: { readonly from: string; readonly to: string } | null;
};

const DEFAULT_PORT = 3458;

export function resolveDashboardConfig(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly exists: (p: string) => boolean;
}): DashboardConfig {
  const { env, home } = input;

  // Canonical dashboard DB: ~/digital-me/.data/dashboard.db, the single
  // digital-me-owned root. $DASHBOARD_DB overrides it (matches the Python
  // intake side in dashboard_intake/__init__.py) and disables migration.
  const defaultDbPath = path.join(home, "digital-me", ".data", "dashboard.db");
  const dashboardDbPath = env["DASHBOARD_DB"] ?? defaultDbPath;
  const legacyMigration = env["DASHBOARD_DB"]
    ? null
    : {
        from: path.join(home, ".local", "share", "digital-me", "dashboard", "data", "system_monitor.db"),
        to: defaultDbPath,
      };

  // brain.db is a DIFFERENT DB from dashboard.db. Honor the dashboard's own
  // $BRAIN_DB / $OPENCLAW_DATA_DIR overrides first (existing installs), then
  // the rule every reader shares (@digital-me/contracts resolveBrainDbPath).
  const brainDbPath =
    env["BRAIN_DB"] ??
    (env["OPENCLAW_DATA_DIR"]
      ? path.join(env["OPENCLAW_DATA_DIR"], "brain.db")
      : resolveBrainDbPath({ env, home, exists: input.exists }).path);

  // $DASHBOARD_PORT (the documented env contract), then $PORT, else 3458 —
  // the default Vite's dev proxy targets (see vite.config.ts).
  const portRaw = env["DASHBOARD_PORT"] || env["PORT"];
  const parsedPort = portRaw ? parseInt(portRaw, 10) : Number.NaN;
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : DEFAULT_PORT;

  // Search previews are restricted to the user-owned knowledge roots: the
  // digital-me tree and the openclaw agent workspace.
  const contentRoots = [
    path.join(home, "digital-me"),
    path.join(env["OPENCLAW_HOME"] ?? path.join(home, ".openclaw"), "workspace"),
  ];

  return { dashboardDbPath, brainDbPath, port, contentRoots, legacyMigration };
}

/**
 * One-shot, idempotent copy of the pre-rename dashboard DB to the canonical
 * path: fires only when the legacy file exists and the new one doesn't.
 * Copies (not moves) so the legacy DB stays put as a rollback backup; WAL
 * sidecars are copied before the main DB so the new path never holds a DB
 * without its companions (SQLite replays -wal on open).
 */
export function migrateLegacyDashboardDb(
  migration: DashboardConfig["legacyMigration"],
  log: { info: (msg: string) => void; error: (msg: string) => void } = console,
): void {
  if (migration === null) return;
  const { from, to } = migration;
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    for (const suffix of ["-wal", "-shm"] as const) {
      if (fs.existsSync(from + suffix)) fs.copyFileSync(from + suffix, to + suffix);
    }
    fs.copyFileSync(from, to);
    log.info(
      `[digital-me dashboard] auto-migrated legacy DB: ${from} -> ${to} ` +
        `(original kept as rollback backup at ${from})`,
    );
  } catch (err) {
    log.error(
      `[digital-me dashboard] legacy DB auto-migration failed: ${(err as Error).message}. ` +
        `Set $DASHBOARD_DB to the path you want explicitly.`,
    );
  }
}
