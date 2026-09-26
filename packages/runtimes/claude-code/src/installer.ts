/**
 * Claude Code runtime installer — copies the shared Digital Me hooks
 * (@digital-me/agent-hooks, the same scripts the Codex runtime installs) +
 * the `digital-me` skill into the user's `~/.claude/` directory, and merges
 * the relevant `settings.json` stanzas with `--runtime claude-code` baked
 * into every hook command.
 *
 * Used by `@digital-me/cli`'s `install` step. Pure data layer: every
 * external effect (fs read/write, path resolution) is injected so the
 * installer is testable without touching `~/.claude/`.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  AGENT_HOOKS_DIR,
  CLAUDE_CODE_ONLY_HOOK_FILES,
  SHARED_HOOK_FILES,
  hookCommand,
  mergeHookManifest,
} from "@digital-me/agent-hooks";

/**
 * Absolute path to the runtime-claude-code package root. Resolved at
 * import time so callers can find the bundled skills/ and templates/
 * directories without knowing the package's npm layout.
 */
const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Workspace layout: this module compiles to <pkg>/dist/*.js, so MODULE_ROOT
// is the package root, which carries skills/ directly. Published CLI
// bundle: esbuild inlines every workspace module into <npm-pkg>/bin/*.js, so
// MODULE_ROOT is the npm package root for EVERY package — per-package assets
// are staged by scripts/build-cli-bundle.mjs under assets/claude-code/ to
// avoid cross-package collisions.
export const PACKAGE_ROOT = existsSync(path.join(MODULE_ROOT, "skills"))
  ? MODULE_ROOT
  : path.join(MODULE_ROOT, "assets", "claude-code");

/**
 * Source of the hook scripts: the shared @digital-me/agent-hooks package
 * (one copy for Claude Code and Codex — the runtime is selected by the
 * `--runtime claude-code` the manifest bakes into each command).
 */
export const HOOKS_DIR = AGENT_HOOKS_DIR;
export const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");
export const TEMPLATES_DIR = path.join(PACKAGE_ROOT, "templates");

/**
 * Every file installed into ~/.claude/hooks/: the shared hooks + their two
 * helpers (dm_m1_emit.py, dm_hook_lib.sh), plus the Claude-Code-only
 * analyze_brain_inject.py.
 */
export const HOOK_NAMES = [
  ...SHARED_HOOK_FILES,
  ...CLAUDE_CODE_ONLY_HOOK_FILES,
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

export const SKILL_NAMES = ["digital-me"] as const;

/**
 * The Claude Code hook stanzas this runtime ships. Used by the installer
 * to merge into the user's `~/.claude/settings.json`. Mirrors the
 * settings.json structure documented in
 * https://docs.claude.com/en/docs/claude-code/hooks.
 */
export type ClaudeHookStanza = {
  readonly hooks: ReadonlyArray<{
    readonly type: "command";
    readonly command: string;
    readonly timeout?: number;
    readonly statusMessage?: string;
    readonly async?: boolean;
  }>;
};

export type ClaudeHooksManifest = {
  readonly UserPromptSubmit: readonly ClaudeHookStanza[];
  readonly Stop: readonly ClaudeHookStanza[];
  readonly PreToolUse: readonly ClaudeHookStanza[];
};

/**
 * Build the hook-manifest fragment to merge into the user's
 * `~/.claude/settings.json`. Uses `$HOME/.claude/hooks/<name> --runtime
 * claude-code` commands (Claude Code runs them through a shell) so the
 * installed location is canonical regardless of where the runtime package
 * itself lives, and the shared scripts know which host they serve.
 *
 * Timeouts:
 *   - memory_search inject: 12s to match the hook script's curl default
 *     (DIGITAL_ME_HOOK_TIMEOUT_SECS:-12). A shorter manifest timeout kills
 *     the hook before curl finishes, making slow searches look like empty injects.
 */
export function buildClaudeHooksManifest(): ClaudeHooksManifest {
  const cmd = (name: HookName) =>
    hookCommand(`$HOME/.claude/hooks/${name}`, "claude-code");
  return {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: cmd("dm_memory_search_inject.sh"),
            timeout: 12,
            statusMessage: "Digital Me: searching brain…",
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: cmd("dm_handoff_reminder.sh"),
            timeout: 5,
          },
          {
            type: "command",
            command: cmd("dm_session_extract.sh"),
            timeout: 8,
            async: true,
          },
          {
            // M1 application-rate live writer: appends one JSONL record per
            // session to ~/.claude/hooks/application_rate.log on session end.
            // Read by intake-sessions-claudecode.py as the authoritative
            // source for per-session app_rate. Async + 10s timeout so a
            // slow transcript-parse never blocks session shutdown.
            type: "command",
            command: cmd("dm_application_rate.sh"),
            timeout: 10,
            async: true,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        hooks: [
          {
            type: "command",
            command: cmd("brain_route_inject.sh"),
            timeout: 3,
          },
        ],
      },
    ],
  };
}

