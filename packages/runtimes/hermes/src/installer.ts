/**
 * Hermes Agent runtime installer — pure data layer used by the digital-me
 * CLI to install the SOUL.md template into ~/.hermes/.
 *
 * Hermes loads SOUL.md fresh on every message so no restart is needed.
 * The bundled template carries a digital-me protocol section bracketed
 * by BEGIN/END markers; on re-install, only that span is replaced —
 * the user's personality text outside the markers is preserved.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const TEMPLATES_DIR = path.join(PACKAGE_ROOT, "templates");
export const SOUL_MD_TEMPLATE = path.join(TEMPLATES_DIR, "SOUL.md");

// 2026-05-22: Hermes Python plugin shipped alongside SOUL.md. Mirrors
// the digital-me-recall plugin we ship for OpenClaw native agents and
// the dm_application_rate.sh Stop hook for Claude Code. Provides:
//   - pre_llm_call recall injection (M1 hygiene)
//   - pre_tool_call route reminders (stub today)
//   - post_tool_call tool-call observability for application_rate
//   - on_session_end M1 live writer to ~/.openclaw/data/application_rate_hermes.log
// Hermes plugins are explicit-opt-in: after install, the user runs
//   hermes plugins enable digital-me-recall-hermes
// to activate it. The installer reports the command in its summary.
export const PLUGINS_DIR = path.join(PACKAGE_ROOT, "plugins");
export const RECALL_PLUGIN_NAME = "digital-me-recall-hermes";
export const RECALL_PLUGIN_SRC_DIR = path.join(PLUGINS_DIR, RECALL_PLUGIN_NAME);

/**
 * Files within the recall plugin dir that the installer copies into
 * `$HERMES_HOME/plugins/digital-me-recall-hermes/` (or wherever the
 * caller specifies as the target). Pure constant — the actual file
 * copy is done by the CLI's installer.
 */
export const RECALL_PLUGIN_FILES = [
  "plugin.yaml",
  "__init__.py",
] as const;

export type RecallPluginFile = (typeof RECALL_PLUGIN_FILES)[number];

/**
 * The `hermes plugins enable` command the user should run post-install
 * to activate the recall plugin (Hermes plugins are explicit-opt-in by
 * design). Reported in the install summary so users know the next step.
 */
export const RECALL_PLUGIN_ENABLE_COMMAND =
  `hermes plugins enable ${RECALL_PLUGIN_NAME}`;

export const SECTION_BEGIN =
  "<!-- BEGIN digital-me auto-generated section — DO NOT EDIT MANUALLY -->";
export const SECTION_END =
  "<!-- END digital-me auto-generated section -->";

/**
 * Merge a digital-me protocol section into an existing SOUL.md body.
 * The merge logic matches the codex installer's mergeCodexMd, modulo the
 * file-specific marker text: only the BEGIN..END span is updated.
 */
export function mergeSoulMd(
  existing: string,
  newManagedSection: string,
): string {
  const wrapped = `${SECTION_BEGIN}\n${newManagedSection.trim()}\n${SECTION_END}`;
  const beginIdx = existing.indexOf(SECTION_BEGIN);
  const endIdx = existing.indexOf(SECTION_END);
  if (
    (beginIdx >= 0 && endIdx < 0) ||
    (beginIdx < 0 && endIdx >= 0) ||
    (beginIdx >= 0 && endIdx >= 0 && endIdx < beginIdx)
  ) {
    throw new Error(
      "Cannot merge SOUL.md: malformed digital-me managed section markers.",
    );
  }
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + SECTION_END.length);
    return `${before}${wrapped}${after}`;
  }
  if (existing.length === 0) return `${wrapped}\n`;
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${wrapped}\n`;
}
