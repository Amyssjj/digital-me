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

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  AGENT_HOOKS_DIR,
  SHARED_HOOK_FILES,
  hookCommand,
  mergeHookManifest,
} from "@digital-me/agent-hooks";

const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Workspace layout: this module compiles to <pkg>/dist/*.js, so MODULE_ROOT
// is the package root, which carries templates/ directly. Published CLI
// bundle: esbuild inlines every workspace module into <npm-pkg>/bin/*.js, so
// MODULE_ROOT is the npm package root for EVERY package — per-package assets
// are staged by scripts/build-cli-bundle.mjs under assets/codex/ to
// avoid cross-package collisions.
export const PACKAGE_ROOT = existsSync(path.join(MODULE_ROOT, "templates"))
  ? MODULE_ROOT
  : path.join(MODULE_ROOT, "assets", "codex");

export const TEMPLATES_DIR = path.join(PACKAGE_ROOT, "templates");
/**
 * Source of the hook scripts: the shared @digital-me/agent-hooks package —
 * the SAME files the Claude Code runtime installs. Codex hooks are
 * I/O-compatible with Claude Code's (same stdin JSON, same
 * `hookSpecificOutput` / `decision` stdout); the few genuine differences
 * (runtime home, /tmp state names, M1 runtime label + WAL, rollout transcript
 * format) are selected by the `--runtime codex` baked into each command.
 * See https://developers.openai.com/codex/hooks.
 */
export const HOOKS_DIR = AGENT_HOOKS_DIR;
export const CODEX_MD_TEMPLATE = path.join(TEMPLATES_DIR, "CODEX.md");
export const MCP_TOML_TEMPLATE = path.join(
  TEMPLATES_DIR,
  "openclaw-brain.mcp.toml",
);

/**
 * Files installed into ~/.codex/hooks/. The first five are wired into Codex
 * hook events (UserPromptSubmit / Stop ×3 / PreToolUse) via
 * `~/.codex/hooks.json`; `dm_m1_emit.py` is the M1 event emitter called as a
 * subprocess by the inject + stop hooks and `dm_hook_lib.sh` the runtime
 * resolution every hook sources (neither is a hook itself, both are
 * installed alongside so the codex install path is self-contained).
 */
export const HOOK_NAMES = SHARED_HOOK_FILES;

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
  // Strip any markers the incoming section already carries before wrapping.
  // The shipped CODEX.md template contains its own BEGIN/END pair (lines 11
  // and 132), so wrapping it verbatim nests a section inside a section on
  // EVERY install. Identical root cause to hermes' SOUL.md.
  const bare = newManagedSection
    .split("\n")
    .filter((l) => l.trim() !== SECTION_BEGIN && l.trim() !== SECTION_END)
    .join("\n")
    .trim();
  const wrapped = `${SECTION_BEGIN}\n${bare}\n${SECTION_END}`;
  const beginIdx = existing.indexOf(SECTION_BEGIN);
  // LAST end marker, not the first: with `indexOf`, every marker after the
  // first one landed in `after` and survived each merge, so damage
  // accumulated instead of being replaced. The live CODEX.md had reached
  // 2 BEGIN / 9 END markers this way (2026-09-01) — the hermes fix was
  // applied and this twin was missed, caught in maintainer review.
  // Spanning to the last marker makes a damaged file self-heal on the next
  // install.
  const endIdx = existing.lastIndexOf(SECTION_END);
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

