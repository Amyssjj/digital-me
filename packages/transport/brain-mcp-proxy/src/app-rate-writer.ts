/**
 * brain-mcp-proxy app-rate writer (M1 application_rate).
 *
 * Records per-agent (surfaced, accessed) wiki-path sets observed at the
 * MCP-proxy chokepoint, then flushes JSONL records to the runtime-scoped
 * log file the dashboard intake reads from
 * (~/.openclaw/data/application_rate_{openclaw,hermes}.log).
 *
 * WHY THIS LIVES IN THE PROXY (and not in digital-me-recall):
 * The recall plugin observes turns via openclaw gateway hooks
 * (`before_prompt_build`, `after_tool_call`). As of 2026-05-20, openclaw's
 * default agent path (embedded runner) stopped dispatching those hooks to
 * extension plugins, so no data flows that way. Hermes' `pre_llm_call`
 * hook also doesn't fire reliably. The MCP proxy, by contrast, is the
 * universal chokepoint — every memory_search / memory_get call from every
 * runtime (openclaw subagents, hermes Discord, claude-code) passes through
 * here. Collecting M1 signal at this layer is self-contained (uses only
 * our own plugins/code) and immune to upstream hook-dispatch bugs.
 *
 * See wiki: infrastructure/m1-application-rate-openclaw-hermes-hook-lifecycle.md
 *
 * SCHEMA (matches what dashboard_intake/derive_application_rate.py reads):
 *   {
 *     "ts": "2026-05-26T...Z",
 *     "session_id": "<bucket_key>",  // see bucketKeyFor() — agent_id + day
 *     "session_date": "YYYY-MM-DD",
 *     "agent_id": "<agent>",
 *     "source": "live",
 *     "surface": "openclaw" | "hermes",
 *     "started_at": "<iso>",
 *     "hook_injections": <int>,     // count of memory_search calls in bucket
 *     "surfaced_unique": <int>,
 *     "acted_unique": <int>,
 *     "application_rate": <float|null>,
 *     "acted_paths": ["wiki/<domain>/<slug>.md", ...],
 *     "ignored_paths": ["wiki/<domain>/<slug>.md", ...],
 *     "flush_reason": "periodic" | "exit" | "stale"
 *   }
 *
 * The intake unions paths across all records per (date, tree, agent) so
 * re-emitting cumulative snapshots from successive flushes is idempotent —
 * paths dedup naturally.
 */

import { createRequire } from "node:module";
import type { CallToolResult } from "./gateway.js";

// ESM contexts don't have a `require` binding — createRequire bridges to
// node's CJS resolver so we can lazy-load node:fs without paying the cost
// at module load time (and without breaking tests that inject `fs`).
const cjsRequire = createRequire(import.meta.url);

// ─── public types ─────────────────────────────────────────────────────────

export interface AppRateWriter {
  /**
   * Record a memory_search call's response. Each hit's path goes into the
   * bucket's `surfaced` set; the call increments `hook_injections`.
   */
  recordSearch(input: {
    agentId: string;
    toolName: string;
    result: CallToolResult;
  }): void;
  /**
   * Record a memory_get / read call. The `path` arg goes into the
   * bucket's `accessed` set.
   */
  recordGet(input: {
    agentId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): void;
  /** Flush all buckets that have new activity since their last flush. */
  flushAll(reason: FlushReason): void;
  /** Stop the periodic flush timer + emit a final flush. Idempotent. */
  shutdown(): void;
}

export type FlushReason = "periodic" | "exit" | "stale" | "manual";

export interface AppRateFs {
  mkdirSync: (p: string, opts: { recursive: boolean }) => void;
  appendFileSync: (p: string, data: string) => void;
}

/** Decision returned by `logPathForAgent`: where to write + how to label `surface`. */
export interface LogTarget {
  /** Absolute path to the JSONL log to append. */
  path: string;
  /** Value of the record's `surface` field — usually "openclaw" or "hermes". */
  surface: string;
}

export interface CreateAppRateWriterInput {
  /**
   * Resolve an agent_id to the log target it should write to, or null to
   * skip (e.g. claude-code already has its own Stop-hook writer and we
   * don't want to double-count).
   */
  logPathForAgent: (agentId: string) => LogTarget | null;
  /** Periodic flush interval in ms. <=0 disables. Default 5 * 60_000. */
  flushIntervalMs?: number;
  /** Inactivity threshold for stale-bucket GC (ms). <=0 disables. Default 24h. */
  staleBucketMs?: number;
  /** Filesystem ops (injected for tests). */
  fs?: AppRateFs;
  /** Wall-clock now (injected for tests). */
  now?: () => number;
  /** Stderr emitter for non-fatal failures. */
  warn?: (line: string) => void;
}

// ─── implementation ───────────────────────────────────────────────────────

interface Bucket {
  agentId: string;
  startedAt: number;
  surfaced: Set<string>;
  accessed: Set<string>;
  hookInjections: number;
  rev: number;
  lastFlushedRev: number;
  lastActivityAt: number;
}

/** Bucket per (agent_id, UTC date). A new day starts a fresh bucket. */
export function bucketKeyFor(agentId: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return `${agentId}::${day}`;
}

/**
 * Parse a memory_search CallToolResult into the list of hit paths.
 * Mirrors `extractHitCount` in handler.ts but pulls the path strings too.
 */
export function extractHitPaths(result: CallToolResult): string[] {
  const item = result.content?.[0];
  if (!item || typeof item !== "object" || !("text" in item)) return [];
  const text = (item as { text?: unknown }).text;
  if (typeof text !== "string") return [];
  let parsed: { results?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.results)) return [];
  const out: string[] = [];
  for (const h of parsed.results) {
    const p = (h as { path?: unknown }).path;
    if (typeof p === "string" && p !== "") out.push(p);
  }
  return out;
}

