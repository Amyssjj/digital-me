/**
 * Tool definitions exposed by the openclaw-brain MCP proxy.
 *
 * These declare the MCP tool shapes only — they don't implement anything.
 * The actual implementations live in openclaw plugins (memory-core,
 * brain-orchestrator, etc.) and are reached via the gateway HTTP forwarder.
 *
 * The shape mirrors openclaw's gateway-exposed tools 1:1 so any MCP client
 * that knew the upstream proxy keeps working unchanged.
 */

const AGENT_ID_PROP = {
  agent_id: {
    type: "string",
    description:
      "Caller agent identity (from agent_identify). When absent, call is logged as unknown.",
  },
} as const;

/** The kind this proxy stamps on the trace rows it writes (see trace-writer.ts).
 * Exported + included in TRACE_KINDS so `traces_query`'s `kind` enum accepts it
 * — otherwise a client can't filter for the rows the proxy itself records. */
export const PROXY_TRACE_KIND = "mcp_tool_call" as const;

const TRACE_KINDS = [
  "tool_call",
  "task_start",
  "task_complete",
  "task_failed",
  "learning_captured",
  "session_start",
  "session_end",
  PROXY_TRACE_KIND,
] as const;

const M1_EVENT_TYPES = [
  "session_start",
  "knowledge_surfaced",
  "assistant_ack",
  "session_snapshot",
  "session_end",
] as const;

const TASK_ACTIONS = [
  "board",
  "run_goal",
  "plan_goal",
  "run_workflow",
  "workflow_list",
  "workflow_import",
  "workflow_delete",
  "schedule_list",
  "schedule_add",
  "schedule_remove",
  "schedule_enable",
  "schedule_disable",
  "schedule_tick",
  "checkpoint",
  "handoff",
  "retry",
  "status",
  "claim",
  "complete",
  "approve",
  "reject",
  "cancel",
] as const;

const WIKI_ACTIONS = [
  "index",
  "status",
  "ingest_raw",
  "tag",
  "prime",
  "compile",
  "query",
  "file_back",
  "lint",
] as const;

