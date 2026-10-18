import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { resolveBrainCallerEnv, type BrainHostServiceConfig } from "./brain-host-service.js";
import { resolveOpenclawExtensionsDir } from "./openclaw-paths.js";

/**
 * Live evidence for `digital-me doctor`'s brain-host rows: the authenticated
 * brain-host `/health` report, and what the legacy openclaw gateway's
 * `digital-me-brain` plugin is doing with its scheduler tick.
 *
 * Everything here is gathered ONCE by the CLI (async: two HTTP probes and a
 * few log tails) and handed to the synchronous `runDoctor` as plain data, so
 * the doctor stays a pure function. Every probe is injected (fetch, fs) and
 * every failure becomes data, never a throw: a check whose signal cannot be
 * read reports WARN/SKIP with the reason, it never fails the doctor.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Per-probe budget: a hung service must not hang the doctor. */
export const LIVE_PROBE_TIMEOUT_MS = 3000;

/** How much of each gateway log to scan for the plugin's last load (the plugin reloads several times a day). */
export const GATEWAY_LOG_TAIL_BYTES = 8 * 1024 * 1024;

export interface HealthResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** The subset of `fetch` the probes use (the global one satisfies it). */
export type HealthFetch = (
  url: string,
  init: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<HealthResponse>;

/** A thrown value as text; Node's fetch hides the useful part (ECONNREFUSED…) in `cause.code`. */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = causeCode(err);
  return code ? `${err.message} (${code})` : err.message;
}

function causeCode(err: unknown): string | undefined {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

// ── brain-host /health ─────────────────────────────────────────────────────

/** What the doctor learned from brain-host's `/health`. */
export type BrainHostHealth =
  /** No probe was attempted (no token on this machine, misconfigured URL). */
  | { readonly status: "skipped"; readonly reason: string }
  /** Nothing answered (refused, timed out). */
  | { readonly status: "unreachable"; readonly url: string; readonly reason: string }
  /** Something answered, but not with a health report (HTTP error, not JSON). */
  | { readonly status: "error"; readonly url: string; readonly reason: string }
  /** brain-host answered the unauthenticated `{ok, version}` only: the token was rejected. */
  | { readonly status: "liveness-only"; readonly url: string; readonly tokenFile: string }
  /** The full, authenticated report (paths, index, `orchestrator`). */
  | { readonly status: "ok"; readonly url: string; readonly body: Readonly<Record<string, unknown>> };

export type BrainHostHealthTarget =
  | { readonly url: string; readonly token: string; readonly tokenFile: string }
  | { readonly skip: string };

/** `/health` beside a brain-host `/tools/invoke` URL. Throws on a malformed URL. */
export function brainHostHealthUrl(invokeUrl: string): string {
  return new URL("/health", invokeUrl).toString();
}

/**
 * Where to probe and with which bearer token — the SAME resolution every
 * installer bakes into client registrations (`resolveBrainCallerEnv`):
 * DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN_FILE, else the always-on
 * service's URL and `<wiki-root>/.data/brain-host.token`. Never throws.
 */
export function resolveBrainHostHealthTarget(
  env: Env,
  cfg: Pick<BrainHostServiceConfig, "host" | "port" | "tokenFile">,
  readTokenFile: (file: string) => string | undefined,
): BrainHostHealthTarget {
  try {
    const caller = resolveBrainCallerEnv(env, cfg, readTokenFile);
    if (!caller) {
      return { skip: `no brain-host token at ${cfg.tokenFile} — brain-host is not installed ('digital-me install --runtime brain-host')` };
    }
    const token = (readTokenFile(caller.brainTokenFile) ?? "").trim();
    if (token === "") return { skip: `the token file ${caller.brainTokenFile} is empty or unreadable` };
    return { url: brainHostHealthUrl(caller.brainUrl), token, tokenFile: caller.brainTokenFile };
  } catch (err) {
    return { skip: errorText(err) };
  }
}

/** GET `/health` with the bearer token. Never throws. */
export async function probeBrainHostHealth(
  target: BrainHostHealthTarget,
  fetchFn: HealthFetch,
  timeoutMs: number = LIVE_PROBE_TIMEOUT_MS,
): Promise<BrainHostHealth> {
  if ("skip" in target) return { status: "skipped", reason: target.skip };
  const { url } = target;
  let res: HealthResponse;
  try {
    res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { status: "unreachable", url, reason: errorText(err) };
  }
  if (!res.ok) return { status: "error", url, reason: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { status: "error", url, reason: `the answer is not JSON (${errorText(err)})` };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: "error", url, reason: "the answer is not a JSON object" };
  }
  const record = body as Record<string, unknown>;
  // Without a valid token brain-host answers `{ok, version}` (liveness only);
  // any other key means the detailed, authenticated report came back.
  return Object.keys(record).some((k) => k !== "ok" && k !== "version")
    ? { status: "ok", url, body: record }
    : { status: "liveness-only", url, tokenFile: target.tokenFile };
}

