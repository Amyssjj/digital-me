// digital-me-recall — openclaw plugin entry.
//
// Auto-applies wiki knowledge to every agent turn and tool call. Four hooks:
//
//   Hook A — before_prompt_build (first turn): injects the digital-me
//            protocol + ACTIVE POLICIES from ~/digital-me/_INDEX.md.
//
//   Hook B — before_prompt_build (every turn): runs memory_search on the
//            current prompt, follows `related:` graph edges, injects the
//            top matches as appendSystemContext.
//
//   Hook C — before_tool_call: O(1) hashmap lookup of wiki entries
//            tagged with `route:`. Caches the index at startup, refreshes
//            on file changes.
//
//   Hook D — after_tool_call (on memory_search): logs query + hit count
//            to brain.db `traces` table. Feeds the promotion pipeline.
//
// Pairs with `digital-me-brain` — that plugin provides the brain.db Hook D
// writes into, plus the MCP tools agents call directly. This plugin is
// hooks-only; it registers zero MCP tools.
//
// Prerequisites:
//   1. openclaw installed (this file imports from its plugin SDK).
//   2. memory-core (or another memory backend plugin) enabled in
//      openclaw config — provides memory_search to Hook B.
//   3. @digital-me/runtime-openclaw installed alongside this entry
//      (provides the hook library).

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";

import {
  applyRecallHygiene,
  buildMemorySearchTrace,
  buildRouteIndex,
  extractFrontmatterText,
  formatRecallInjection,
  formatRouteInjection,
  loadBootContext,
  matchRouteConditions,
  parseDigitalMeAck,
  parseRelatedField,
  warnIfUntestedHost,
} from "@digital-me/runtime-openclaw";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const DEFAULTS = {
  wikiRoot: path.join(os.homedir(), "digital-me", "wiki"),
  indexPath: path.join(os.homedir(), "digital-me", "_INDEX.md"),
  protocolsDir: path.join(os.homedir(), ".openclaw", "shared_protocols"),
  recallMaxResults: 5,
  recallGraphDepth: 1,
  brainDbPath: path.join(os.homedir(), ".openclaw", "data", "brain.db"),
};

const DIGITAL_ME_PROTOCOL = `You are connected to the Digital Me ecosystem — a Living Knowledge wiki
at ~/digital-me/wiki/ that captures rules, gotchas, and preferences for
this user.

Behavioral rules:
1. Before starting non-trivial work, call memory_search with the task topic.
2. Wiki entries marked priority: always are mandatory; treat as policy.
3. When you write a wiki entry about a specific tool's behavior, include
   route: tool=<name>, params.<field> contains "<value>" in the frontmatter
   so future tool calls auto-recall it (see digital-me-recall Hook C).
4. After completing a task, capture reusable insights via learning_capture
   (provided by digital-me-brain).`;

// ─── Module-level M1 application_rate state (2026-05-26) ────────────────
//
// The openclaw gateway re-invokes register() multiple times per process
// (initial load + config hot reload + periodic re-discovery). Keeping
// session state and the periodic-flush timer at MODULE level — not
// register() closure — means:
//
//   1. Session accumulators survive re-registration; state isn't lost
//      when the gateway re-instantiates the plugin entry.
//   2. The periodic-flush timer is created exactly once per process
//      (idempotent guard below), so re-registers don't spawn duplicate
//      flush threads.
//   3. process.on("exit"/"SIGTERM"/"SIGINT") handlers are added once,
//      avoiding listener-leak warnings.
//
// Hook handlers themselves still live inside register() — they close
// over `api` which is per-register — but they read/write the module-
// level state through the helpers defined below.

const APPLICATION_RATE_LOG = path.join(
  os.homedir(),
  ".openclaw",
  "data",
  "application_rate_openclaw.log",
);

// ─── M1 universal-protocol event sink (2026-05-27) ──────────────────────
//
// Canonical event WAL — one canonical M1 event per line. Mirrors what
// hermes (~/.openclaw/data/m1_events_hermes.jsonl) and claude-code
// (~/.openclaw/data/m1_events_claude_code.jsonl) emit. See wiki:
// infrastructure/m1-universal-event-protocol.md
const M1_EVENTS_WAL = path.join(
  os.homedir(),
  ".openclaw",
  "data",
  "m1_events_openclaw.jsonl",
);

// Once-only per-session session_start guard. Reset on module reload —
// the seed-from-WAL routine below repopulates from disk on register().
const m1SessionStarted = new Set();
// sessionKey → rev at last session_snapshot emit
const m1SessionSnapshotRev = new Map();

const M1_V1_EVENT_TYPES = new Set([
  "session_start",
  "knowledge_surfaced",
  "assistant_ack",
  "session_snapshot",
  "session_end",
]);

function m1DeriveEventId(sessionId, turnId, eventType, entries, ackSignal) {
  // Stable id matching the brain handler + claude-code + hermes derivers.
  // Same inputs → same id → brain INSERT OR IGNORE catches retries.
  const crypto = require("node:crypto");
  const entriesKey = JSON.stringify(
    (entries || []).map((e) => [e?.path ?? "", e?.score ?? null]),
  );
  const h = crypto
    .createHash("sha1")
    .update(entriesKey + "|" + (ackSignal || ""))
    .digest("hex")
    .slice(0, 12);
  return `${sessionId}::${turnId || "_"}::${eventType}::${h}`;
}

