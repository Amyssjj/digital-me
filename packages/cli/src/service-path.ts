import path from "node:path";

/**
 * Deterministic PATH for generated OS service units (launchd / systemd).
 *
 * Services must NOT inherit the installing shell's PATH. `digital-me install`
 * and `digital-me service <name> install` are routinely run from an agent
 * session (Claude Code, Codex, ...) whose PATH carries a dozen transient
 * plugin bin directories — on 2026-09-20 the live brain-host plist had ~12 of
 * them baked in. The ambient `PATH` is therefore ignored entirely.
 *
 * The computed PATH is: the directory of the resolved service binary first
 * (so the exact `node` / `npm` the unit was generated against wins), then a
 * fixed system list, then the per-user tool dirs (`~/.local/bin`,
 * `~/Library/pnpm` — the dashboard's `npm run start` needs pnpm). Duplicates
 * are removed, first occurrence wins.
 *
 * The ONLY override is the explicit `DIGITAL_ME_SERVICE_PATH`: when set and
 * non-empty it replaces the computed PATH verbatim.
 */

export const SERVICE_PATH_OVERRIDE_ENV = "DIGITAL_ME_SERVICE_PATH";

const DEFAULT_SYSTEM_PATH: readonly string[] = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

/** Pure: HOME + env + absolute service binary → the unit's PATH string. */
export function resolveServicePath(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  binPath: string,
): string {
  const override = env[SERVICE_PATH_OVERRIDE_ENV]?.trim();
  if (override) return override;
  const entries = [
    path.dirname(binPath),
    ...DEFAULT_SYSTEM_PATH,
    path.join(home, ".local", "bin"),
    path.join(home, "Library", "pnpm"),
  ];
  return [...new Set(entries)].join(":");
}
