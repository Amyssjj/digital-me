/**
 * The brain sidecar: `digital-me-brain.env`, written by `digital-me install`
 * next to the hook scripts (`~/.claude/hooks`, `~/.codex/hooks`) and into the
 * Hermes recall plugin dir, so a hook finds brain-host even when its host
 * never passes DIGITAL_ME_BRAIN_URL to it.
 *
 * An env var only reaches a hook if the host forwards it. Claude Code exports
 * settings.json `env` to its hooks; Codex does not apply
 * `[shell_environment_policy.set]` to hook processes, and the Hermes gateway
 * process never sees the MCP stanza's `env:`. Without this file those hooks
 * fell back to the (stopped) openclaw gateway and injected nothing.
 *
 * One contract, mirrored by the readers (the claude-code / codex
 * `dm_memory_search_inject.sh` + `dm_m1_emit.py`, the Hermes recall plugin):
 *
 *   - `KEY=VALUE` lines; only DIGITAL_ME_BRAIN_URL and
 *     DIGITAL_ME_BRAIN_TOKEN_FILE are honoured
 *   - parsed line by line, never sourced: blank lines, `#` comments and
 *     unknown keys are ignored, one pair of surrounding quotes is stripped,
 *     and a missing or unreadable file changes nothing
 *   - read only while DIGITAL_ME_BRAIN_URL is unset in the process env, and
 *     each key only fills in what the env leaves unset (explicit env wins)
 *   - it beats OPENCLAW_GATEWAY_* and openclaw.json: it records the
 *     installer's decision that brain-host is the brain
 *   - the URL and the token-file PATH only — never the bearer token
 */

/** File name every reader looks for next to itself. */
export const BRAIN_SIDECAR_FILE = "digital-me-brain.env";

export interface BrainSidecarValues {
  /** The brain-host `/tools/invoke` URL (DIGITAL_ME_BRAIN_URL). */
  readonly brainUrl: string;
  /** Path of the file holding its bearer token (DIGITAL_ME_BRAIN_TOKEN_FILE). */
  readonly brainTokenFile: string;
}

/**
 * The sidecar's contents: a comment header plus exactly the two `KEY=VALUE`
 * lines. Throws on an empty value (every reader treats a URL with no
 * resolvable token as a hard error, so half a contract is never written) and
 * on a line break inside a value, which would smuggle in an extra line.
 */
export function renderBrainSidecar(values: BrainSidecarValues): string {
  const { brainUrl, brainTokenFile } = values;
  if (brainUrl.trim() === "" || brainTokenFile.trim() === "") {
    throw new Error(
      "renderBrainSidecar: brainUrl and brainTokenFile must be set together (DIGITAL_ME_BRAIN_URL without DIGITAL_ME_BRAIN_TOKEN_FILE is a configuration error)",
    );
  }
  if (/[\r\n]/.test(brainUrl) || /[\r\n]/.test(brainTokenFile)) {
    throw new Error("renderBrainSidecar: values must be single-line (a line break would add a line to the sidecar)");
  }
  return [
    "# Written by `digital-me install` — brain endpoint for the Digital Me hooks.",
    "# The hooks (and the Hermes recall plugin) next to this file read it when",
    "# DIGITAL_ME_BRAIN_URL is not in their environment, because some hosts",
    "# never pass it to hook processes; an exported value always wins. It holds",
    "# the URL and the token-file path only — never the token. Re-run the",
    "# install to change it; it is removed when brain-host is not configured.",
    `DIGITAL_ME_BRAIN_URL=${brainUrl}`,
    `DIGITAL_ME_BRAIN_TOKEN_FILE=${brainTokenFile}`,
    "",
  ].join("\n");
}
