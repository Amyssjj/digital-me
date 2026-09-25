/**
 * Brain tool vocabulary — the single source of truth for every action name
 * and enum value the brain's MCP tools accept.
 *
 * Three places used to hand-maintain these lists (the MCP proxy's JSON
 * Schema, the openclaw typebox schemas, and brain-orchestrator's router /
 * validators) and they drifted: the proxy advertised actions the brain
 * rejected with "Unknown action". Now:
 *
 *   - brain-orchestrator validates against these arrays (the `tasks` router
 *     is a handler map typed `Record<TasksAction, …>`, so an action without
 *     a handler, or a handler without an action, fails to compile);
 *   - brain-mcp-proxy derives its JSON Schema `enum`s from them;
 *   - runtime-openclaw derives its typebox `Type.Enum`s from them;
 *   - brain-host validates `wiki` actions against {@link WIKI_ACTIONS}.
 *
 * Adding a value here is a promise that the brain serves it — the contract
 * tests in brain-orchestrator and cli fail otherwise.
 */

/** Sub-actions of the `tasks` tool (served by brain-orchestrator's router). */
export const TASKS_ACTIONS = [
  "run_goal",
  "run_workflow",
  "board",
  "status",
  "checkpoint",
  "handoff",
  "approve",
  "reject",
  "cancel",
  "claim",
  "complete",
  "schedule_add",
  "schedule_list",
  "schedule_remove",
  "schedule_enable",
  "schedule_disable",
  "schedule_tick",
  "workflow_import",
  "workflow_list",
  "workflow_delete",
] as const;

export type TasksAction = (typeof TASKS_ACTIONS)[number];

/** The kind the MCP proxy stamps on the trace rows it writes itself. */
export const PROXY_TRACE_KIND = "mcp_tool_call" as const;

/** Trace kinds accepted by `traces_record` / `traces_query`. */
export const TRACE_KINDS = [
  "tool_call",
  "task_start",
  "task_complete",
  "task_failed",
  "learning_captured",
  "session_start",
  "session_end",
  PROXY_TRACE_KIND,
] as const;

export type TraceKind = (typeof TRACE_KINDS)[number];

/** Learning kinds accepted by `learning_capture`. */
export const LEARNING_KINDS = [
  "feedback",
  "project",
  "reference",
  "rejection",
] as const;

export type LearningKind = (typeof LEARNING_KINDS)[number];

/** M1 universal-protocol v1 event types accepted by `m1_event_record`. */
export const M1_EVENT_TYPES = [
  "session_start",
  "knowledge_surfaced",
  "assistant_ack",
  "session_snapshot",
  "session_end",
] as const;

export type M1EventType = (typeof M1_EVENT_TYPES)[number];

/** Sub-actions of the `wiki` tool (brain-host serves only `status`). */
export const WIKI_ACTIONS = ["status"] as const;

export type WikiAction = (typeof WIKI_ACTIONS)[number];

/** Corpora accepted by `memory_search` / `memory_get`. */
export const MEMORY_CORPORA = ["memory", "wiki", "all"] as const;

/** Type guard: is `value` a member of one of the vocabulary arrays above? */
export function isOneOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
