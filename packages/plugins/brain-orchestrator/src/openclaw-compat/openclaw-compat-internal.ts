/**
 * Internal re-exports for tests in this directory. External consumers
 * (the rest of brain-orchestrator) should import from `./index.js`.
 */

export {
  GATEWAY_SCOPE_SYMBOL_KEY,
  isGatewayScopeAvailable,
  resetGatewayScopeForTests,
  runInGatewayScope,
} from "./gateway-scope.js";
export type { RunInGatewayScopeOptions } from "./gateway-scope.js";

export { buildCompatReport } from "./feature-detect.js";
export type { CompatReport } from "./feature-detect.js";

export {
  clearServicesBus,
  consumeService,
  publishService,
  readServicesBus,
} from "./services-bus.js";
