/**
 * The tool surface served on `/tools/invoke`: memory_search, memory_get,
 * wiki (status). Same envelope openclaw's gateway returns —
 * `{ ok, result: { content: [{type:"text", text}], details } }` — so every
 * existing caller (proxy, hooks, dashboard) keeps working unchanged.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize as normalizePath, resolve, sep } from "node:path";
import type { BrainTool, MCPToolResult } from "@digital-me/brain-orchestrator";
import { isOneOf, WIKI_ACTIONS } from "@digital-me/contracts";
import { errorMessage } from "./errors.js";
import type { Embedder } from "./retriever/embedder.js";
import { search, type VectorCache } from "./retriever/search.js";
import type { IndexStore } from "./retriever/store.js";

export type ToolEnvelope =
  | {
      readonly ok: true;
      readonly result: { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean };
    }
  | { readonly ok: false; readonly error: { type: string; message: string } };

export type ToolDeps = {
  readonly store: IndexStore;
  readonly cache: VectorCache;
  readonly embedder: Embedder;
  /** Absolute roots that memory_get may read from (the wiki/ and tastes/ dirs). */
  readonly readableRoots: readonly string[];
  /** The directory containing wiki/ and tastes/; `wiki/x/y.md` paths resolve against it. */
  readonly wikiRoot: string;
  readonly version: string;
  /** Orchestrator tools (tasks, agent_identify, …) mounted alongside the retriever tools. */
  readonly extraTools?: ReadonlyMap<string, BrainTool>;
};

export const TOOL_NAMES = ["memory_search", "memory_get", "wiki"] as const;

/** Wrap a brain-orchestrator MCP result in the gateway envelope (isError passes through). */
export function fromMcpResult(r: MCPToolResult): ToolEnvelope {
  return {
    ok: true,
    result: {
      content: r.content.map((c) => ({ type: "text" as const, text: c.text })),
      details: { ...r.details },
      ...(r.isError ? { isError: true } : {}),
    },
  };
}

export function okEnvelope(details: Record<string, unknown>): ToolEnvelope {
  return { ok: true, result: { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details } };
}

export function errEnvelope(type: string, message: string): ToolEnvelope {
  return { ok: false, error: { type, message } };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export async function invokeTool(deps: ToolDeps, tool: string, args: Record<string, unknown>): Promise<ToolEnvelope> {
  switch (tool) {
    case "memory_search":
      return memorySearch(deps, args);
    case "memory_get":
      return memoryGet(deps, args);
    case "wiki":
      return wikiTool(deps, args);
    default: {
      const extra = deps.extraTools?.get(tool);
      if (extra) return fromMcpResult(await extra.execute(args));
      const served = [...TOOL_NAMES, ...(deps.extraTools?.keys() ?? [])].join(", ");
      return errEnvelope("unknown_tool", `Unknown tool "${tool}" (brain-host serves: ${served})`);
    }
  }
}

async function memorySearch(deps: ToolDeps, args: Record<string, unknown>): Promise<ToolEnvelope> {
  const query = str(args.query);
  if (query === undefined) return errEnvelope("invalid_request", "memory_search requires a non-empty `query`");
  try {
    const res = await search(deps.store, deps.cache, deps.embedder, query, {
      limit: typeof args.limit === "number" ? args.limit : typeof args.maxResults === "number" ? args.maxResults : undefined,
      corpus: str(args.corpus),
    });
    return okEnvelope({ ...res, citations: "auto" });
  } catch (err) {
    // Never `ok` with an empty list when the index is unusable — the failure
    // mode that hid a dead openclaw index for weeks.
    return errEnvelope("search_unavailable", errorMessage(err));
  }
}

/**
 * Map a requested path onto a file inside one of the readable roots.
 * Accepts absolute paths, `wiki/<domain>/<file>.md`-style paths relative to
 * `base` (the directory that contains wiki/ and tastes/), and paths relative
 * to a root itself. Anything that escapes the roots resolves to null.
 */
export function resolveReadable(roots: readonly string[], base: string, requested: string): string | null {
  const candidates = isAbsolute(requested) ? [requested] : [join(base, requested), ...roots.map((r) => join(r, requested))];
  for (const c of candidates) {
    const abs = resolve(normalizePath(c));
    if (roots.some((r) => abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep))) return abs;
  }
  return null;
}

function memoryGet(deps: ToolDeps, args: Record<string, unknown>): ToolEnvelope {
  const path = str(args.path);
  if (path === undefined) return errEnvelope("invalid_request", "memory_get requires `path`");
  const abs = resolveReadable(deps.readableRoots, deps.wikiRoot, path);
  if (abs === null) return errEnvelope("forbidden", `path is outside the readable roots: ${path}`);
  let text: string;
  try {
    text = readFileSync(abs, "utf-8");
  } catch {
    return errEnvelope("not_found", `no such file: ${path}`);
  }
  const lines = text.split("\n");
  const from = typeof args.from === "number" && args.from >= 1 ? Math.floor(args.from) : 1;
  const count = typeof args.lines === "number" && args.lines >= 1 ? Math.floor(args.lines) : lines.length;
  const slice = lines.slice(from - 1, from - 1 + count);
  return okEnvelope({ path: abs, from, lines: slice.length, total: lines.length, text: slice.join("\n") });
}

function wikiTool(deps: ToolDeps, args: Record<string, unknown>): ToolEnvelope {
  const action = str(args.action) ?? "status";
  // WIKI_ACTIONS is what the MCP proxy advertises; this is the only one served.
  if (!isOneOf(WIKI_ACTIONS, action)) {
    return errEnvelope("invalid_request", `wiki action "${action}" is not served by brain-host (only: ${WIKI_ACTIONS.join(", ")})`);
  }
  const stats = deps.store.stats();
  return okEnvelope({
    status: "ok",
    version: deps.version,
    provenance: deps.store.getProvenance(),
    lastIndexAt: deps.store.getMeta("last_index_at"),
    ...stats,
  });
}