/** Keys a fragment declares INLINE (`key = ...`) directly under its header. */
export function inlineKeysOf(fragment: string): string[] {
  const keys: string[] = [];
  let seenHeader = false;
  for (const raw of fragment.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      if (seenHeader) break; // a nested/next table ends the inline region
      seenHeader = true;
      continue;
    }
    if (!seenHeader) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

/**
 * Remove `[<header-body>.<key>]` sub-tables for each key in `inlineKeys`,
 * along with the lines they own (up to the next table header).
 *
 * `header` arrives as `[mcp_servers.<name>]`; the sub-table to strip is
 * therefore `[mcp_servers.<name>.<key>]`.
 */
export function stripDuplicatedSubTables(
  lines: readonly string[],
  header: string,
  inlineKeys: readonly string[],
): string[] {
  if (inlineKeys.length === 0) return [...lines];
  const base = header.trim().slice(1, -1); // "mcp_servers.<name>"
  const targets = new Set(inlineKeys.map((k) => `[${base}.${k}]`));
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    const isHeader = t.startsWith("[") && t.endsWith("]");
    if (isHeader) skipping = targets.has(t);
    if (!skipping) out.push(line);
  }
  return out;
}

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
  // Drop any sub-table that re-declares a key our fragment sets INLINE.
  //
  // TOML forbids defining a key both ways, and it is a WHOLE-FILE error: the
  // parser aborts and every other server in config.toml disappears with it.
  // Codex writes `env` as a sub-table (`[mcp_servers.<name>.env]`) while this
  // fragment writes it inline, and the block-replacement above stops at the
  // next `[...]` header — which IS that sub-table — so it survived and
  // collided. Observed 2026-09-01: re-installing the codex runtime made the
  // entire config unparseable, taking all six MCP servers down, not just ours.
  //
  // Only sub-tables we would actually duplicate are removed; anything else
  // under the same server (notably `[mcp_servers.<name>.tools.*]`, which holds
  // per-tool approval settings the operator or codex owns) is preserved.
  const after = stripDuplicatedSubTables(
    lines.slice(endIdx),
    header,
    inlineKeysOf(fragment),
  ).join("\n");
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
 * Every command is `<hooksDir>/<script> --runtime codex`: the scripts are
 * shared with Claude Code and read the runtime from their argv.
 *
 * Event mapping (parity with the Claude Code runtime):
 *   - UserPromptSubmit → dm_memory_search_inject.sh   (surface + M1 session_start/knowledge_surfaced)
 *   - Stop             → dm_handoff_reminder.sh        (handoff nudge)
 *                        dm_session_extract.sh         (skinny audit log)
 *                        dm_application_rate.sh        (M1 assistant_ack + session_end)
 *   - PreToolUse       → brain_route_inject.sh         (brain-MCP protocol injection)
 *
 * Timeouts:
 *   - memory_search inject: 12s to match the hook script's curl default
 *     (DIGITAL_ME_HOOK_TIMEOUT_SECS:-12). A shorter manifest timeout kills
 *     the hook before curl finishes, making slow searches look like empty injects.
 */
