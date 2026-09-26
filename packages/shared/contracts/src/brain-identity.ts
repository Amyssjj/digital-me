/**
 * The brain's name — one vocabulary for the product's hub.
 *
 *   digital-me-brain  The brain as agents and people see it: the MCP server
 *                     every runtime registers (so tools surface as
 *                     `mcp__digital-me-brain__tasks`), and the openclaw
 *                     plugin id.
 *   brain-host        The always-on process that serves the brain (the
 *                     `@digital-me/brain-host` package, its launchd/systemd
 *                     service, the DIGITAL_ME_BRAIN_* env). A role — "the
 *                     host of the digital-me-brain" — not a second name for it.
 *
 * `openclaw-brain` was the MCP server's name while openclaw was the hub. It is
 * kept only as a legacy alias: installers remove a registration under it, and
 * readers of agent transcripts still recognise its tool names so sessions from
 * before the rename keep counting.
 */

/** MCP server name every runtime registers the brain under. */
export const BRAIN_MCP_SERVER_NAME = "digital-me-brain";

/** Earlier MCP server names — removed on install, still recognised in transcripts. */
export const LEGACY_BRAIN_MCP_SERVER_NAMES: readonly string[] = ["openclaw-brain"];

/**
 * Every fully-qualified spelling an agent transcript may use for one brain
 * tool: Claude Code keeps the server name verbatim (`mcp__digital-me-brain__x`),
 * Codex normalises hyphens to underscores (`mcp__digital_me_brain__x`), and
 * each legacy server name contributes both forms too.
 */
export function brainMcpToolNames(tool: string): string[] {
  return [BRAIN_MCP_SERVER_NAME, ...LEGACY_BRAIN_MCP_SERVER_NAMES].flatMap((server) => [
    `mcp__${server}__${tool}`,
    `mcp__${server.replace(/-/g, "_")}__${tool}`,
  ]);
}

/**
 * Rewrite references to a legacy brain server name inside one CLI argument to
 * the current name: `mcp__openclaw-brain__tasks` (Claude Code tool names),
 * `mcp__openclaw_brain__tasks` (Codex's spelling) and
 * `mcp_servers.openclaw-brain.…` (Codex `-c` overrides).
 *
 * `setup` never rewrites an existing config.yaml, so `cli_exec_aliases` saved
 * before the rename still carry the old name — and a Codex override for a
 * server that no longer exists breaks the whole `codex exec`. The alias
 * resolver passes every arg through this so those configs keep working.
 */
export function migrateLegacyBrainServerRefs(arg: string): string {
  let out = arg;
  for (const legacy of LEGACY_BRAIN_MCP_SERVER_NAMES) {
    const legacyUnderscore = legacy.replace(/-/g, "_");
    out = out
      .split(`mcp__${legacy}__`).join(`mcp__${BRAIN_MCP_SERVER_NAME}__`)
      .split(`mcp__${legacyUnderscore}__`).join(`mcp__${BRAIN_MCP_SERVER_NAME.replace(/-/g, "_")}__`)
      .split(`mcp_servers.${legacy}.`).join(`mcp_servers.${BRAIN_MCP_SERVER_NAME}.`);
  }
  return out;
}
