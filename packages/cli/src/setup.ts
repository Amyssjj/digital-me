/**
 * `digital-me setup` — orchestrated install. Detects which CLIs are
 * present on disk, asks the user (or accepts non-interactive flags),
 * installs the matching runtime adapters, and writes a starter config
 * with sensible cli_exec_alias entries.
 *
 * Pure data layer: every effect (fs read/write, prompt I/O) is injected
 * so the orchestrator is testable without touching the live home dir.
 */

import path from "node:path";

import { TRANSCRIPT_SOURCE as CLAUDE_CODE_TRANSCRIPT_SOURCE } from "@digital-me/runtime-claude-code";
import { TRANSCRIPT_SOURCE as CODEX_TRANSCRIPT_SOURCE } from "@digital-me/runtime-codex";
import { TRANSCRIPT_SOURCE as HERMES_TRANSCRIPT_SOURCE } from "@digital-me/runtime-hermes";
import { TRANSCRIPT_SOURCE as OPENCLAW_TRANSCRIPT_SOURCE } from "@digital-me/runtime-openclaw";

export type DetectedRuntime = "claude-code" | "codex" | "hermes" | "openclaw";

export const RUNTIME_DETECTION: Readonly<
  Record<DetectedRuntime, ReadonlyArray<string>>
> = {
  "claude-code": ["$HOME/.claude"],
  codex: ["$HOME/.codex"],
  hermes: ["$HOME/.hermes"],
  openclaw: ["$HOME/.openclaw"],
};

/**
 * Where each runtime emits session transcripts. The digital-me CLI
 * writes one `sources:` entry per detected runtime into the rendered
 * starter config, so downstream consumers (digest, dashboard,
 * dream-cycle) don't have to hardcode paths.
 */
const TRANSCRIPT_SOURCES: Readonly<
  Record<DetectedRuntime, RuntimeTranscriptSource>
> = {
  "claude-code": CLAUDE_CODE_TRANSCRIPT_SOURCE,
  codex: CODEX_TRANSCRIPT_SOURCE,
  hermes: HERMES_TRANSCRIPT_SOURCE,
  openclaw: OPENCLAW_TRANSCRIPT_SOURCE,
};

export type RuntimeTranscriptSource = {
  readonly id: string;
  readonly path: string;
  readonly format: string;
  readonly glob?: string;
};

export type SetupDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dirExists: (p: string) => boolean;
};

export type DetectionReport = {
  readonly runtimes: readonly DetectedRuntime[];
  readonly skipped: readonly DetectedRuntime[];
};

/**
 * Detect which CLIs the user has installed by checking for their
 * canonical config directory (`~/.claude/`, `~/.codex/`, `~/.hermes/`).
 * This is a *signal*, not a guarantee — but a missing config dir is a
 * reliable "this CLI is not set up" indicator.
 */
export function detectInstalledRuntimes(deps: SetupDeps): DetectionReport {
  const runtimes: DetectedRuntime[] = [];
  const skipped: DetectedRuntime[] = [];
  for (const name of Object.keys(RUNTIME_DETECTION) as DetectedRuntime[]) {
    const candidates = RUNTIME_DETECTION[name];
    const found = candidates.some((c) => deps.dirExists(expand(deps.env, c)));
    if (found) runtimes.push(name);
    else skipped.push(name);
  }
  return { runtimes, skipped };
}

// ── Alias config generation ───────────────────────────────────────────────

export type AliasStanza = {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly finalMessageArg?: string;
};

export type AliasMap = Readonly<Record<string, AliasStanza>>;

/**
 * Build the default `cli_exec_aliases` map for whichever CLIs were
 * detected. The aliases match upstream task-orchestrator's behavior
 * (same flag conventions for `claude` / `codex`) so workflows that
 * declare `dispatch.agentId: "claude-code-cli"` keep working after the
 * cutover.
 *
 * Tool allowlists are intentionally conservative: every alias gets
 * Bash/Read/Write/Edit + the openclaw-brain MCP tools. Power users
 * customize via config.yaml.
 */
export function buildDefaultAliases(runtimes: readonly DetectedRuntime[]): AliasMap {
  const out: Record<string, AliasStanza> = {};
  if (runtimes.includes("claude-code")) {
    out["claude-code-cli"] = {
      binary: "claude",
      args: [
        "-p",
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        [
          "mcp__openclaw-brain__memory_search",
          "mcp__openclaw-brain__tasks",
          "mcp__openclaw-brain__traces_record",
          "Bash",
          "Read",
          "Write",
          "Edit",
        ].join(","),
        "--no-session-persistence",
        "--output-format",
        "text",
        "{{prompt}}",
      ],
      env: { OPENCLAW_AGENT_ID: "claude-code" },
      timeoutMs: 1_800_000,
    };
  }
  if (runtimes.includes("codex")) {
    out["codex-cli"] = {
      binary: "codex",
      args: [
        "-c",
        'mcp_servers.openclaw-brain.tools.memory_search.approval_mode="approve"',
        "-c",
        'mcp_servers.openclaw-brain.tools.traces_record.approval_mode="approve"',
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "{{prompt}}",
      ],
      env: { OPENCLAW_AGENT_ID: "codex" },
      timeoutMs: 1_800_000,
      finalMessageArg: "--output-last-message",
    };
  }
  return out;
}

// ── Transcript source aggregation ─────────────────────────────────────────