// ── The openclaw gateway's tick ───────────────────────────────────────────
//
// The gateway's digital-me-brain plugin decides ONCE, at load, whether it
// ticks the scheduler (runtimes/openclaw/templates/brain/index.mjs): it logs
// `digital-me-brain: registered N tools …` on every load and, only when it
// will NOT tick, `digital-me-brain: scheduler tick DISABLED …` right after.
// That logged decision is the one signal that reflects the gateway's own
// environment (config.scheduler, DIGITAL_ME_OPENCLAW_SCHEDULER, whether the
// brain-host token existed at its start) — none of which the doctor can see
// directly. A liveness probe of the gateway's `/health` rules out a stale
// decision from a gateway that has since stopped.

export const GATEWAY_PLUGIN_LOAD_MARKER = "digital-me-brain: registered ";
export const GATEWAY_TICK_DISABLED_MARKER = "digital-me-brain: scheduler tick DISABLED";
export const OPENCLAW_GATEWAY_DEFAULT_PORT = 18789;

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/;

/** The tick decision the plugin logged at its most recent load. */
export interface GatewayTickDecision {
  readonly ticking: boolean;
  /** When that load happened, if the log line carries a timestamp. */
  readonly at?: string;
  readonly logPath: string;
}

/**
 * The plugin's decision at the LAST load in `text` (both the stdout log's
 * plain lines and the debug log's JSON lines carry the markers verbatim), or
 * undefined when `text` holds no load line.
 */
export function parseGatewayTickDecision(text: string): Omit<GatewayTickDecision, "logPath"> | undefined {
  const lines = text.split("\n");
  let disabled = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.includes(GATEWAY_TICK_DISABLED_MARKER)) {
      disabled = true;
    } else if (line.includes(GATEWAY_PLUGIN_LOAD_MARKER)) {
      const at = ISO_TIMESTAMP.exec(line)?.[0];
      return at ? { ticking: !disabled, at } : { ticking: !disabled };
    }
  }
  return undefined;
}

/** The fs calls `readFileTail` makes — injectable for tests. */
export type TailFs = {
  readonly openSync: (file: string, flags: string) => number;
  readonly fstatSync: (fd: number) => { readonly size: number };
  readonly readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  readonly closeSync: (fd: number) => void;
};

/**
 * The last `maxBytes` of a file as UTF-8 (whole lines only: a tail that
 * starts mid-file drops its partial first line). Gateway logs reach ~100 MB,
 * so the doctor never reads one whole. Throws like `openSync` does.
 */
export function readFileTail(
  file: string,
  maxBytes: number,
  fs: TailFs = { openSync, fstatSync, readSync, closeSync },
): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.subarray(0, read).toString("utf-8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Where the gateway answers `GET /health` (`{"ok":true,"status":"live"}`,
 * unauthenticated): OPENCLAW_GATEWAY_HOST/PORT, else openclaw.json
 * `gateway.port`, else 127.0.0.1:18789 — the brain-mcp-proxy's own order.
 */
export function openclawGatewayHealthUrl(env: Env, openclawConfig?: unknown): string {
  const host = (env.OPENCLAW_GATEWAY_HOST ?? "").trim() || "127.0.0.1";
  const envPort = Number(env.OPENCLAW_GATEWAY_PORT);
  const filePort = (openclawConfig as { gateway?: { port?: unknown } } | null | undefined)?.gateway?.port;
  const port = validPort(envPort) ? envPort : validPort(filePort) ? filePort : OPENCLAW_GATEWAY_DEFAULT_PORT;
  return `http://${host}:${port}/health`;
}

