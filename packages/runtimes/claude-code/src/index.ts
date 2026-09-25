/**
 * @digital-me/runtime-claude-code
 *
 * Claude Code runtime adapter for the digital-me brain. Ships:
 *   - The shared Digital Me hooks (UserPromptSubmit, Stop x3, PreToolUse)
 *     from @digital-me/agent-hooks — the same scripts the Codex runtime
 *     installs, registered here with `--runtime claude-code`.
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
  mergeBrainEnvIntoSettings,
  mergeHooksIntoSettings,
} from "./installer.js";
export type {
  BrainHostEnv,
  ClaudeHookStanza,
  ClaudeHooksManifest,
  HookName,
} from "./installer.js";
export { TRANSCRIPT_SOURCE } from "./manifest.js";