export function buildCodexHooksManifest(
  hooksDir: string = DEFAULT_CODEX_HOOKS_DIR,
): CodexHooksManifest {
  const cmd = (name: CodexHookName) => hookCommand(`${hooksDir}/${name}`, "codex");
  return {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: cmd("dm_memory_search_inject.sh"),
            timeout: 12,
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
 * idempotent; a command an older installer registered without `--runtime`
 * is upgraded in place (never duplicated). Pure function — the installer
 * does the disk I/O.
 */
export function mergeCodexHooksJson(
  existing: Record<string, unknown>,
  hooksDir: string = DEFAULT_CODEX_HOOKS_DIR,
): Record<string, unknown> {
  const existingHooks =
    (existing.hooks as Record<string, CodexHookStanza[]> | undefined) ?? {};
  return {
    ...existing,
    hooks: mergeHookManifest(existingHooks, buildCodexHooksManifest(hooksDir)),
  };
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
  /**
   * digital-me brain-host `/tools/invoke` URL. Emitted as DIGITAL_ME_BRAIN_URL
   * in the proxy's env so the proxy Codex spawns talks to brain-host instead
   * of the openclaw gateway (brain-mcp-proxy/config.ts honours it). Must be
   * paired with `brainTokenFile`; Codex does not forward the parent shell env
   * to MCP servers, so the pair has to live in config.toml.
   */
  brainUrl?: string;
  /**
   * PATH of the file holding the bearer token for `brainUrl`, emitted as
   * DIGITAL_ME_BRAIN_TOKEN_FILE. The secret itself never lands in
   * config.toml — the proxy reads the file (mode 600) at start-up.
   */
  brainTokenFile?: string;
}

const nonEmpty = (value: string | undefined): boolean =>
  value !== undefined && value !== "";

export function buildCodexMcpConfig(inputs: CodexMcpConfigInputs): string {
  const agentId = inputs.agentId ?? "codex";
  const { brainUrl, brainTokenFile } = inputs;
  const hasBrain = nonEmpty(brainUrl);
  if (hasBrain !== nonEmpty(brainTokenFile)) {
    // Same rule as the proxy: a URL with no resolvable token is a
    // configuration error, never a silent fallback to the gateway (and a
    // token file without a URL is meaningless).
    throw new Error(
      "buildCodexMcpConfig: brainUrl and brainTokenFile must be set together (DIGITAL_ME_BRAIN_URL without DIGITAL_ME_BRAIN_TOKEN_FILE is a configuration error)",
    );
  }
  const env = [
    `OPENCLAW_HOME = ${tomlString(inputs.openclawHome)}`,
    `OPENCLAW_AGENT_ID = ${tomlString(agentId)}`,
    // Both are non-empty strings here: the guard above rejected every other
    // combination, so the casts only restate what it established. A
    // DIGITAL_ME_BRAIN_TOKEN an earlier installer wrote into this stanza is
    // dropped on re-install because mergeMcpServer replaces the whole block
    // (and strips a colliding `[...env]` sub-table).
    ...(hasBrain
      ? [
          `DIGITAL_ME_BRAIN_URL = ${tomlString(brainUrl as string)}`,
          `DIGITAL_ME_BRAIN_TOKEN_FILE = ${tomlString(brainTokenFile as string)}`,
        ]
      : []),
    `PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"`,
  ];
  return [
    "[mcp_servers.openclaw-brain]",
    `command = ${tomlString(inputs.nodeBin)}`,
    `args = [${tomlString(inputs.proxyBinPath)}]`,
    `env = { ${env.join(", ")} }`,
    "",
  ].join("\n");
}

// ── Shell-tool environment ([shell_environment_policy.set]) ───────────────
//
// `[shell_environment_policy.set]` reaches the commands Codex runs through its
// shell tool — NOT hook processes. Hooks run with the Codex process's own
// environment, which has no DIGITAL_ME_BRAIN_URL (verified live 2026-09-22:
// the app-server env lacked it, so the inject hook fell back to the stopped
// openclaw gateway and silently injected nothing). The hooks
// (dm_memory_search_inject.sh, dm_m1_emit.py) read the pair from the
// `digital-me-brain.env` sidecar the installer writes next to them instead;
// this table is still written so shell commands the agent runs reach
// brain-host too. As everywhere else only the URL and the token FILE path are
// written; the secret stays on disk and every reader loads it itself.

/** The two brain-host variables (URL + token-file path); throws on half a contract. */
export function brainHookEnv(brain: {
  readonly brainUrl: string;
  readonly brainTokenFile: string;
}): Record<string, string> {
  if (brain.brainUrl.trim() === "" || brain.brainTokenFile.trim() === "") {
    throw new Error(
      "brainHookEnv: brainUrl and brainTokenFile must be set together (DIGITAL_ME_BRAIN_URL without DIGITAL_ME_BRAIN_TOKEN_FILE is a configuration error)",
    );
  }
  return {
    DIGITAL_ME_BRAIN_URL: brain.brainUrl,
    DIGITAL_ME_BRAIN_TOKEN_FILE: brain.brainTokenFile,
  };
}

export const SHELL_ENV_POLICY_HEADER = "[shell_environment_policy]";
export const SHELL_ENV_POLICY_SET_HEADER = "[shell_environment_policy.set]";

const isTableHeader = (trimmed: string): boolean =>
  trimmed.startsWith("[") && trimmed.endsWith("]");

/** `KEY = ...` at the start of a line (bare TOML keys only). */
const KEY_LINE = /^\s*([A-Za-z0-9_-]+)\s*=/;
/** `set.KEY = ...` — the dotted-key spelling inside [shell_environment_policy]. */
const DOTTED_SET_KEY = /^\s*set\.([A-Za-z0-9_-]+)\s*=/;
/** Any `set = ...` assignment inside [shell_environment_policy]. */
const SET_ASSIGN = /^\s*set\s*=/;
/** A single-line inline table: `set = { ... }` with an optional trailing comment. */
const INLINE_SET = /^(\s*set\s*=\s*)\{(.*)\}\s*(#.*)?$/;

/** Index of the line ending the table that starts at `headerIdx`: the next header, or lines.length. */
function tableEnd(lines: readonly string[], headerIdx: number): number {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (isTableHeader(lines[i]!.trim())) return i;
  }
  return lines.length;
}

/**
 * Rewrite the `key = value` lines of the table at `headerIdx` for every key in
 * `vars` (in place, keeping position and comments), then append the keys the
 * table did not have after its last non-blank line — so the blank lines that
 * separate it from the next table stay at the end.
 */
function mergeIntoTable(
  lines: readonly string[],
  headerIdx: number,
  vars: ReadonlyMap<string, string>,
  keyOf: (line: string) => string | undefined,
  render: (key: string, value: string) => string,
): string {
  const end = tableEnd(lines, headerIdx);
  const body = lines.slice(headerIdx + 1, end);
  const pending = new Map(vars);
  for (let i = 0; i < body.length; i++) {
    const key = keyOf(body[i]!);
    if (key !== undefined && pending.has(key)) {
      body[i] = render(key, pending.get(key)!);
      pending.delete(key);
    }
  }
  let insertAt = body.length;
  while (insertAt > 0 && body[insertAt - 1]!.trim() === "") insertAt--;
  body.splice(insertAt, 0, ...[...pending].map(([k, v]) => render(k, v)));
  return [...lines.slice(0, headerIdx + 1), ...body, ...lines.slice(end)].join("\n");
}

/** Split the body of a TOML inline table on top-level commas (quotes and nesting respected). */
export function splitInlineTable(body: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === "\\" && quote === '"') {
        // Keep the escaped character with its backslash (a trailing lone
        // backslash simply ends the string as-is).
        current += body[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
    } else if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") items.push(current);
  return items;
}

/** Merge `vars` into a single-line `set = { ... }` inline table, preserving the other pairs. */
function mergeInlineSet(match: RegExpExecArray, vars: ReadonlyMap<string, string>): string {
  const pending = new Map(vars);
  const pairs = splitInlineTable(match[2]!).map((item) => {
    const key = KEY_LINE.exec(item)?.[1];
    if (key !== undefined && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key} = ${tomlString(value)}`;
    }
    return item.trim();
  });
  for (const [k, v] of pending) pairs.push(`${k} = ${tomlString(v)}`);
  const comment = match[3] !== undefined ? ` ${match[3]}` : "";
  return `${match[1]}{ ${pairs.join(", ")} }${comment}`;
}

/**
 * Merge `vars` into the `shell_environment_policy.set` table of a Codex
 * config.toml body, idempotently and preserving every other key in that table
 * (and every other table). Line-based like {@link mergeMcpServer} — enough for
 * the key = "string" pairs Codex documents there, without a TOML dependency.
 *
 * TOML lets `set` be spelled four ways and defining it twice is a WHOLE-FILE
 * parse error that would take every MCP server in config.toml down with it
 * (the 2026-09-01 env sub-table incident), so each spelling is merged in
 * place rather than a second one added:
 *
 *   1. `[shell_environment_policy.set]` sub-table          → keys rewritten / appended
 *   2. `set = { ... }` inline table under the parent       → pairs rewritten / appended
 *   3. `set.KEY = ...` dotted keys under the parent        → dotted keys rewritten / appended
 *   4. `[shell_environment_policy]` present without `set`  → sub-table added right after it
 *   5. no shell_environment_policy at all                  → sub-table appended at EOF
 *
 * A multi-line inline `set = {` table (TOML 1.1) cannot be merged line-wise
 * and throws instead of risking a duplicate definition.
 */
export function mergeShellEnvPolicySet(
  existingToml: string,
  vars: Readonly<Record<string, string>>,
): string {
  const entries = new Map(Object.entries(vars));
  if (entries.size === 0) return existingToml;
  const lines = existingToml.split("\n");
  const renderBare = (k: string, v: string) => `${k} = ${tomlString(v)}`;

  // 1. Explicit sub-table.
  const setIdx = lines.findIndex((l) => l.trim() === SHELL_ENV_POLICY_SET_HEADER);
  if (setIdx >= 0) {
    return mergeIntoTable(lines, setIdx, entries, (l) => KEY_LINE.exec(l)?.[1], renderBare);
  }

  const parentIdx = lines.findIndex((l) => l.trim() === SHELL_ENV_POLICY_HEADER);
  if (parentIdx >= 0) {
    const end = tableEnd(lines, parentIdx);
    const body = lines.slice(parentIdx + 1, end);
    // 2. Inline table.
    const inlineOffset = body.findIndex((l) => SET_ASSIGN.test(l));
    if (inlineOffset >= 0) {
      const lineIdx = parentIdx + 1 + inlineOffset;
      const match = INLINE_SET.exec(lines[lineIdx]!);
      if (match === null) {
        throw new Error(
          `mergeShellEnvPolicySet: ${SHELL_ENV_POLICY_HEADER} has a multi-line \`set = {\` table (line ${lineIdx + 1}) that cannot be merged line-wise — move its keys to a [shell_environment_policy.set] table and re-run`,
        );
      }
      lines[lineIdx] = mergeInlineSet(match, entries);
      return lines.join("\n");
    }
    // 3. Dotted keys.
    if (body.some((l) => DOTTED_SET_KEY.test(l))) {
      return mergeIntoTable(
        lines,
        parentIdx,
        entries,
        (l) => DOTTED_SET_KEY.exec(l)?.[1],
        (k, v) => `set.${k} = ${tomlString(v)}`,
      );
    }
    // 4. Parent without `set`: add the sub-table right after the parent's block.
    const before = lines.slice(0, end);
    while (before.length > 0 && before[before.length - 1]!.trim() === "") before.pop();
    const after = lines.slice(end);
    const block = [SHELL_ENV_POLICY_SET_HEADER, ...[...entries].map(([k, v]) => renderBare(k, v))];
    return [...before, "", ...block, ...(after.length > 0 ? ["", ...after] : [""])].join("\n");
  }

  // 5. Nothing yet: append a fresh sub-table (same separator rules as mergeMcpServer).
  const fragment = [SHELL_ENV_POLICY_SET_HEADER, ...[...entries].map(([k, v]) => renderBare(k, v))].join("\n");
  const sep = existingToml.endsWith("\n") || existingToml.length === 0 ? "" : "\n";
  return `${existingToml}${sep}${existingToml.length > 0 ? "\n" : ""}${fragment}\n`;
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
