/**
 * Brain API Client — connects to openclaw-brain MCP server via stdio
 * and provides typed wrappers with in-process TTL cache.
 *
 * Replaces direct SQLite reads to task-orchestrator.db for kanban,
 * traces, and wiki endpoints. System_monitor.db reads remain as
 * legacy fallback (see db.ts TODOs).
 */

import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MAX_RESULT_BYTES_ENV } from "@digital-me/brain-mcp-proxy";

// ── In-process TTL Cache ──────��───────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const DEFAULT_TTL_MS = 10_000; // 10s — dashboard polls every ~5s

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// Periodic cache cleanup (every 60s)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }
}, 60_000).unref();

// ── MCP Client Singleton ──────────────────────────────────────────

let client: Client | null = null;
let connectPromise: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    // Resolve the brain-mcp-proxy script path. Order (most-specific first):
    //   1. $BRAIN_PROXY_PATH env var — power-user override (e.g. running
    //      against a forked proxy build).
    //   2. Node module resolution against @digital-me/brain-mcp-proxy.
    //      This is the zero-config path: the dashboard package declares
    //      brain-mcp-proxy as a workspace dep, so pnpm install wires up
    //      the symlink and createRequire().resolve() finds the bin
    //      regardless of where the dashboard is launched from.
    //   3. Bare "brain-mcp-proxy.mjs" on $PATH — last-resort fallback for
    //      installs where the workspace symlink isn't reachable.
    let proxyPath: string;
    if (process.env.BRAIN_PROXY_PATH) {
      proxyPath = process.env.BRAIN_PROXY_PATH;
    } else {
      try {
        const require = createRequire(import.meta.url);
        proxyPath = require.resolve("@digital-me/brain-mcp-proxy/bin/brain-mcp-proxy.mjs");
      } catch {
        proxyPath = "brain-mcp-proxy.mjs";
      }
    }
    const nodeBin = process.env.NODE_BIN || "node";
    const transport = new StdioClientTransport({
      command: nodeBin,
      args: [proxyPath],
      // Disable the proxy's oversize-result guard for this spawn: the
      // dashboard is the one consumer that legitimately reads the full
      // board JSON (tens of MB — Kanban stats, workflow run counts), and
      // the SDK client handles it fine. Agent-facing spawns keep the cap.
      env: {
        ...process.env,
        [MAX_RESULT_BYTES_ENV]: "0",
      } as Record<string, string>,
    });

    const c = new Client(
      { name: "digital-me-dashboard", version: "2.0.0" },
      { capabilities: {} },
    );

    await c.connect(transport);
    client = c;
    connectPromise = null;
    console.log("[brain-client] Connected to openclaw-brain MCP server");
    return c;
  })();

  connectPromise.catch(() => {
    connectPromise = null;
  });

  return connectPromise;
}

// ── Generic Tool Call Helper ──────────────────────────────────────

async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const c = await getClient();
  const result = await c.callTool({ name: toolName, arguments: args });

  // MCP responses carry a content array; extract the first text entry as JSON.
  if (result.content && Array.isArray(result.content)) {
    for (const entry of result.content as Array<{ type: string; text?: string }>) {
      if (entry.type === "text" && typeof entry.text === "string") {
        try {
          return JSON.parse(entry.text);
        } catch {
          return entry.text;
        }
      }
    }
  }
  return result;
}

// ── Types (defensive — accept multiple naming conventions) ────────

export interface BrainGoal {
  id: string;
  name: string;
  description: string;
  status: string;
  type?: string;
  parent_goal_id?: string | null;
  parentGoalId?: string | null;
  source_workflow_id?: string | null;
  sourceWorkflowId?: string | null;
  source_workflow_version?: number | null;
  sourceWorkflowVersion?: number | null;
  created_at?: number | string;
  createdAt?: string;
  updated_at?: number | string;
  updatedAt?: string;
  completed_at?: number | string | null;
  completedAt?: string | null;
  created_by?: string;
  createdBy?: string;
  agent_id?: string | null;
  agentId?: string | null;
  tasks?: BrainTask[];
}

