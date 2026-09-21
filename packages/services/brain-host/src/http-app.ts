/**
 * HTTP request listener for brain-host. Speaks the gateway wire:
 *   POST /tools/invoke  {tool, agentId?, args}  → tool envelope
 *   GET  /health        → {ok, version, entries, provenance}
 * Bearer-token gated; unknown agent ids are accepted (attribution only).
 * All dependencies injected; no process state.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { errorMessage } from "./errors.js";
import type { ToolEnvelope } from "./tools.js";

export const INVOKE_PATH = "/tools/invoke";
export const HEALTH_PATH = "/health";
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export type InvokeFn = (tool: string, args: Record<string, unknown>, agentId: string) => Promise<ToolEnvelope>;

export type ListenerDeps = {
  readonly token: string;
  readonly invoke: InvokeFn;
  readonly health: () => Record<string, unknown>;
  readonly log: (line: string) => void;
  readonly maxBodyBytes?: number;
  readonly defaultAgentId?: string;
};

export function extractBearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m ? m[1]!.trim() : null;
}

export function tokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) return { ok: false, status: 413, message: `request body exceeds ${maxBytes} bytes` };
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw === "") return { ok: false, status: 400, message: "empty request body" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, message: "request body is not valid JSON" };
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, type: string, message: string): void {
  send(res, status, { ok: false, error: { type, message } });
}

export function createRequestListener(deps: ListenerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === HEALTH_PATH) {
      if (req.method !== "GET") return sendError(res, 405, "method_not_allowed", "GET only");
      return send(res, 200, { ok: true, ...deps.health() });
    }
    if (url.pathname !== INVOKE_PATH) return sendError(res, 404, "not_found", `unknown path ${url.pathname}`);
    if (req.method !== "POST") return sendError(res, 405, "method_not_allowed", "POST only");
    const bearer = extractBearer(req.headers.authorization);
    if (bearer === null || !tokenEqual(bearer, deps.token)) return sendError(res, 401, "unauthorized", "missing or invalid bearer token");

    const body = await readJsonBody(req, maxBody);
    if (!body.ok) return sendError(res, body.status, "invalid_request", body.message);
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
}
