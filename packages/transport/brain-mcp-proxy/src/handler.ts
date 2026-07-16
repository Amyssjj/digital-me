/**
 * MCP CallToolRequest handler.
 *
 * Pure-ish: I/O dependencies (gateway invoke, log emitter, optional trace
 * writer, optional wiki-body inliner) injected at construction time.
 * The handler:
 *   1. injects defaultAgentId into args when caller didn't set one
 *   2. emits an attribution log line per call
 *   3. forwards to the gateway via the injected invokeFn
 *   4. for memory_search responses, optionally inlines the top hit's full
 *      body into results[0].full_body so non-Claude-Code agents (Codex,
 *      Hermes) don't need a follow-up memory_get to read the most relevant
 *      entry. (Added 2026-05-22 during M1 calibration — mirrors the
 *      Claude-Code-side hook's top-1 body inline.)
 *   5. catches unexpected exceptions and returns an isError result
 *   6. records a trace via the optional traceWriter (fire-and-forget) —
 *      this is the universal observability chokepoint for every
 *      MCP-routed openclaw-brain tool call from any client.
 */

import type { CallToolResult } from "./gateway.js";
import type { AppRateWriter } from "./app-rate-writer.js";

// ─── Top-hit body inliner (M1 fix, 2026-05-22) ─────────────────────────────

/**
 * Inputs needed to read a wiki entry's body off local disk so we can inline
 * it into the memory_search response.
 *
 * The proxy gets this via the `wikiBodyInliner` dep in createCallToolHandler.
 * Production wires it to a small fs-backed reader; tests pass a fake.
 */
export interface WikiBodyInliner {
  /**
   * Given a memory_search hit's `path` field (which the brain encodes as a
   * cwd-relative path like '../../../../<home>/digital-me/wiki/X.md'),
   * return up to `maxChars` of the file's body (frontmatter stripped) or
   * null if the file can't be located/read.
   */
  readBody: (hitPath: string, maxChars: number) => string | null;
}

/** Default cap on inlined body length. Keeps top-1 inline at ~1 KB tokens. */
const DEFAULT_TOP1_BODY_CHARS = 2000;

/** Minimum score (0–1) for a hit to qualify for inlining. */
const DEFAULT_INLINE_MIN_SCORE = 0.4;

/**
 * Walk a memory_search-shaped CallToolResult and, if the top hit clears
 * `minScore` AND `readBody` returns content, augment results[0] with a
 * `full_body` field. Returns a NEW CallToolResult — the input is not
 * mutated. Returns the input unchanged when:
 *   - tool name isn't memory_search
 *   - the response isn't text-shaped (errors, malformed payloads)
 *   - results is empty or first hit lacks a path
 *   - top hit score < minScore
 *   - reader returns null
 */
export function inlineTopHitBody(input: {
  toolName: string;
  result: CallToolResult;
  inliner: WikiBodyInliner;
  maxChars?: number;
  minScore?: number;
}): CallToolResult {
  if (input.toolName !== "memory_search") return input.result;
  const item = input.result.content?.[0];
  if (!item || typeof item !== "object" || !("text" in item)) return input.result;
  const text = (item as { text?: unknown }).text;
  if (typeof text !== "string") return input.result;

  let parsed: { results?: Array<Record<string, unknown>>; [k: string]: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    return input.result;
  }
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length === 0) {
    return input.result;
  }
  const top = parsed.results[0];
  if (!top || typeof top !== "object") return input.result;
  const path = (top as { path?: unknown }).path;
  if (typeof path !== "string" || path === "") return input.result;
  const score = typeof top.score === "number" ? top.score : 0;
  const minScore = input.minScore ?? DEFAULT_INLINE_MIN_SCORE;
  if (score < minScore) return input.result;

  const maxChars = input.maxChars ?? DEFAULT_TOP1_BODY_CHARS;
  const body = input.inliner.readBody(path, maxChars);
  if (!body) return input.result;

  const augmentedResults = parsed.results.slice();
  augmentedResults[0] = { ...top, full_body: body };
  const augmentedPayload = { ...parsed, results: augmentedResults };

  return {
    ...input.result,
    content: [
      { type: "text", text: JSON.stringify(augmentedPayload) },
      ...(input.result.content?.slice(1) ?? []),
    ],
  };
}

// ─── Oversize-result guard (2026-07-16) ─────────────────────────────────────
//
// A single oversized tool result can kill the MCP client outright: the live
// incident was `tasks {action:"board", format:"json"}` returning a ~59 MB
// board (every-minute scheduled-workflow goals × full task records), which
// Claude Code's stdio client answered with "Connection closed". The proxy
// process itself survives — it's the client that dies — so the guard's job
// is to never forward a result that large in the first place. Applies to
// both transports (stdio + Streamable HTTP) since both share this handler.