export interface BrainTask {
  id: string;
  name: string;
  task: string;
  status: string;
  priority?: string;
  blocked_by?: string[];
  blockedBy?: string[];
  attempt_count?: number;
  attemptCount?: number;
  started_at?: number | string | null;
  startedAt?: string | null;
  completed_at?: number | string | null;
  completedAt?: string | null;
  failure_reason?: string | null;
  failureReason?: string | null;
  on_upstream_failure?: string;
  onUpstreamFailure?: string;
  latest_checkpoint?: string | null;
  latestCheckpoint?: unknown;
  latest_output?: string | null;
  latestOutput?: string | null;
  dispatch?: string | { mode: string; agentId?: string };
  attempts?: BrainAttempt[];
}

export interface BrainAttempt {
  attempt_id?: string;
  attemptId?: string;
  attempt_number?: number;
  attemptNumber?: number;
  status: string;
  started_at?: number | string;
  startedAt?: string;
  ended_at?: number | string | null;
  endedAt?: string | null;
  output_summary?: string | null;
  outputSummary?: string | null;
  failure_reason?: string | null;
  failureReason?: string | null;
  artifact_paths?: string | string[];
  artifactPaths?: string[];
}

export interface BrainTrace {
  // Accept both snake_case (DB) and camelCase (API)
  trace_id?: string; traceId?: string;
  span_id?: string; spanId?: string;
  parent_span_id?: string | null; parentSpanId?: string | null;
  name?: string;
  service?: string;
  kind?: string;
  status?: string;
  agent_id?: string; agentId?: string;
  goal_id?: string; goalId?: string;
  task_id?: string; taskId?: string;
  start_time?: string; startTime?: string;
  end_time?: string | null; endTime?: string | null;
  duration_ms?: number | null; durationMs?: number | null;
  timestamp?: number;
  attributes?: string | Record<string, unknown> | null;
  events?: string | Array<unknown> | null;
  data?: unknown;
}

export interface BrainWorkflowTemplate {
  id: string;
  name: string;
  description?: string;
  version?: number;
  tags?: string | string[];
  steps?: Array<{
    step_key?: string; stepKey?: string;
    name: string;
    blocked_by_keys?: string | string[]; blockedByKeys?: string[];
    dispatch?: string | { mode: string; agentId?: string };
    sort_order?: number; sortOrder?: number;
  }>;
  // Run stats that brain may include
  latestRun?: {
    goalId: string;
    status: string;
    startedAt: string;
    completedAt?: string | null;
    taskStatuses?: Record<string, string>;
  } | null;
  totalRuns?: number;
  successRate?: number;
}

export interface BrainWikiStatus {
  totalEntries?: number;
  totalConcepts?: number;
  totalRaw?: number;
  entriesByDomain?: Record<string, number>;
  byDomain?: Record<string, number>;
  freshness?: {
    rate?: number;
    medianAgeDays?: number;
    staleCount?: number;
  };
  healthScore?: number;
  [key: string]: unknown; // allow extra fields
}

// ── Public API: Tasks ─────────────────────────────────────────────

export async function brainBoard(): Promise<{ goals: BrainGoal[]; stats?: Record<string, unknown> }> {
  const cacheKey = "brain:board";
  const cached = getCached<{ goals: BrainGoal[]; stats?: Record<string, unknown> }>(cacheKey);
  if (cached) return cached;

  const raw = (await callTool("tasks", { action: "board", format: "json" })) as Record<string, unknown>;
  const result = {
    goals: Array.isArray(raw?.goals) ? (raw.goals as BrainGoal[]) : [],
    stats: (raw?.stats as Record<string, unknown>) ?? undefined,
  };

  setCache(cacheKey, result);
  return result;
}

export async function brainTaskStatus(taskId: string): Promise<BrainTask | null> {
  const raw = (await callTool("tasks", { action: "status", taskId, format: "json" })) as Record<string, unknown>;
  return (raw?.task ?? null) as BrainTask | null;
}

