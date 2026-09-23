import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRAIN_SIDECAR_FILE, renderBrainSidecar } from "@digital-me/contracts";
import type { BrainCallerEnv } from "./brain-host-service.js";

/**
 * The install-time half of the brain sidecar (`digital-me-brain.env`, see
 * `@digital-me/contracts` brain-sidecar.ts): the file the hooks and the
 * Hermes recall plugin read when their host never passes DIGITAL_ME_BRAIN_URL
 * to them. The installers keep writing settings.json `env`, the codex
 * `[shell_environment_policy.set]` and the MCP registrations as well; this is
 * what the hook processes can always see.
 */

type BrainSidecarSync =
  /** brain-host resolved: the sidecar now carries its URL + token-file path. */
  | { readonly action: "written"; readonly file: string; readonly brainUrl: string }
  /** No brain-host: a sidecar left by an earlier install was deleted. */
  | { readonly action: "removed"; readonly file: string }
  /** No brain-host and no sidecar: nothing to do. */
  | { readonly action: "absent"; readonly file: string };

/**
 * Make `<dir>/digital-me-brain.env` match the installer's brain decision:
 * written when `caller` (resolveBrainCallerEnv) resolved brain-host, removed
 * otherwise — a stale sidecar would keep the hooks on a brain-host that is no
 * longer configured, since every reader treats it as the installer's word.
 */
export function syncBrainSidecar(dir: string, caller: BrainCallerEnv | undefined): BrainSidecarSync {
  const file = path.join(dir, BRAIN_SIDECAR_FILE);
  if (caller !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, renderBrainSidecar(caller), "utf-8");
    return { action: "written", file, brainUrl: caller.brainUrl };
  }
  if (!existsSync(file)) return { action: "absent", file };
  rmSync(file, { force: true });
  return { action: "removed", file };
}

/** One install-log line for a sync, or undefined when nothing changed. */
export function describeBrainSidecar(sync: BrainSidecarSync): string | undefined {
  switch (sync.action) {
    case "written":
      return `${sync.file} → brain-host at ${sync.brainUrl}`;
    case "removed":
      return `removed stale ${sync.file} (no brain-host configured)`;
    case "absent":
      return undefined;
  }
}