/**
 * Build the list of transcript sources for the detected runtimes. Each
 * runtime package self-describes its emission directory + format; this
 * function just collects those manifests, preserving the canonical
 * order of `RUNTIME_DETECTION` so the rendered config is deterministic.
 */
export function buildTranscriptSources(
  runtimes: readonly DetectedRuntime[],
): readonly RuntimeTranscriptSource[] {
  return (Object.keys(RUNTIME_DETECTION) as DetectedRuntime[])
    .filter((r) => runtimes.includes(r))
    .map((r) => TRANSCRIPT_SOURCES[r]);
}

// ── Config rendering ──────────────────────────────────────────────────────

/**
 * Render a starter config.yaml for the wiki root. Combines the
 * detected aliases with the per-runtime transcript-source manifests
 * and a sensible dream-cycle stanza.
 */
export function renderStarterConfig(opts: {
  readonly wikiRoot: string;
  readonly aliases: AliasMap;
  readonly sources?: readonly RuntimeTranscriptSource[];
}): string {
  const sources = opts.sources ?? [];
  const lines: string[] = [
    "# digital-me starter config — generated by `digital-me setup`",
    "# `sources:` was auto-populated from detected runtimes; edit if any path is off.",
    "",
    'engine: openclaw',
    "",
    "standalone:",
    "  llm_provider: gemini",
    "  llm_model: gemini-3-flash-preview",
    "  embedding_provider: gemini",
    "  embedding_model: gemini-embedding-001",
    "  api_key_env: GEMINI_API_KEY",
    "",
  ];
  if (sources.length === 0) {
    lines.push("sources: []  # populate with: { name, path, format } entries");
  } else {
    lines.push("sources:");
    for (const s of sources) {
      lines.push(`  - name: ${s.id}`);
      lines.push(`    path: ${JSON.stringify(s.path)}`);
      lines.push(`    format: ${s.format}`);
      if (s.glob !== undefined) {
        lines.push(`    glob: ${JSON.stringify(s.glob)}`);
      }
    }
  }
  lines.push(
    "",
    "dream_cycle:",
    '  schedule: "0 3 * * *"',
    "  staleness_threshold_days: 30",
    "  auto_archive: false",
    "",
  );
  if (Object.keys(opts.aliases).length > 0) {
    lines.push("# CLI-exec aliases — used by brain-orchestrator workflows that");
    lines.push("# declare dispatch.agentId. Detected CLIs were wired in automatically.");
    lines.push("cli_exec_aliases:");
    for (const [name, alias] of Object.entries(opts.aliases)) {
      lines.push(`  ${name}:`);
      lines.push(`    binary: ${JSON.stringify(alias.binary)}`);
      lines.push(`    args:`);
      for (const a of alias.args) lines.push(`      - ${JSON.stringify(a)}`);
      if (alias.env) {
        lines.push(`    env:`);
        for (const [k, v] of Object.entries(alias.env)) {
          lines.push(`      ${k}: ${JSON.stringify(v)}`);
        }
      }
      if (alias.timeoutMs !== undefined) {
        lines.push(`    timeoutMs: ${alias.timeoutMs}`);
      }
      if (alias.finalMessageArg !== undefined) {
        lines.push(`    finalMessageArg: ${JSON.stringify(alias.finalMessageArg)}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── Wiki dir scaffolding ──────────────────────────────────────────────────

export type InitWikiPlan = {
  /** Directories to create. Already-existing dirs are skipped. */
  readonly dirsToCreate: readonly string[];
  /** Files to write only if they don't exist (unless `overwrite`). */
  readonly filesToCreate: ReadonlyArray<{
    readonly path: string;
    readonly contents: string;
    /** Always rewrite, even when the file exists. For generated reference
     * files (never user-edited) that must track the shipped template. */
    readonly overwrite?: boolean;
  }>;
};

/**
 * Compute the set of dirs + files needed to initialize a fresh wiki
 * root. Pure: returns a plan; the caller does the disk writes.
 */
export function planWikiInit(opts: {
  readonly wikiRoot: string;
  readonly aliases: AliasMap;
  readonly sources?: readonly RuntimeTranscriptSource[];
}): InitWikiPlan {
  const root = opts.wikiRoot;
  return {
    dirsToCreate: [
      root,
      path.join(root, "wiki"),
      path.join(root, "inbox"),
      path.join(root, ".cache"),
    ],
    filesToCreate: [
      // Pristine reference template — always rewritten so re-running setup
      // after an upgrade refreshes it (it's the re-seeding/diffing baseline).
      {
        path: path.join(root, "config.example.yaml"),
        contents: renderStarterConfig({
          wikiRoot: root,
          aliases: opts.aliases,
          sources: opts.sources,
        }),
        overwrite: true,
      },
      // The live config. Written only if absent (the caller skips existing
      // files), so a user's edited config.yaml is never clobbered. Pre-seeded
      // so the default engine=openclaw path works with no manual copy step.
      {
        path: path.join(root, "config.yaml"),
        contents: renderStarterConfig({
          wikiRoot: root,
          aliases: opts.aliases,
          sources: opts.sources,
        }),
      },
      {
        path: path.join(root, "wiki", ".gitkeep"),
        contents: "",
      },
      {
        path: path.join(root, "inbox", ".gitkeep"),
        contents: "",
      },
    ],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function expand(
  env: Readonly<Record<string, string | undefined>>,
  s: string,
): string {
  return s
    .replace(/\$HOME/g, env.HOME ?? "$HOME")
    .replace(/\$\{HOME\}/g, env.HOME ?? "$HOME");
}
