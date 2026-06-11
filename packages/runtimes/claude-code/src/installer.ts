/**
 * Claude Code runtime installer — copies the 5 hooks + the `digital-me`
 * skill into the user's `~/.claude/` directory, and merges the relevant
 * `settings.json` stanzas.
 *
 * Used by `@digital-me/cli`'s `install` step. Pure data layer: every
 * external effect (fs read/write, path resolution) is injected so the
 * installer is testable without touching `~/.claude/`.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Absolute path to the runtime-claude-code package root. Resolved at
 * import time so callers can find the bundled hooks/ and skills/
 * directories without knowing the package's npm layout.
 */
const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Workspace layout: this module compiles to <pkg>/dist/*.js, so MODULE_ROOT
// is the package root, which carries hooks/ directly. Published CLI
// bundle: esbuild inlines every workspace module into <npm-pkg>/bin/*.js, so
// MODULE_ROOT is the npm package root for EVERY package — per-package assets
// are staged by scripts/build-cli-bundle.mjs under assets/claude-code/ to
// avoid cross-package collisions (e.g. claude-code and codex both ship hooks/).
export const PACKAGE_ROOT = existsSync(path.join(MODULE_ROOT, "hooks"))
  ? MODULE_ROOT
  : path.join(MODULE_ROOT, "assets", "claude-code");

export const HOOKS_DIR = path.join(PACKAGE_ROOT, "hooks");
export const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");
export const TEMPLATES_DIR = path.join(PACKAGE_ROOT, "templates");

export const HOOK_NAMES = [
  "dm_memory_search_inject.sh",
  "brain_route_inject.sh",
  "dm_handoff_reminder.sh",
  "dm_session_extract.sh",
  "dm_application_rate.sh",
  "analyze_brain_inject.py",
  // M1 universal-protocol event emitter — called as a subprocess by
  // dm_memory_search_inject.sh (session_start + knowledge_surfaced) and
  // dm_application_rate.sh (assistant_ack + session_end). Not a hook
  // itself, just a shared helper that ships alongside the hooks so it's
  // on the same install path. See wiki:
  // infrastructure/m1-universal-event-protocol.md
  "dm_m1_emit.py",
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
 * `~/.claude/settings.json`. Uses `$HOME/.claude/hooks/<name>` paths so
 * the installed location is canonical regardless of where the runtime
 * package itself lives.
 */
export function buildClaudeHooksManifest(): ClaudeHooksManifest {
  const cmd = (name: HookName) => `$HOME/.claude/hooks/${name}`;
  return {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: cmd("dm_memory_search_inject.sh"),
            timeout: 8,
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
 * the user's other hooks and settings. Pure function — the installer
 * does the actual disk I/O.
 */
export function mergeHooksIntoSettings(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const manifest = buildClaudeHooksManifest();
  const existingHooks =
    (existing.hooks as Record<string, ClaudeHookStanza[]> | undefined) ?? {};
  const mergedHooks: Record<string, ClaudeHookStanza[]> = { ...existingHooks };
  for (const event of Object.keys(manifest) as Array<keyof ClaudeHooksManifest>) {
    const ours = manifest[event];
    const theirs = mergedHooks[event] ?? [];
    // De-dupe by command string — re-running the installer is idempotent.
    const seen = new Set<string>();
    for (const stanza of theirs) {
      for (const h of stanza.hooks) seen.add(h.command);
    }
    const ourFiltered = ours
      .map((s) => ({
        hooks: s.hooks.filter((h) => !seen.has(h.command)),
      }))
      .filter((s) => s.hooks.length > 0);
    mergedHooks[event] = [...theirs, ...ourFiltered];
  }
  return { ...existing, hooks: mergedHooks };
}