/**
 * Normalise raw paths to the canonical `wiki/<domain>/<slug>.md` form the
 * dashboard intake classifies. Matches the normaliser in the existing
 * recall plugin so log records line up across writers.
 */
export function normaliseWikiPath(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  // Canonical form: strip both the cwd-relative-prefix encoding the brain
  // returns AND the leading "wiki/" so that hits from memory_search (which
  // come back as ".../digital-me/wiki/<domain>/<slug>.md") and from
  // memory_get / Read (which take bare "<domain>/<slug>.md") intersect
  // cleanly in our acted ∩ surfaced arithmetic.
  //
  // Match the existing digital-me-recall plugin's normalizeAccessedPath
  // semantics so records produced by both writers line up in the dashboard
  // intake (which treats bare paths as wiki/ via its back-compat branch).
  if (raw.includes("/wiki/")) return raw.split("/wiki/")[1] || null;
  if (raw.startsWith("wiki/")) return raw.slice("wiki/".length) || null;
  if (raw.startsWith("tastes/")) return raw; // tastes/ has a distinct tree
  if (raw.startsWith("memory/")) return null; // per-agent memory, not corpus
  if (raw.startsWith("/")) return null; // unmappable absolute path
  return raw; // already bare "<domain>/<slug>.md"
}

export function createAppRateWriter(
  input: CreateAppRateWriterInput,
): AppRateWriter {
  const {
    logPathForAgent,
    flushIntervalMs = 5 * 60 * 1000,
    staleBucketMs = 24 * 60 * 60 * 1000,
    fs = realFs(),
    now = Date.now,
    warn = () => {},
  } = input;

  const buckets = new Map<string, Bucket>();

  function getBucket(agentId: string): Bucket {
    const key = bucketKeyFor(agentId, now());
    let b = buckets.get(key);
    if (!b) {
      const t = now();
      b = {
        agentId,
        startedAt: t,
        surfaced: new Set(),
        accessed: new Set(),
        hookInjections: 0,
        rev: 0,
        lastFlushedRev: 0,
        lastActivityAt: t,
      };
      buckets.set(key, b);
    }
    return b;
  }

  function bump(b: Bucket): void {
    b.rev += 1;
    b.lastActivityAt = now();
  }

  function writeRecord(key: string, b: Bucket, reason: FlushReason, dropAfter: boolean): boolean {
    const target = logPathForAgent(b.agentId);
    if (!target) {
      // Skipped runtime (e.g. claude-code has its own writer)
      if (dropAfter) buckets.delete(key);
      return false;
    }
    if (b.surfaced.size === 0 && b.hookInjections === 0) {
      if (dropAfter) buckets.delete(key);
      return false;
    }

    const acted = new Set<string>();
    const ignored = new Set<string>();
    for (const p of b.surfaced) {
      if (b.accessed.has(p)) acted.add(p);
      else ignored.add(p);
    }

    const ts = new Date(now());
    const record = {
      ts: ts.toISOString(),
      session_id: key,
      session_date: ts.toISOString().slice(0, 10),
      agent_id: b.agentId,
      source: "live",
      surface: target.surface,
      started_at: new Date(b.startedAt).toISOString(),
      hook_injections: b.hookInjections,
      surfaced_unique: b.surfaced.size,
      acted_unique: acted.size,
      application_rate: b.surfaced.size > 0 ? acted.size / b.surfaced.size : null,
      acted_paths: [...acted].sort(),
      ignored_paths: [...ignored].sort(),
      flush_reason: reason,
    };

    try {
      fs.mkdirSync(dirnameOf(target.path), { recursive: true });
      fs.appendFileSync(target.path, JSON.stringify(record) + "\n");
      b.lastFlushedRev = b.rev;
    } catch (err) {
      warn(
        `brain-mcp-proxy: app_rate write failed (${target.path}): ${stringifyErr(err)}`,
      );
      return false;
    }

    if (dropAfter) buckets.delete(key);
    return true;
  }

  function flushAll(reason: FlushReason): void {
    const t = now();
    for (const [key, b] of [...buckets.entries()]) {
      try {
        if (staleBucketMs > 0 && t - b.lastActivityAt > staleBucketMs) {
          writeRecord(key, b, "stale", /*dropAfter=*/ true);
          continue;
        }
        if (b.rev === b.lastFlushedRev) continue;
        writeRecord(key, b, reason, /*dropAfter=*/ false);
      } catch (err) {
        warn(
          `brain-mcp-proxy: app_rate flush failed for ${key}: ${stringifyErr(err)}`,
        );
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (flushIntervalMs > 0) {
    timer = setInterval(() => {
      try {
        flushAll("periodic");
      } catch (err) {
        warn(`brain-mcp-proxy: periodic flush crashed: ${stringifyErr(err)}`);
      }
    }, flushIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  let shut = false;

  return {
    recordSearch({ agentId, toolName, result }) {
      if (toolName !== "memory_search") return;
      if (result.isError) return;
      try {
        const paths = extractHitPaths(result);
        if (paths.length === 0) return;
        const b = getBucket(agentId);
        let added = 0;
        for (const raw of paths) {
          const norm = normaliseWikiPath(raw);
          if (norm) {
            if (!b.surfaced.has(norm)) added++;
            b.surfaced.add(norm);
          }
        }
        b.hookInjections += 1;
        if (added > 0 || b.hookInjections === 1) bump(b);
        else b.lastActivityAt = now(); // keep alive
      } catch (err) {
        warn(`brain-mcp-proxy: app_rate recordSearch failed: ${stringifyErr(err)}`);
      }
    },

    recordGet({ agentId, toolName, args }) {
      // memory_get, plus also accept claude-code-style read tools so a future
      // proxy-routed Read call would be observed. Today only memory_get
      // routes through this proxy — the others are file-system reads handled
      // by the client itself.
      if (toolName !== "memory_get") return;
      try {
        const raw = (args.path ?? args.file_path) as unknown;
        if (typeof raw !== "string" || raw === "") return;
        const norm = normaliseWikiPath(raw);
        if (!norm) return;
        const b = getBucket(agentId);
        const before = b.accessed.size;
        b.accessed.add(norm);
        if (b.accessed.size !== before) bump(b);
      } catch (err) {
        warn(`brain-mcp-proxy: app_rate recordGet failed: ${stringifyErr(err)}`);
      }
    },

    flushAll,

    shutdown() {
      if (shut) return;
      shut = true;
      try {
        if (timer) clearInterval(timer);
      } catch {
        // best-effort
      }
      try {
        flushAll("exit");
      } catch {
        // best-effort
      }
    },
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────

function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function realFs(): AppRateFs {
  // Lazy node:fs import — keep the indirection so tests substitute trivially.
  const fsMod = cjsRequire("node:fs") as typeof import("node:fs");
  return {
    mkdirSync: (p, opts) => fsMod.mkdirSync(p, opts),
    appendFileSync: (p, data) => fsMod.appendFileSync(p, data, "utf8"),
  };
}

// ─── default agent → log path policy ──────────────────────────────────────

/**
 * Default policy: write hermes-* agents to the hermes log, claude-code
 * agents are skipped (their Stop-hook writer already records them), and
 * everyone else goes to the openclaw log.
 *
 * Pure helper so tests can verify the policy without setting up a real
 * writer.
 */
export function defaultLogPathForAgent(
  agentId: string,
  paths: { openclawLog: string; hermesLog: string },
): LogTarget | null {
  if (!agentId) return { path: paths.openclawLog, surface: "openclaw" };
  const a = agentId.toLowerCase();
  if (a.startsWith("claude-code") || a.startsWith("unknown:claude")) return null;
  if (a.startsWith("hermes")) return { path: paths.hermesLog, surface: "hermes" };
  return { path: paths.openclawLog, surface: "openclaw" };
}
