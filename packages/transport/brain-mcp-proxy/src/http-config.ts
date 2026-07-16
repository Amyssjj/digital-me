/**
 * Configuration resolution for the Streamable HTTP transport entry point.
 *
 * Secure-by-default posture:
 *   - The transport never starts without a bearer token (BRAIN_MCP_HTTP_TOKEN,
 *     minimum length enforced — there is deliberately no default value).
 *   - Binds to the IPv4 loopback interface unless BRAIN_MCP_HTTP_HOST is set
 *     explicitly. Reaching it from another machine is an opt-in decision;
 *     see the README's remote-access section (prefer a private overlay
 *     network such as WireGuard/Tailscale over raw LAN binding).
 *
 * Pure functions, no side effects.
 */

export const DEFAULT_HTTP_HOST = "127.0.0.1";
/** One above the gateway's default (18789) so the pair reads as a family. */
export const DEFAULT_HTTP_PORT = 18790;
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MIN_TOKEN_LENGTH = 16;

export type HttpConfig = {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** Attribution fallback when a request carries no agent id (header/query). */
  readonly defaultAgentId: string | undefined;
  readonly maxBodyBytes: number;
};

export class HttpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpConfigError";
  }
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed;
}

function parsePositiveInt(
  value: string,
  source: string,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > max) {
    throw new HttpConfigError(
      `${source} is not a valid value (expected integer in 1..${max}): ${value}`,
    );
  }
  return n;
}

/**
 * True for hosts that keep the transport machine-local. Used to decide
 * whether to emit the network-exposure warning at startup.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function loadHttpConfig(input: {
  env: NodeJS.ProcessEnv;
}): HttpConfig {
  const { env } = input;

  const token = nonEmptyEnv(env.BRAIN_MCP_HTTP_TOKEN);
  if (token === undefined) {
    throw new HttpConfigError(
      "BRAIN_MCP_HTTP_TOKEN is required — the HTTP transport never starts " +
        "unauthenticated. Generate one with: openssl rand -hex 32",
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new HttpConfigError(
      `BRAIN_MCP_HTTP_TOKEN is too short (${token.length} chars, minimum ` +
        `${MIN_TOKEN_LENGTH}). Generate a strong one with: openssl rand -hex 32`,
    );
  }

  const host = nonEmptyEnv(env.BRAIN_MCP_HTTP_HOST) ?? DEFAULT_HTTP_HOST;

  const rawPort = nonEmptyEnv(env.BRAIN_MCP_HTTP_PORT);
  const port =
    rawPort === undefined
      ? DEFAULT_HTTP_PORT
      : parsePositiveInt(rawPort, "BRAIN_MCP_HTTP_PORT", 65535);

  const rawMaxBody = nonEmptyEnv(env.BRAIN_MCP_HTTP_MAX_BODY_BYTES);
  const maxBodyBytes =
    rawMaxBody === undefined
      ? DEFAULT_MAX_BODY_BYTES
      : parsePositiveInt(
          rawMaxBody,
          "BRAIN_MCP_HTTP_MAX_BODY_BYTES",
          Number.MAX_SAFE_INTEGER,
        );

  const defaultAgentId = nonEmptyEnv(env.BRAIN_MCP_HTTP_DEFAULT_AGENT_ID);

  return { host, port, token, defaultAgentId, maxBodyBytes };
}
