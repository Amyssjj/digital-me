/**
 * Per-request read-only better-sqlite3 connections that cannot crash Node.
 *
 * A better-sqlite3 native build can abort the whole process when a Statement
 * is garbage-collected while its Database is still open: `Statement::~Statement`
 * runs in a V8 GC weak callback and trips the native assertion
 * `node::RemoveEnvironmentCleanupHook … (env) != nullptr`. Seen on 2026-09-22
 * with a source-built (node-gyp) 12.10.0 on Homebrew Node 24.20: the dashboard
 * crash-looped, launchd kept restarting it, and polls and sweep captures met
 * "connection refused". The upstream prebuilt binary does not crash, but a
 * Node upgrade whose prebuild download fails falls back to a source build
 * again. A `db.prepare(sql).all()` temporary is garbage the moment it returns,
 * so any GC that lands mid-request (mapping a large result is enough) can
 * finalize one while the connection is open. Closing the Database first
 * finalizes every statement, after which collecting them is harmless.
 *
 * So every statement handed out here stays reachable until the connection is
 * closed, which makes the dashboard immune whichever binary is installed.
 * Every per-request reader (metrics, activity feed, remote clients, the
 * Kanban) goes through this one helper.
 */

import Database from "better-sqlite3";

export function withReadonlyDb<T>(
  dbPath: string,
  fn: (db: Database.Database) => T,
  opts: { readonly fileMustExist?: boolean } = {},
): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: opts.fileMustExist ?? false });
  const statements: unknown[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((source: string) => {
    const statement = prepare(source);
    statements.push(statement);
    return statement;
  }) as typeof db.prepare;
  try {
    return fn(db);
  } finally {
    // Close before releasing: closing finalizes the statements, so their
    // later collection takes better-sqlite3's safe path.
    db.close();
    statements.length = 0;
  }
}
