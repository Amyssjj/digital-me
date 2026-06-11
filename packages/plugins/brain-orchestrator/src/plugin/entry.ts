/**
 * brain-orchestrator plugin entry — builds the set of MCP tool
 * descriptors that compose the orchestrator surface. Five tools:
 *
 *   - `tasks`             routes 20 sub-actions via `dispatchAction`.
 *   - `agent_identify`    wraps `identifyAgent`.
 *   - `learning_capture`  wraps `captureLearning`.
 *   - `traces_record`     wraps `recordTrace`.
 *   - `traces_query`      wraps `queryTraces`.
 *
 * Returns runtime-agnostic descriptors: each one carries `{ name,
 * description, execute }`. The actual openclaw plugin SDK registration
 * (typebox schemas, openclaw `api.registerTool` calls) is the Phase-5
 * runtime adapter's job. Keeping this layer free of openclaw imports
 * preserves the upstream-adaptation constraint — schema-system or
 * registration-API changes upstream don't ripple into brain-orchestrator.
 *
 * Other consumers (dream-cycle worker, custom CLIs) can reuse the same
 * descriptors by adapting them to their own framework.
 */

import {
  identifyAgent,
  type IdentifyAgentDeps,
} from "../handlers/agents.js";
import {
  captureLearning,
  VALID_LEARNING_KINDS,
  type CaptureLearningDeps,
} from "../handlers/learnings.js";
import {
  queryTraces,
  recordTrace,
  VALID_TRACE_KINDS,
  type QueryTracesDeps,
  type RecordTraceDeps,
} from "../handlers/traces.js";
import {
  recordM1Event,
  scoreM1,
  isV1EventType,
  type RecordM1EventInput,
} from "../handlers/m1.js";
import type {
  LearningKind,
  LearningsStore,
} from "../store/learnings.js";
import type { TraceKind, TracesStore } from "../store/traces.js";
import type { AgentsStore } from "../store/agents.js";
import type { M1EventsStore, M1Entry } from "../store/m1-events.js";
import { dispatchAction, type RouterDeps } from "./router.js";
import { type MCPToolResult, toMCPResult } from "./envelope.js";
import type { RouterResult } from "./router.js";

export type BrainOrchestratorPluginDeps = RouterDeps & {
  readonly agents: AgentsStore;
  readonly learnings: LearningsStore;
  readonly traces: TracesStore;
  /**
   * Optional — when present, exposes the `m1_event_record` and
   * `m1_score` MCP tools backed by the universal M1 protocol store.
   * Older deployments without the m1_events table can omit this dep
   * and the M1 tools simply aren't registered. See wiki:
   * infrastructure/m1-universal-event-protocol.md
   */
  readonly m1Events?: M1EventsStore;
};

export type BrainTool = {
  readonly name: string;
  readonly description: string;
  readonly execute: (
    params: Readonly<Record<string, unknown>>,
  ) => Promise<MCPToolResult>;
};

/**
 * Build the five MCP tool descriptors. The caller (runtime adapter)
 * decides how to register them with its framework.
 */
export function buildBrainOrchestratorTools(
  deps: BrainOrchestratorPluginDeps,
): readonly BrainTool[] {
  return [
    {
      name: "tasks",
      description:
        "Task orchestrator: manage goals, tasks, workflows, checkpoints, and handoffs.",
      execute: async (params) => {
        const result = await dispatchAction(
          deps,
          String(params.action ?? ""),
          params,
        );
        return toMCPResult(result);
      },
    },
    {
      name: "agent_identify",
      description:
        "Register or refresh an agent identity. Returns a short-lived session token + server time.",
      execute: async (params) =>
        toMCPResult(handleAgentIdentify(deps, params)),
    },
    {
      name: "learning_capture",
      description:
        "Capture a reusable learning (feedback / project / reference / rejection) into the brain.",
      execute: async (params) =>
        toMCPResult(handleLearningCapture(deps, params)),
    },
    {
      name: "traces_record",
      description:
        "Record a trace event (tool call, task lifecycle, session boundary, learning capture).",
      execute: async (params) =>
        toMCPResult(handleTracesRecord(deps, params)),
    },
    {
      name: "traces_query",
      description:
        "Query trace events with optional filters by agent, goal, task, kind, and time range.",
      execute: async (params) =>
        toMCPResult(handleTracesQuery(deps, params)),
    },
    ...(deps.m1Events
      ? [
          {
            name: "m1_event_record",
            description:
              "Record one M1 universal-protocol event (session_start | knowledge_surfaced | assistant_ack | session_snapshot | session_end). Idempotent on event_id — retries are safe. See wiki: infrastructure/m1-universal-event-protocol.md",
            execute: async (params: Readonly<Record<string, unknown>>) =>
              toMCPResult(handleM1EventRecord(deps, params)),
          },
          {
            name: "m1_score",
            description:
              "Compute M1 application_rate rollups (ack_rate + use_rate per day/runtime/agent) from m1_events in the given window. Defaults to last 24h.",
            execute: async (params: Readonly<Record<string, unknown>>) =>
              toMCPResult(handleM1Score(deps, params)),
          },
        ]
      : []),
  ];
}

