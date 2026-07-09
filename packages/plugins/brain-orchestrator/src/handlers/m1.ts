/**
 * M1 application_rate handlers — pure logic for the universal event
 * protocol's brain side.
 *
 * Two operations:
 *   - `recordM1Event` — accept one event from an emitter, dedupe by
 *     event_id, persist to m1_events.
 *   - `scoreM1` — read m1_events in a window, pair surfaced↔ack by
 *     (session_id, turn_id), compute ack_rate per (runtime, agent_id, day),
 *     return rollups.
 *
 * Caller responsibility: vocabulary checks (event_type ∈ V1 set) happen
 * at the envelope/MCP layer if strict v1 enforcement is wanted; the store
 * accepts anything for forward-compat. The scorer ignores unknown
 * event_types.
 *
 * See wiki: infrastructure/m1-universal-event-protocol.md
 */

import { createHash } from "node:crypto";
import type {
  M1Entry,
  M1EventRecord,
  M1EventsStore,
} from "../store/m1-events.js";
import { M1_EVENT_TYPES_V1 } from "../store/m1-events.js";

// ── Record handler ─────────────────────────────────────────────────────────

export type RecordM1EventInput = {
  /** Stable client-generated event_id (for idempotent ingest). When
   *  omitted, the server derives one from the other fields — but this
   *  makes retries land as new rows, so emitters SHOULD provide it. */
  readonly eventId?: string;
  readonly schemaVersion?: number;
  readonly metric?: string;
  readonly runtime: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly eventType: string;
  readonly entries?: ReadonlyArray<M1Entry>;
  readonly ackSignal?: string;
  readonly t?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
};

export type RecordM1EventResult = {
  readonly eventId: string;
  readonly inserted: boolean;
};

export type RecordM1EventDeps = {
  readonly m1Events: M1EventsStore;
  readonly now?: () => number;
  readonly newEventId?: (input: RecordM1EventInput) => string;
};

/**
 * Derive a stable event_id from the input when the caller didn't provide
 * one. Format: `<session>::<turn>::<event_type>::<entries_hash>`. Same
 * inputs → same id → INSERT OR IGNORE catches retries.
 */
export function deriveEventId(input: RecordM1EventInput): string {
  const turn = input.turnId ?? "_";
  const entriesKey = JSON.stringify(
    (input.entries ?? []).map((e) => [e.path, e.score ?? null]),
  );
  const hash = createHash("sha1")
    .update(entriesKey + "|" + (input.ackSignal ?? ""))
    .digest("hex")
    .slice(0, 12);
  return `${input.sessionId}::${turn}::${input.eventType}::${hash}`;
}

export function recordM1Event(
  deps: RecordM1EventDeps,
  input: RecordM1EventInput,
): RecordM1EventResult {
  const eventId =
    input.eventId ?? (deps.newEventId ?? deriveEventId)(input);
  const t = input.t ?? (deps.now ?? Date.now)();
  const record: M1EventRecord = {
    eventId,
    schemaVersion: input.schemaVersion ?? 1,
    metric: input.metric ?? "m1_application_rate",
    runtime: input.runtime,
    agentId: input.agentId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    eventType: input.eventType,
    entries: input.entries,
    ackSignal: input.ackSignal,
    t,
    extra: input.extra,
  };
  const r = deps.m1Events.create(record);
  return { eventId, inserted: r.inserted };
}

// ── Scorer ─────────────────────────────────────────────────────────────────

export type M1Rollup = {
  /** YYYY-MM-DD UTC. */
  readonly day: string;
  readonly runtime: string;
  readonly agentId: string;
  /** Turns where a knowledge_surfaced event has a matching assistant_ack. */
  readonly acknowledgedTurns: number;
  /** All turns with at least one knowledge_surfaced event. */
  readonly surfacedTurns: number;
  /** acknowledgedTurns / surfacedTurns, or null when surfacedTurns == 0. */
  readonly ackRate: number | null;
  /** Distinct paths surfaced across all turns in (day, runtime, agent). */
  readonly surfacedEntries: number;
  /** Distinct paths the assistant acknowledged across all turns. */
  readonly actedEntries: number;
  /** actedEntries / surfacedEntries — entry-level use rate (≈M1b proxy). */
  readonly useRate: number | null;
};

