/**
 * HTTP request listener for brain-host. Speaks the gateway wire:
 *   POST /tools/invoke  {tool, agentId?, args}  → tool envelope
 *   GET  /health        → {ok, version} without a token (liveness only);
 *                         {ok, version, entries, provenance, …} with a valid bearer token
 * Bearer-token gated; unknown agent ids are accepted (attribution only).
 * The returned listener never rejects: any failure (a client aborting
 * mid-upload, a throwing health probe) becomes a 500 or a closed response,
 * so `void listener(req, res)` cannot crash the process.
 * All dependencies injected; no process state. Token/body helpers are the
 * shared ones in @digital-me/contracts (also used by brain-mcp-proxy).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken, readJsonBody, timingSafeTokenEqual } from "@digital-me/contracts";
import { errorMessage } from "./errors.js";
import type { ToolEnvelope } from "./tools.js";

export const INVOKE_PATH = "/tools/invoke";
export const HEALTH_PATH = "/health";
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export type InvokeFn = (tool: string, args: Record<string, unknown>, agentId: string) => Promise<ToolEnvelope>;

export type ListenerDeps = {
  readonly token: string;
  /** Reported by the unauthenticated /health liveness answer. */
  readonly version: string;
  readonly invoke: InvokeFn;
  /** Full detail (paths, index, orchestrator state); served to token holders only. */
  readonly health: () => Record<string, unknown>;
  readonly log: (line: string) => void;
  readonly maxBodyBytes?: number;
  readonly defaultAgentId?: string;
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, type: string, message: string): void {
  send(res, status, { ok: false, error: { type, message } });
}

function authorized(req: IncomingMessage, token: string): boolean {
  const bearer = extractBearerToken(req.headers.authorization);
  return bearer !== null && timingSafeTokenEqual(token, bearer);
}

export function createRequestListener(deps: ListenerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === HEALTH_PATH) {
      if (req.method !== "GET") return sendError(res, 405, "method_not_allowed", "GET only");
      if (!authorized(req, deps.token)) return send(res, 200, { ok: true, version: deps.version });
      return send(res, 200, { ok: true, ...deps.health() });
    }
    if (url.pathname !== INVOKE_PATH) return sendError(res, 404, "not_found", `unknown path ${url.pathname}`);
    if (req.method !== "POST") return sendError(res, 405, "method_not_allowed", "POST only");
    if (!authorized(req, deps.token)) return sendError(res, 401, "unauthorized", "missing or invalid bearer token");

    const body = await readJsonBody(req, maxBody);
    if (!body.ok) {
      deps.log(`invoke rejected: HTTP ${body.status} ${body.message}`);
      return sendError(res, body.status, "invalid_request", body.message);
    }
    const value = body.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return sendError(res, 400, "invalid_request", "body must be a JSON object");
    const rec = value as Record<string, unknown>;
    if (typeof rec.tool !== "string" || rec.tool === "") return sendError(res, 400, "invalid_request", "`tool` is required");
    const args = typeof rec.args === "object" && rec.args !== null && !Array.isArray(rec.args) ? (rec.args as Record<string, unknown>) : {};
    const agentId = typeof rec.agentId === "string" && rec.agentId !== "" ? rec.agentId : deps.defaultAgentId ?? "unknown";

    const started = Date.now();
    let envelope: ToolEnvelope;
    try {
      envelope = await deps.invoke(rec.tool, args, agentId);
    } catch (err) {
      deps.log(`invoke ${rec.tool} agent=${agentId} threw: ${errorMessage(err)}`);
      return sendError(res, 500, "internal", "tool invocation failed");
    }
    deps.log(`invoke ${rec.tool} agent=${agentId} ok=${envelope.ok} ${Date.now() - started}ms`);
    return send(res, 200, envelope);
  };
  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      deps.log(`request failed: ${errorMessage(err)}`);
      try {
        if (!res.headersSent) sendError(res, 500, "internal", "internal server error");
        else res.end();
      } catch {
        // The socket is already gone; nothing left to tell the client.
      }
    }
  };
}
