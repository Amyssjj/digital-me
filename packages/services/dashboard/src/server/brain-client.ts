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
 *
 * The default factory (used by `defaultClientFactory`) reads command +
 * args from @digital-me/contracts so the brain-mcp-proxy binary location
 * is config-driven. Live wiring is done in server/index.ts.
 */

import { TtlCache } from "./cache.js";
import { extractToolResult } from "./parse.js";

// ── Minimal MCP client surface we depend on ────────────────────────────────

export type CallToolRequest = {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

export type MinimalMcpClient = {
  callTool: (req: CallToolRequest) => Promise<unknown>;
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

// ── Helpers ────────────────────────────────────────────────────────────────

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Public factory ─────────────────────────────────────────────────────────

export type BrainClient = {
  connect(): Promise<MinimalMcpClient>;
  init(): Promise<InitResult>;
  isConnected(): boolean;
  board(): Promise<BoardResult>;
  taskStatus(taskId: string): Promise<BrainTask | null>;
  workflowList(): Promise<BrainWorkflowTemplate[]>;
  scheduleList(): Promise<Array<Record<string, unknown>>>;
  tracesQuery(opts: TracesQueryOpts): Promise<TracesQueryResult>;
  wikiStatus(): Promise<BrainWikiStatus>;
};

export function createBrainClient(deps: {
  clientFactory: MinimalMcpClientFactory;
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

  async function board(): Promise<BoardResult> {
    const key = "board";
    const cached = cache.get<BoardResult>(key);
    if (cached !== null) return cached;
    const raw = (await callTool("tasks", {
      action: "board",
      format: "json",
    })) as Record<string, unknown>;
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
  };
}