export type ScoreM1Deps = {
  readonly m1Events: M1EventsStore;
};

export type ScoreM1Input = {
  /** Lower bound epoch ms (inclusive). Defaults to 24h ago. */
  readonly since?: number;
  /** Upper bound epoch ms (exclusive). Defaults to "now + 1ms". */
  readonly until?: number;
  /** Optional runtime filter. */
  readonly runtime?: string;
  /** Defaults to `Date.now()`. Injected for tests. */
  readonly now?: () => number;
};

/** Convert an epoch-ms timestamp into a UTC YYYY-MM-DD string. */
function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Treat any of these ack_signal values as "the LLM acknowledged the
 * surfaced context this turn":
 *
 *   - explicit_path: a surfaced path appeared literally in the response
 *   - title_match:   a surfaced entry's title appeared
 *   - no_applicable: the LLM declined explicitly per the directive
 *                    (this IS an acknowledgment — they read it and
 *                    judged none applied; counts as ack but contributes
 *                    zero acted entries to the use_rate denominator)
 *
 * `no_acknowledgement` and missing signals are NOT acks.
 */
const ACK_SIGNALS_THAT_COUNT: ReadonlySet<string> = new Set([
  "explicit_path",
  "title_match",
  "no_applicable",
]);

export function scoreM1(
  deps: ScoreM1Deps,
  input: ScoreM1Input = {},
): readonly M1Rollup[] {
  const now = (input.now ?? Date.now)();
  const since = input.since ?? now - 24 * 60 * 60 * 1000;
  const until = input.until ?? now + 1;

  const pairs = deps.m1Events.pairSurfacedWithAck({
    since,
    until,
    runtime: input.runtime,
  });

  // Aggregate per (day, runtime, agent).
  const buckets = new Map<
    string,
    {
      day: string;
      runtime: string;
      agentId: string;
      surfacedTurns: number;
      acknowledgedTurns: number;
      surfacedPaths: Set<string>;
      actedPaths: Set<string>;
    }
  >();

  for (const { surfaced, ack } of pairs) {
    const day = dayKey(surfaced.t);
    const key = `${day}::${surfaced.runtime}::${surfaced.agentId}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        day,
        runtime: surfaced.runtime,
        agentId: surfaced.agentId,
        surfacedTurns: 0,
        acknowledgedTurns: 0,
        surfacedPaths: new Set(),
        actedPaths: new Set(),
      };
      buckets.set(key, b);
    }
    b.surfacedTurns += 1;
    for (const e of surfaced.entries ?? []) b.surfacedPaths.add(e.path);

    if (ack && typeof ack.ackSignal === "string") {
      if (ACK_SIGNALS_THAT_COUNT.has(ack.ackSignal)) {
        b.acknowledgedTurns += 1;
      }
      // Acted entries come from the ack's `entries` field (the subset
      // the parser identified as acted). `no_applicable` → empty acted.
      for (const e of ack.entries ?? []) b.actedPaths.add(e.path);
    }
  }

  const out: M1Rollup[] = [];
  for (const b of buckets.values()) {
    out.push({
      day: b.day,
      runtime: b.runtime,
      agentId: b.agentId,
      acknowledgedTurns: b.acknowledgedTurns,
      surfacedTurns: b.surfacedTurns,
      // Unreachable null arm: a bucket only exists after surfacedTurns += 1,
      // so surfacedTurns >= 1 whenever a rollup is emitted. Defensive only.
      /* v8 ignore next */
      ackRate: b.surfacedTurns > 0 ? b.acknowledgedTurns / b.surfacedTurns : null,
      surfacedEntries: b.surfacedPaths.size,
      actedEntries: b.actedPaths.size,
      useRate:
        b.surfacedPaths.size > 0
          ? b.actedPaths.size / b.surfacedPaths.size
          : null,
    });
  }
  return out;
}

// ── Envelope helpers — vocabulary validation ──────────────────────────────

export function isV1EventType(value: unknown): boolean {
  return typeof value === "string" && M1_EVENT_TYPES_V1.has(value as never);
}
