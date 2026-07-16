/**
 * Authentication and attribution helpers for the HTTP transport.
 *
 * - Bearer-token check uses a timing-safe comparison (both sides hashed to
 *   equal length first, as timingSafeEqual requires same-size buffers).
 * - Per-request agent-id resolution: clients identify themselves via the
 *   X-Agent-Id header (or `agent_id` URL query for clients that can't set
 *   custom headers). Attribution feeds the trace table and M1 application
 *   rate, so an invalid id is rejected rather than silently normalized.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export function extractBearerToken(
  header: string | undefined,
): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  return match[1]!;
}

export function timingSafeTokenEqual(
  expected: string,
  provided: string,
): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type AgentIdResolution =
  | { readonly ok: true; readonly source: "explicit"; readonly agentId: string }
  | {
      readonly ok: true;
      readonly source: "fallback";
      readonly agentId: string | undefined;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the effective agent id for one request. Precedence: explicit
 * value (header or query) > fallback from config > undefined (the handler
 * then attributes the call as `unknown:mcp`).
 *
 * `source` distinguishes an authenticated transport identity ("explicit")
 * from a config fallback — the transport enforces explicit identities over
 * any `agent_id` a client puts inside tool arguments.
 */
export function resolveAgentId(input: {
  headerValue: string | string[] | undefined;
  fallback: string | undefined;
}): AgentIdResolution {
  const { headerValue, fallback } = input;
  if (headerValue === undefined) {
    return { ok: true, source: "fallback", agentId: fallback };
  }
  if (Array.isArray(headerValue)) {
    return { ok: false, reason: "duplicate X-Agent-Id header" };
  }
  const trimmed = headerValue.trim();
  if (trimmed === "") {
    return { ok: true, source: "fallback", agentId: fallback };
  }
  if (!AGENT_ID_PATTERN.test(trimmed)) {
    return {
      ok: false,
      reason:
        "invalid agent id: must start alphanumeric and contain only " +
        "[A-Za-z0-9._-], max 64 chars",
    };
  }
  return { ok: true, source: "explicit", agentId: trimmed };
}
