/**
 * Learning-capture handler — pure business logic for capturing a learning
 * plus the paired `learning_captured` trace.
 *
 * The envelope validates the `kind` string before reaching here; this
 * handler does NOT re-validate because the type guarantees it.
 */

import { randomUUID } from "node:crypto";
import type {
  LearningKind,
  LearningsStore,
} from "../store/learnings.js";
import type { TracesStore } from "../store/traces.js";

export const VALID_LEARNING_KINDS: ReadonlySet<LearningKind> =
  new Set<LearningKind>(["feedback", "project", "reference", "rejection"]);

export type CaptureLearningInput = {
  readonly agentId: string;
  readonly kind: LearningKind;
  readonly text: string;
  readonly why?: string;
  readonly applyWhen?: string;
  readonly sourceContext?: string;
  readonly confidence?: number;
  readonly proposedWikiPath?: string;
};

export type CaptureLearningResult = {
  readonly learningId: string;
};

export type CaptureLearningDeps = {
  readonly learnings: LearningsStore;
  readonly traces: TracesStore;
  readonly now?: () => number;
  readonly newLearningId?: () => string;
  readonly newTraceId?: () => string;
};

/**
 * Persist a learning + a paired trace event. The trace ties the learning
 * to its capture moment for the dashboard's "what did the agent learn"
 * timeline.
 */
export function captureLearning(
  deps: CaptureLearningDeps,
  input: CaptureLearningInput,
): CaptureLearningResult {
  const now = (deps.now ?? Date.now)();
  const learningId = (deps.newLearningId ?? (() => `lrn-${randomUUID()}`))();
  const traceId = (deps.newTraceId ?? (() => `trc-${randomUUID()}`))();

  deps.learnings.create({
    id: learningId,
    agentId: input.agentId,
    kind: input.kind,
    text: input.text,
    why: input.why,
    applyWhen: input.applyWhen,
    sourceContext: input.sourceContext,
    confidence: input.confidence,
    proposedWikiPath: input.proposedWikiPath,
    createdAt: now,
  });

  deps.traces.create({
    id: traceId,
    agentId: input.agentId,
    kind: "learning_captured",
    payload: { learning_id: learningId, learning_kind: input.kind },
    t: now,
  });

  return { learningId };
}