// ── M1 universal protocol handlers ────────────────────────────────────────

export function handleM1EventRecord(
  deps: BrainOrchestratorPluginDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  if (!deps.m1Events) {
    return { ok: false, text: "m1_event_record: m1Events store not configured." };
  }
  const runtime = asString(params.runtime);
  const agentId = asString(params.agent_id) || asString(params.agentId);
  const sessionId = asString(params.session_id) || asString(params.sessionId);
  const eventType = asString(params.event_type) || asString(params.eventType);
  if (!runtime || !agentId || !sessionId || !eventType) {
    return {
      ok: false,
      text:
        "m1_event_record requires runtime, agent_id, session_id, and event_type.",
    };
  }
  // Strict v1 vocabulary check — unknown event_types are rejected at the
  // envelope so emitters can't drift quietly. Forward-compat happens via
  // schema_version bump, not by sneaking new event_types into v1.
  if (!isV1EventType(eventType)) {
    return {
      ok: false,
      text: `m1_event_record: unknown event_type "${eventType}" for schema_version 1. Allowed: session_start, knowledge_surfaced, assistant_ack, session_snapshot, session_end.`,
    };
  }

  const turnId = asOptString(params.turn_id) ?? asOptString(params.turnId);
  const eventId = asOptString(params.event_id) ?? asOptString(params.eventId);
  const ackSignal =
    asOptString(params.ack_signal) ?? asOptString(params.ackSignal);
  const schemaVersion =
    typeof params.schema_version === "number"
      ? params.schema_version
      : typeof params.schemaVersion === "number"
        ? params.schemaVersion
        : undefined;
  const t = typeof params.t === "number" ? params.t : undefined;

  let entries: ReadonlyArray<M1Entry> | undefined;
  const entriesRaw = params.entries;
  if (Array.isArray(entriesRaw)) {
    entries = entriesRaw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        path: String(x.path ?? ""),
        title: typeof x.title === "string" ? x.title : undefined,
        score: typeof x.score === "number" ? x.score : undefined,
        source: typeof x.source === "string" ? x.source : undefined,
      }))
      .filter((e) => e.path.length > 0);
  } else if (typeof entriesRaw === "string" && entriesRaw.length > 0) {
    try {
      const parsed = JSON.parse(entriesRaw) as unknown;
      if (Array.isArray(parsed)) {
        entries = parsed
          .filter(
            (x): x is Record<string, unknown> => !!x && typeof x === "object",
          )
          .map((x) => ({
            path: String(x.path ?? ""),
            title: typeof x.title === "string" ? x.title : undefined,
            score: typeof x.score === "number" ? x.score : undefined,
            source: typeof x.source === "string" ? x.source : undefined,
          }))
          .filter((e) => e.path.length > 0);
      }
    } catch {
      return {
        ok: false,
        text: "m1_event_record: `entries` must be an array or JSON-array string.",
      };
    }
  }

  let extra: Record<string, unknown> | undefined;
  const extraRaw = params.extra;
  if (extraRaw && typeof extraRaw === "object" && !Array.isArray(extraRaw)) {
    extra = extraRaw as Record<string, unknown>;
  } else if (typeof extraRaw === "string" && extraRaw.length > 0) {
    try {
      const parsed = JSON.parse(extraRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extra = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore — extra is best-effort
    }
  }

  const input: RecordM1EventInput = {
    eventId,
    schemaVersion,
    runtime,
    agentId,
    sessionId,
    turnId,
    eventType,
    entries,
    ackSignal,
    t,
    extra,
  };

  const result = recordM1Event({ m1Events: deps.m1Events }, input);
  return {
    ok: true,
    text: JSON.stringify({ ok: true, ...result }, null, 2),
    json: { ...result },
  };
}

export function handleM1Score(
  deps: BrainOrchestratorPluginDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  if (!deps.m1Events) {
    return { ok: false, text: "m1_score: m1Events store not configured." };
  }
  const since = typeof params.since === "number" ? params.since : undefined;
  const until = typeof params.until === "number" ? params.until : undefined;
  const runtime = asOptString(params.runtime);
  const rollups = scoreM1(
    { m1Events: deps.m1Events },
    { since, until, runtime },
  );
  return {
    ok: true,
    text: JSON.stringify({ ok: true, rollups }, null, 2),
    json: { rollups },
  };
}

// ── Standalone-tool param coercion + dispatch ─────────────────────────────

