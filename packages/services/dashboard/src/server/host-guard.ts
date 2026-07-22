/**
 * DNS-rebinding guard for the unauthenticated dashboard API.
 *
 * The dashboard serves the user's entire personal "brain" with NO auth. Its
 * whole perimeter is (a) binding to loopback only and (b) deliberately omitting
 * CORS (see server.ts). Same-origin policy alone does NOT close that perimeter:
 * a malicious site the user visits can re-resolve its own hostname to 127.0.0.1
 * (DNS rebinding) and, because the browser then treats the response as
 * same-origin with the attacker's page, read every `/api/*` payload. Loopback
 * binding does not help — the rebound request still arrives on 127.0.0.1.
 *
 * The standard defense is to reject any request whose `Host` header is not a
 * known loopback name. Legitimate local clients (the browser hitting
 * http://localhost:PORT, the Vite dev proxy hitting 127.0.0.1:PORT) always send
 * a loopback Host; an attacker's rebound request carries the attacker's own
 * hostname (e.g. `evil.example`) and is rejected. The attacker cannot forge a
 * loopback Host without also making the browser treat the origin as the
 * loopback origin — at which point SOP + no-CORS already blocks the read.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Extract the lowercased hostname from a `Host` header value, stripping any
 * `:port` suffix and IPv6 brackets. Returns null for missing/empty/malformed
 * values (which are treated as not-allowed by callers).
 *
 *   "localhost:3458"  -> "localhost"
 *   "127.0.0.1"       -> "127.0.0.1"
 *   "[::1]:3458"      -> "::1"
 *   "EVIL.example"    -> "evil.example"
 *   ":3458" / "" / undefined -> null
 */
export function extractHostname(hostHeader: string | undefined | null): string | null {
  if (!hostHeader) return null;
  let name: string;
  if (hostHeader.startsWith("[")) {
    // IPv6 literal: "[::1]" or "[::1]:3458". Take what's inside the brackets.
    const end = hostHeader.indexOf("]");
    if (end === -1) return null; // malformed — no closing bracket
    name = hostHeader.slice(1, end);
  } else {
    name = hostHeader.split(":")[0];
  }
  return name.length > 0 ? name.toLowerCase() : null;
}

/**
 * True only when the `Host` header names a loopback host. Used to reject
 * DNS-rebinding requests against the unauthenticated dashboard API.
 */
export function isLoopbackHost(hostHeader: string | undefined | null): boolean {
  const name = extractHostname(hostHeader);
  return name !== null && LOOPBACK_HOSTNAMES.has(name);
}
