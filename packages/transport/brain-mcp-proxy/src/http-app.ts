/**
 * Streamable HTTP request handling for the brain MCP proxy.
 *
 * Stateless MCP pattern: every POST to /mcp builds a fresh SDK Server +
 * StreamableHTTPServerTransport pair, handles exactly one JSON-RPC message,
 * and tears down when the response closes. No session table, no cross-talk
 * between concurrent clients (Claude Code + Codex on a second machine each
 * get their own per-request server), no session-id lifecycle to leak.
 *
 * The tool surface and forwarding behavior are identical to the stdio
 * transport: both feed the same `createCallToolHandler`, so traces, M1
 * app-rate observation, and gateway forwarding stay on this machine — the
 * remote client is a remote control, not a second brain.
 *
 * All I/O dependencies are injected; the module owns no process state.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "./gateway.js";
import type { CallToolRequest } from "./handler.js";
import {
  extractBearerToken,
  resolveAgentId,
  timingSafeTokenEqual,
} from "./http-auth.js";
import { TOOLS } from "./tools.js";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";
export const AGENT_ID_HEADER = "x-agent-id";
export const AGENT_ID_QUERY_PARAM = "agent_id";

export type ToolHandler = (req: CallToolRequest) => Promise<CallToolResult>;

export interface RequestListenerDeps {
  /** Shared secret; requests without a matching bearer token get 401. */
  readonly token: string;
  readonly maxBodyBytes: number;
  /** Attribution fallback when the request names no agent id. */
  readonly defaultAgentId: string | undefined;
  /**
   * Per-request tool-handler factory. Called once per POST with the
   * resolved agent id so attribution (traces, M1 app-rate) reflects the
   * calling client, not a process-wide default.
   */
  readonly createToolHandler: (agentId: string | undefined) => ToolHandler;
  readonly log: (line: string) => void;
}

type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413; readonly message: string };

/** Read and JSON-parse a request body, enforcing the byte cap. */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > maxBytes) {
        return {
          ok: false,
          status: 413,
          message: `request body exceeds ${maxBytes} bytes`,
        };
      }
      chunks.push(buf);
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      message: `failed to read request body: ${errorMessage(err)}`,
    };
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw === "") {
    return { ok: false, status: 400, message: "empty request body" };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, message: "request body is not valid JSON" };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
  );
}

/**
 * Handle one HTTP request end-to-end. Exported for direct testing; the
 * production entry wraps it via createRequestListener.
 */
export async function handleMcpRequest(
  deps: RequestListenerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://internal");

    if (url.pathname === HEALTH_PATH) {
      if (req.method !== "GET") {
        sendJsonRpcError(res, 405, -32000, "method not allowed", {
          Allow: "GET",
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    if (url.pathname !== MCP_PATH) {
      sendJsonRpcError(res, 404, -32000, "not found");
      return;
    }

    // Stateless transport: only POST carries JSON-RPC messages. GET (the
    // standalone SSE notification stream) and DELETE (session termination)
    // get 405, which spec-compliant Streamable HTTP clients tolerate.
    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, -32000, "method not allowed", {
        Allow: "POST",
      });
      return;
    }

    const provided = extractBearerToken(req.headers.authorization);
    if (provided === null || !timingSafeTokenEqual(deps.token, provided)) {
      sendJsonRpcError(res, 401, -32001, "unauthorized", {
        "WWW-Authenticate": "Bearer",
      });
      return;
    }

    const headerAgentId = req.headers[AGENT_ID_HEADER];
    const queryAgentId = url.searchParams.get(AGENT_ID_QUERY_PARAM);
    const resolution = resolveAgentId({
      headerValue:
        headerAgentId !== undefined
          ? headerAgentId
          : queryAgentId !== null
            ? queryAgentId
            : undefined,
      fallback: deps.defaultAgentId,
    });
    if (!resolution.ok) {
      sendJsonRpcError(res, 400, -32000, resolution.reason);
      return;
    }

    const body = await readJsonBody(req, deps.maxBodyBytes);
    if (!body.ok) {
      sendJsonRpcError(res, body.status, -32700, body.message);
      return;
    }

    const toolHandler = deps.createToolHandler(resolution.agentId);
    const server = new Server(
      { name: "openclaw-brain", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (mcpReq) =>
      toolHandler({
        name: mcpReq.params.name,
        arguments: mcpReq.params.arguments,
      }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body.value);
  } catch (err) {
    deps.log(`brain-mcp-http: request failed: ${errorMessage(err)}`);
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, "internal server error");
    } else {
      res.end();
    }
  }
}

/** Build the node:http request listener for the HTTP transport. */
export function createRequestListener(
  deps: RequestListenerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleMcpRequest(deps, req, res);
  };
}
