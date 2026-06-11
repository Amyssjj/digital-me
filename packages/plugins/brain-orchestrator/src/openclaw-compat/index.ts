/**
 * Public barrel for brain-orchestrator internals. Importing from this module
 * is how other source files in brain-orchestrator (resolver, scheduler,
 * stores, tool handlers, plugin entry) reach the openclaw SDK surface.
 *
 * Discipline: NO source file outside `src/openclaw-compat/` should import
 * from `openclaw/*` directly or read the gateway-scope Symbol.for key
 * inline. All openclaw-touching code lives here.
 */

// Types describing the openclaw SDK surface.
export type {
  CommandHandler,
  ExecRunArgs,
  ExecRunResult,
  OpenClawApi,
  OpenClawRuntime,
  PluginEntryDefinition,
  SubagentRunArgs,
  ToolHandler,
} from "./types.js";

// Gateway-scope hack, isolated.
export {
  GATEWAY_SCOPE_SYMBOL_KEY,
  isGatewayScopeAvailable,
  runInGatewayScope,
} from "./gateway-scope.js";
export type { RunInGatewayScopeOptions } from "./gateway-scope.js";

// Compatibility self-check.
export { buildCompatReport } from "./feature-detect.js";
export type { CompatReport } from "./feature-detect.js";

// Cross-plugin service bus.
export { consumeService, publishService } from "./services-bus.js";
