/**
 * Codex hook trust — keep the hooks this installer writes runnable.
 *
 * Codex only runs a `hooks.json` handler whose normalized identity hashes to
 * the `trusted_hash` recorded for it in config.toml:
 *
 *   [hooks.state."<hooks.json path>:<event>:<group>:<handler>"]
 *   trusted_hash = "sha256:…"
 *
 * Any edit to a handler (a new argv flag, a different timeout) makes the hash
 * stop matching: Codex marks the hook "modified" and silently skips it until
 * someone approves it again in Codex's hook review. That is how every Digital
 * Me hook went dark for Codex on 2026-09-27 — a reinstall appended
 * `--runtime codex` to each command, no trust was recorded, and recall plus
 * the M1 events stopped with no error anywhere.
 *
 * So the installer records trust for the handlers it writes itself — only
 * those; the user's own hooks still go through Codex's review — and
 * `digital-me doctor` reports any of ours Codex would skip.
 *
 * The hash mirrors codex-rs `hook_hash` (hooks/src/engine/discovery.rs) and
 * `version_for_toml` (config/src/fingerprint.rs): sha256 over the key-sorted
 * compact JSON of `{event_name, matcher?, hooks: [normalized handler]}`.
 * Pure functions; the CLI does the disk I/O.
 */

import { createHash } from "node:crypto";

/** Codex hook event names → the snake_case label in state keys and hashes. */
export const CODEX_HOOK_EVENT_LABELS: Readonly<Record<string, string>> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
};

/** Events whose group `matcher` Codex ignores (and so leaves out of the hash). */
const MATCHERLESS_EVENTS = new Set(["UserPromptSubmit", "Stop", "Interrupt"]);
/** Events with a short, clamped timeout (codex-rs `normalize_command_hook`). */
const SHORT_TIMEOUT_EVENTS = new Set(["SessionEnd", "Interrupt"]);
/** Events whose handlers may set `additionalContextLimit`. */
const CONTEXT_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
]);
/** codex-rs `DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT` — dropped from the hash when set to it. */
const DEFAULT_ADDITIONAL_CONTEXT_LIMIT = 2500;

/** The `hooks.json` command-handler fields that take part in the hash. */
export type CodexTrustableHandler = {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly timeout?: unknown;
  readonly async?: unknown;
  readonly statusMessage?: unknown;
  readonly additionalContextLimit?: unknown;
};

/** One handler's trust identity: its config.toml state key and current hash. */
export type CodexHookTrustEntry = {
  readonly key: string;
  readonly hash: string;
  readonly event: string;
  readonly command: string;
};

export type CodexHookTrustStatus = "trusted" | "modified" | "untrusted";

/** codex-rs `hook_key`: `<hooks.json path>:<event label>:<group>:<handler>`. */
export function codexHookStateKey(
  hooksJsonPath: string,
  eventLabel: string,
  groupIndex: number,
  handlerIndex: number,
): string {
  return `${hooksJsonPath}:${eventLabel}:${groupIndex}:${handlerIndex}`;
}

function nonNegativeInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * The hash Codex computes for one command handler, or undefined when Codex
 * would not load it as one (unknown event, non-command type, empty command).
 */
export function codexHookTrustHash(
  event: string,
  matcher: string | undefined,
  handler: CodexTrustableHandler,
): string | undefined {
  const eventLabel = CODEX_HOOK_EVENT_LABELS[event];
  if (eventLabel === undefined || handler.type !== "command") return undefined;
  const command = handler.command;
  if (typeof command !== "string" || command.trim() === "") return undefined;

  const timeout = nonNegativeInt(handler.timeout);
  const normalized: Record<string, unknown> = {
    type: "command",
    command,
    timeout: SHORT_TIMEOUT_EVENTS.has(event)
      ? Math.min(3, Math.max(1, timeout ?? 1))
      : Math.max(1, timeout ?? 600),
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === "string") normalized.statusMessage = handler.statusMessage;
  const limit = nonNegativeInt(handler.additionalContextLimit);
  if (CONTEXT_EVENTS.has(event) && limit !== undefined && limit !== DEFAULT_ADDITIONAL_CONTEXT_LIMIT) {
    normalized.additionalContextLimit = limit;
  }

  const identity: Record<string, unknown> = { event_name: eventLabel, hooks: [normalized] };
  if (matcher !== undefined && !MATCHERLESS_EVENTS.has(event)) identity.matcher = matcher;
  const digest = createHash("sha256").update(sortedJson(identity)).digest("hex");
  return `sha256:${digest}`;
}

/** Compact JSON with every object's keys sorted (serde_json `sort_all_objects`). */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const body = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson(obj[k])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/**
 * Trust identities of the handlers in a parsed `hooks.json` whose command
 * `isOurs` accepts, at their actual positions (state keys are positional).
 */