/** Default cap on the bytes of content forwarded per tool result. Legitimate
 * agent-facing results are orders of magnitude smaller (a max-limit
 * traces_query is ~100 KB); agent clients truncate far below this anyway. */
export const DEFAULT_MAX_RESULT_BYTES = 4 * 1024 * 1024;

/** Env override for the cap. `0` disables the guard entirely — the
 * dashboard's brain client sets that: it spawns its own proxy and
 * legitimately consumes the full board JSON. */
export const MAX_RESULT_BYTES_ENV = "BRAIN_MCP_MAX_RESULT_BYTES";

/** Resolve the result-size cap from the environment: a non-negative integer
 * number of bytes, 0 meaning "disabled". Unset/invalid values fall back to
 * the default so a typo can't silently disable the guard. */
export function resolveMaxResultBytes(env: NodeJS.ProcessEnv): number {
  const raw = env[MAX_RESULT_BYTES_ENV];
  if (raw === undefined || raw === "") return DEFAULT_MAX_RESULT_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return DEFAULT_MAX_RESULT_BYTES;
  }
  return n;
}

/** Total UTF-8 bytes a result's content would occupy on the wire. Non-text
 * content items (none exist today — the gateway only returns text) are
 * measured by their JSON serialization. */
export function resultContentBytes(result: CallToolResult): number {
  let total = 0;
  for (const item of result.content ?? []) {
    const text = (item as { text?: unknown }).text;
    total +=
      typeof text === "string"
        ? Buffer.byteLength(text, "utf8")
        : Buffer.byteLength(JSON.stringify(item), "utf8");
  }
  return total;
}

/** The isError result returned in place of an oversized one. */
export function oversizeResult(input: {
  toolName: string;
  bytes: number;
  maxBytes: number;
}): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          `MCP proxy: '${input.toolName}' returned ${input.bytes} bytes, over the ` +
          `${input.maxBytes}-byte forwarding cap (oversized results crash MCP clients). ` +
          `Narrow the call — e.g. tasks board with format:"json" accepts since (epoch ms) ` +
          `and limit, or omit format:"json" for the compact markdown board. ` +
          `Operators can tune the cap via ${MAX_RESULT_BYTES_ENV} (0 disables).`,
      },
    ],
    isError: true,
  };
}

export type GatewayInvoker = (input: {
  toolName: string;
  args: Record<string, unknown>;
}) => Promise<CallToolResult>;

export type CallToolRequest = {
  name: string;
  arguments?: Record<string, unknown> | undefined;
};

/**
 * Per-tool-call trace event. `traceWriter` is invoked once per CallTool
 * regardless of outcome. The writer is responsible for any persistence
 * (e.g., SQLite insert) and must NEVER throw — failures are swallowed.
 */
export interface ToolCallTrace {
  toolName: string;
  agentId: string;
  /** First-class summary fields, populated when the tool args provide them. */
  query?: string;
  /** Number of hits returned (set for memory_search; undefined otherwise). */
  hitCount?: number;
  /** Wall-clock duration in ms from invocation start to gateway return. */
  durationMs: number;
  /** True if the gateway returned an error or the invoke threw. */
  isError: boolean;
  /** Epoch ms when the call completed. */
  completedAt: number;
}

export type TraceWriter = (trace: ToolCallTrace) => void;

/** Try to extract a result hit count from a memory_search-shaped response. */
export function extractHitCount(
  toolName: string,
  result: CallToolResult,
): number | undefined {
  if (toolName !== "memory_search") return undefined;
  // memory_search returns {content: [{type:"text", text:"<json>"}]} where
  // the JSON has { results: [...] }. Parse defensively.
  const item = result.content?.[0];
  if (!item || typeof item !== "object" || !("text" in item)) return undefined;
  const text = (item as { text?: unknown }).text;
  if (typeof text !== "string") return undefined;
  try {
    const parsed = JSON.parse(text) as { results?: unknown };
    return Array.isArray(parsed.results) ? parsed.results.length : undefined;
  } catch {
    return undefined;
  }
}

export function buildToolArgs(
  args: Record<string, unknown> | undefined,
  defaultAgentId: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(args ?? {}) };
  const current = out.agent_id;
  const callerSet = typeof current === "string" && current !== "";
  if (!callerSet && defaultAgentId !== undefined) {
    out.agent_id = defaultAgentId;
  }
  return out;
}

