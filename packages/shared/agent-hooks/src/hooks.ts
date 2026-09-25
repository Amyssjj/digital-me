/**
 * The single source of the Digital Me lifecycle hooks.
 *
 * Claude Code and Codex speak the same hook protocol (stdin JSON with
 * `prompt` / `session_id` / `transcript_path` / `tool_name`, stdout
 * `hookSpecificOutput` / `decision`), so both runtimes install the SAME
 * scripts from `hooks/` here. What genuinely differs — the runtime home
 * (~/.claude vs ~/.codex), the per-session /tmp state names, the M1 runtime
 * label + WAL, and the transcript format dm_application_rate.sh parses — is
 * selected by ONE runtime id that each installer bakes into the hook command
 * it registers: `<hooks dir>/<script> --runtime <id>` (see hooks/dm_hook_lib.sh).
 * The installed files stay byte-identical to this source.
 *
 * Pure data + pure merge helpers; the CLI does the disk I/O.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Workspace layout: this module compiles to <pkg>/dist/*.js, so MODULE_ROOT
// is the package root, which carries hooks/ directly. Published CLI bundle:
// esbuild inlines every workspace module into <npm-pkg>/bin/*.js, so
// MODULE_ROOT is the npm package root — scripts/build-cli-bundle.mjs stages
// this package's hooks/ under assets/agent-hooks/.
export const AGENT_HOOKS_ROOT = existsSync(path.join(MODULE_ROOT, "hooks"))
  ? MODULE_ROOT
  : path.join(MODULE_ROOT, "assets", "agent-hooks");

export const AGENT_HOOKS_DIR = path.join(AGENT_HOOKS_ROOT, "hooks");

/** Runtimes the shared hooks support (the `--runtime` values). */
export const HOOK_RUNTIMES = ["claude-code", "codex"] as const;
export type HookRuntime = (typeof HOOK_RUNTIMES)[number];

/**
 * Files every runtime installs: the five hooks wired into host events, the
 * M1 emitter they spawn, and the runtime-resolution library they source.
 * Neither helper is a hook itself; both must sit next to the hooks.
 */
export const SHARED_HOOK_FILES = [
  "dm_memory_search_inject.sh",
  "brain_route_inject.sh",
  "dm_handoff_reminder.sh",
  "dm_session_extract.sh",
  "dm_application_rate.sh",
  // M1 universal-protocol event emitter — called as a subprocess by
  // dm_memory_search_inject.sh (session_start + knowledge_surfaced) and
  // dm_application_rate.sh (assistant_ack + session_end). See wiki:
  // infrastructure/m1-universal-event-protocol.md
  "dm_m1_emit.py",
  // Sourced by every hook: resolves --runtime into paths + state names.
  "dm_hook_lib.sh",
] as const;

export type SharedHookFile = (typeof SHARED_HOOK_FILES)[number];

/**
 * Claude-Code-only extra: the offline analyser for the PreToolUse
 * brain-route experiment (reads ~/.claude/logs + ~/.claude/projects).
 */
export const CLAUDE_CODE_ONLY_HOOK_FILES = ["analyze_brain_inject.py"] as const;

/** Suffix every registered hook command carries. */
export function runtimeArg(runtime: HookRuntime): string {
  return `--runtime ${runtime}`;
}

/** The command line a runtime registers for one installed hook script. */
export function hookCommand(scriptPath: string, runtime: HookRuntime): string {
  return `${scriptPath} ${runtimeArg(runtime)}`;
}

/**
 * The script path of a command {@link hookCommand} built — i.e. the bare
 * command line an installer registered before the runtime was baked in.
 */
export function legacyHookCommand(command: string): string {
  return command.replace(/ --runtime \S+$/, "");
}

type HookHandler = { readonly command: string };
type HookStanza<H extends HookHandler> = { readonly hooks: ReadonlyArray<H> };

/**
 * Merge a runtime's hook manifest into the host's existing `hooks` object
 * (settings.json for Claude Code, hooks.json for Codex). Pure.
 *
 *   - The user's other hooks, events and stanza keys are preserved.
 *   - A handler whose command is the LEGACY bare path of one of ours (what an
 *     older installer registered, before `--runtime` was baked in) is
 *     upgraded in place to the new command, keeping its position and any
 *     keys the user tuned — so an upgrade never leaves the hook registered
 *     twice.
 *   - De-dupes by command string, so re-running the installer is idempotent.
 */
export function mergeHookManifest<H extends HookHandler, S extends HookStanza<H>>(
  existingHooks: Readonly<Record<string, readonly S[]>>,
  manifest: Readonly<Record<string, readonly S[]>>,
): Record<string, S[]> {
  const merged: Record<string, S[]> = {};
  for (const [event, stanzas] of Object.entries(existingHooks)) {
    merged[event] = [...stanzas];
  }
  for (const [event, ours] of Object.entries(manifest)) {
    const upgrades = new Map<string, string>();
    for (const stanza of ours) {
      for (const h of stanza.hooks) {
        const legacy = legacyHookCommand(h.command);
        if (legacy !== h.command) upgrades.set(legacy, h.command);
      }
    }
    const theirs = (merged[event] ?? []).map((stanza) => ({
      ...stanza,
      hooks: stanza.hooks.map((h) => {
        const upgraded = upgrades.get(h.command);
        return upgraded === undefined ? h : { ...h, command: upgraded };
      }),
    }));
    const seen = new Set<string>();
    for (const stanza of theirs) {
      for (const h of stanza.hooks) seen.add(h.command);
    }
    const ourFiltered = ours
      .map((s) => ({ ...s, hooks: s.hooks.filter((h) => !seen.has(h.command)) }))
      .filter((s) => s.hooks.length > 0);
    merged[event] = [...theirs, ...ourFiltered];
  }
  return merged;
}
