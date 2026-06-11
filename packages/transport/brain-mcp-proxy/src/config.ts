/**
 * Configuration resolution for brain-mcp-proxy.
 *
 * Two responsibilities:
 *   1. Resolve the gateway host/port/auth-token from env vars, falling back
 *      to the openclaw gateway state file ($OPENCLAW_HOME/openclaw.json).
 *   2. Resolve the default agent_id used to stamp outgoing tool calls when
 *      the caller didn't set one — from OPENCLAW_AGENT_ID env, then --agent-id
 *      argv flag.
 *
 * Pure functions, no side effects beyond reading the openclaw config file.
 */

import fs from "node:fs";
import path from "node:path";

// Default to the IPv4 loopback literal, not "localhost". On Node >=17 the DNS
// resolver prefers IPv6, so "localhost" can resolve to ::1 while the gateway
// listens only on 127.0.0.1 — every call then fails with ECONNREFUSED. Pinning
// 127.0.0.1 makes the out-of-box default reach a loopback-bound gateway.
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18789;

export type GatewayConfig = {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly url: string;
};

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

type GatewayFileShape = {
  gateway?: {
    port?: unknown;
    auth?: {
      token?: unknown;
      password?: unknown;
    };
  };
};

function readGatewayFile(openclawHome: string): GatewayFileShape | null {
  const configPath = path.join(openclawHome, "openclaw.json");
  if (!fs.existsSync(configPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new GatewayConfigError(
      `failed to read ${configPath}: ${(err as Error).message}`,
    );
  }
  try {
    return JSON.parse(raw) as GatewayFileShape;
  } catch (err) {
    throw new GatewayConfigError(
      `failed to parse ${configPath} as JSON: ${(err as Error).message}`,
    );
  }
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "") return undefined;
  return value;
}

function parsePort(value: string | number, source: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new GatewayConfigError(
      `${source} is not a valid TCP port: ${value}`,
    );
  }
  return n;
}

export function loadGatewayConfig(input: {
  env: NodeJS.ProcessEnv;
  openclawHome: string;
}): GatewayConfig {
  const { env, openclawHome } = input;
  const fileShape = readGatewayFile(openclawHome);

  // Host: env > default. (File doesn't carry host today; defaults to 127.0.0.1.)
  const host = nonEmptyEnv(env.OPENCLAW_GATEWAY_HOST) ?? DEFAULT_HOST;

  // Port: env > file > default.
  const envPort = nonEmptyEnv(env.OPENCLAW_GATEWAY_PORT);
  let port: number;
  if (envPort !== undefined) {
    port = parsePort(envPort, "OPENCLAW_GATEWAY_PORT");
  } else if (
    fileShape?.gateway?.port !== undefined &&
    typeof fileShape.gateway.port === "number"
  ) {
    port = parsePort(
      fileShape.gateway.port,
      `${path.join(openclawHome, "openclaw.json")} gateway.port`,
    );
  } else {
    port = DEFAULT_PORT;
  }

  // Token: env > file.auth.token > file.auth.password.
  let token: string | undefined = nonEmptyEnv(env.OPENCLAW_GATEWAY_TOKEN);
  if (token === undefined) {
    const fileToken = fileShape?.gateway?.auth?.token;
    if (typeof fileToken === "string" && fileToken !== "") {
      token = fileToken;
    }
  }
  if (token === undefined) {
    const filePw = fileShape?.gateway?.auth?.password;
    if (typeof filePw === "string" && filePw !== "") {
      token = filePw;
    }
  }
  if (token === undefined) {
    throw new GatewayConfigError(
      "gateway auth token not found — set OPENCLAW_GATEWAY_TOKEN or populate gateway.auth.token in openclaw.json",
    );
  }

  return {
    host,
    port,
    token,
    url: `http://${host}:${port}/tools/invoke`,
  };
}

export function resolveDefaultAgentId(input: {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
}): string | undefined {
  const { env, argv } = input;

  const fromEnv = env.OPENCLAW_AGENT_ID;
  if (typeof fromEnv === "string") {
    const trimmed = fromEnv.trim();
    if (trimmed !== "") return trimmed;
  }

  const flagPrefix = "--agent-id=";
  for (const arg of argv) {
    if (arg.startsWith(flagPrefix)) {
      const value = arg.slice(flagPrefix.length).trim();
      if (value !== "") return value;
    }
  }

  return undefined;
}