export async function brainWorkflowList(): Promise<BrainWorkflowTemplate[]> {
  const cacheKey = "brain:workflow_list";
  const cached = getCached<BrainWorkflowTemplate[]>(cacheKey);
  if (cached) return cached;

  const raw = (await callTool("tasks", { action: "workflow_list", format: "json" })) as Record<string, unknown>;
  const result: BrainWorkflowTemplate[] = Array.isArray(raw?.templates)
    ? (raw.templates as BrainWorkflowTemplate[])
    : Array.isArray(raw)
      ? (raw as BrainWorkflowTemplate[])
      : [];

  setCache(cacheKey, result, 30_000); // 30s TTL
  return result;
}

export async function brainScheduleList(): Promise<Array<Record<string, unknown>>> {
  const cacheKey = "brain:schedule_list";
  const cached = getCached<Array<Record<string, unknown>>>(cacheKey);
  if (cached) return cached;

  const raw = (await callTool("tasks", { action: "schedule_list", format: "json" })) as Record<string, unknown>;
  const result = Array.isArray(raw?.schedules) ? raw.schedules as Array<Record<string, unknown>> : [];

  setCache(cacheKey, result, 30_000);
  return result;
}

// ── Public API: Traces ─────────────���──────────────────────────────

export async function brainTracesQuery(opts: {
  agentId?: string;
  goalId?: string;
  taskId?: string;
  kind?: string;
  since?: number;
  limit?: number;
}): Promise<{ traces: BrainTrace[]; total?: number }> {
  const cacheKey = `brain:traces:${JSON.stringify(opts)}`;
  const cached = getCached<{ traces: BrainTrace[]; total?: number }>(cacheKey);
  if (cached) return cached;

  const args: Record<string, unknown> = {};
  if (opts.agentId) args.agent_id = opts.agentId;
  if (opts.goalId) args.goal_id = opts.goalId;
  if (opts.taskId) args.task_id = opts.taskId;
  if (opts.kind) args.kind = opts.kind;
  if (opts.since != null) args.since = opts.since;
  if (opts.limit != null) args.limit = opts.limit;

  const raw = (await callTool("traces_query", args)) as Record<string, unknown>;
  const result = {
    traces: Array.isArray(raw?.traces) ? (raw.traces as BrainTrace[]) : [],
    total: typeof raw?.total === "number" ? raw.total : undefined,
  };

  setCache(cacheKey, result, 15_000); // 15s TTL
  return result;
}

// ── Public API: Wiki ──────────────────────────────────────────���───

export async function brainWikiStatus(): Promise<BrainWikiStatus> {
  const cacheKey = "brain:wiki:status";
  const cached = getCached<BrainWikiStatus>(cacheKey);
  if (cached) return cached;

  const raw = (await callTool("wiki", { action: "status" })) as Record<string, unknown>;
  const result: BrainWikiStatus = {
    totalEntries: (raw?.totalEntries ?? raw?.totalConcepts ?? 0) as number,
    totalConcepts: (raw?.totalConcepts ?? 0) as number,
    totalRaw: (raw?.totalRaw ?? 0) as number,
    entriesByDomain: (raw?.entriesByDomain ?? raw?.byDomain ?? {}) as Record<string, number>,
    freshness: (raw?.freshness ?? {}) as BrainWikiStatus["freshness"],
    healthScore: (raw?.healthScore ?? 0) as number,
  };

  setCache(cacheKey, result, 60_000); // 60s TTL — wiki changes slowly
  return result;
}

// ── Public API: Memory search ─────────────────────────────────────

/** Ranked knowledge search via the brain's memory_search tool. Returns the
 *  raw (parsed) payload — normalization lives in search.ts. Uncached: search
 *  is user-initiated, not polled. */
export async function brainMemorySearch(
  query: string,
  opts: { corpus?: "wiki" | "memory" | "all"; limit?: number } = {},
): Promise<unknown> {
  return callTool("memory_search", {
    query,
    corpus: opts.corpus ?? "all",
    limit: opts.limit ?? 20,
  });
}

// ── Connection Lifecycle ───────��───────────────────────────���──────

export async function initBrainClient(): Promise<void> {
  try {
    await getClient();
  } catch (err) {
    console.error("[brain-client] Failed to connect to openclaw-brain:", err);
    console.warn("[brain-client] Brain-backed endpoints will return errors until connection is restored");
  }
}

export function isBrainConnected(): boolean {
  return client !== null;
}
