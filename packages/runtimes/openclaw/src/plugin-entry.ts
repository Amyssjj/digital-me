/**
 * openclaw plugin entry — wraps brain-orchestrator's runtime-agnostic
 * `BrainTool` descriptors into openclaw's plugin SDK tool shape (typebox
 * parameter schemas + a 2-arg `execute(toolCallId, params)` callback)
 * and exposes a single `buildOpenClawBrainTools(deps)` factory that the
 * user's openclaw plugin entry calls inside `register(api)`:
 *
 *     // user's openclaw plugin index.ts
 *     export default definePluginEntry({
 *       id: "@digital-me/brain",
 *       name: "Digital Me Brain",
 *       register(api) {
 *         const tools = buildOpenClawBrainTools(deps);
 *         for (const tool of tools) api.registerTool(tool);
 *       },
 *     });
 *
 * The tool descriptors have the exact shape openclaw's `AgentTool`
 * expects — `name`, `description`, `parameters: TSchema`, and an
 * `execute(toolCallId, params)` returning `{ content: [{type:"text",
 * text}], details, isError? }`.
 */

import type { TSchema } from "typebox";
import {
  buildBrainOrchestratorTools,
  type BrainOrchestratorPluginDeps,
  type BrainTool,
  type MCPToolResult,
} from "@digital-me/brain-orchestrator";
import { TOOL_SCHEMAS, type ToolName } from "./tool-schemas.js";

/** The shape openclaw's `api.registerTool` accepts. Defined locally so we
 *  don't need a direct dep on `@earendil-works/pi-agent-core`. */
export type OpenClawAgentTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<MCPToolResult>;
};

/**
 * Build openclaw-shaped tool descriptors for all 5 brain-orchestrator
 * tools. Each combines the runtime-agnostic `BrainTool.execute` with the
 * typebox parameter schema from `TOOL_SCHEMAS`.
 */
export function buildOpenClawBrainTools(
  deps: BrainOrchestratorPluginDeps,
): readonly OpenClawAgentTool[] {
  const brainTools = buildBrainOrchestratorTools(deps);
  return brainTools.map((t) => toOpenClawTool(t));
}

/**
 * Wrap a single `BrainTool` in openclaw's `AgentTool` shape. Exported so
 * tests (and future custom tools) can exercise the schema-lookup gate
 * directly. Throws if no typebox schema exists for the tool name —
 * surfaces the contract violation early rather than letting openclaw's
 * registerTool fail with an opaque error.
 */
export function toOpenClawTool(brain: BrainTool): OpenClawAgentTool {
  const schema = TOOL_SCHEMAS[brain.name as ToolName];
  if (!schema) {
    throw new Error(
      `runtime-openclaw: missing typebox schema for tool "${brain.name}". ` +
        `Add it to tool-schemas.ts.`,
    );
  }
  return {
    name: brain.name,
    description: brain.description,
    parameters: schema,
    execute: async (_toolCallId, params) => {
      // openclaw passes params as `unknown`; brain-orchestrator's
      // handler signature requires a plain object — narrow defensively.
      const record =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      return await brain.execute(record);
    },
  };
}
