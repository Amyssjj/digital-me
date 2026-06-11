/**
 * Trace handlers — pure business logic for the brain telemetry surface.
 *
 * Two operations: `recordTrace` writes one row, `queryTraces` reads with
 * optional filters. The envelope is responsible for vocabulary validation
 * and string→object payload coercion before invoking these handlers.
 */

import { randomUUID } from "node:crypto";
import type {
  TraceKind,
  TraceQueryFilters,
  TraceRecord,
  TracesStore,
} from "../store/traces.js";

export const VALID_TRACE_KINDS: ReadonlySet<TraceKind> = new Set<TraceKind>([
  "tool_call",
  "task_start",
  "task_complete",
  "task_failed",
  "learning_captured",
  "session_start",
  "session_end",
]);

export type RecordTraceInput = {
  readonly agentId: string;
  readonly kind: TraceKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly taskId?: string;
  readonly goalId?: string;
  readonly durationMs?: number;
  /** Epoch ms. Defaults to server time when omitted. */
  readonly t?: number;
};

export type RecordTraceResult = {
  readonly traceId: string;
};

export type RecordTraceDeps = {
  readonly traces: TracesStore;
  readonly now?: () => number;
  readonly newTraceId?: () => string;
};

export function recordTrace(
  deps: RecordTraceDeps,
  input: RecordTraceInput,
): RecordTraceResult {
  const traceId = (deps.newTraceId ?? (() => `trc-${randomUUID()}`))();
  const t = input.t ?? (deps.now ?? Date.now)();
  deps.traces.create({
    id: traceId,
    agentId: input.agentId,
    kind: input.kind,
    payload: input.payload,
    taskId: input.taskId,
    goalId: input.goalId,
    durationMs: input.durationMs,
    t,
  });
  return { traceId };
}

export type QueryTracesDeps = {
  readonly traces: TracesStore;
};

/**
 * Read traces with optional filters. Thin wrapper over the store but
 * exposed as a handler so callers don't bypass the envelope-layer
 * vocabulary validation by importing the store directly.
 */
export function queryTraces(
  deps: QueryTracesDeps,
  filters: TraceQueryFilters,
): readonly TraceRecord[] {
  return deps.traces.query(filters);
}