function validPort(p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536;
}

/**
 * Every place the gateway loads a `digital-me-brain` plugin from: the
 * canonical state-dir install, plus the two lower-precedence copies it still
 * loads when that one is missing (see the doctor's shadow-copy check).
 */
export function gatewayBrainPluginPaths(home: string, env: Env): string[] {
  return [
    path.join(resolveOpenclawExtensionsDir(home, env), "digital-me-brain", "index.mjs"),
    path.join(home, "openclaw", "dist", "extensions", "digital-me-brain", "index.js"),
    path.join(home, "openclaw", "extensions", "digital-me-brain", "index.mjs"),
  ];
}

/** What the doctor knows about the gateway's scheduler tick. */
export type OpenclawGatewayEvidence =
  /** No digital-me-brain plugin is installed: the gateway cannot tick Digital Me schedules. */
  | { readonly state: "absent" }
  /** Nothing listens on the gateway port (connection refused). */
  | { readonly state: "not-running"; readonly url: string; readonly reason: string }
  /**
   * The plugin's logged decision at its last load. `answering` says whether
   * the gateway answered `/health` just now (false: it timed out or reset,
   * so it may be busy or wedged — a refused connection is `not-running`);
   * `liveness` is the same in words.
   */
  | {
      readonly state: "ticking" | "disabled";
      readonly decision: GatewayTickDecision;
      readonly answering: boolean;
      readonly liveness: string;
    }
  /** The decision could not be read (no log, no load line in the scanned tails). */
  | { readonly state: "unknown"; readonly reason: string };

export interface GatewayEvidenceDeps {
  /** {@link gatewayBrainPluginPaths}. */
  readonly pluginPaths: readonly string[];
  readonly fileExists: (p: string) => boolean;
  readonly fetch: HealthFetch;
  /** {@link openclawGatewayHealthUrl}. */
  readonly healthUrl: string;
  /** Gateway logs, newest first (`listGatewayLogs`). */
  readonly logPaths: readonly string[];
  /** Tail of one log ({@link readFileTail}); may throw. */
  readonly readTail: (file: string) => string;
  readonly timeoutMs?: number;
}

/** Gather the gateway evidence. Never throws. */
export async function collectOpenclawGatewayEvidence(deps: GatewayEvidenceDeps): Promise<OpenclawGatewayEvidence> {
  if (!deps.pluginPaths.some((p) => deps.fileExists(p))) return { state: "absent" };
  let answering = true;
  let liveness: string;
  try {
    // Any HTTP answer at all means a gateway process is listening.
    await deps.fetch(deps.healthUrl, { signal: AbortSignal.timeout(deps.timeoutMs ?? LIVE_PROBE_TIMEOUT_MS) });
    liveness = `gateway answering at ${deps.healthUrl}`;
  } catch (err) {
    // Refused = nothing listens. Anything else (a timeout, a reset) cannot
    // tell a stopped gateway from a busy one: report the logged decision,
    // flagged as unconfirmed.
    if (causeCode(err) === "ECONNREFUSED") {
      return { state: "not-running", url: deps.healthUrl, reason: errorText(err) };
    }
    answering = false;
    liveness = `gateway liveness unknown: ${deps.healthUrl} ${errorText(err)}`;
  }
  const scanned: string[] = [];
  const unreadable: string[] = [];
  for (const logPath of deps.logPaths) {
    let text: string;
    try {
      text = deps.readTail(logPath);
    } catch (err) {
      unreadable.push(`${logPath}: ${errorText(err)}`);
      continue;
    }
    scanned.push(logPath);
    const decision = parseGatewayTickDecision(text);
    if (decision) {
      return { state: decision.ticking ? "ticking" : "disabled", decision: { ...decision, logPath }, answering, liveness };
    }
  }
  if (deps.logPaths.length === 0) {
    return { state: "unknown", reason: "no openclaw gateway log found (set OPENCLAW_GATEWAY_LOG if it lives elsewhere)" };
  }
  const reasons: string[] = [];
  if (scanned.length > 0) reasons.push(`no digital-me-brain load line in the scanned tail of ${scanned.join(", ")}`);
  if (unreadable.length > 0) reasons.push(`unreadable: ${unreadable.join("; ")}`);
  return { state: "unknown", reason: reasons.join("; ") };
}