export function attributionLabel(
  args: Record<string, unknown>,
): string {
  const agentId = args.agent_id;
  if (typeof agentId === "string" && agentId !== "") return agentId;
  const runtime = args.runtime;
  const runtimeStr = typeof runtime === "string" && runtime !== "" ? runtime : "mcp";
  return `unknown:${runtimeStr}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function createCallToolHandler(deps: {
  invokeFn: GatewayInvoker;
  defaultAgentId: string | undefined;
  log: (line: string) => void;
  /**
   * Optional trace writer. Called once per CallTool with timing + agent +
   * outcome. Must never throw — failures are caught and silently dropped
   * so trace persistence cannot affect the actual tool response.
   */
  traceWriter?: TraceWriter;
  /**
   * Optional wiki-body inliner. When provided, memory_search responses get
   * their top-scoring hit's full body inlined into results[0].full_body so
   * non-Claude-Code agents (Codex, Hermes) don't need a follow-up
   * memory_get to read the most relevant entry. (M1 fix, 2026-05-22.)
   * Must never throw — failures fall through to the unmodified response.
   */
  wikiBodyInliner?: WikiBodyInliner;
  /**
   * Optional M1 application_rate writer. Observes memory_search (surfaced
   * paths) and memory_get (accessed paths) at this universal MCP chokepoint
   * and writes per-(agent, day) JSONL records to the runtime-scoped log file
   * the dashboard intake reads. Replaces the broken gateway-hook path that
   * digital-me-recall uses, for runtimes where those hooks aren't dispatched
   * (openclaw codex/embedded path, hermes Discord). Must never throw —
   * failures are swallowed so writer health can never affect tool responses.
   * See wiki: infrastructure/m1-application-rate-openclaw-hermes-hook-lifecycle.md
   */
  appRateWriter?: AppRateWriter;
  /**
   * Cap (bytes) on the content forwarded per tool result; oversized results
   * are replaced with an isError explanation instead of being shipped to the
   * client (see the oversize-result guard above). 0 disables the guard.
   * Defaults to DEFAULT_MAX_RESULT_BYTES when omitted.
   */
  maxResultBytes?: number;
}): (req: CallToolRequest) => Promise<CallToolResult> {
  const {
    invokeFn,
    defaultAgentId,
    log,
    traceWriter,
    wikiBodyInliner,
    appRateWriter,
  } = deps;
  const maxResultBytes = deps.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;

  return async (req) => {
    const args = buildToolArgs(req.arguments, defaultAgentId);
    const agentId = attributionLabel(args);
    log(`[brain] ${req.name} called by ${agentId}`);
    const startedAt = Date.now();
    const recordTrace = (result: CallToolResult, isError: boolean): void => {
      if (!traceWriter) return;
      try {
        const query =
          typeof args.query === "string" ? args.query : undefined;
        traceWriter({
          toolName: req.name,
          agentId,
          ...(query !== undefined ? { query } : {}),
          ...((): { hitCount?: number } => {
            const n = extractHitCount(req.name, result);
            return n !== undefined ? { hitCount: n } : {};
          })(),
          durationMs: Date.now() - startedAt,
          isError,
          completedAt: Date.now(),
        });
      } catch {
        // Trace writer must NEVER affect the tool response. Swallow.
      }
    };

    try {
      const result = await invokeFn({ toolName: req.name, args });
      // Augment memory_search responses with the top hit's body. Inliner
      // is fault-tolerant — on any internal error it returns the input
      // result unchanged. Wrap defensively anyway.
      let finalResult = result;
      if (wikiBodyInliner && !result.isError) {
        try {
          finalResult = inlineTopHitBody({
            toolName: req.name,
            result,
            inliner: wikiBodyInliner,
          });
        } catch {
          // Inlining must never affect the tool response. Fall through.
          finalResult = result;
        }
      }
      // Oversize guard — measured after inlining (which adds bytes) so the
      // check reflects what would actually go over the wire.
      if (maxResultBytes > 0) {
        const bytes = resultContentBytes(finalResult);
        if (bytes > maxResultBytes) {
          log(
            `[brain] ${req.name} result oversized (${bytes} > ${maxResultBytes} bytes), replaced with error`,
          );
          finalResult = oversizeResult({
            toolName: req.name,
            bytes,
            maxBytes: maxResultBytes,
          });
        }
      }
      recordTrace(finalResult, !!finalResult.isError);
      if (appRateWriter) {
        try {
          if (req.name === "memory_search") {
            appRateWriter.recordSearch({
              agentId,
              toolName: req.name,
              result: finalResult,
            });
          } else if (req.name === "memory_get") {
            appRateWriter.recordGet({
              agentId,
              toolName: req.name,
              args,
            });
          }
        } catch {
          // appRateWriter must never affect the tool response. Swallow.
        }
      }
      return finalResult;
    } catch (err) {
      const errorResult: CallToolResult = {
        content: [
          { type: "text", text: `MCP proxy error: ${errorMessage(err)}` },
        ],
        isError: true,
      };
      recordTrace(errorResult, true);
      return errorResult;
    }
  };
}
