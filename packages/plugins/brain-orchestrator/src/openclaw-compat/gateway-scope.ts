/**
 * Gateway-scope shim — isolated wrapper around openclaw's internal
 * `Symbol.for("openclaw.pluginRuntimeGatewayRequestScope")` AsyncLocalStorage.
 *
 * Why this lives here (and not inline in scheduler / index.ts):
 *   The plugin's periodic scheduler tick needs to run inside a "gateway
 *   request scope" so openclaw's runtime helpers (subagent.run, etc.)
 *   resolve the active client and pluginId correctly. Openclaw exposes the
 *   storage via a process-global symbol-keyed slot. That's an internal
 *   contract — upstream could rename the key without notice.
 *
 *   We isolate the access here so:
 *   1. Rest of brain-orchestrator imports `runInGatewayScope` and forgets
 *      about the underlying mechanism.
 *   2. When the symbol slot is empty (older openclaw, build-time scan,
 *      future rename), we degrade gracefully — the function runs without
 *      a synthetic scope, optional features that need it disable themselves
 *      via `isGatewayScopeAvailable()`, and a single-shot warning logs.
 *   3. A CI integration test against the latest openclaw release verifies
 *      the symbol still resolves to a usable store (canary).
 *
 * Reference: docs/UPSTREAM-ADAPTATION-CONSTRAINT.md (S1.3 resolution).
 */

/** The symbol key upstream openclaw uses. Exported for the CI canary test. */
export const GATEWAY_SCOPE_SYMBOL_KEY =
  "openclaw.pluginRuntimeGatewayRequestScope";

/** Shape of upstream's stored AsyncLocalStorage (duck-typed; we only need `.run`). */
type AlsLike = {
  run<T>(store: GatewayRequestScope, fn: () => T): T;
};

type GatewayRequestScope = {
  isWebchatConnect: () => boolean;
  pluginId?: string;
};

let warnedDegraded = false;

function readGlobalSlot(): unknown {
  const key = Symbol.for(GATEWAY_SCOPE_SYMBOL_KEY);
  return (globalThis as Record<symbol, unknown>)[key];
}

function asAls(value: unknown): AlsLike | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as { run?: unknown };
  if (typeof candidate.run !== "function") return null;
  return value as AlsLike;
}

/**
 * Reports whether the gateway scope is currently usable. Optional features
 * (the periodic scheduler tick, gateway_start catch-up) should check this
 * before enabling themselves and degrade quietly if false.
 */
export function isGatewayScopeAvailable(): boolean {
  return asAls(readGlobalSlot()) !== null;
}

export type RunInGatewayScopeOptions = {
  /** Plugin identifier published into the synthetic scope. Defaults to "brain-orchestrator". */
  readonly pluginId?: string;
  /**
   * Called once if the scope is unavailable and the function had to run
   * outside it. Useful for logging the degradation to the host so users
   * see a clear message instead of mysterious missing features.
   */
  readonly onDegraded?: (message: string) => void;
};

/**
 * Run `fn` inside the upstream gateway request scope so plugin runtime
 * helpers find a non-empty AsyncLocalStorage store. When the scope is
 * unavailable, runs `fn` directly and invokes `onDegraded` exactly once
 * across the process lifetime.
 */
export function runInGatewayScope<T>(
  fn: () => T,
  options: RunInGatewayScopeOptions = {},
): T {
  const als = asAls(readGlobalSlot());
  if (als !== null) {
    return als.run(
      {
        isWebchatConnect: () => false,
        pluginId: options.pluginId ?? "brain-orchestrator",
      },
      fn,
    );
  }

  if (!warnedDegraded) {
    warnedDegraded = true;
    const message =
      "openclaw-compat: gateway scope unavailable; running without synthetic scope. " +
      "Periodic cron-tick paths that depend on subagent.run resolving the gateway client " +
      "may misbehave. Verify openclaw exposes Symbol.for(\"" +
      GATEWAY_SCOPE_SYMBOL_KEY +
      "\") on globalThis as an AsyncLocalStorage instance.";
    options.onDegraded?.(message);
  }
  return fn();
}

/**
 * Test helper: clear the once-warned flag. Production code should never
 * call this.
 */
export function resetGatewayScopeForTests(): void {
  warnedDegraded = false;
}
