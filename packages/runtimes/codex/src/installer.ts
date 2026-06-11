/**
 * Codex CLI runtime installer — pure data layer used by the digital-me CLI
 * to wire CODEX.md + the openclaw-brain MCP server into ~/.codex/.
 *
 * The bundled CODEX.md ships an auto-generated section bracketed by
 *   <!-- BEGIN digital-me auto-generated section — DO NOT EDIT MANUALLY -->
 *   <!-- END digital-me auto-generated section -->
 * markers. The installer replaces JUST that span on re-install so the
 * user's hand-edits outside the span are preserved.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const TEMPLATES_DIR = path.join(PACKAGE_ROOT, "templates");
export const HOOKS_DIR = path.join(PACKAGE_ROOT, "hooks");
export const CODEX_MD_TEMPLATE = path.join(TEMPLATES_DIR, "CODEX.md");
export const MCP_TOML_TEMPLATE = path.join(
  TEMPLATES_DIR,
  "openclaw-brain.mcp.toml",
);

/**
 * Codex lifecycle hooks this runtime ships. The first five are wired into
 * Codex hook events (UserPromptSubmit / Stop ×3 / PreToolUse) via
 * `~/.codex/hooks.json`; `dm_m1_emit.py` is the shared M1 event emitter
 * called as a subprocess by the inject + stop hooks (not a hook itself,
 * but installed alongside them so the codex install path is self-contained).
 *
 * Codex hooks are I/O-compatible with Claude Code's (same stdin JSON, same
 * `hookSpecificOutput` / `decision` stdout), so these are adapted ports of
 * the Claude Code hooks. See https://developers.openai.com/codex/hooks.
 */
export const HOOK_NAMES = [
  "dm_memory_search_inject.sh",
  "brain_route_inject.sh",
  "dm_handoff_reminder.sh",
  "dm_session_extract.sh",
  "dm_application_rate.sh",
  "dm_m1_emit.py",
] as const;

export type CodexHookName = (typeof HOOK_NAMES)[number];

export const SECTION_BEGIN =
  "<!-- BEGIN digital-me auto-generated section — DO NOT EDIT MANUALLY -->";
export const SECTION_END =
  "<!-- END digital-me auto-generated section -->";

/**
 * Replace (or insert) the digital-me auto-generated section inside an
 * existing CODEX.md body. Idempotent: the BEGIN/END markers fence the
 * managed span, user content outside is preserved.
 *
 * - If both markers are found, the content between them is replaced.
 * - If only BEGIN exists (malformed), the existing tail is left and a
 *   new managed section is appended at the bottom.
 * - If neither marker exists, the new managed section is appended at the
 *   bottom (with a leading newline if the file isn't empty).
 */
