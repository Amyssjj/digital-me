/**
 * Hermes Agent runtime installer — pure data layer used by the digital-me
 * CLI to install the SOUL.md template into ~/.hermes/.
 *
 * Hermes loads SOUL.md fresh on every message so no restart is needed.
 * The bundled template carries a digital-me protocol section bracketed
 * by BEGIN/END markers; on re-install, only that span is replaced —
 * the user's personality text outside the markers is preserved.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Workspace layout: this module compiles to <pkg>/dist/*.js, so MODULE_ROOT
// is the package root, which carries templates/ directly. Published CLI
// bundle: esbuild inlines every workspace module into <npm-pkg>/bin/*.js, so
// MODULE_ROOT is the npm package root for EVERY package — per-package assets
// are staged by scripts/build-cli-bundle.mjs under assets/hermes/ to
// avoid cross-package collisions (e.g. claude-code and codex both ship hooks/).
export const PACKAGE_ROOT = existsSync(path.join(MODULE_ROOT, "templates"))
  ? MODULE_ROOT
  : path.join(MODULE_ROOT, "assets", "hermes");

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
 * Inputs for the `env:` map of the `openclaw-brain` MCP stanza in
 * ~/.hermes/config.yaml (written by `hermes mcp add --env KEY=VALUE ...`).
 */
export interface HermesMcpEnvInputs {
  /** OPENCLAW_HOME — the openclaw state dir the proxy reads openclaw.json from. */
  readonly openclawHome: string;
  /** OPENCLAW_AGENT_ID attribution label; defaults to "hermes". */
  readonly agentId?: string;
  /**
   * digital-me brain-host: `DIGITAL_ME_BRAIN_URL` plus the PATH of its token
   * file (`DIGITAL_ME_BRAIN_TOKEN_FILE`). Hermes does not forward the
   * installer's shell env to MCP servers, so the pair has to be baked into
   * the stanza; the secret itself never is — brain-mcp-proxy reads the file.
   * Omit to leave the proxy on the openclaw gateway.
   */
  readonly brain?: {
    readonly brainUrl: string;
    readonly brainTokenFile: string;
  };
}

/**
 * The `KEY=VALUE` pairs to pass after `--env` to `hermes mcp add`. Pure —
 * the CLI spawns the command. Throws on half a brain-host contract (a URL
 * with no token file or vice versa): every caller treats a URL with no
 * resolvable token as a hard error, never a gateway fallback, so the
 * installer must not write one.
 */
export function buildHermesMcpEnv(inputs: HermesMcpEnvInputs): string[] {
  const env = [
    `OPENCLAW_HOME=${inputs.openclawHome}`,
    `OPENCLAW_AGENT_ID=${inputs.agentId ?? "hermes"}`,
  ];
  const brain = inputs.brain;
  if (brain !== undefined) {
    if (brain.brainUrl.trim() === "" || brain.brainTokenFile.trim() === "") {
      throw new Error(
        "buildHermesMcpEnv: brainUrl and brainTokenFile must be set together (DIGITAL_ME_BRAIN_URL without DIGITAL_ME_BRAIN_TOKEN_FILE is a configuration error)",
      );
    }
    env.push(
      `DIGITAL_ME_BRAIN_URL=${brain.brainUrl}`,
      `DIGITAL_ME_BRAIN_TOKEN_FILE=${brain.brainTokenFile}`,
    );
  }
  return env;
}

/**
 * Merge a digital-me protocol section into an existing SOUL.md body.
 * The merge logic matches the codex installer's mergeCodexMd, modulo the
 * file-specific marker text: only the BEGIN..END span is updated.
 */
export function mergeSoulMd(
  existing: string,
  newManagedSection: string,
): string {
  // Strip any markers the incoming section already carries before wrapping.
  // The shipped template contains its own BEGIN/END pair, so wrapping it
  // verbatim nested one section inside another on EVERY install — which is
  // how a live SOUL.md accumulated 2 begin and 9 end markers.
  const bare = newManagedSection
    .split("\n")
    .filter((l) => l.trim() !== SECTION_BEGIN && l.trim() !== SECTION_END)
    .join("\n")
    .trim();
  const wrapped = `${SECTION_BEGIN}\n${bare}\n${SECTION_END}`;
  const beginIdx = existing.indexOf(SECTION_BEGIN);
  // LAST end marker, not the first.
  //
  // With `indexOf` here, any marker after the first one fell into `after` and
  // survived every subsequent merge — so duplicates accumulated instead of
  // being replaced. A live SOUL.md reached TWO begin markers and NINE end
  // markers this way (2026-09-01), which then tripped the malformed-section
  // guard below and would have made the next install throw outright.
  //
  // Taking the last end marker makes the replacement span cover every stray
  // marker in between, so a damaged file self-heals on the next install
  // rather than degrading further.
  const endIdx = existing.lastIndexOf(SECTION_END);
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
