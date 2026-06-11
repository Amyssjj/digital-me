/**
 * @digital-me/runtime-claude-code
 *
 * Claude Code runtime adapter for the digital-me brain. Ships:
 *   - 5 hook scripts (UserPromptSubmit, Stop x2, PreToolUse) under
 *     packages/runtimes/claude-code/hooks/.
 *   - The `digital-me` skill bundle (skills/digital-me/SKILL.md).
 *   - A settings.json template (templates/settings.json).
 *
 * The installer (in `src/installer.ts`) is the data layer the
 * digital-me CLI uses to wire everything into `~/.claude/`. All
 * filesystem effects live in the CLI; this package is pure-data +
 * pure-merge logic so it can be unit-tested.
 */

export {
  HOOK_NAMES,
  HOOKS_DIR,
  PACKAGE_ROOT,
  SKILL_NAMES,
  SKILLS_DIR,
  TEMPLATES_DIR,
  buildClaudeHooksManifest,
  mergeHooksIntoSettings,
} from "./installer.js";
export type {
  ClaudeHookStanza,
  ClaudeHooksManifest,
  HookName,
} from "./installer.js";
export { TRANSCRIPT_SOURCE } from "./manifest.js";