export function collectCodexHookTrust(
  hooksJson: Readonly<Record<string, unknown>>,
  hooksJsonPath: string,
  isOurs: (command: string) => boolean,
): CodexHookTrustEntry[] {
  const out: CodexHookTrustEntry[] = [];
  const events = asRecord(hooksJson.hooks);
  for (const [event, groups] of Object.entries(events)) {
    const eventLabel = CODEX_HOOK_EVENT_LABELS[event];
    if (eventLabel === undefined || !Array.isArray(groups)) continue;
    groups.forEach((group: unknown, groupIndex) => {
      const g = asRecord(group);
      const matcher = typeof g.matcher === "string" ? g.matcher : undefined;
      const handlers: unknown[] = Array.isArray(g.hooks) ? g.hooks : [];
      handlers.forEach((handler, handlerIndex) => {
        const h = asRecord(handler);
        if (typeof h.command !== "string" || !isOurs(h.command)) return;
        const hash = codexHookTrustHash(event, matcher, h);
        if (hash === undefined) return;
        out.push({
          key: codexHookStateKey(hooksJsonPath, eventLabel, groupIndex, handlerIndex),
          hash,
          event,
          command: h.command,
        });
      });
    });
  }
  return out;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// ── config.toml [hooks.state."<key>"] tables ──────────────────────────────

const STATE_HEADER_RE =
  /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/;
const TABLE_HEADER_RE = /^\s*\[/;
const TRUSTED_HASH_RE = /^\s*trusted_hash\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/** The state key a `[hooks.state."<key>"]` header line names, or undefined. */
function stateHeaderKey(line: string): string | undefined {
  const m = STATE_HEADER_RE.exec(line);
  if (!m) return undefined;
  const quoted = m[1]!;
  return quoted.startsWith("'") ? quoted.slice(1, -1) : unescapeBasic(quoted.slice(1, -1));
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, esc: string) => {
    if (esc.length > 1) return String.fromCodePoint(parseInt(esc.slice(1), 16));
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" };
    return simple[esc] ?? esc;
  });
}

/** A TOML basic string for a state key (codex-rs escapes `\` and `"`). */
function basicString(s: string): string {
  let escaped = "";
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (c === "\\" || c === '"') escaped += `\\${c}`;
    else if (code < 0x20 || code === 0x7f) escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    else escaped += c;
  }
  return `"${escaped}"`;
}

/** End (exclusive) of the table whose header sits at `headerIdx`. */
function tableEnd(lines: readonly string[], headerIdx: number): number {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (TABLE_HEADER_RE.test(lines[i]!)) return i;
  }
  return lines.length;
}

/** `trusted_hash` per state key, from the `[hooks.state."<key>"]` tables of a config.toml. */
export function readCodexHookTrust(configToml: string): Map<string, string> {
  const lines = configToml.split("\n");
  const out = new Map<string, string>();
  lines.forEach((line, idx) => {
    const key = stateHeaderKey(line);
    if (key === undefined) return;
    for (let i = idx + 1; i < tableEnd(lines, idx); i++) {
      const m = TRUSTED_HASH_RE.exec(lines[i]!);
      if (m) out.set(key, m[1] ?? m[2]!);
    }
  });
  return out;
}

/** Whether Codex would run a handler: its recorded hash vs. its current one. */
export function codexHookTrustStatus(
  entry: CodexHookTrustEntry,
  trusted: ReadonlyMap<string, string>,
): CodexHookTrustStatus {
  const recorded = trusted.get(entry.key);
  if (recorded === undefined) return "untrusted";
  return recorded === entry.hash ? "trusted" : "modified";
}

/**
 * Record `trusted_hash` for each entry in a config.toml body, idempotently.
 * An existing `[hooks.state."<key>"]` table keeps its other keys (notably a
 * user's `enabled = false`); a missing one is appended at EOF.
 *
 * Throws when a key is already spelled some other way (a dotted key or an
 * inline table inside `[hooks.state]`): appending a table header for it would
 * define the key twice, a TOML parse error that takes the whole of Codex's
 * config down. The caller reports it and leaves the file alone.
 */
export function mergeCodexHookTrust(
  configToml: string,
  entries: readonly CodexHookTrustEntry[],
): string {
  const lines = configToml.split("\n");
  const appended: string[] = [];
  for (const { key, hash } of entries) {
    const assignment = `trusted_hash = "${hash}"`;
    const headerIdx = lines.findIndex((l) => stateHeaderKey(l) === key);
    if (headerIdx < 0) {
      if (configToml.includes(basicString(key)) || configToml.includes(`'${key}'`)) {
        throw new Error(
          `mergeCodexHookTrust: hook state ${key} is set outside a [hooks.state."…"] table — ` +
            "move it to its own table and re-run",
        );
      }
      appended.push("", `[hooks.state.${basicString(key)}]`, assignment);
      continue;
    }
    const end = tableEnd(lines, headerIdx);
    const hashIdx = lines.findIndex((l, i) => i > headerIdx && i < end && TRUSTED_HASH_RE.test(l));
    if (hashIdx >= 0) lines[hashIdx] = assignment;
    else lines.splice(headerIdx + 1, 0, assignment);
  }
  if (appended.length === 0) return lines.join("\n");
  const body = lines.join("\n").replace(/\n+$/, "");
  // Each appended table starts with a blank separator line — not needed at BOF.
  return body === "" ? `${appended.slice(1).join("\n")}\n` : `${body}\n${appended.join("\n")}\n`;
}
