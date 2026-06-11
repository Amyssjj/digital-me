/**
 * @digital-me/runtime-openclaw
 *
 * openclaw runtime adapter for the digital-me brain. Wires:
 *   - The `Dispatcher` interface required by brain-orchestrator's
 *     scheduler, using openclaw's subagent + exec runtime.
 *   - (Future) Openclaw plugin entry that registers the 5 `BrainTool`
 *     descriptors with typebox schemas via `api.registerTool`.
 *   - (Future) The data-driven proactive-learning rule engine.
 */

export {
  createOpenClawDispatcher,
} from "./dispatcher.js";
export type { OpenClawDispatcherDeps } from "./dispatcher.js";

export {
  buildOpenClawBrainTools,
  toOpenClawTool,
} from "./plugin-entry.js";
export type { OpenClawAgentTool } from "./plugin-entry.js";

export { TRANSCRIPT_SOURCE } from "./manifest.js";

export {
  AgentIdentifyToolSchema,
  LearningCaptureToolSchema,
  TasksToolSchema,
  TOOL_SCHEMAS,
  TracesQueryToolSchema,
  TracesRecordToolSchema,
} from "./tool-schemas.js";
export type {
  TasksToolParams,
  ToolName,
} from "./tool-schemas.js";

export {
  buildInjection,
  extractRecentMessagesText,
  loadDomainContext,
  matchDomains,
} from "./proactive-learning.js";
export type {
  DomainRule,
  MessageLike,
  ProactiveLearningConfig,
  ReadFileFn,
} from "./proactive-learning.js";

export {
  DEFAULT_WORKER_SCRIPT,
  createOpenClawAliasResolver,
  defaultArtifactRoot,
} from "./alias-resolver.js";
export type {
  AliasResolverOptions,
  CliAliasConfig,
} from "./alias-resolver.js";

export {
  BRAIN_ENTRY_TEMPLATE,
  BRAIN_INSTALL_FILES,
  BRAIN_MANIFEST_TEMPLATE,
  BRAIN_PLUGIN_DIRNAME,
  BRAIN_TEMPLATES_DIR,
  ENTRY_TEMPLATE,
  EXTENSION_PACKAGE_JSON,
  INSTALL_FILES,
  MANIFEST_TEMPLATE,
  PACKAGE_ROOT as INSTALLER_PACKAGE_ROOT,
  PLUGINS,
  PLUGIN_DIRNAME,
  PREBUILT_DIR,
  RECALL_ENTRY_TEMPLATE,
  RECALL_INSTALL_FILES,
  RECALL_MANIFEST_TEMPLATE,
  RECALL_PLUGIN_DIRNAME,
  RECALL_TEMPLATES_DIR,
  TEMPLATES_DIR,
  buildExtensionPackageJson,
} from "./installer.js";
export type {
  PluginInstallDescriptor,
  ResolvedPackagePaths,
} from "./installer.js";

export {
  applyRecallHygiene,
  buildMemorySearchTrace,
  buildRouteIndex,
  extractActivePolicies,
  extractFrontmatterText,
  extractRuleSection,
  formatRecallInjection,
  formatRouteInjection,
  loadBootContext,
  matchRouteConditions,
  parseDigitalMeAck,
  parseRelatedField,
  parseRouteFrontmatter,
  readWikiBody,
} from "./recall-hooks.js";
export type {
  AckEntry,
  AckSignal,
  BootContextFsAccess,
  BootContextSources,
  MemorySearchTrace,
  ParsedAck,
  RecallHit,
  RouteRule,
  WikiBodyReader,
} from "./recall-hooks.js";

export { expandViaGraph } from "./wiki-graph.js";
export type { WikiEntry } from "./wiki-graph.js";

export {
  DEFAULT_PNPM_SPEC,
  DEFAULT_TAG_MATURITY_HOURS,
  OVERLAY_DIRNAMES,
  selectMatureStableTag,
  updateOpenclaw,
} from "./updater.js";
export type {
  ExecFn,
  ExecResult,
  UpdateOpenclawOptions,
  UpdateResult,
  UpdateStatus,
} from "./updater.js";