export function mergeCodexMd(
  existing: string,
  newManagedSection: string,
): string {
  const wrapped = `${SECTION_BEGIN}\n${newManagedSection.trim()}\n${SECTION_END}`;
  const beginIdx = existing.indexOf(SECTION_BEGIN);
  const endIdx = existing.indexOf(SECTION_END);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    // Replace the existing managed span (inclusive of both markers).
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + SECTION_END.length);
    return `${before}${wrapped}${after}`;
  }
  if (existing.length === 0) return `${wrapped}\n`;
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${wrapped}\n`;
}

/**
 * Merge an MCP-server TOML fragment into an existing config.toml body.
 * Looks for `[mcp_servers.<name>]` headers — if the target header
 * exists, replace its block; otherwise append the fragment.
 *
 * This is a *line-based* merge, not a real TOML parse — sufficient for
 * the simple key=value MCP-server stanzas we ship, and avoids pulling
 * in a TOML parser dependency.
 */
export function mergeMcpServer(
  existingToml: string,
  fragment: string,
): string {
  const header = extractMcpHeader(fragment);
  if (!header) return existingToml; // nothing to merge
  const lines = existingToml.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === header);
  if (headerIdx < 0) {
    // Header not found — append the fragment at the end.
    const sep = existingToml.endsWith("\n") || existingToml.length === 0 ? "" : "\n";
    return `${existingToml}${sep}${existingToml.length > 0 ? "\n" : ""}${fragment.trim()}\n`;
  }
  // Find the end of the existing block: the next `[...]` header OR EOF.
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.startsWith("[") && t.endsWith("]")) {
      endIdx = i;
      break;
    }
  }
  const before = lines.slice(0, headerIdx).join("\n");
  const after = lines.slice(endIdx).join("\n");
  const beforeSep = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  const afterSep = after.length > 0 ? "\n" : "";
  return `${before}${beforeSep}${fragment.trim()}\n${afterSep}${after}`;
}

function extractMcpHeader(fragment: string): string | undefined {
  const m = fragment.match(/\[mcp_servers\.[^\]]+\]/);
  return m ? m[0] : undefined;
}

// ── Hooks (hooks.json) ─────────────────────────────────────────────────────

/**
 * One Codex hook handler. Mirrors the Codex `hooks.json` schema documented
 * at https://developers.openai.com/codex/hooks. `type` is always "command"
 * (the only handler kind Codex executes today). `async` is intentionally
 * NOT emitted: Codex parses but does not yet honour it, so our Stop hooks
 * run synchronously and rely on tight `timeout`s instead.
 */
export type CodexHookHandler = {
  readonly type: "command";
  readonly command: string;
  readonly timeout?: number;
  readonly statusMessage?: string;
};

/** A matcher group: optional `matcher` regex + the handlers it triggers. */
export type CodexHookStanza = {
  readonly matcher?: string;
  readonly hooks: ReadonlyArray<CodexHookHandler>;
};

export type CodexHooksManifest = {
  readonly UserPromptSubmit: readonly CodexHookStanza[];
  readonly Stop: readonly CodexHookStanza[];
  readonly PreToolUse: readonly CodexHookStanza[];
};

/**
 * The default install location of the codex hook scripts. `hooks.json`
 * commands must be runnable paths; Codex does not document shell-style
 * `$HOME` expansion, so the installer resolves an absolute directory and
 * passes it in. This default is here only for test readability.
 */
export const DEFAULT_CODEX_HOOKS_DIR = "$HOME/.codex/hooks";

/**
 * Build the Codex hooks manifest to write into `~/.codex/hooks.json`.
 *
 * @param hooksDir absolute path to the installed hooks directory
 *   (e.g. `<home>/.codex/hooks`). The installer passes the resolved
 *   home path so the command entries don't depend on env expansion.
 *
 * Event mapping (parity with the Claude Code runtime):
 *   - UserPromptSubmit → dm_memory_search_inject.sh   (surface + M1 session_start/knowledge_surfaced)
 *   - Stop             → dm_handoff_reminder.sh        (handoff nudge)
 *                        dm_session_extract.sh         (skinny audit log)
 *                        dm_application_rate.sh        (M1 assistant_ack + session_end)
 *   - PreToolUse       → brain_route_inject.sh         (brain-MCP protocol injection)
 */
export function buildCodexHooksManifest(
  hooksDir: string = DEFAULT_CODEX_HOOKS_DIR,
): CodexHooksManifest {
  const cmd = (name: CodexHookName) => `${hooksDir}/${name}`;
  return {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: cmd("dm_memory_search_inject.sh"),
            timeout: 8,
            statusMessage: "Digital Me: searching brain…",
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: cmd("dm_handoff_reminder.sh"),
            timeout: 5,
          },
          {
            type: "command",
            command: cmd("dm_session_extract.sh"),
            timeout: 5,
          },
          {
            // M1 application-rate live writer: appends one JSONL record per
            // session to ~/.codex/hooks/application_rate.log on Stop, and
            // emits the canonical assistant_ack + session_end M1 events.
            type: "command",
            command: cmd("dm_application_rate.sh"),
            timeout: 10,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        // Match all tools — the script does its own tool-name filtering
        // (brain tasks tool + Bash/exec_command sqlite writes).
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: cmd("brain_route_inject.sh"),
            timeout: 3,
          },
        ],
      },
    ],
  };
}

/**
 * Merge our hook stanzas into an existing `hooks.json` object (the parsed
 * contents of `~/.codex/hooks.json`). Preserves the user's other hooks and
 * top-level keys. De-dupes by command string so re-running the installer is
 * idempotent. Pure function — the installer does the disk I/O.
 */
export function mergeCodexHooksJson(
  existing: Record<string, unknown>,
  hooksDir: string = DEFAULT_CODEX_HOOKS_DIR,
): Record<string, unknown> {
  const manifest = buildCodexHooksManifest(hooksDir);
  const existingHooks =
    (existing.hooks as Record<string, CodexHookStanza[]> | undefined) ?? {};
  const mergedHooks: Record<string, CodexHookStanza[]> = { ...existingHooks };
  for (const event of Object.keys(manifest) as Array<keyof CodexHooksManifest>) {
    const ours = manifest[event];
    const theirs = mergedHooks[event] ?? [];
    const seen = new Set<string>();
    for (const stanza of theirs) {
      for (const h of stanza.hooks) seen.add(h.command);
    }
    const ourFiltered = ours
      .map((s) => ({
        ...s,
        hooks: s.hooks.filter((h) => !seen.has(h.command)),
      }))
      .filter((s) => s.hooks.length > 0);
    mergedHooks[event] = [...theirs, ...ourFiltered];
  }
  return { ...existing, hooks: mergedHooks };
}

/**
 * Build the `[mcp_servers.openclaw-brain]` TOML stanza pointing at the
 * digital-me-os brain-mcp-proxy bin, with proper env vars.
 *
 * Generated rather than templated because the proxy bin's absolute path
 * is resolved at install time — different per user (workspace vs. global
 * npm install vs. wherever digital-me-os got cloned).
 *
 * Output is idempotent-friendly: `mergeMcpServer` will swap an existing
 * `[mcp_servers.openclaw-brain]` block in place.
 */
export interface CodexMcpConfigInputs {
  /** Absolute path to /node OR a recognized Node binary launcher. */
  nodeBin: string;
  /** Absolute path to brain-mcp-proxy's bin/brain-mcp-proxy.mjs */
  proxyBinPath: string;
  /** Absolute path to OPENCLAW_HOME (where openclaw.json lives) */
  openclawHome: string;
  /** Agent id to inject into outbound calls when caller doesn't set one. */
  agentId?: string;
}

export function buildCodexMcpConfig(inputs: CodexMcpConfigInputs): string {
  const agentId = inputs.agentId ?? "codex";
  return [
    "[mcp_servers.openclaw-brain]",
    `command = ${tomlString(inputs.nodeBin)}`,
    `args = [${tomlString(inputs.proxyBinPath)}]`,
    `env = { OPENCLAW_HOME = ${tomlString(inputs.openclawHome)}, OPENCLAW_AGENT_ID = ${tomlString(agentId)}, PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" }`,
    "",
  ].join("\n");
}

/**
 * Minimal TOML basic string escaper.
 * Our values are absolute paths and agent ids — no need for triple-quoted
 * strings or multiline. If you find yourself needing more, swap in a real
 * TOML library.
 */
function tomlString(value: string): string {
  // Intentionally matches control characters (\u0000-\u001f, \u007f) to
  // escape them for TOML output -- the whole point of this function.
  // eslint-disable-next-line no-control-regex
  const escaped = value.replace(/["\\\u0000-\u001f\u007f]/g, (char) => {
    switch (char) {
      case "\b":
        return "\\b";
      case "\t":
        return "\\t";
      case "\n":
        return "\\n";
      case "\f":
        return "\\f";
      case "\r":
        return "\\r";
      case '"':
        return '\\"';
      case "\\":
        return "\\\\";
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
  return `"${escaped}"`;
}
