/**
 * HTTP hardening helpers shared by every digital-me HTTP listener
 * (brain-host's /tools/invoke, brain-mcp-proxy's Streamable HTTP transport).
 *
 * - Bearer tokens are compared in constant time: both sides are sha256-hashed
 *   to equal length first, so neither the content nor the length of the
 *   expected token leaks through timing (timingSafeEqual needs same-size
 *   buffers; comparing raw buffers would short-circuit on length).
 * - Request bodies are read with a byte cap, and a stream failure (client
 *   abort, ECONNRESET) resolves to a 400 result instead of rejecting, so a
 *   listener started as `void listener(req, res)` cannot surface it as an
 *   unhandled rejection.
 * - Bind/tokens follow one secure-by-default rule: a minimum token length,
 *   and a loopback check callers use to warn about network exposure.
 *
 * Node built-ins only; this package stays dependency-free.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Shortest bearer token an HTTP listener accepts (`openssl rand -hex 32` gives 64). */
export const MIN_TOKEN_LENGTH = 16;

/** Parse `Authorization: Bearer <token>` (scheme case-insensitive). null when absent or another scheme. */
export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  return match[1]!;
}

/** Constant-time token comparison that does not leak either token's length. */
export function timingSafeTokenEqual(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

/**
 * True for hosts that keep a listener machine-local. Anything else is a
 * network-exposed bind and should be warned about at startup.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413; readonly message: string };

/**
 * Read and JSON-parse a request body, enforcing the byte cap. Never rejects:
 * a stream error (aborted upload) maps to a 400 result.
 */
export async function readJsonBody(req: AsyncIterable<unknown>, maxBytes: number): Promise<JsonBodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > maxBytes) {
        return { ok: false, status: 413, message: `request body exceeds ${maxBytes} bytes` };
      }
      chunks.push(buf);
    }
  } catch (err) {
    return { ok: false, status: 400, message: `failed to read request body: ${err instanceof Error ? err.message : String(err)}` };
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw === "") return { ok: false, status: 400, message: "empty request body" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, message: "request body is not valid JSON" };
  }
}
