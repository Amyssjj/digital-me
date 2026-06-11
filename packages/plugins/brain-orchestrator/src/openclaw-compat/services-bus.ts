/**
 * Typed `globalThis.__digitalMeServices` namespace for cross-plugin coupling.
 *
 * Why a globalThis namespace and not an openclaw SDK API:
 * Openclaw's plugin SDK does not currently expose `api.publishService` /
 * `api.consumeService`. Upstream's own plugins use ad-hoc globalThis keys
 * (e.g. `globalThis.__brainTraceRecorder = …`) as the de facto coupling
 * pattern. We adopt the same pattern but with one well-known namespace
 * and TypeScript types so consumers have a single contract.
 *
 * Forward-compatibility note: when openclaw eventually adds a real
 * services-discovery API, `feature-detect.ts` will detect it and a future
 * version of this module will prefer that API automatically. Today, the
 * globalThis namespace is the only mechanism that works on all openclaw
 * versions.
 *
 * Naming convention for service keys: lowercase with hyphens
 * (`trace-recorder`, `agent-registry`, `goal-events`). Each key has a TS
 * contract that consumers can express via the generic parameter of
 * consumeService<T>.
 */

const NAMESPACE = "__digitalMeServices";

// Augment globalThis with our namespace so consumers in this package get
// typed access through `globalThis.__digitalMeServices` if they prefer
// inline reads.
declare global {
   
  var __digitalMeServices: Record<string, unknown> | undefined;
}

function globalSlot(): { -readonly [k in typeof NAMESPACE]?: Record<string, unknown> } {
  return globalThis as unknown as {
    [k in typeof NAMESPACE]?: Record<string, unknown>;
  };
}

/**
 * Publish an implementation under a service name. Idempotent — calling
 * twice with the same name replaces the previous implementation. Creates
 * the namespace if it doesn't yet exist.
 */
export function publishService<T>(name: string, impl: T): void {
  const slot = globalSlot();
  const current = slot[NAMESPACE] ?? {};
  current[name] = impl;
  slot[NAMESPACE] = current;
}

/**
 * Consume a service by name. Returns `undefined` when no implementation is
 * registered. Consumers must check the return value before invoking — the
 * absence of a service is a graceful-degradation signal, not an error.
 */
export function consumeService<T>(name: string): T | undefined {
  const slot = globalSlot();
  const bus = slot[NAMESPACE];
  if (bus === undefined) return undefined;
  return bus[name] as T | undefined;
}

/**
 * Read the entire services namespace (or `undefined` if nothing has been
 * published yet). Used by feature-detect.ts and for tests that need to
 * inspect the bus state.
 */
export function readServicesBus(): Readonly<Record<string, unknown>> | undefined {
  const slot = globalSlot();
  return slot[NAMESPACE];
}

/**
 * Clear all services and remove the namespace from globalThis. Primarily
 * for tests — production plugins should never call this.
 */
export function clearServicesBus(): void {
  const slot = globalSlot();
  delete slot[NAMESPACE];
}