/**
 * Merge our hook stanzas into an existing settings.json object. Preserves
 * the user's other hooks and settings; a command an older installer
 * registered without `--runtime` is upgraded in place (never duplicated).
 * Pure function — the installer does the actual disk I/O.
 */
export function mergeHooksIntoSettings(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const existingHooks =
    (existing.hooks as Record<string, ClaudeHookStanza[]> | undefined) ?? {};
  return {
    ...existing,
    hooks: mergeHookManifest(existingHooks, buildClaudeHooksManifest()),
  };
}

/**
 * Brain-host plumbing for the hooks. Claude Code exports settings.json `env`
 * to every hook process, so writing `DIGITAL_ME_BRAIN_URL` and
 * `DIGITAL_ME_BRAIN_TOKEN_FILE` there is what makes
 * `dm_memory_search_inject.sh` / `dm_m1_emit.py` talk to the digital-me
 * brain-host instead of the openclaw gateway — without a shell export the
 * user has to remember per machine. Only the token FILE path is written: the
 * secret stays on disk (mode 600) and every hook reads it itself.
 */
export type BrainHostEnv = {
  /** The brain-host `/tools/invoke` URL (DIGITAL_ME_BRAIN_URL). */
  readonly url: string;
  /** Path of the file holding its bearer token (DIGITAL_ME_BRAIN_TOKEN_FILE). */
  readonly tokenFile: string;
};

/**
 * Merge the brain-host env into an existing settings.json object. Both keys
 * travel together — every caller treats a URL with no resolvable token as a
 * hard error, so the installer refuses to write half a contract. A
 * `DIGITAL_ME_BRAIN_TOKEN` an earlier installer version wrote is REMOVED so
 * settings.json stops carrying the secret (the hooks would otherwise keep
 * preferring it over the file). Preserves the user's other `env` entries; a
 * malformed non-object `env` is replaced. Pure function — the installer does
 * the actual disk I/O.
 */
export function mergeBrainEnvIntoSettings(
  existing: Record<string, unknown>,
  brain: BrainHostEnv,
): Record<string, unknown> {
  if (brain.url.trim() === "" || brain.tokenFile.trim() === "") {
    throw new Error(
      "brain-host env needs both DIGITAL_ME_BRAIN_URL and DIGITAL_ME_BRAIN_TOKEN_FILE — refusing to write a URL without a token file (callers treat a URL with no resolvable token as a hard error, never a gateway fallback)",
    );
  }
  const current = existing.env;
  const existingEnv: Record<string, unknown> =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  delete existingEnv.DIGITAL_ME_BRAIN_TOKEN;
  return {
    ...existing,
    env: {
      ...existingEnv,
      DIGITAL_ME_BRAIN_URL: brain.url,
      DIGITAL_ME_BRAIN_TOKEN_FILE: brain.tokenFile,
    },
  };
}
