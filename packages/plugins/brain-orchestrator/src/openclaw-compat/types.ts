/**
 * Narrow TypeScript types describing the openclaw plugin SDK surface that
 * brain-orchestrator depends on. These mirror upstream shape but live in our
 * package so the rest of the plugin type-checks without importing from
 * `openclaw/*` directly.
 *
 * If upstream changes a field name, we update it here in one place and the
 * rest of the codebase continues to compile.
 *
 * The types here are intentionally minimal — we declare only what we actually
 * use, not the full upstream surface.
 */

// ── Plugin runtime ─────────────────────────────────────────────────────────

/** Result of an exec-mode run. */
export type ExecRunResult = {
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

export type SubagentRunArgs = {
  readonly sessionKey: string;
  readonly message: string;
  readonly model?: string;
  readonly extraSystemPrompt?: string;
  readonly deliver?: boolean;
  readonly idempotencyKey?: string;
  readonly channel?: string;
  readonly accountId?: string;
  readonly threadId?: string;
  readonly agentId?: string;
};

export type ExecRunArgs = {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

export type OpenClawRuntime = {
  readonly log: (
    level: "info" | "warn" | "error" | "debug",
    message: string,
  ) => void;
  readonly subagent: {
    readonly run: (args: SubagentRunArgs) => Promise<{ runId: string }>;
    readonly getSessionMessages?: (args: {
      sessionKey: string;
      limit?: number;
    }) => Promise<{ messages: readonly unknown[] }>;
  };
  readonly subagentRun?: (args: SubagentRunArgs) => Promise<{ runId: string }>;
  readonly subagentGetSessionMessages?: (args: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages: readonly unknown[] }>;
  readonly execRun?: (args: ExecRunArgs) => Promise<ExecRunResult>;
  readonly requestHeartbeatNow?: () => void;
  readonly resolveGuidance?: (
    refs: readonly string[],
  ) => Promise<readonly string[]>;
};

// ── Plugin API ─────────────────────────────────────────────────────────────

export type ToolHandler = (
  args: Readonly<Record<string, unknown>>,
) => Promise<unknown> | unknown;

export type CommandHandler = (
  args: readonly string[],
) => Promise<unknown> | unknown;

export type OpenClawApi = {
  readonly runtime?: OpenClawRuntime;
  readonly pluginConfig?: Readonly<Record<string, unknown>>;
  readonly logger: {
    readonly info: (message: string) => void;
    readonly warn: (message: string) => void;
    readonly error: (message: string) => void;
    readonly debug?: (message: string) => void;
  };
  readonly resolvePath: (input: string) => string;
  readonly registerTool: (name: string, handler: ToolHandler) => void;
  readonly registerCommand?: (name: string, handler: CommandHandler) => void;
  readonly on?: (event: string, handler: (payload: unknown) => void) => void;
};

// ── Plugin entry ───────────────────────────────────────────────────────────

export type PluginEntryDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly register: (api: OpenClawApi) => void;
};
