/**
 * Spawn parameters for the dashboard's private brain-mcp-proxy child.
 *
 * Pure: resolves the proxy script + node binary from the environment and
 * returns the `StdioServerParameters` the SDK's StdioClientTransport takes.
 * Extracted from the legacy stdio brain client so the spawn contract — in particular
 * the read-buffer cap that decides whether a full board JSON can reach the
 * dashboard at all — is unit-tested without spawning anything.
 *
 * Precedence for the brain backend is NOT decided here: the child proxy
 * inherits this process's env and applies brain-mcp-proxy's own rule
 * (DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN → OPENCLAW_GATEWAY_* →
 * openclaw.json). Point the dashboard at brain-host by exporting those two
 * variables into its environment.
 */

import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MAX_RESULT_BYTES_ENV } from "@digital-me/brain-mcp-proxy";

/**
 * Largest single JSON-RPC message the dashboard's stdio client will accept
 * from the proxy. @modelcontextprotocol/sdk >= 1.30 caps the stdio ReadBuffer
 * at 10 MB by default and CLOSES the transport when one message exceeds it —
 * the full 7-day board JSON is ~55 MB, so with the default every board call
 * killed the proxy and every brain route then failed with "Not connected".
 * 256 MiB leaves headroom over the largest window brainBoard() will request
 * (see BOARD_WINDOW_MAX_DAYS in brain-client.ts).
 */
const PROXY_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/** Bare script name used when workspace resolution fails; relies on $PATH. */
const PROXY_FALLBACK_SCRIPT = "brain-mcp-proxy.mjs";

const PROXY_MODULE_SPECIFIER = "@digital-me/brain-mcp-proxy/bin/brain-mcp-proxy.mjs";

export type ProxySpawnInput = {
  /** The dashboard process's environment (inherited by the child). */
  readonly env: NodeJS.ProcessEnv;
  /** Node module resolver, i.e. `createRequire(import.meta.url).resolve`. */
  readonly resolve: (specifier: string) => string;
};

/**
 * Resolve the brain-mcp-proxy script path. Order (most-specific first):
 *   1. $BRAIN_PROXY_PATH — power-user override (e.g. a forked proxy build).
 *   2. Node module resolution against @digital-me/brain-mcp-proxy. This is
 *      the zero-config path: the dashboard declares brain-mcp-proxy as a
 *      workspace dep, so pnpm install wires up the symlink and resolution
 *      finds the bin regardless of where the dashboard is launched from.
 *   3. Bare "brain-mcp-proxy.mjs" on $PATH — last-resort fallback for
 *      installs where the workspace symlink isn't reachable.
 */
export function resolveProxyPath(input: ProxySpawnInput): string {
  const override = input.env.BRAIN_PROXY_PATH;
  if (override !== undefined && override !== "") return override;
  try {
    return input.resolve(PROXY_MODULE_SPECIFIER);
  } catch {
    return PROXY_FALLBACK_SCRIPT;
  }
}

/** Build the StdioClientTransport parameters for the dashboard's proxy. */
export function proxyTransportParams(input: ProxySpawnInput): StdioServerParameters {
  const nodeBin = input.env.NODE_BIN;
  return {
    command: nodeBin !== undefined && nodeBin !== "" ? nodeBin : "node",
    args: [resolveProxyPath(input)],
    // Disable the proxy's oversize-result guard for this spawn: the
    // dashboard is the one consumer that legitimately reads the full
    // board JSON (tens of MB — Kanban stats, workflow run counts). Agent-
    // facing spawns keep the cap. Raising maxBufferSize below is what makes
    // that exemption usable again on SDK >= 1.30.
    env: {
      ...(input.env as Record<string, string>),
      [MAX_RESULT_BYTES_ENV]: "0",
    },
    maxBufferSize: PROXY_MAX_BUFFER_BYTES,
  };
}
