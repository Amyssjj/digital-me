/**
 * @digital-me/agent-hooks
 *
 * The one copy of the Digital Me lifecycle hook scripts (hooks/) that both
 * the Claude Code and the Codex runtime install, plus the helpers their
 * installers use to register them with the runtime baked into the command
 * line. See src/hooks.ts.
 */

export {
  AGENT_HOOKS_DIR,
  AGENT_HOOKS_ROOT,
  CLAUDE_CODE_ONLY_HOOK_FILES,
  HOOK_RUNTIMES,
  SHARED_HOOK_FILES,
  hookCommand,
  legacyHookCommand,
  mergeHookManifest,
  runtimeArg,
} from "./hooks.js";
export type { HookRuntime, SharedHookFile } from "./hooks.js";