export const TOOLS = [
  {
    name: "agent_identify",
    description:
      "Register or re-register the calling agent with the brain. Returns a short-lived session token and server time. Un-identified callers are allowed through with a soft-warn for 30 days.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description:
            "Unique agent identifier (e.g. 'claude-code-main', 'hermes-discord')",
        },
        runtime: {
          type: "string",
          description:
            "Runtime environment (e.g. 'claude-code', 'codex', 'antigravity', 'cron')",
        },
        version: {
          type: "string",
          description: "Agent or runtime version string",
        },
        capabilities: {
          type: "array",
          items: { type: "string" },
          description:
            "List of capabilities this agent supports (e.g. 'tasks', 'wiki', 'memory')",
        },
      },
      required: ["agent_id", "runtime"],
    },
  },
  {
    name: "tasks",
    description: `Task Orchestrator — manage goals, tasks, workflows, and schedules. Actions: ${TASK_ACTIONS.join(", ")}`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: `Action to perform: ${TASK_ACTIONS.join(", ")}`,
          enum: [...TASK_ACTIONS],
        },
        ...AGENT_ID_PROP,
        description: { type: "string", description: "Goal description (for run_goal)" },
        workflowJson: {
          type: "string",
          description: "Full workflow JSON (for workflow_import)",
        },
        cronExpr: {
          type: "string",
          description:
            "Cron expression for schedule_add — 5-field, e.g. '30 23 * * *' (gateway tool reads `cronExpr`).",
        },
        enabled: { type: "boolean", description: "Enable/disable flag (for schedule_add)" },
        scheduleId: {
          type: "string",
          description: "Schedule ID (for schedule_remove/enable/disable)",
        },
        tasks: {
          type: "string",
          description:
            'JSON array of task plan items for run_goal: [{"name":"step-id","task":"what to do","blockedByNames":["other-step-id"],"dispatch":{"mode":"spawn","agentId":"target-agent"}}]. Every item needs name, task, blockedByNames (array, may be []), and dispatch. dispatch.mode is one of spawn|manual|approval|notify|wake; spawn requires agentId; approval/notify/wake have their own fields.',
        },
        templateId: { type: "string", description: "Workflow template ID (for run_workflow)" },
        variables: { type: "object", description: "Workflow variables (for run_workflow)" },
        taskId: { type: "string", description: "Task ID (for checkpoint, handoff, retry)" },
        phase: { type: "string", description: "Current phase (for checkpoint)" },
        summary: { type: "string", description: "Progress summary (for checkpoint/handoff)" },
        progressPercent: { type: "number", description: "Progress 0-100 (for checkpoint)" },
        artifactPaths: {
          type: "array",
          items: { type: "string" },
          description: "Artifact paths (for handoff)",
        },
        mode: { type: "string", enum: ["restart", "resume"], description: "Retry mode" },
        retryMode: {
          type: "string",
          enum: ["restart", "resume"],
          description: "Retry mode (for retry)",
        },
        goalId: { type: "string", description: "Goal ID (for cancel)" },
        deliverableState: {
          type: "string",
          description: "Handoff deliverable state: complete or partial",
        },
        recommendedNextStep: {
          type: "string",
          description: "Recommended next step after handoff",
        },
        blocker: { type: "string", description: "Known blocker description (for checkpoint)" },
      },
      required: ["action"],
    },
  },
  {
    name: "wiki",
    description: `Knowledge Wiki — personal research wiki with raw notes, compiled concepts, and Q&A. Actions: ${WIKI_ACTIONS.join(", ")}`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "Action: index (rebuild), status (health), ingest_raw (add article), tag (assign topics), prime (concept context), compile (recompile concept), query (Q&A), file_back (enrich concept), lint (health check)",
          enum: [...WIKI_ACTIONS],
        },
        ...AGENT_ID_PROP,
        query: { type: "string", description: "Search query, question, or task description" },
        slug: { type: "string", description: "Concept slug (e.g. 'task-orchestration')" },
        title: { type: "string", description: "Title for new raw article" },
        content: { type: "string", description: "Markdown content for new raw article" },
        topics: { type: "string", description: "Comma-separated topic slugs" },
        rawPath: { type: "string", description: "Raw article relative path" },
        section: { type: "string", description: "Section heading for file_back" },
        insight: { type: "string", description: "Insight text for file_back" },
      },
      required: ["action"],
    },
  },
  {
    name: "learning_capture",
    description:
      "Capture a reusable learning (feedback, project insight, reference, or rejection signal) into the brain's persistent store.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Caller agent identity" },
        kind: {
          type: "string",
          description: "Learning kind: feedback, project, reference, or rejection",
          enum: ["feedback", "project", "reference", "rejection"],
        },
        text: { type: "string", description: "The learning content" },
        why: { type: "string", description: "Why this learning matters" },
        apply_when: {
          type: "string",
          description: "When/where this learning should be applied",
        },
        source_context: {
          type: "string",
          description: "Source context (file path, conversation ref, etc.)",
        },
        confidence: {
          type: "number",
          description: "Confidence score 0-1",
          minimum: 0,
          maximum: 1,
        },
        proposed_wiki_path: {
          type: "string",
          description:
            "Suggested wiki path for graduation (e.g. 'agents/my-learning.md')",
        },
      },
      required: ["agent_id", "kind", "text"],
    },
  },
  {
    name: "traces_record",
    description:
      "Record an execution trace event (tool call, task lifecycle, session boundary).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Caller agent identity" },
        kind: {
          type: "string",
          description: `Trace kind: ${TRACE_KINDS.join(", ")}`,
          enum: [...TRACE_KINDS],
        },
        payload: {
          type: "string",
          description: "JSON object with trace-specific data",
        },
        task_id: { type: "string", description: "Associated task ID" },
        goal_id: { type: "string", description: "Associated goal ID" },
        duration_ms: { type: "number", description: "Duration in milliseconds" },
        t: {
          type: "number",
          description: "Timestamp (epoch ms). Defaults to server time if omitted.",
        },
      },
      required: ["agent_id", "kind", "payload"],
    },
  },
  {
    name: "traces_query",
    description:
      "Query execution traces with optional filters by agent, goal, task, kind, and time range.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Filter by agent ID" },
        goal_id: { type: "string", description: "Filter by goal ID" },
        task_id: { type: "string", description: "Filter by task ID" },
        kind: {
          type: "string",
          description: "Filter by trace kind",
          enum: [...TRACE_KINDS],
        },
        since: { type: "number", description: "Only traces after this epoch ms timestamp" },
        limit: { type: "number", description: "Max results (default 100, max 1000)" },
      },
    },
  },
  {
    name: "memory_search",
    description:
      "Search shared institutional knowledge (wiki) via semantic search. Use corpus='wiki' to search knowledge wiki concepts, corpus='all' for both.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        ...AGENT_ID_PROP,
        limit: { type: "number", description: "Max results (default 5)" },
        corpus: {
          type: "string",
          enum: ["memory", "wiki", "all"],
          description:
            "Search corpus: memory (default, wiki learnings), wiki (knowledge wiki concepts), all (both merged)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "Retrieve a specific memory file by path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Memory file path to retrieve" },
        ...AGENT_ID_PROP,
      },
      required: ["path"],
    },
  },
  {
    name: "m1_event_record",
    description:
      "Record one M1 universal-protocol event. Idempotent on event_id. See wiki: infrastructure/m1-universal-event-protocol.md",
    inputSchema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description:
            "Stable client-generated id (for idempotent ingest). Defaults to a server-derived id from session_id+turn_id+event_type+entries-hash.",
        },
        schema_version: { type: "number", description: "Protocol schema version (1)." },
        runtime: {
          type: "string",
          description: "Emitter runtime: claude-code | hermes | openclaw",
        },
        agent_id: { type: "string", description: "Agent identity" },
        session_id: { type: "string", description: "Runtime-stable session id" },
        turn_id: { type: "string", description: "Monotonic per-session turn id" },
        event_type: {
          type: "string",
          description: `Event type: ${M1_EVENT_TYPES.join(" | ")}`,
          enum: [...M1_EVENT_TYPES],
        },
        entries: {
          type: "string",
          description:
            "JSON-string array of surfaced/acted entries: [{path,title?,score?,source?}]",
        },
        ack_signal: {
          type: "string",
          description:
            "On assistant_ack: explicit_path | title_match | no_applicable | no_acknowledgement",
        },
        extra: {
          type: "string",
          description: "JSON object of additional payload fields",
        },
        t: { type: "number", description: "Event timestamp (epoch ms)" },
      },
      required: ["runtime", "agent_id", "session_id", "event_type"],
    },
  },
  {
    name: "m1_score",
    description:
      "Compute M1 application_rate rollups (ack_rate, use_rate) per (day, runtime, agent) from m1_events in a window. Defaults to last 24h.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Lower bound epoch ms (default 24h ago)" },
        until: { type: "number", description: "Upper bound epoch ms (default now+1)" },
        runtime: {
          type: "string",
          description: "Optional runtime filter",
        },
      },
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];
