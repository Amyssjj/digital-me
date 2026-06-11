/**
 * MCP envelope adapter — converts the runtime-agnostic `RouterResult` into
 * the openclaw plugin tool's `{ content: [{ type: "text", text }], details,
 * isError? }` response shape.
 *
 * Pure / generic on purpose: any consumer that speaks MCP (openclaw plugin
 * entry, a future dream-cycle MCP tool, an external server) reuses this
 * one adapter. No openclaw imports — the shape matches the published MCP
 * tool result schema.
 *
 * The mapping:
 *   - `ok: true`  → `isError: false` + text/json
 *   - `ok: false` → `isError: true`  + text/json
 *   - `json` field present (e.g. format=json) → emits the SAME json payload
 *     in `details` so MCP callers can read structured data without
 *     re-parsing the text body.
 */

import type { RouterResult } from "./router.js";

export type MCPContent = {
  readonly type: "text";
  readonly text: string;
};

export type MCPToolResult = {
  readonly content: readonly MCPContent[];
  readonly details: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
};

export function toMCPResult(r: RouterResult): MCPToolResult {
  const base: MCPToolResult = {
    content: [{ type: "text", text: r.text }],
    details: r.json !== undefined ? { json: r.json } : {},
  };
  return r.ok ? base : { ...base, isError: true };
}

/**
 * Handler factory — turn an async `RouterResult`-returning function into
 * an MCP `execute` callback. Used by the openclaw plugin entry to wrap
 * `dispatchAction` and the four standalone handlers (agent_identify,
 * learning_capture, traces_record, traces_query).
 */
export function asMCPExecute<TParams extends Record<string, unknown>>(
  handler: (params: Readonly<TParams>) => Promise<RouterResult> | RouterResult,
): (
  _toolCallId: string,
  params: Readonly<TParams>,
) => Promise<MCPToolResult> {
  return async (_toolCallId, params) => {
    const result = await handler(params);
    return toMCPResult(result);
  };
}
