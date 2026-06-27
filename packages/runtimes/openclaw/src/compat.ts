/**
 * digital-me ↔ openclaw compatibility contract.
 *
 * Single source of truth for which openclaw host versions the digital-me
 * plugins (digital-me-brain, digital-me-recall) are verified against.
 *
 * Two layers, by design:
 *   1. HARD FLOOR — `OPENCLAW_MIN_HOST_VERSION` is written into each plugin's
 *      generated package.json as `install.minHostVersion`. openclaw's loader
 *      reads that field and REFUSES TO LOAD the plugin on an older host
 *      (src/plugins/min-host-version.ts). This is enforced by core, not us.
 *   2. SOFT CEILING — `warnIfUntestedHost()` logs a one-line warning when the
 *      host is NEWER than the highest version we've verified. We cannot predict
 *      future SDK breaks, so a too-new host is a warning, never a hard block.
 *
 * Bump `MAX_TESTED_OPENCLAW_VERSION` (and, when an old host stops being
 * supported, `MIN_OPENCLAW_VERSION`) each time the plugins are re-verified
 * against a new openclaw stable release.
 */

/**
 * Lowest openclaw host version the plugins are verified against. 2026.5.12 is
 * the first loader that required the package.json `openclaw.extensions` field
 * these plugins depend on for discovery.
 */
export const MIN_OPENCLAW_VERSION = "2026.5.12";

/**
 * Value for package.json `install.minHostVersion`. openclaw expects the
 * `">=x.y.z"` shape (src/plugins/min-host-version.ts MIN_HOST_VERSION_RE).
 */
export const OPENCLAW_MIN_HOST_VERSION = `>=${MIN_OPENCLAW_VERSION}`;

/** Highest openclaw stable release the plugins have been verified against. */
export const MAX_TESTED_OPENCLAW_VERSION = "2026.6.10";

/** Parse a "YYYY.M.PATCH[-prerelease][+build]" version into [year, month, patch]. */
function parseVersionTriple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** a > b on [year, month, patch]. */
function isStrictlyNewer(
  a: [number, number, number],
  b: [number, number, number],
): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

/**
 * Minimal shape this module needs from the openclaw plugin `api`. Kept local so
 * the plugin entries (plain .mjs) can call in without importing openclaw types.
 */
export interface CompatHostApi {
  config?: { meta?: { lastTouchedVersion?: string } };
  logger?: { warn?: (msg: string) => void };
}

/**
 * Resolve the running host openclaw version, defensively. openclaw does not
 * expose its version on the plugin `api` object, so we read (in order) the env
 * vars a bundled host may set, then `config.meta.lastTouchedVersion` (stamped
 * by the gateway on startup, so it tracks the running binary in practice).
 * Returns undefined when the version cannot be determined — callers must treat
 * that as "skip", never as an error.
 */
export function resolveHostOpenclawVersion(
  api: CompatHostApi | undefined,
): string | undefined {
  try {
    return (
      process.env.OPENCLAW_BUNDLED_VERSION ||
      process.env.OPENCLAW_VERSION ||
      process.env.OPENCLAW_SERVICE_VERSION ||
      api?.config?.meta?.lastTouchedVersion ||
      undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Warn once if the host openclaw is newer than the verified range. NEVER throws
 * — a compatibility check must not be able to break plugin load. No-ops when the
 * host version is unknown or within range.
 */
export function warnIfUntestedHost(
  api: CompatHostApi | undefined,
  pluginId: string,
): void {
  try {
    const host = resolveHostOpenclawVersion(api);
    if (!host) return;
    const hostTriple = parseVersionTriple(host);
    const maxTriple = parseVersionTriple(MAX_TESTED_OPENCLAW_VERSION);
    if (!hostTriple || !maxTriple) return;
    if (isStrictlyNewer(hostTriple, maxTriple)) {
      api?.logger?.warn?.(
        `${pluginId}: running on openclaw ${host}, newer than the verified range ` +
          `(tested through ${MAX_TESTED_OPENCLAW_VERSION}). If you hit issues, ` +
          `update digital-me or report a compatibility bug.`,
      );
    }
  } catch {
    // A compat check must never block plugin load.
  }
}