function m1WalAppend(payload) {
  try {
    fs.mkdirSync(path.dirname(M1_EVENTS_WAL), { recursive: true });
    fs.appendFileSync(M1_EVENTS_WAL, JSON.stringify(payload) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort direct write of one M1 event to brain.db's m1_events
 * table via the brainDb SQLite handle the plugin already maintains
 * for Hook D's trace inserts.
 *
 * Why direct write instead of HTTP-to-self: this plugin runs INSIDE
 * the openclaw gateway process, so we have in-process access to the
 * same brain.db the m1_event_record MCP handler would write to. Direct
 * write avoids the bootstrap-time HTTP loopback (gateway not fully
 * listening yet) and saves a round-trip on every event.
 *
 * The brain plugin owns the m1_events table migration; if this plugin
 * loads before the brain plugin in a fresh install, the INSERT throws
 * and we swallow it — the WAL line is on disk and m1_backfill replays
 * once the table exists.
 */
function m1WriteToBrainDb(brainDb, event) {
  if (!brainDb) return false;
  try {
    brainDb
      .prepare(
        `INSERT OR IGNORE INTO m1_events
          (event_id, schema_version, metric, runtime, agent_id, session_id,
           turn_id, event_type, entries_json, ack_signal, extra_json, t)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.event_id,
        event.schema_version ?? 1,
        event.metric ?? "m1_application_rate",
        event.runtime,
        event.agent_id,
        event.session_id,
        event.turn_id ?? null,
        event.event_type,
        JSON.stringify(event.entries ?? []),
        event.ack_signal ?? null,
        JSON.stringify(event.extra ?? {}),
        event.t,
      );
    return true;
  } catch {
    return false;
  }
}

// Module-level handle to the brainDb — populated by m1InitBrainDb on
// plugin register. Stays as null when the brain plugin isn't loaded yet
// (events still land in the WAL for later backfill).
let m1BrainDb = null;

function m1InitBrainDb(db) {
  m1BrainDb = db;
}

/**
 * Build + emit one canonical M1 event. Two-step durability:
 *   1. WAL append (sync, always tried first — source of truth)
 *   2. Best-effort direct write to brain.db.m1_events (sync, in-process)
 *
 * Caller stays sync — both ops are synchronous SQLite + filesystem
 * appends. Failure on either is swallowed; WAL is the durable backstop.
 */
function m1Emit({
  eventType,
  sessionId,
  agentId,
  turnId = "0",
  entries = [],
  ackSignal = null,
  extra = null,
}) {
  if (!M1_V1_EVENT_TYPES.has(eventType)) return;
  const payload = {
    event_id: m1DeriveEventId(sessionId, turnId, eventType, entries, ackSignal),
    schema_version: 1,
    metric: "m1_application_rate",
    runtime: "openclaw",
    agent_id: agentId || "unknown",
    session_id: sessionId,
    turn_id: String(turnId),
    event_type: eventType,
    entries,
    t: Date.now(),
  };
  if (ackSignal) payload.ack_signal = ackSignal;
  if (extra && Object.keys(extra).length > 0) payload.extra = extra;

  m1WalAppend(payload);
  m1WriteToBrainDb(m1BrainDb, payload);
}

function m1MaybeEmitSessionStart(sessionId, agentId) {
  if (!sessionId || m1SessionStarted.has(sessionId)) return;
  m1SessionStarted.add(sessionId);
  m1Emit({
    eventType: "session_start",
    sessionId,
    agentId,
    turnId: "0",
    entries: [],
  });
}

/**
 * Seed `m1SessionStarted` from the WAL on plugin register (mirrors
 * hermes pattern). Without this, module reload spawns duplicate
 * session_start events for sessions that already had one.
 */
function m1SeedSessionStartedFromWal(maxLines = 5000) {
  if (!fs.existsSync(M1_EVENTS_WAL)) return 0;
  let seeded = 0;
  try {
    // Tail-read: a few hundred KB max for max_lines=5000 (avg ~300B/line).
    const stat = fs.statSync(M1_EVENTS_WAL);
    const readSize = Math.min(stat.size, maxLines * 256);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(M1_EVENTS_WAL, "r");
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const tail = buf.toString("utf8").split("\n").slice(-maxLines);
    for (const line of tail) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (ev.event_type !== "session_start") continue;
        const sid = ev.session_id;
        if (typeof sid === "string" && sid && !m1SessionStarted.has(sid)) {
          m1SessionStarted.add(sid);
          seeded++;
        }
      } catch {
        // skip bad line
      }
    }
  } catch {
    // best-effort
  }
  return seeded;
}

/**
 * Emit session_snapshot or session_end with cumulative session metrics.
 * Mirrors the hermes `_emit_session_lifecycle_m1` helper.
 */
function m1EmitSessionLifecycle({ sessionId, eventType, reason }) {
  if (eventType !== "session_snapshot" && eventType !== "session_end") return;
  const stats = m1SessionStats.get(sessionId);
  if (!stats) return;
  const surfaced = m1SessionSeen.get(sessionId) ?? new Set();
  const acted = new Set([...surfaced].filter((p) => stats.accessed.has(p)));
  if (surfaced.size === 0 && stats.hook_injections === 0) return;

  const entries = [...surfaced].sort().map((p) => ({ path: p }));
  m1Emit({
    eventType,
    sessionId,
    agentId: stats.agent_id,
    turnId: String(stats.hook_injections),
    entries,
    extra: {
      reason,
      hook_injections: stats.hook_injections,
      surfaced_unique: surfaced.size,
      acted_unique: acted.size,
      acted_paths: [...acted].sort(),
    },
  });
  m1SessionSnapshotRev.set(sessionId, stats.rev);
}

// sessionKey → { hook_injections, accessed: Set, agent_id, started_at, rev, lastFlushedRev, lastActivityAt }
const m1SessionStats = new Map();
// sessionKey → Set<path>
const m1SessionSeen = new Map();

let m1WriterInitialized = false;
let m1FlushTimer = null;
let m1FlushIntervalMs = 5 * 60 * 1000;
let m1StaleSessionMs = 24 * 60 * 60 * 1000;
let m1Logger = null;

function m1GetSessionStats(sessionKey, agentId) {
  const k = sessionKey || "_no_session";
  let s = m1SessionStats.get(k);
  if (!s) {
    s = {
      hook_injections: 0,
      accessed: new Set(),
      agent_id: agentId || "unknown",
      started_at: new Date().toISOString(),
      rev: 0,
      lastFlushedRev: 0,
      lastActivityAt: Date.now(),
      // Set when knowledge_surfaced is emitted; read by the agent_end hook
      // to pair the assistant reply's ack with this turn's surfaced entries.
      // { turnId: string, entries: Array<{path,title,score,source}> } | null
      lastSurfaced: null,
      // turn_ids already acked, so a re-fired agent_end (or module reload)
      // doesn't double-emit. The brain dedupes via event_id too, but this
      // avoids re-parsing the reply needlessly.
      ackedTurns: new Set(),
    };
    m1SessionStats.set(k, s);
  } else if (!s.agent_id && agentId) {
    s.agent_id = agentId;
  }
  return s;
}

function m1BumpActivity(stats) {
  stats.rev += 1;
  stats.lastActivityAt = Date.now();
}

function m1NormalizeAccessedPath(raw) {
  if (!raw || typeof raw !== "string") return null;
  if (raw.includes("/wiki/")) return raw.split("/wiki/")[1];
  if (raw.startsWith("memory/")) return raw;
  if (raw.startsWith("/")) return null;
  return raw;
}

function m1WriteAppRateRecord(sessionKey, stats, reason, dropAfter = false) {
  const surfaced = m1SessionSeen.get(sessionKey) ?? new Set();
  const acted = new Set([...surfaced].filter((p) => stats.accessed.has(p)));
  const ignored = new Set([...surfaced].filter((p) => !stats.accessed.has(p)));

  if (surfaced.size === 0 && stats.hook_injections === 0) {
    if (dropAfter) {
      m1SessionStats.delete(sessionKey);
      m1SessionSeen.delete(sessionKey);
    }
    return false;
  }

  const now = new Date();
  const record = {
    ts: now.toISOString(),
    session_id: sessionKey,
    session_date: now.toISOString().slice(0, 10),
    agent_id: stats.agent_id || "unknown",
    source: "live",
    surface: "openclaw",
    started_at: stats.started_at,
    hook_injections: stats.hook_injections,
    surfaced_unique: surfaced.size,
    acted_unique: acted.size,
    application_rate: surfaced.size > 0 ? acted.size / surfaced.size : null,
    acted_paths: [...acted].sort(),
    ignored_paths: [...ignored].sort(),
    flush_reason: reason,
  };

  try {
    fs.mkdirSync(path.dirname(APPLICATION_RATE_LOG), { recursive: true });
  } catch {
    // best-effort
  }
  fs.appendFileSync(
    APPLICATION_RATE_LOG,
    JSON.stringify(record) + "\n",
    "utf8",
  );
  stats.lastFlushedRev = stats.rev;
  console.error(
    `[DM-RECALL-APP-RATE] session=${sessionKey.slice(0, 8)} agent=${
      record.agent_id
    } reason=${reason} inj=${record.hook_injections} surf=${record.surfaced_unique} acted=${
      record.acted_unique
    } rate=${record.application_rate === null ? "n/a" : record.application_rate.toFixed(3)}`,
  );
  if (dropAfter) {
    m1SessionStats.delete(sessionKey);
    m1SessionSeen.delete(sessionKey);
  }
  return true;
}

function m1FlushAllSessions(reason) {
  const now = Date.now();
  for (const [sessionKey, stats] of [...m1SessionStats.entries()]) {
    try {
      if (now - stats.lastActivityAt > m1StaleSessionMs) {
        // Finalize as canonical session_end before drop (universal-protocol
        // event), then the legacy aggregate record.
        m1EmitSessionLifecycle({
          sessionId: sessionKey,
          eventType: "session_end",
          reason: "stale",
        });
        m1WriteAppRateRecord(sessionKey, stats, "stale", /*dropAfter=*/ true);
        continue;
      }
      if (stats.rev === stats.lastFlushedRev) continue;
      // Canonical session_snapshot event on periodic flush — but only
      // if there's actually new activity since the last snapshot.
      if (
        (m1SessionSnapshotRev.get(sessionKey) ?? -1) !== stats.rev
      ) {
        m1EmitSessionLifecycle({
          sessionId: sessionKey,
          eventType: "session_snapshot",
          reason,
        });
      }
      m1WriteAppRateRecord(sessionKey, stats, reason, /*dropAfter=*/ false);
    } catch (err) {
      m1Logger?.warn?.(
        `digital-me-recall: ${reason} flush failed for ${sessionKey}: ${err.message}`,
      );
    }
  }
}

function m1InitWriterOnce({ flushIntervalMs, staleSessionMs, logger }) {
  // Always refresh tunables on re-register so config hot reloads take
  // effect without restarting the timer.
  m1FlushIntervalMs = flushIntervalMs;
  m1StaleSessionMs = staleSessionMs;
  m1Logger = logger ?? m1Logger;
  if (m1WriterInitialized) return;
  m1WriterInitialized = true;

  if (m1FlushIntervalMs > 0) {
    m1FlushTimer = setInterval(() => {
      try {
        m1FlushAllSessions("periodic");
      } catch (err) {
        m1Logger?.warn?.(
          `digital-me-recall: periodic flush failed: ${err.message}`,
        );
      }
    }, m1FlushIntervalMs);
    if (typeof m1FlushTimer.unref === "function") m1FlushTimer.unref();
  }

  // Process-exit flush — guarded once-only so we don't add a fresh
  // listener on every register() invocation. appendFileSync is sync,
  // so a record actually makes it to disk before the process dies.
  const exitFlush = () => {
    try {
      m1FlushAllSessions("exit");
    } catch {
      // best-effort
    }
  };
  process.on("exit", exitFlush);
  process.on("SIGINT", exitFlush);
  process.on("SIGTERM", exitFlush);
}

export default definePluginEntry({
  id: "digital-me-recall",
  name: "Digital Me Recall",
  description:
    "Auto-applies wiki knowledge: boot-time protocol injection, per-turn memory_search recall with graph expansion, per-tool routed reminders, and memory_search observability.",
  register(api) {
    // Guard: bail during build-time scan when runtime isn't available
    if (!api.runtime) {
      api.logger.info("digital-me-recall: skip register — runtime not available (build-time scan)");
      return;
    }

    // Compatibility: warn (never block) if the host openclaw is newer than the
    // verified range. The hard floor is enforced by openclaw via package.json
    // install.minHostVersion; this covers the too-new side.
    warnIfUntestedHost(api, "digital-me-recall");

    const wikiRoot = api.pluginConfig?.wikiRoot || DEFAULTS.wikiRoot;
    const indexPath = api.pluginConfig?.indexPath || DEFAULTS.indexPath;
    const protocolsDir = api.pluginConfig?.protocolsDir || DEFAULTS.protocolsDir;
    const recallMaxResults =
      api.pluginConfig?.recallMaxResults ?? DEFAULTS.recallMaxResults;
    const recallGraphDepth =
      api.pluginConfig?.recallGraphDepth ?? DEFAULTS.recallGraphDepth;
    const enableRouteHashmap = api.pluginConfig?.enableRouteHashmap !== false;
    const enableObservability = api.pluginConfig?.enableObservability !== false;
    const brainDbPath = api.pluginConfig?.brainDbPath || DEFAULTS.brainDbPath;
    // Per-event stderr diagnostics (hook A/C/D chatter) land in
    // gateway.err.log on every prompt build and tool call — off by default,
    // opt in via pluginConfig.debug when tracing hook flow. Genuine
    // error-path logging stays unconditional.
    const debug = api.pluginConfig?.debug === true;

    // ─── Pre-cache boot context (Hook A) ──────────────────────────────
    const fsAccess = {
      readFile: (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
      existsSync: (p) => fs.existsSync(p),
      readdirSync: (p) => fs.readdirSync(p),
    };
    let cachedBootContext = loadBootContext(
      {
        digitalMeProtocol: DIGITAL_ME_PROTOCOL,
        activePoliciesPath: indexPath,
        protocolsDir,
      },
      fsAccess,
    );
    // Watch _INDEX.md so ACTIVE POLICIES stays fresh after dream-cycle reruns
    if (fs.existsSync(indexPath)) {
      try {
        let debounce = null;
        fs.watch(indexPath, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            cachedBootContext = loadBootContext(
              {
                digitalMeProtocol: DIGITAL_ME_PROTOCOL,
                activePoliciesPath: indexPath,
                protocolsDir,
              },
              fsAccess,
            );
            api.logger.info(`digital-me-recall: boot context reloaded (${cachedBootContext.length} chars)`);
          }, 1000);
        });
      } catch {
        // best-effort
      }
    }

    // ─── Pre-build route hashmap (Hook C) ─────────────────────────────
    let routeIndex = new Map();
    if (enableRouteHashmap && fs.existsSync(wikiRoot)) {
      const allEntries = walkMarkdownFiles(wikiRoot);
      routeIndex = buildRouteIndex(allEntries);
      api.logger.info(
        `digital-me-recall: routeIndex built — ${routeIndex.size} tools, ` +
          `${[...routeIndex.values()].reduce((s, v) => s + v.length, 0)} rules`,
      );
      // Live-reload on wiki changes (one-second debounce)
      try {
        let debounce = null;
        fs.watch(wikiRoot, { recursive: true }, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            routeIndex = buildRouteIndex(walkMarkdownFiles(wikiRoot));
            api.logger.info(`digital-me-recall: routeIndex reloaded (${routeIndex.size} tools)`);
          }, 1000);
        });
      } catch {
        // recursive watch unsupported on this platform — accept stale index
      }
    }

    // ─── Open brain.db connection for Hook D + M1 emitter ─────────────
    // Opened unconditionally — Hook D is gated by enableObservability,
    // but the M1 universal-protocol emitter (which writes to a separate
    // m1_events table owned by digital-me-brain) needs a handle even
    // when observability is off. Both writers are best-effort; an
    // unavailable brain.db just routes events to the WAL for backfill.
    let brainDb = null;
    try {
      brainDb = new DatabaseSync(brainDbPath);
      // Second in-process writer to brain.db — without a busy_timeout a
      // WAL checkpoint by the brain plugin makes our INSERTs throw
      // SQLITE_BUSY immediately (and get swallowed). Match the brain
      // plugin's 5s wait.
      brainDb.exec("PRAGMA busy_timeout=5000");
      // Schema migrations for both traces (v700) and m1_events (v710)
      // are owned by digital-me-brain. If brain hasn't run yet, our
      // INSERTs will throw and we swallow them — events land in the
      // WAL for m1_backfill to replay later.
    } catch (err) {
      api.logger.warn(`digital-me-recall: brain.db open failed: ${err.message}`);
    }
    // Make the brainDb handle available to the module-level M1 emitter.
    m1InitBrainDb(brainDb);
    // Seed the once-only session_start guard from the WAL so module
    // reload doesn't re-fire session_start for in-flight sessions.
    const m1Seeded = m1SeedSessionStartedFromWal();

    // ─── Hook A — Boot Context (first turn) ───────────────────────────
    api.on("before_prompt_build", async (event, ctx) => {
      if (debug) {
        console.error(
          `[DM-RECALL-HOOK-A] before_prompt_build firstTurn=${!event.messages || event.messages.length <= 1} agentId=${ctx?.agentId ?? "?"}`,
        );
      }
      const isFirstTurn = !event.messages || event.messages.length <= 1;
      if (!isFirstTurn) return;
      if (!cachedBootContext) return;
      return { appendSystemContext: cachedBootContext };
    });

    // ─── Hook B — Per-Turn Recall (every turn) ────────────────────────
    // Per-session dedup cache (M1 fix, 2026-05-22): track wiki paths already
    // surfaced this session so we don't keep re-injecting the same entries.
    // Keyed by sessionKey; the inner Set holds normalized paths. Shared
    // with the M1 application_rate writer via the module-level
    // m1SessionSeen (see the module header) so re-registration doesn't
    // discard accumulated dedup state.
    const sessionSeen = m1SessionSeen;
    const RECALL_MIN_SCORE = api.pluginConfig?.recallMinScore ?? 0.4;
    const RECALL_TOP1_BODY_CHARS = api.pluginConfig?.recallTop1BodyChars ?? 2000;
    const wikiReader = {
      readFile: (p) => {
        try {
          return fs3.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
      existsSync: (p) => {
        try {
          return fs3.existsSync(p);
        } catch {
          return false;
        }
      },
    };

    // ─── M1 application-rate tracking (2026-05-22, self-contained 2026-05-26) ──
    // Per-session counters for the session_end live writer. Mirrors the
    // Claude-Code-side application_rate.log shape so M1/M2 analysis is
    // uniform across the two surfaces.
    //
    // 2026-05-26: state and timers are MODULE-LEVEL (see m1SessionStats,
    // m1SessionSeen above) so they survive openclaw's multi-register
    // gateway lifecycle. The wiki entry
    // m1-application-rate-openclaw-hermes-hook-lifecycle.md documents the
    // root cause; this plugin's self-contained writer adds three triggers
    // — periodic flush, stale-session GC, and process-exit flush — that
    // do not depend on session_end firing reliably.
    m1InitWriterOnce({
      flushIntervalMs:
        api.pluginConfig?.appRateFlushIntervalMs ?? 5 * 60 * 1000,
      staleSessionMs:
        api.pluginConfig?.appRateStaleSessionMs ?? 24 * 60 * 60 * 1000,
      logger: api.logger,
    });

    if (recallMaxResults > 0) {
      api.on("before_prompt_build", async (event, ctx) => {
        const prompt = event.prompt || "";
        if (!prompt.trim()) return;
        try {
          const memory = await getActiveMemorySearchManager({
            cfg: api.config,
            agentId: ctx.agentId,
          });
          if (!memory.manager) return;
          const hits = await memory.manager.search(prompt, {
            maxResults: recallMaxResults,
            sessionKey: ctx.sessionKey,
          });
          if (!hits || hits.length === 0) return;

          // Expand hits via `related:` graph edges (1-hop by default)
          const seeds = hits
            .filter((h) => h && h.path)
            .map((h) => ({
              path: h.path,
              title: h.title,
              body: h.body ?? h.snippet ?? "",
              score: h.score,
            }));
          const expanded = expandHitsViaGraph(seeds, wikiRoot, recallGraphDepth);

          // M1 hygiene: score-gate, per-session dedup, inline top-1 full body.
          const sessionKey = ctx.sessionKey || "_no_session";
          if (!sessionSeen.has(sessionKey)) sessionSeen.set(sessionKey, new Set());
          const seen = sessionSeen.get(sessionKey);
          const hygienic = applyRecallHygiene({
            hits: expanded,
            seen,
            minScore: RECALL_MIN_SCORE,
            bodyMaxChars: RECALL_TOP1_BODY_CHARS,
            wikiRoot,
            reader: wikiReader,
          });
          if (hygienic.length === 0) return;

          const injection = formatRecallInjection(hygienic);
          if (!injection) return;
          // M1 tracking: count this as a hook injection for the session.
          const sStats = m1GetSessionStats(sessionKey, ctx.agentId);
          sStats.hook_injections += 1;
          m1BumpActivity(sStats);

          // ── M1 universal-protocol events (2026-05-27) ────────────────
          // session_start once per session, then knowledge_surfaced
          // with the surfaced entry universe for this turn.
          m1MaybeEmitSessionStart(sessionKey, ctx.agentId);
          const surfacedSeen = new Set();
          const surfacedForEvent = [];
          for (const h of hygienic) {
            const norm = m1NormalizeAccessedPath(h.path) || h.path;
            if (!norm || surfacedSeen.has(norm)) continue;
            surfacedSeen.add(norm);
            surfacedForEvent.push({
              path: norm,
              title: h.title || "",
              score: h.score ?? null,
              source: "memory_search",
            });
          }
          const surfacedTurnId = String(sStats.hook_injections);
          m1Emit({
            eventType: "knowledge_surfaced",
            sessionId: sessionKey,
            agentId: ctx.agentId || sStats.agent_id,
            turnId: surfacedTurnId,
            entries: surfacedForEvent,
          });
          // Remember this turn's surfaced universe so the agent_end hook can
          // pair the assistant reply's [Digital Me] ack against it.
          sStats.lastSurfaced = {
            turnId: surfacedTurnId,
            entries: surfacedForEvent,
          };

          return { appendSystemContext: injection };
        } catch (err) {
          api.logger.warn(`digital-me-recall: recall failed: ${err.message}`);
        }
      });
    }

    // ─── Hook C — Per-Tool Route ──────────────────────────────────────
    if (enableRouteHashmap) {
      api.on("before_tool_call", async (event, ctx) => {
        if (debug) {
          console.error(
            `[DM-RECALL-HOOK-C] before_tool_call toolName=${event.toolName} agentId=${ctx?.agentId ?? "?"}`,
          );
        }
        const rules = routeIndex.get(event.toolName);
        if (!rules || rules.length === 0) return;
        const matched = rules.filter((r) =>
          matchRouteConditions(r.conditions, event.params || {}),
        );
        if (matched.length === 0) return;
        const injection = formatRouteInjection(matched);
        if (!injection) return;
        return { appendSystemContext: injection };
      });
    }

    // ─── Hook D — Observability (memory_search trace) ─────────────────
    // Console.error path is deliberate — api.logger.info doesn't appear
    // to surface in gateway.log on this build, so for diagnostic
    // visibility we shadow critical events to stderr (which lands in
    // ~/.openclaw/logs/gateway.err.log). The tag `[DM-RECALL-HOOK-D]`
    // is unique so we can grep for it without false positives. Gated
    // behind pluginConfig.debug so it doesn't grow gateway.err.log on
    // every tool call in normal operation.
    if (debug) {
      console.error(
        `[DM-RECALL-HOOK-D] init: enableObservability=${enableObservability} brainDb=${brainDb ? "open" : "null"}`,
      );
    }
    if (enableObservability && brainDb) {
      api.on("after_tool_call", async (event, ctx) => {
        // Diagnostic: log every tool call so we can see what toolNames flow
        if (debug) {
          console.error(
            `[DM-RECALL-HOOK-D] after_tool_call toolName=${event.toolName} agentId=${ctx?.agentId ?? "?"} error=${event.error ? "yes" : "no"}`,
          );
        }
        if (event.toolName !== "memory_search") return;
        if (event.error) return; // only log successful searches
        try {
          const query =
            typeof event.params?.query === "string" ? event.params.query : "";
          const hitCount = Array.isArray(event.result?.hits)
            ? event.result.hits.length
            : 0;
          const trace = buildMemorySearchTrace({
            agentId: ctx.agentId || "unknown",
            sessionKey: ctx.sessionKey,
            query,
            hitCount,
          });
          brainDb
            .prepare(
              `INSERT INTO traces (id, agent_id, kind, payload, t)
               VALUES (?, ?, 'memory_search', ?, ?)`,
            )
            .run(
              cryptoRandomId(),
              trace.agentId,
              JSON.stringify({
                query: trace.query,
                hitCount: trace.hitCount,
                sessionKey: trace.sessionKey,
              }),
              Date.now(),
            );
          if (debug) {
            console.error(
              `[DM-RECALL-HOOK-D] trace INSERTED query="${query.slice(0, 60)}" hits=${hitCount}`,
            );
          }
        } catch (err) {
          // Fire-and-forget; never throw from after_tool_call
          console.error(`[DM-RECALL-HOOK-D] trace INSERT failed: ${err.message}`);
          api.logger.warn(`digital-me-recall: trace insert failed: ${err.message}`);
        }
      });
    }

    // ─── M1 application-rate tracking — accessed-path observer ────────
    // Always on (independent of brain.db observability). Tracks memory_get
    // / wiki Read calls into the per-session accessed set so session_end
    // (and the periodic flush) can compute acted ∩ surfaced.
    api.on("after_tool_call", async (event, ctx) => {
      try {
        if (event.error) return;
        const name = event.toolName;
        if (
          name !== "memory_get" &&
          name !== "Read" &&
          name !== "read_file"
        ) {
          return;
        }
        let raw;
        if (name === "memory_get") {
          raw = event.params?.path;
        } else {
          raw = event.params?.file_path ?? event.params?.path;
        }
        const norm = m1NormalizeAccessedPath(typeof raw === "string" ? raw : "");
        if (!norm) return;
        const stats = m1GetSessionStats(ctx.sessionKey, ctx.agentId);
        const before = stats.accessed.size;
        stats.accessed.add(norm);
        if (stats.accessed.size !== before) m1BumpActivity(stats);
      } catch {
        // Tracking must never fail the tool call.
      }
    });

    // ─── M1 assistant_ack emitter — agent_end (per-turn reply parse) ──
    // OpenClaw's analogue of the claude-code Stop hook and the hermes
    // post_llm_call: at the end of each turn, parse the assistant reply for
    // the [Digital Me] application-start marker and emit an assistant_ack
    // paired with this turn's surfaced entries. Without this, OpenClaw emits
    // knowledge_surfaced but never assistant_ack — so the M1 scorer (which
    // pairs surfaced↔ack) reports 0% application_rate for openclaw.
    // Fire-and-forget; tracking must never fail the turn.
    api.on("agent_end", async (event, ctx) => {
      try {
        if (!event || !event.success) return;
        const messages = event.messages;
        if (!Array.isArray(messages) || messages.length === 0) return;
        const sessionKey = ctx?.sessionKey || "_no_session";
        const stats = m1SessionStats.get(sessionKey);
        const surfaced = stats?.lastSurfaced;
        // Nothing surfaced this turn → nothing to acknowledge.
        if (!surfaced || !Array.isArray(surfaced.entries) || surfaced.entries.length === 0) {
          return;
        }
        if (stats.ackedTurns.has(surfaced.turnId)) return; // already acked

        // Extract the last assistant message's text (string or content blocks).
        let assistantText = "";
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (!msg || typeof msg !== "object" || msg.role !== "assistant") continue;
          const content = msg.content;
          if (typeof content === "string") {
            assistantText = content;
          } else if (Array.isArray(content)) {
            assistantText = content
              .filter(
                (b) =>
                  b && typeof b === "object" && b.type === "text" &&
                  typeof b.text === "string",
              )
              .map((b) => b.text)
              .join("\n");
          }
          break; // newest assistant message only
        }
        if (!assistantText) return;

        const { ackSignal, actedEntries } = parseDigitalMeAck(
          assistantText,
          surfaced.entries,
        );
        m1Emit({
          eventType: "assistant_ack",
          sessionId: sessionKey,
          agentId: ctx?.agentId || stats.agent_id,
          turnId: surfaced.turnId,
          entries: actedEntries,
          ackSignal,
          extra: { ack_method: "agent_end_reply_parse" },
        });
        stats.ackedTurns.add(surfaced.turnId);
        // Mirror acted paths into the accessed set so the session_end /
        // periodic legacy-log writer (acted = surfaced ∩ accessed) agrees
        // with the per-turn ack signal.
        for (const e of actedEntries) {
          const norm = m1NormalizeAccessedPath(e.path) || e.path;
          if (norm) stats.accessed.add(norm);
        }
        m1BumpActivity(stats);
      } catch (err) {
        api.logger.warn(
          `digital-me-recall: agent_end ack emit failed: ${err.message}`,
        );
      }
    });

    // ─── assistant_ack — before_message_write (acpx / embedded runtime) ──
    // `agent_end` is dispatched ONLY by openclaw's cli-runner and codex
    // run-attempt paths. The acpx embedded runtime backend (the COO agent)
    // never fires agent_end — it dispatches `before_message_write` when the
    // assistant reply is written. Without this handler, acpx-backed agents
    // surface knowledge but never ack, pinning their application_rate at 0%.
    // CONSTRAINTS: before_message_write is SYNCHRONOUS — the host drops any
    // Promise return (runSyncHookHandler warns + ignores it) — so this
    // handler must NOT be async/await; `m1Emit` is synchronous. It also
    // fires for user messages, so gate on `msg.role === "assistant"`.
    // Deduped against agent_end via stats.ackedTurns (no double-count).
    api.on("before_message_write", (event, ctx) => {
      try {
        const msg = event?.message;
        if (!msg || typeof msg !== "object" || msg.role !== "assistant") return;
        const sessionKey = ctx?.sessionKey || "_no_session";
        const stats = m1SessionStats.get(sessionKey);
        const surfaced = stats?.lastSurfaced;
        // Nothing surfaced this turn → nothing to acknowledge.
        if (!surfaced || !Array.isArray(surfaced.entries) || surfaced.entries.length === 0) {
          return;
        }
        if (stats.ackedTurns.has(surfaced.turnId)) return; // already acked

        // Extract the assistant message text (string or content blocks).
        let assistantText = "";
        const content = msg.content;
        if (typeof content === "string") {
          assistantText = content;
        } else if (Array.isArray(content)) {
          assistantText = content
            .filter(
              (b) =>
                b && typeof b === "object" && b.type === "text" &&
                typeof b.text === "string",
            )
            .map((b) => b.text)
            .join("\n");
        }
        if (!assistantText) return;

        const { ackSignal, actedEntries } = parseDigitalMeAck(
          assistantText,
          surfaced.entries,
        );
        m1Emit({
          eventType: "assistant_ack",
          sessionId: sessionKey,
          agentId: ctx?.agentId || stats.agent_id,
          turnId: surfaced.turnId,
          entries: actedEntries,
          ackSignal,
          extra: { ack_method: "before_message_write_reply_parse" },
        });
        stats.ackedTurns.add(surfaced.turnId);
        for (const e of actedEntries) {
          const norm = m1NormalizeAccessedPath(e.path) || e.path;
          if (norm) stats.accessed.add(norm);
        }
        m1BumpActivity(stats);
      } catch (err) {
        api.logger.warn(
          `digital-me-recall: before_message_write ack emit failed: ${err.message}`,
        );
      }
    });

    // ─── M1 application-rate live writer — session_end ────────────────
    // On session_end, compute per-session stats and append one JSONL record
    // to APPLICATION_RATE_LOG. Mirrors Claude Code's
    // ~/.claude/hooks/application_rate.log shape so M1/M2 analysis is
    // unified across surfaces. Fire-and-forget; failure must never affect
    // the agent.
    api.on("session_end", async (_event, ctx) => {
      try {
        const sessionKey = ctx.sessionKey || "_no_session";
        const stats = m1SessionStats.get(sessionKey);
        if (!stats) return; // nothing happened this session
        // Canonical session_end event first (uses session state before
        // the legacy writer drops it).
        m1EmitSessionLifecycle({
          sessionId: sessionKey,
          eventType: "session_end",
          reason: "session_end",
        });
        m1WriteAppRateRecord(sessionKey, stats, "session_end", /*dropAfter=*/ true);
      } catch (err) {
        api.logger.warn(
          `digital-me-recall: session_end app-rate write failed: ${err.message}`,
        );
      }
    });

    api.logger.info(
      `digital-me-recall: registered hooks (` +
        `boot=on, recall=${recallMaxResults > 0 ? "on" : "off"}, ` +
        `route=${enableRouteHashmap ? "on" : "off"}, ` +
        `observability=${enableObservability && brainDb ? "on" : "off"}, ` +
        `m1_emitter=${brainDb ? "on" : "wal-only"}, ` +
        `assistant_ack=agent_end+before_message_write, ` +
        `app_rate=on, periodic_flush_ms=${m1FlushIntervalMs}, ` +
        `m1_wal_seeded_sessions=${m1Seeded})`,
    );

    api.lifecycle?.onShutdown?.(() => {
      try {
        // Final flush so the gateway's graceful shutdown captures the
        // last few minutes of activity that the periodic timer didn't
        // catch. The module-level state survives register-teardown so
        // this still has work to flush even after re-registers.
        m1FlushAllSessions("shutdown");
      } catch {
        // best-effort
      }
      try {
        brainDb?.close();
      } catch {
        // best-effort
      }
      // We deliberately do NOT clearInterval(m1FlushTimer) here. The
      // timer is owned by the module, not this register() invocation,
      // and openclaw may call register() again after shutdown of one
      // closure (e.g. config hot reload). The timer will be cleared
      // when the process itself exits.
    });
  },
});

// ─── helpers ──────────────────────────────────────────────────────────────

function walkMarkdownFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith(".md") && !ent.name.startsWith("_")) {
        try {
          out.push({ filePath: full, text: fs.readFileSync(full, "utf8") });
        } catch {
          // skip unreadable
        }
      }
    }
  };
  walk(dir);
  return out;
}

function expandHitsViaGraph(seeds, wikiRoot, maxDepth) {
  const seen = new Set();
  const out = [];
  const enqueue = (hit) => {
    if (!hit || seen.has(hit.path)) return;
    seen.add(hit.path);
    out.push(hit);
  };
  for (const s of seeds) enqueue(s);
  if (maxDepth <= 0) return out;

  const loadHit = (relPath) => {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(wikiRoot, relPath);
    if (!fs.existsSync(abs)) return null;
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
    return {
      path: abs,
      body: text.replace(/^---\n[\s\S]*?\n---\n/, "").trim(),
      title: text.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, ""),
    };
  };

  let frontier = out.slice();
  for (let d = 0; d < maxDepth; d++) {
    const next = [];
    for (const node of frontier) {
      let text;
      try {
        const abs = path.isAbsolute(node.path) ? node.path : path.join(wikiRoot, node.path);
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const fmText = extractFrontmatterText(text);
      if (!fmText) continue;
      const related = parseRelatedField(fmText);
      for (const rel of related) {
        const loaded = loadHit(rel);
        if (loaded && !seen.has(loaded.path)) {
          seen.add(loaded.path);
          out.push(loaded);
          next.push(loaded);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return out;
}

function cryptoRandomId() {
  // Avoid pulling in node:crypto for a one-shot id — Math.random suffices
  // for a trace row's primary key (we only need uniqueness within a few
  // ticks; brain.db's traces table uses TEXT id so no collision concerns).
  return `trc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
