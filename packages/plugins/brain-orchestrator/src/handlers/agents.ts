/**
 * Agent-identity handlers — pure business logic, no MCP/openclaw envelope.
 *
 * These functions are what the openclaw plugin entry wires into MCP tools.
 * Keeping them pure (typed inputs, structured Result outputs, no MCP-shape
 * content arrays) lets the dream-cycle, dashboard, and direct unit tests
 * call the same code paths without rebuilding tool plumbing — the V2-C5
 * refactor goal.
 */

import { randomUUID } from "node:crypto";
import type { AgentsStore } from "../store/agents.js";

/** Session tokens are valid for 24 hours. */
export const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Soft-warn deadline for un-identified callers. After this date, callers
 * that omit `agent_id` may be throttled. Owner of this date is the
 * deployment (not the open-source plugin) — kept here for parity with
 * upstream; downstream consumers can override via composition.
 */
export const UNIDENTIFIED_SOFT_WARN_DEADLINE = "2026-05-27";

export type IdentifyAgentInput = {
  readonly agentId: string;
  readonly runtime: string;
  readonly version?: string;
  readonly capabilities?: readonly string[];
};

export type IdentifyAgentResult = {
  readonly sessionToken: string;
  readonly serverTime: string;
  readonly created: boolean;
};

export type IdentifyAgentDeps = {
  readonly agents: AgentsStore;
  readonly now?: () => number;
  readonly newToken?: () => string;
};

/**
 * Register or refresh an agent. Returns a short-lived session token plus
 * an ISO server timestamp. Idempotent for an existing `agentId`.
 */
export function identifyAgent(
  deps: IdentifyAgentDeps,
  input: IdentifyAgentInput,
): IdentifyAgentResult {
  const now = (deps.now ?? Date.now)();
  const sessionToken = (deps.newToken ?? randomUUID)();
  const tokenExpiresAt = now + SESSION_TOKEN_TTL_MS;
  const { created } = deps.agents.upsert({
    agentId: input.agentId,
    runtime: input.runtime,
    version: input.version,
    capabilities: input.capabilities ?? [],
    sessionToken,
    tokenExpiresAt,
  });
  return {
    sessionToken,
    serverTime: new Date(now).toISOString(),
    created,
  };
}

/**
 * Build a human-readable warning for un-identified callers. Returns
 * `undefined` when the caller did provide an `agentId` — letting the
 * envelope conditionally surface the warning. Pure function so callers
 * (envelope, dashboard, traces collector) all render the same string.
 */
export function buildUnidentifiedCallWarning(
  agentId: string | undefined,
): string | undefined {
  if (agentId) return undefined;
  return (
    `[brain-api] Un-identified call (agent_id missing). ` +
    `Please call agent_identify at session start. ` +
    `After ${UNIDENTIFIED_SOFT_WARN_DEADLINE}, un-identified calls may be throttled.`
  );
}
