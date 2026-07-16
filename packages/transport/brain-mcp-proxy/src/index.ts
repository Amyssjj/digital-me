/**
 * @digital-me/brain-mcp-proxy
 *
 * Stdio MCP server that forwards tool calls to openclaw's HTTP gateway.
 * The binary entry point is in bin/brain-mcp-proxy.mjs; this module is the
 * importable API for embedding tests or alternate launchers.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

/** Absolute on-disk root of this package (the dir containing package.json). */
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Absolute path to the stdio bin that MCP clients (Codex, Claude Code,
 * Hermes) should spawn. Used by `digital-me install --runtime <codex|claude-code>`
 * to write the resolved path into client config — no global npm install
 * needed, no PATH dependency.
 */
export const BIN_PATH = path.join(PACKAGE_ROOT, "bin", "brain-mcp-proxy.mjs");

export { loadGatewayConfig, resolveDefaultAgentId } from "./config.js";
export type { GatewayConfig } from "./config.js";
export { GatewayConfigError } from "./config.js";
export { invokeGatewayTool } from "./gateway.js";
export type { CallToolResult, GatewayEndpoint } from "./gateway.js";
export {
  buildToolArgs,
  attributionLabel,
  createCallToolHandler,
  extractHitCount,
} from "./handler.js";
export type {
  CallToolRequest,
  GatewayInvoker,
  ToolCallTrace,
  TraceWriter,
} from "./handler.js";
export {
  createSqliteTraceWriter,
  defaultBrainDbPath,
} from "./trace-writer.js";
export { startParentPidWatcher } from "./lifecycle.js";
export type { ParentPidWatcherInput } from "./lifecycle.js";
export { TOOLS } from "./tools.js";
export type { ToolName } from "./tools.js";
export { main } from "./server.js";
export {
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_MAX_BODY_BYTES,
  MIN_TOKEN_LENGTH,
  HttpConfigError,
  isLoopbackHost,
  loadHttpConfig,
} from "./http-config.js";
export type { HttpConfig } from "./http-config.js";
export {
  extractBearerToken,
  resolveAgentId,
  timingSafeTokenEqual,
} from "./http-auth.js";
export type { AgentIdResolution } from "./http-auth.js";
export {
  AGENT_ID_HEADER,
  AGENT_ID_QUERY_PARAM,
  HEALTH_PATH,
  MCP_PATH,
  createRequestListener,
  handleMcpRequest,
  readJsonBody,
  withEnforcedAgentId,
} from "./http-app.js";
export type { RequestListenerDeps, ToolHandler } from "./http-app.js";
export { mainHttp } from "./http-server.js";
