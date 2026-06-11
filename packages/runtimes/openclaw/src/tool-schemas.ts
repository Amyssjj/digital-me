/**
 * TypeBox parameter schemas for the 5 brain-orchestrator MCP tools.
 *
 * These mirror the runtime-agnostic `BrainTool` descriptors with the
 * openclaw plugin SDK's expected `TSchema` shape. They live in the
 * openclaw runtime adapter because typebox is an openclaw concern —
 * brain-orchestrator stays schema-free.
 */

import { Type, type Static } from "typebox";

// ── tasks ──────────────────────────────────────────────────────────────────

export const TasksToolSchema = Type.Object(
  {
    action: Type.String({
      description:
        "Action to perform. One of: run_goal, run_workflow, board, status, checkpoint, handoff, approve, reject, cancel, claim, complete, schedule_add, schedule_list, schedule_remove, schedule_enable, schedule_disable, schedule_tick, workflow_import, workflow_list, workflow_delete.",
    }),
    description: Type.Optional(
      Type.String({ description: "Goal description for run_goal." }),
    ),
    tasks: Type.Optional(
      Type.String({
        description:
          'JSON array of task plan items for run_goal: [{"name":"...","task":"...","blockedByNames":[],"dispatch":{"mode":"spawn","agentId":"..."}}]',
      }),
    ),
    templateId: Type.Optional(
      Type.String({
        description:
          "Workflow template ID — used by run_workflow, schedule_add, workflow_delete.",
      }),
    ),
    variables: Type.Optional(
      Type.String({
        description:
          'JSON object of template variables for run_workflow / schedule_add, e.g. {"env":"prod"}.',
      }),
    ),
    taskId: Type.Optional(
      Type.String({
        description:
          "Task ID or name for status, checkpoint, handoff, approve, reject, claim, complete.",
      }),
    ),
    phase: Type.Optional(Type.String({ description: "Checkpoint phase name." })),
    summary: Type.Optional(
      Type.String({ description: "Checkpoint or handoff summary." }),
    ),
    artifactPaths: Type.Optional(
      Type.String({
        description:
          "Comma-separated artifact file paths for checkpoint / handoff.",
      }),
    ),
    progressPercent: Type.Optional(
      Type.Number({ description: "Progress percentage (0-100) for checkpoint." }),
    ),
    blocker: Type.Optional(
      Type.String({ description: "Known blocker description (checkpoint)." }),
    ),
    deliverableState: Type.Optional(
      Type.String({
        description: "Handoff deliverable state: 'complete' | 'partial'.",
      }),
    ),
    recommendedNextStep: Type.Optional(
      Type.String({
        description: "Recommended next step (checkpoint / handoff).",
      }),
    ),
    reason: Type.Optional(
      Type.String({ description: "Optional rejection reason (reject action)." }),
    ),
    goalId: Type.Optional(
      Type.String({ description: "Goal ID for cancel action." }),
    ),
    parentGoalId: Type.Optional(
      Type.String({
        description: "Parent goal ID for run_goal (create as subgoal).",
      }),
    ),
    scheduleName: Type.Optional(
      Type.String({ description: "Human-readable schedule label." }),
    ),
    cronExpr: Type.Optional(
      Type.String({ description: 'Cron expression (5-field), e.g. "0 7 * * *".' }),
    ),
    timezone: Type.Optional(
      Type.String({
        description: "IANA timezone, e.g. 'UTC' or 'America/New_York'. Default: UTC.",
      }),
    ),
    scheduleId: Type.Optional(
      Type.String({
        description:
          "Schedule ID or name for schedule_remove / schedule_enable / schedule_disable.",
      }),
    ),
    workflowJson: Type.Optional(
      Type.String({ description: "Full workflow JSON for workflow_import." }),
    ),
    force: Type.Optional(
      Type.Boolean({
        description: "Bypass workflow-level mutex (run_workflow only).",
      }),
    ),
    format: Type.Optional(
      Type.String({
        description:
          'Set to "json" for structured machine-readable output on board / status / schedule_list / workflow_list.',
      }),
    ),
    since: Type.Optional(
      Type.Number({
        description:
          "Lower bound (epoch ms) for board JSON output. Defaults to now - 7 days.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type TasksToolParams = Static<typeof TasksToolSchema>;

// ── agent_identify ─────────────────────────────────────────────────────────

export const AgentIdentifyToolSchema = Type.Object(
  {
    agent_id: Type.String({
      description:
        "Unique agent identifier (e.g. 'claude-code', 'codex', 'hermes').",
    }),
    runtime: Type.String({
      description:
        "Runtime environment (e.g. 'claude-code', 'codex-cli', 'cron-trigger').",
    }),
    version: Type.Optional(
      Type.String({ description: "Agent version string." }),
    ),
    capabilities: Type.Optional(
      Type.String({
        description:
          'JSON array of capability strings, e.g. \'["tasks","wiki","memory"]\'.',
      }),
    ),
  },
  { additionalProperties: false },
);

// ── learning_capture ───────────────────────────────────────────────────────

export const LearningCaptureToolSchema = Type.Object(
  {
    agent_id: Type.String({ description: "Caller agent identity." }),
    kind: Type.String({
      description: "Learning kind: feedback | project | reference | rejection.",
    }),
    text: Type.String({ description: "The learning content." }),
    why: Type.Optional(
      Type.String({ description: "Why this learning matters." }),
    ),
    apply_when: Type.Optional(
      Type.String({
        description: "When/where this learning should be applied.",
      }),
    ),
    source_context: Type.Optional(
      Type.String({
        description: "Source context (file path, conversation ref, etc).",
      }),
    ),
    confidence: Type.Optional(
      Type.Number({
        description: "Confidence score 0-1.",
        minimum: 0,
        maximum: 1,
      }),
    ),
    proposed_wiki_path: Type.Optional(
      Type.String({
        description: "Suggested wiki path for graduation, e.g. 'agents/foo.md'.",
      }),
    ),
  },
  { additionalProperties: false },
);

// ── traces_record ──────────────────────────────────────────────────────────

export const TracesRecordToolSchema = Type.Object(
  {
    agent_id: Type.String({ description: "Caller agent identity." }),
    kind: Type.String({
      description:
        "Trace kind: tool_call | task_start | task_complete | task_failed | learning_captured | session_start | session_end.",
    }),
    payload: Type.Optional(
      Type.String({
        description: "JSON object with trace-specific data.",
      }),
    ),
    task_id: Type.Optional(
      Type.String({ description: "Associated task ID." }),
    ),
    goal_id: Type.Optional(
      Type.String({ description: "Associated goal ID." }),
    ),
    duration_ms: Type.Optional(
      Type.Number({ description: "Duration in milliseconds." }),
    ),
    t: Type.Optional(
      Type.Number({
        description:
          "Timestamp (epoch ms). Defaults to server time if omitted.",
      }),
    ),
  },
  { additionalProperties: false },
);

// ── traces_query ───────────────────────────────────────────────────────────

export const TracesQueryToolSchema = Type.Object(
  {
    agent_id: Type.Optional(
      Type.String({ description: "Filter by agent ID." }),
    ),
    goal_id: Type.Optional(
      Type.String({ description: "Filter by goal ID." }),
    ),
    task_id: Type.Optional(
      Type.String({ description: "Filter by task ID." }),
    ),
    kind: Type.Optional(
      Type.String({ description: "Filter by trace kind." }),
    ),
    since: Type.Optional(
      Type.Number({
        description: "Only traces after this epoch ms timestamp.",
      }),
    ),
    limit: Type.Optional(
      Type.Number({ description: "Max results (default 100, max 1000)." }),
    ),
  },
  { additionalProperties: false },
);

// ── m1_event_record (universal M1 protocol) ────────────────────────────────

export const M1EventRecordToolSchema = Type.Object(
  {
    event_id: Type.Optional(
      Type.String({
        description:
          "Stable client-generated event_id (for idempotent ingest). Format: `<session_id>::<turn_id>::<event_type>::<entries_hash>`. When omitted, the server derives one.",
      }),
    ),
    schema_version: Type.Optional(
      Type.Number({
        description: "Protocol schema version. Defaults to 1.",
      }),
    ),
    runtime: Type.String({
      description: "Emitter runtime: claude-code | hermes | openclaw",
    }),
    agent_id: Type.String({
      description: "Agent identity (e.g. hermes-discord, coo, claude-code).",
    }),
    session_id: Type.String({
      description: "Runtime-stable session identifier.",
    }),
    turn_id: Type.Optional(
      Type.String({
        description: "Monotonic per-session turn id. Required for knowledge_surfaced and assistant_ack.",
      }),
    ),
    event_type: Type.String({
      description:
        "Event type. v1: session_start | knowledge_surfaced | assistant_ack | session_snapshot | session_end.",
    }),
    entries: Type.Optional(
      Type.String({
        description:
          "JSON array of surfaced entries. Each: {path,title?,score?,source?}. Required on knowledge_surfaced; on assistant_ack carries the acted subset.",
      }),
    ),
    ack_signal: Type.Optional(
      Type.String({
        description:
          "On assistant_ack: explicit_path | title_match | no_applicable | no_acknowledgement.",
      }),
    ),
    extra: Type.Optional(
      Type.String({
        description:
          "JSON object of additional payload fields (free-form, schema-version-scoped).",
      }),
    ),
    t: Type.Optional(
      Type.Number({
        description: "Event timestamp (epoch ms). Defaults to server time.",
      }),
    ),
  },
  { additionalProperties: false },
);

// ── m1_score ───────────────────────────────────────────────────────────────

export const M1ScoreToolSchema = Type.Object(
  {
    since: Type.Optional(
      Type.Number({
        description: "Lower bound epoch ms (inclusive). Defaults to 24h ago.",
      }),
    ),
    until: Type.Optional(
      Type.Number({
        description: "Upper bound epoch ms (exclusive). Defaults to now + 1ms.",
      }),
    ),
    runtime: Type.Optional(
      Type.String({
        description: "Optional runtime filter (claude-code | hermes | openclaw).",
      }),
    ),
  },
  { additionalProperties: false },
);

// ── Schema lookup ──────────────────────────────────────────────────────────

export const TOOL_SCHEMAS = {
  tasks: TasksToolSchema,
  agent_identify: AgentIdentifyToolSchema,
  learning_capture: LearningCaptureToolSchema,
  traces_record: TracesRecordToolSchema,
  traces_query: TracesQueryToolSchema,
  m1_event_record: M1EventRecordToolSchema,
  m1_score: M1ScoreToolSchema,
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
