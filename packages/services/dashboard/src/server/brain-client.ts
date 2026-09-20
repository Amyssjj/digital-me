/**
 * Brain client — typed wrappers around the MCP brain tool surface.
 *
 * The upstream module hardcoded the path to mcp-brain-proxy.mjs and the
 * MCP client class, used module-level singletons, and started a setInterval
 * timer at import time. This rewrite:
 *
 *   - injects the underlying MCP client via a `clientFactory`, so tests
 *     can supply a fake without spawning subprocesses
 *   - encapsulates state in an object returned by `createBrainClient`,
 *     so consumers can have multiple instances (e.g. tests) without
 *     module-scope leaks
 *   - returns a Result-shaped error from `init()` instead of console.error
 *   - drops the connection when the underlying transport closes, so the
 *     next call reconnects instead of failing forever with "Not connected"
 *
 * The spawn contract for the default (stdio proxy) client lives in
 * proxy-spawn.ts; live wiring is done in brain-client.mc.ts / server.ts.
 */

import { TtlCache } from "./cache.js";
import { extractToolResult } from "./parse.js";

// ── Minimal MCP client surface we depend on ────────────────────────────────

export type CallToolRequest = {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

/**
 * The slice of @modelcontextprotocol/sdk's Client we use. `onclose` /
 * `onerror` are the SDK's Protocol hooks — assignable slots, fired when the
 * transport closes (child exit, read-buffer overflow) or errors.
 */
export type MinimalMcpClient = {
  callTool: (req: CallToolRequest) => Promise<unknown>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
};

export type MinimalMcpClientFactory = () => Promise<MinimalMcpClient>;

// ── Result types (loose — match upstream's "accept multiple naming
//    conventions" stance) ───────────────────────────────────────────────────

export type BrainGoal = Record<string, unknown> & { id: string; name: string };
export type BrainTask = Record<string, unknown> & { id: string; name: string };
export type BrainTrace = Record<string, unknown>;
export type BrainWorkflowTemplate = Record<string, unknown> & {
  id: string;
  name: string;
};
export type BrainWikiStatus = {
  totalEntries: number;
  totalConcepts: number;
  totalRaw: number;
  entriesByDomain: Record<string, number>;
  freshness: Record<string, unknown>;
  healthScore: number;
};

export type BoardResult = {
  goals: BrainGoal[];
  stats?: Record<string, unknown>;
};

export type BoardOpts = {
  /** Look-back window (days) for terminal goals; see clampBoardDays. */
  days?: number;
  /** Optional cap on goals returned (most recently updated first). */
  limit?: number;
};

export type TracesQueryOpts = {
  agentId?: string;
  goalId?: string;
  taskId?: string;
  kind?: string;
  since?: number;
  limit?: number;
};

export type TracesQueryResult = {
  traces: BrainTrace[];
  total?: number;
};

export type InitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

// ── Cache TTLs ─────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 10_000;
const WORKFLOW_TTL_MS = 30_000;
const SCHEDULE_TTL_MS = 30_000;
const TRACES_TTL_MS = 15_000;
const WIKI_TTL_MS = 60_000;

// ── Board window ───────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Largest look-back window (days) the dashboard asks the brain for, and the
 * default when a caller gives none. It equals the brain's own default board
 * window: `tasks {action:"board", format:"json"}` returns the whole window as
 * ONE MCP message (~55 MB per 7 days of every-minute workflow goals), so the
 * range selector may narrow the fetch but must never widen it — a 30-day or
 * "all time" preset would ship hundreds of MB through a stdio pipe and
 * re-create the transport overflow this module guards against. Wider views
 * need a paginated/aggregated brain API, not a bigger single message.
 */
export const BOARD_WINDOW_MAX_DAYS = 7;

/** Resolve a caller's `days` into the window actually requested: default and
 *  ceiling are BOARD_WINDOW_MAX_DAYS; negative or non-finite input (e.g. a
 *  NaN from a malformed query string) never widens the window. */
export function clampBoardDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return BOARD_WINDOW_MAX_DAYS;
  return Math.min(Math.max(days, 0), BOARD_WINDOW_MAX_DAYS);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Public factory ─────────────────────────────────────────────────────────

export type MemorySearchOpts = {
  corpus?: "wiki" | "memory" | "all";
  limit?: number;
};

export type BrainClient = {
  connect(): Promise<MinimalMcpClient>;
  init(): Promise<InitResult>;
  isConnected(): boolean;
  board(opts?: BoardOpts): Promise<BoardResult>;
  taskStatus(taskId: string): Promise<BrainTask | null>;
  workflowList(): Promise<BrainWorkflowTemplate[]>;
  scheduleList(): Promise<Array<Record<string, unknown>>>;
  tracesQuery(opts: TracesQueryOpts): Promise<TracesQueryResult>;
  wikiStatus(): Promise<BrainWikiStatus>;
  memorySearch(query: string, opts?: MemorySearchOpts): Promise<unknown>;
};

export function createBrainClient(deps: {
  clientFactory: MinimalMcpClientFactory;
  /** Optional sink for connection-lifecycle warnings (close / error). */
  warn?: (message: string) => void;
}): BrainClient {
  const cache = new TtlCache(DEFAULT_TTL_MS);
  let client: MinimalMcpClient | null = null;
  let connectPromise: Promise<MinimalMcpClient> | null = null;

  async function connect(): Promise<MinimalMcpClient> {
    if (client !== null) return client;
    if (connectPromise !== null) return connectPromise;

    const promise = deps.clientFactory();
    connectPromise = promise;
    try {
      const c = await promise;
      // Recovery path: when the transport closes (child exit, read-buffer
      // overflow) drop the singleton so the next call reconnects. Guarded so
      // a late close from a superseded client can never discard a newer one.
      c.onclose = () => {
        if (client === c) {
          client = null;
          deps.warn?.("[brain-client] connection closed; will reconnect on next call");
        }
      };
      c.onerror = (err) => {
        deps.warn?.(`[brain-client] transport error: ${err.message}`);
      };
      client = c;
      connectPromise = null;
      return c;
    } catch (err) {
      connectPromise = null;
      throw err;
    }
  }

  async function init(): Promise<InitResult> {
    try {
      await connect();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async function callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const c = await connect();
    const raw = await c.callTool({ name: toolName, arguments: args });
    return extractToolResult(raw);
  }

  async function board(opts: BoardOpts = {}): Promise<BoardResult> {
    const days = clampBoardDays(opts.days);
    const key = `board:${days}:${opts.limit ?? "all"}`;
    const cached = cache.get<BoardResult>(key);
    if (cached !== null) return cached;
    const args: Record<string, unknown> = {
      action: "board",
      format: "json",
      since: Date.now() - days * DAY_MS,
    };
    if (opts.limit !== undefined) args.limit = opts.limit;
    const raw = (await callTool("tasks", args)) as Record<string, unknown>;
    const result: BoardResult = {
      goals: asArray<BrainGoal>(raw?.goals),
      stats: (raw?.stats as Record<string, unknown> | undefined) ?? undefined,
    };
    cache.set(key, result);
    return result;
  }

  async function taskStatus(taskId: string): Promise<BrainTask | null> {
    const raw = (await callTool("tasks", {
      action: "status",
      taskId,
      format: "json",
    })) as Record<string, unknown>;
    return (raw?.task as BrainTask | null | undefined) ?? null;
  }

  async function workflowList(): Promise<BrainWorkflowTemplate[]> {
    const key = "workflow_list";
    const cached = cache.get<BrainWorkflowTemplate[]>(key);
    if (cached !== null) return cached;
    const raw = await callTool("tasks", {
      action: "workflow_list",
      format: "json",
    });
    let result: BrainWorkflowTemplate[];
    if (Array.isArray(raw)) {
      result = raw as BrainWorkflowTemplate[];
    } else if (
      typeof raw === "object" &&
      raw !== null &&
      Array.isArray((raw as Record<string, unknown>).templates)
    ) {
      result = (raw as { templates: BrainWorkflowTemplate[] }).templates;
    } else {
      result = [];
    }
    cache.set(key, result, WORKFLOW_TTL_MS);
    return result;
  }

  async function scheduleList(): Promise<Array<Record<string, unknown>>> {
    const key = "schedule_list";
    const cached = cache.get<Array<Record<string, unknown>>>(key);
    if (cached !== null) return cached;
    const raw = (await callTool("tasks", {
      action: "schedule_list",
      format: "json",
    })) as Record<string, unknown>;
    const result = asArray<Record<string, unknown>>(raw?.schedules);
    cache.set(key, result, SCHEDULE_TTL_MS);
    return result;
  }

  async function tracesQuery(
    opts: TracesQueryOpts,
  ): Promise<TracesQueryResult> {
    const key = `traces:${JSON.stringify(opts)}`;
    const cached = cache.get<TracesQueryResult>(key);
    if (cached !== null) return cached;

    const args: Record<string, unknown> = {};
    if (opts.agentId !== undefined) args.agent_id = opts.agentId;
    if (opts.goalId !== undefined) args.goal_id = opts.goalId;
    if (opts.taskId !== undefined) args.task_id = opts.taskId;
    if (opts.kind !== undefined) args.kind = opts.kind;
    if (opts.since !== undefined) args.since = opts.since;
    if (opts.limit !== undefined) args.limit = opts.limit;

    const raw = (await callTool("traces_query", args)) as Record<
      string,
      unknown
    >;
    const result: TracesQueryResult = {
      traces: asArray<BrainTrace>(raw?.traces),
      total: typeof raw?.total === "number" ? raw.total : undefined,
    };
    cache.set(key, result, TRACES_TTL_MS);
    return result;
  }

  async function wikiStatus(): Promise<BrainWikiStatus> {
    const key = "wiki:status";
    const cached = cache.get<BrainWikiStatus>(key);
    if (cached !== null) return cached;
    const raw = (await callTool("wiki", { action: "status" })) as Record<
      string,
      unknown
    >;
    const totalEntries =
      typeof raw?.totalEntries === "number"
        ? raw.totalEntries
        : typeof raw?.totalConcepts === "number"
          ? raw.totalConcepts
          : 0;
    const result: BrainWikiStatus = {
      totalEntries,
      totalConcepts:
        typeof raw?.totalConcepts === "number" ? raw.totalConcepts : 0,
      totalRaw: typeof raw?.totalRaw === "number" ? raw.totalRaw : 0,
      entriesByDomain:
        (raw?.entriesByDomain as Record<string, number> | undefined) ??
        (raw?.byDomain as Record<string, number> | undefined) ??
        {},
      freshness:
        (raw?.freshness as Record<string, unknown> | undefined) ?? {},
      healthScore: typeof raw?.healthScore === "number" ? raw.healthScore : 0,
    };
    cache.set(key, result, WIKI_TTL_MS);
    return result;
  }

  /** Ranked knowledge search. Returns the tool's raw (parsed) payload —
   *  shaping lives in search.ts so the router owns one normalizer. Uncached:
   *  searches are user-initiated, not polled. */
  async function memorySearch(
    query: string,
    opts: MemorySearchOpts = {},
  ): Promise<unknown> {
    return callTool("memory_search", {
      query,
      corpus: opts.corpus ?? "all",
      limit: opts.limit ?? 20,
    });
  }

  return {
    connect,
    init,
    isConnected: () => client !== null,
    board,
    taskStatus,
    workflowList,
    scheduleList,
    tracesQuery,
    wikiStatus,
    memorySearch,
  };
}
