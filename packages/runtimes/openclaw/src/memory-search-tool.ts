/**
 * `brain_memory_search` — an IN-GATEWAY memory search tool registered by the
 * digital-me-brain openclaw plugin.
 *
 * Why this exists (2026-09-01, openclaw 2026.8.1):
 *   - openclaw gives one-shot CLI runs (the cli-backend heartbeat, `openclaw
 *     agent` exec) a TRANSIENT memory manager per `memory_search` call
 *     (memory-core tools.ts: `oneShotCliRun → purpose "cli"`). On a large
 *     store that is a cold open plus a KNN subprocess inside the hardcoded
 *     15 s deadline — 0/19 heartbeat calls succeeded on a 1.7 GB index — and
 *     each attempt also kicks off a full reindex that races the gateway's own
 *     indexer, aborts, and strands a 1.3 GB temp database.
 *   - An external MCP server (the brain proxy) cannot be the workaround in
 *     those runs: openclaw treats it as "native tool use" and a headless run
 *     cannot answer the approval prompt.
 *   - Tools registered by an openclaw plugin are served through the bundle
 *     server without that gate, and `getActiveMemorySearchManager` from the
 *     plugin SDK resolves the gateway's long-lived (warm) manager — the same
 *     path `/tools/invoke` uses, ~1–3 s for the same query.
 *
 * The search itself is injected (`MemorySearchFn`) so this module stays free
 * of openclaw imports and fully unit-testable; the plugin template wires it
 * to the SDK.
 */

import { Type, type Static } from "typebox";
import type { MCPToolResult } from "@digital-me/brain-orchestrator";
import type { OpenClawAgentTool } from "./plugin-entry.js";

export const BRAIN_MEMORY_SEARCH_TOOL_NAME = "brain_memory_search";

/** Hard cap on results; keeps a liveness probe from pulling whole corpora. */
export const BRAIN_MEMORY_SEARCH_MAX_RESULTS = 20;
export const BRAIN_MEMORY_SEARCH_DEFAULT_RESULTS = 6;
/** Snippet fallback length when a hit carries only a body. */
const SNIPPET_CHARS = 400;

export const BrainMemorySearchToolSchema = Type.Object(
  {
    query: Type.String({ description: "Search query (natural language)." }),
    agent: Type.Optional(
      Type.String({
        description:
          "openclaw agent whose memory index to search (e.g. 'coo'). Defaults to the host's primary agent.",
      }),
    ),
    maxResults: Type.Optional(
      Type.Number({
        description: `Max results (default ${BRAIN_MEMORY_SEARCH_DEFAULT_RESULTS}, max ${BRAIN_MEMORY_SEARCH_MAX_RESULTS}).`,
      }),
    ),
  },
  { additionalProperties: false },
);
export type BrainMemorySearchToolParams = Static<typeof BrainMemorySearchToolSchema>;

/** A hit as returned by openclaw's MemorySearchManager.search (loosely typed:
 *  the SDK's result type is not exported to plugins). */
export type RawMemoryHit = {
  readonly path?: unknown;
  readonly title?: unknown;
  readonly score?: unknown;
  readonly snippet?: unknown;
  readonly body?: unknown;
  readonly source?: unknown;
};

export type MemorySearchFn = (params: {
  readonly agentId: string;
  readonly query: string;
  readonly maxResults: number;
}) => Promise<readonly RawMemoryHit[] | null | undefined>;

export type BrainMemorySearchHit = {
  readonly path: string;
  readonly title?: string;
  readonly score?: number;
  readonly snippet?: string;
  readonly source?: string;
};

/** Normalize one raw hit; drops entries with no usable path. */
export function normalizeMemoryHit(raw: RawMemoryHit): BrainMemorySearchHit | null {
  if (typeof raw.path !== "string" || raw.path === "") return null;
  const snippetSource =
    typeof raw.snippet === "string" && raw.snippet !== ""
      ? raw.snippet
      : typeof raw.body === "string"
        ? raw.body.slice(0, SNIPPET_CHARS)
        : undefined;
  return {
    path: raw.path,
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.score === "number" && Number.isFinite(raw.score) ? { score: raw.score } : {}),
    ...(snippetSource !== undefined ? { snippet: snippetSource } : {}),
    ...(typeof raw.source === "string" ? { source: raw.source } : {}),
  };
}

/** Clamp a caller-supplied result count into [1, MAX]; non-numbers → default. */
export function resolveMaxResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return BRAIN_MEMORY_SEARCH_DEFAULT_RESULTS;
  }
  return Math.min(BRAIN_MEMORY_SEARCH_MAX_RESULTS, Math.max(1, Math.floor(value)));
}

function textResult(payload: Record<string, unknown>, isError: boolean): MCPToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Build the openclaw-shaped `brain_memory_search` tool. `defaultAgentId` is
 * the owner used when the caller passes no `agent`.
 */
export function buildBrainMemorySearchTool(deps: {
  readonly search: MemorySearchFn;
  readonly defaultAgentId: string;
}): OpenClawAgentTool {
  return {
    name: BRAIN_MEMORY_SEARCH_TOOL_NAME,
    description:
      "Search an openclaw agent's memory index on the gateway's long-lived (warm) manager. " +
      "Use this instead of memory_search from one-shot CLI sessions such as heartbeats: there " +
      "memory_search cold-opens the whole index per call and cannot meet its 15s deadline. " +
      "Pass agent to pick the index (e.g. 'coo'); returns {agent, query, count, results[{path,title,score,snippet}]}.",
    parameters: BrainMemorySearchToolSchema,
    execute: async (_toolCallId, params) => {
      const record =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      const query = typeof record.query === "string" ? record.query.trim() : "";
      const agentRaw = typeof record.agent === "string" ? record.agent.trim() : "";
      const agentId = agentRaw !== "" ? agentRaw : deps.defaultAgentId;
      if (query === "") {
        return textResult({ error: "query required", agent: agentId }, true);
      }
      const maxResults = resolveMaxResults(record.maxResults);
      const startedAt = Date.now();
      try {
        const raw = (await deps.search({ agentId, query, maxResults })) ?? [];
        const results = raw
          .map((hit) => normalizeMemoryHit(hit))
          .filter((hit): hit is BrainMemorySearchHit => hit !== null)
          .slice(0, maxResults);
        return textResult(
          {
            agent: agentId,
            query,
            count: results.length,
            results,
            durationMs: Date.now() - startedAt,
            path: "gateway-warm-manager",
          },
          false,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(
          { error: message, agent: agentId, query, durationMs: Date.now() - startedAt },
          true,
        );
      }
    },
  };
}