export function handleAgentIdentify(
  deps: IdentifyAgentDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const agentId = asString(params.agent_id);
  const runtime = asString(params.runtime);
  if (!agentId || !runtime) {
    return {
      ok: false,
      text: "agent_identify requires agent_id and runtime.",
    };
  }
  const version = asOptString(params.version);
  const capsRaw = params.capabilities;
  let capabilities: string[] = [];
  if (Array.isArray(capsRaw)) {
    capabilities = capsRaw.filter((x): x is string => typeof x === "string");
  } else if (typeof capsRaw === "string" && capsRaw.length > 0) {
    try {
      const parsed = JSON.parse(capsRaw) as unknown;
      if (!Array.isArray(parsed)) {
        return {
          ok: false,
          text: "capabilities must be a JSON array of strings.",
        };
      }
      capabilities = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      return {
        ok: false,
        text: "capabilities must be a valid JSON array of strings.",
      };
    }
  }
  const result = identifyAgent(deps, {
    agentId,
    runtime,
    version,
    capabilities,
  });
  const json = {
    session_token: result.sessionToken,
    server_time: result.serverTime,
    created: result.created,
  };
  return {
    ok: true,
    text: JSON.stringify({ ok: true, ...json }, null, 2),
    json,
  };
}

export function handleLearningCapture(
  deps: CaptureLearningDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const agentId = asString(params.agent_id);
  const kind = asString(params.kind);
  const text = asString(params.text);
  if (!agentId || !kind || !text) {
    return {
      ok: false,
      text: "learning_capture requires agent_id, kind, and text.",
    };
  }
  if (!VALID_LEARNING_KINDS.has(kind as LearningKind)) {
    return {
      ok: false,
      text:
        `Invalid kind "${kind}". Must be one of: ` +
        [...VALID_LEARNING_KINDS].join(", "),
    };
  }
  const result = captureLearning(deps, {
    agentId,
    kind: kind as LearningKind,
    text,
    why: asOptString(params.why),
    applyWhen: asOptString(params.apply_when),
    sourceContext: asOptString(params.source_context),
    confidence:
      typeof params.confidence === "number" ? params.confidence : undefined,
    proposedWikiPath: asOptString(params.proposed_wiki_path),
  });
  return {
    ok: true,
    text: JSON.stringify({ ok: true, learning_id: result.learningId }, null, 2),
    json: { learning_id: result.learningId },
  };
}

export function handleTracesRecord(
  deps: RecordTraceDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const agentId = asString(params.agent_id);
  const kind = asString(params.kind);
  if (!agentId || !kind) {
    return {
      ok: false,
      text: "traces_record requires agent_id and kind.",
    };
  }
  if (!VALID_TRACE_KINDS.has(kind as TraceKind)) {
    return {
      ok: false,
      text:
        `Invalid trace kind "${kind}". Must be one of: ` +
        [...VALID_TRACE_KINDS].join(", "),
    };
  }
  const payloadRaw = params.payload;
  let payload: Record<string, unknown> = {};
  // Reject a directly-passed array up front. The runtime hands us already-
  // decoded JSON, so an array slips past both branches below (the object
  // branch guards with !Array.isArray) and would otherwise be silently
  // recorded as an empty object with ok:true.
  if (Array.isArray(payloadRaw)) {
    return { ok: false, text: "payload must be a JSON object." };
  }
  if (typeof payloadRaw === "string" && payloadRaw.length > 0) {
    try {
      const parsed = JSON.parse(payloadRaw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, text: "payload must be a JSON object." };
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, text: "payload must be valid JSON." };
    }
  } else if (
    payloadRaw &&
    typeof payloadRaw === "object" &&
    !Array.isArray(payloadRaw)
  ) {
    payload = payloadRaw as Record<string, unknown>;
  }
  const result = recordTrace(deps, {
    agentId,
    kind: kind as TraceKind,
    payload,
    taskId: asOptString(params.task_id),
    goalId: asOptString(params.goal_id),
    durationMs:
      typeof params.duration_ms === "number" ? params.duration_ms : undefined,
    t: typeof params.t === "number" ? params.t : undefined,
  });
  return {
    ok: true,
    text: JSON.stringify({ ok: true, trace_id: result.traceId }, null, 2),
    json: { trace_id: result.traceId },
  };
}

export function handleTracesQuery(
  deps: QueryTracesDeps,
  params: Readonly<Record<string, unknown>>,
): RouterResult {
  const kind = asOptString(params.kind);
  if (kind && !VALID_TRACE_KINDS.has(kind as TraceKind)) {
    return {
      ok: false,
      text:
        `Invalid trace kind "${kind}". Must be one of: ` +
        [...VALID_TRACE_KINDS].join(", "),
    };
  }
  const traces = queryTraces(deps, {
    agentId: asOptString(params.agent_id),
    goalId: asOptString(params.goal_id),
    taskId: asOptString(params.task_id),
    kind: kind as TraceKind | undefined,
    since: typeof params.since === "number" ? params.since : undefined,
    limit: typeof params.limit === "number" ? params.limit : undefined,
  });
  return {
    ok: true,
    text: JSON.stringify({ traces }, null, 2),
    json: { traces },
  };
}

// ── Local helpers ─────────────────────────────────────────────────────────

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asOptString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
