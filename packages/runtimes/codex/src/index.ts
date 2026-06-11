/**
 * @digital-me/runtime-codex
 *
 * Codex CLI runtime adapter for the digital-me brain. Ships:
 *   - CODEX.md instructions template (templates/CODEX.md).
 *   - openclaw-brain MCP server fragment (templates/openclaw-brain.mcp.toml).
 *   - Lifecycle hooks (hooks/) wired into Codex's UserPromptSubmit / Stop /
 *     PreToolUse events, plus the shared dm_m1_emit.py M1 event emitter.
 *   - Pure-data installer that merges all three into the user's ~/.codex/.
 *
 * The CLI does the disk I/O; this package owns the merge logic so the
 * digital-me-os install/update step is testable without touching live
 * files.
 */

export {
  CODEX_MD_TEMPLATE,
  DEFAULT_CODEX_HOOKS_DIR,
  HOOK_NAMES,
  HOOKS_DIR,
  MCP_TOML_TEMPLATE,
  PACKAGE_ROOT,
  SECTION_BEGIN,
  SECTION_END,
  TEMPLATES_DIR,
  buildCodexHooksManifest,
  buildCodexMcpConfig,
  mergeCodexHooksJson,
  mergeCodexMd,
  mergeMcpServer,
} from "./installer.js";
export type {
  CodexHookHandler,
  CodexHookName,
  CodexHooksManifest,
  CodexHookStanza,
  CodexMcpConfigInputs,
} from "./installer.js";
export { TRANSCRIPT_SOURCE } from "./manifest.js";
