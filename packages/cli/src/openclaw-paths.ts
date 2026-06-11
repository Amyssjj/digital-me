import path from "node:path";

/**
 * Canonical openclaw plugin-install dir = the STATE dir's extensions folder
 * (`$OPENCLAW_HOME/extensions`, default `~/.openclaw/extensions`).
 *
 * This is the HIGHEST-precedence location openclaw loads plugins from, AND it
 * lives OUTSIDE the openclaw source checkout — so it is immune to both
 * `git checkout <tag>` upgrades and being compiled into `<repo>/dist/extensions`
 * by the stock build.
 *
 * Proven 2026-06-03 by a controlled precedence test: load precedence is
 *   `~/.openclaw/extensions` ▸ `~/openclaw/dist/extensions` ▸ `~/openclaw/extensions`.
 * The old `~/openclaw/extensions` default is the LOWEST precedence and is
 * shadowed by the build's `dist/extensions` copy, so it never actually loads.
 *
 * Resolution order: explicit arg → `$OPENCLAW_EXTENSIONS_DIR` →
 * `$OPENCLAW_HOME/extensions` → `<home>/.openclaw/extensions`.
 */
export function resolveOpenclawExtensionsDir(
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  explicit?: string,
): string {
  if (explicit) return explicit;
  if (env.OPENCLAW_EXTENSIONS_DIR) return env.OPENCLAW_EXTENSIONS_DIR;
  const stateDir = env.OPENCLAW_HOME ?? path.join(home, ".openclaw");
  return path.join(stateDir, "extensions");
}
