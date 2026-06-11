/**
 * @digital-me/runtime-hermes
 *
 * Hermes Agent runtime adapter for the digital-me brain. Ships a
 * SOUL.md persona template with a digital-me protocol section, plus
 * a pure-data installer the digital-me CLI uses to merge it into
 * ~/.hermes/SOUL.md without clobbering the user's personality text.
 *
 * Hermes loads SOUL.md fresh on every message, so re-running the
 * installer takes effect immediately — no agent restart needed.
 */

export {
  PACKAGE_ROOT,
  PLUGINS_DIR,
  RECALL_PLUGIN_ENABLE_COMMAND,
  RECALL_PLUGIN_FILES,
  RECALL_PLUGIN_NAME,
  RECALL_PLUGIN_SRC_DIR,
  SECTION_BEGIN,
  SECTION_END,
  SOUL_MD_TEMPLATE,
  TEMPLATES_DIR,
  mergeSoulMd,
} from "./installer.js";
export type { RecallPluginFile } from "./installer.js";
export { TRANSCRIPT_SOURCE } from "./manifest.js";
