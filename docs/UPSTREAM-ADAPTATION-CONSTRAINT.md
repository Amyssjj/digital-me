# Upstream-Adaptation Constraint

## The constraint

`digital-me-os` is built **on top of** upstream openclaw, not alongside it. Three operational realities follow:

1. **We consume openclaw, we don't change it.** Any architecture that depends on a new upstream API, an SDK addition, or a core change is **not a viable architecture**.
2. **We must adapt to the latest openclaw automatically.** As upstream evolves, our plugins should keep working with minimal churn. Pinning to an old version is failure.
3. **The foundation is fixed; our space for design is internal.** Within our plugin boundary we have full freedom. Outside it (the SDK, the gateway, the protocol) is exogenous.

This is a self-contained-downstream-plugin model, not a co-design model.

## What this means for the V2 review recommendations

Re-evaluating each previously-reviewed architecture item against the constraint:

| # | Item | Requires upstream change? | Still valid? |
|---|---|---|---|
| C1 | Split god-store into per-domain stores | No — internal | ✅ Keep |
| C2 | Decompose Resolver | No — internal | ✅ Keep |
| C3 | Split `tasks` mega-tool into per-domain MCP tools | No — `api.registerTool` is already per-tool; we just call it many times instead of once | ✅ Keep |
| C4 | Real plugin-services discovery API (`api.publishService` / `api.consumeService`) | **YES — needs upstream SDK addition** | ❌ **Drop** — stay on `globalThis` pattern, just clean it up |
| C5 | Extract business logic from `index.ts` | No — internal | ✅ Keep |
| C6 | Replace `Originator` with generic `DispatchContext` | Partial — internal types change is free, but if we touch how we *call* `subagent.run` we must keep the call signature the upstream SDK accepts | ✅ Keep (with caveat) |
| C7 | Publish brain_agents contract via `@digital-me/contracts` | No — internal | ✅ Keep |
| C8 | Per-tool API versioning in plugin manifest | No — the manifest is ours | ✅ Keep |
| C9 | Workflow-git-isolation as separate plugin via lifecycle hooks | Partial — "first-class lifecycle hook API" needs upstream addition; "separate plugin via globalThis" works today | ⚠ Adjust — extract to separate plugin using same coupling pattern openclaw allows today |
| C10 | Test and isolate `interpolateVars` | No — internal | ✅ Keep |
| S1.3 | Gateway-scope hack → public `runInGatewayScope` SDK API | **YES — needs upstream SDK addition** | ❌ **Drop** — keep the hack, harden it instead |

## Items dropped because they require upstream changes

### ~~C4 (real services discovery API)~~

The V2 proposal said:
> Refactor: Get a proper plugin-services discovery API on the openclaw plugin SDK.

**Revised:** stay on `globalThis` pattern. **But** clean it up:

- Use one well-known namespace: `globalThis.__digitalMeServices` instead of ad-hoc keys
- Define a TS type contract in `@digital-me/contracts`:
  ```typescript
  declare global {
    var __digitalMeServices: DigitalMeServices | undefined;
  }
  export type DigitalMeServices = {
    traceRecorder?: TraceRecorder;
    agentRegistry?: AgentRegistry;
    // ... other cross-plugin services we publish
  };
  ```
- Publishing in `index.ts`:
  ```typescript
  globalThis.__digitalMeServices = {
    ...(globalThis.__digitalMeServices ?? {}),
    traceRecorder: { record: (params) => store.traces.insert(params) },
  };
  ```
- Consuming (in other digital-me plugins, e.g. memory-core fork):
  ```typescript
  globalThis.__digitalMeServices?.traceRecorder?.record(params);
  ```

This is **still a globalThis hack** — but with a typed contract, single namespace, and explicit publish/consume convention. It works on any openclaw version because it doesn't use any openclaw API at all.

### ~~S1.3 (real `runInGatewayScope` SDK API)~~

The V2 proposal said:
> Get a real API on the openclaw plugin SDK.

**Revised:** keep the `Symbol.for("openclaw.pluginRuntimeGatewayRequestScope")` hack. **But** harden it:

- Isolate in `src/openclaw-compat/gateway-scope.ts` with the explanatory comment upstream already has
- On plugin startup, **verify the key resolves to a store**. If it doesn't, log a clear warning and disable the cron-tick code path (graceful degradation, not silent failure)
- Add a CI integration test that loads the plugin against the latest openclaw release and verifies the symbol still resolves
- When the test fails on an openclaw release, that's the signal to investigate. The CI failure is the canary.

This pattern is the **detect-and-degrade-and-notify** alternative to "request the upstream feature." It works regardless of openclaw's roadmap.

## Items adjusted because of the constraint

### C9 (workflow-git-isolation extraction)

The V2 proposal said:
> Define a "workflow lifecycle hook" extension API in brain-orchestrator: third parties register `onGoalStart` / `onGoalComplete` handlers.

**Revised:** brain-orchestrator publishes `goalEvents` on the digital-me services namespace; workflow-git-isolation subscribes to it.

```typescript
// brain-orchestrator/index.ts
const goalEvents = createEventEmitter();
store.setGoalStatusChangeCallback((goalId, from, to) => {
  goalEvents.emit("status-change", { goalId, from, to });
});
globalThis.__digitalMeServices = {
  ...(globalThis.__digitalMeServices ?? {}),
  goalEvents,
};

// workflow-git-isolation/index.ts
const goalEvents = globalThis.__digitalMeServices?.goalEvents;
if (goalEvents) {
  goalEvents.on("status-change", ({ goalId, to }) => {
    if (to === "completed" || to === "failed") finalizeBranch(goalId);
  });
}
```

Same coupling pattern as C4, applied to lifecycle events. Workflow branching becomes a separate plugin without requiring any upstream API.

### C6 (Originator → DispatchContext)

Internal type rename is free. **The constraint:** wherever we call into the openclaw SDK (subagent.run, etc.), we must produce the shape it expects. So `DispatchContext` is our internal type; at the dispatch boundary we project it back to whatever `subagent.run` accepts:

```typescript
// Internal:
function dispatchSpawn(task: OrchestratorTaskRecord) {
  return runtime.subagentRun(toSubagentRunArgs(task.dispatchContext, task));
}

// One adapter, one place:
function toSubagentRunArgs(ctx: DispatchContext | undefined, task: Task) {
  // Translate to whatever upstream subagent.run currently expects.
  // This adapter is the only place that knows the upstream shape.
  return {
    sessionKey: buildSessionKey(task),
    message: buildPrompt(task),
    agentId: task.dispatch.agentId,
    // If routingKey is "discord:<channel>:<account>:<thread>" we parse it here
    // and reproject to channel/accountId/threadId. If it's another shape,
    // we leave them undefined.
    ...projectRoutingKey(ctx?.routingKey),
  };
}
```

The boundary adapter absorbs upstream evolution. Our internal types stay clean.

## Items unchanged (purely internal refactors)

C1, C2, C3, C5, C7, C8, C10 remain as in the V2 review — all internal to our plugin boundary, no upstream impact.

## What this constraint adds — upstream adaptation pattern

This is the bigger point: **build the plugin so upstream changes don't break it.** A few patterns:

### 1. Pin a compatibility range, test continuously

`brain-orchestrator/package.json`:
```json
"peerDependencies": {
  "openclaw": ">=2026.5.0 <2027.0.0"
}
```

CI integration tests run against:
- The currently-pinned range (must pass)
- The latest tagged openclaw release (warning if fails)
- Openclaw `main` (informational; tracks upstream development)

When openclaw releases a new minor and our pinned-range CI fails, that's the signal to bump and investigate.

### 2. Wrap the SDK surface we use in a `compat/` layer

```
src/openclaw-compat/
├── plugin-entry.ts      // re-exports definePluginEntry, OpenClawPluginApi types
├── gateway-scope.ts     // the Symbol.for hack, isolated, with degrade fallback
├── subagent-run.ts      // adapter: our DispatchContext → upstream subagent.run args
├── exec-run.ts          // adapter: our exec task → upstream exec args (if used)
└── README.md            // documents which openclaw symbols we touch and why
```

Every place we call into openclaw goes through this layer. When openclaw renames `subagentRun` → `runSubagent`, we update the adapter in one file. The rest of the plugin doesn't notice.

### 3. Defensive feature detection at startup

On plugin register, run a self-check:

```typescript
function checkOpenclawCompatibility(api: OpenClawPluginApi): CompatReport {
  const report: CompatReport = { ok: true, warnings: [], failures: [] };

  // Required features:
  if (!api.runtime?.subagent) report.failures.push("api.runtime.subagent missing");
  if (!api.registerTool) report.failures.push("api.registerTool missing");

  // Optional features (degrade gracefully):
  if (!hasGatewayRequestScope()) {
    report.warnings.push("gateway request scope unavailable; cron tick disabled");
  }
  if (typeof api.publishService === "function") {
    // Future-proofing: when openclaw eventually adds this, we use it.
    report.warnings.push("api.publishService detected; preferring SDK API over globalThis");
  }

  report.ok = report.failures.length === 0;
  return report;
}
```

Plugin logs the report on startup. Users see a clear "this feature degraded because openclaw version X doesn't have Y" message rather than mysterious failures.

### 4. Forward-compatibility: feature-flag new openclaw APIs

When openclaw eventually does add `api.publishService` (or similar), our plugin can pick it up automatically:

```typescript
function publishService<T>(name: string, impl: T): void {
  // Prefer the SDK API if available.
  if (typeof api.publishService === "function") {
    api.publishService(name, impl);
    return;
  }
  // Fall back to globalThis namespace.
  globalThis.__digitalMeServices = {
    ...(globalThis.__digitalMeServices ?? {}),
    [name]: impl,
  };
}
```

One function, two implementations, auto-detects. As openclaw evolves, our plugin evolves with it without any code churn.

### 5. Track upstream releases as a first-class workflow

Add a `pnpm openclaw:check-upstream` script that:
- Reads `peerDependencies.openclaw`
- Queries npm for newer published versions
- Runs the integration test against the latest
- Reports any compat warnings

Run this on a cron schedule (CI nightly). The result is the operational signal for "openclaw moved, we should look."

## Net summary: revised refactor severity

| Severity | Item | Why |
|---|---|---|
| **High** (do during port) | C1 Per-domain stores | Aligns with new families' shape; better testability |
| **High** | C3 Split mega-tool into per-domain tools | Public API quality; matches `metric.*` etc. convention |
| **High** | C5 Extract logic from `index.ts` | Plugin entry should be wire-up only |
| **Medium** | C2 Decompose Resolver | Internal cleanup; high payoff but invasive |
| **Medium** | C6 Internal `DispatchContext` (with boundary adapter) | Decouples our types from chat platforms |
| **Medium** | C10 Test interpolateVars | Security-relevant |
| **Medium** | C9 Extract workflow-git-isolation as a separate plugin (using globalThis events, not SDK API) | Optional-feature isolation; users without git skip it |
| **Low-medium** | C8 Per-family tool versioning in our manifest | Helps consumers; cheap to do |
| **Low-medium** | C7 Publish brain_agents contract via `@digital-me/contracts` | Future-proofs eventual plugin promotion |
| **Adapt instead of refactor** | ~~C4~~ | Use globalThis with typed namespace; auto-prefer real SDK API if openclaw adds one |
| **Adapt instead of refactor** | ~~S1.3~~ | Keep Symbol.for hack; isolate, harden with degrade fallback + CI canary |
| **New** | A1 Add `src/openclaw-compat/` layer | All SDK-facing calls go through one place |
| **New** | A2 Compatibility self-check + report on startup | Users see graceful degradation, not mysterious failures |
| **New** | A3 CI integration test against latest openclaw release | Canary for upstream-breaking changes |
| **New** | A4 Forward-compat feature detection | When openclaw adds APIs, we adopt them automatically |

## What I should have said in the V2 review

The V2 review framed several items as "needs upstream cooperation." Under the constraint, that's the wrong framing. The right framing is:

**For every upstream-dependency: how do we adapt without one?**

- C4 / "real services API": adapt → typed globalThis namespace
- S1.3 / "real gateway-scope API": adapt → isolated hack + canary + degrade fallback
- C9 / "lifecycle hooks": adapt → separate plugin that subscribes via globalThis events
- C6 / "subagent.run shape": adapt → boundary adapter in `src/openclaw-compat/`

The result is **the same architectural decomposition** (per-domain stores, focused tools, slim plugin entry) layered on top of a **compatibility surface** that absorbs upstream change. The plugin remains pure-downstream; openclaw doesn't need to know we exist.

## Updated port-day scope

1. **Apply all S1 items** as previously planned (paths, node:sqlite ✓ already done, hardcoded IDs, exec worker path)
2. **Add `src/openclaw-compat/`** as the first step of the port — every SDK touchpoint goes through it
3. **Apply C1** (per-domain stores) — already partially done
4. **Apply C3** (per-domain MCP tools) — most user-visible win
5. **Apply C5** (extract from index.ts) — easy win
6. **Apply C10** (test interpolateVars) — small, security-relevant
7. **Add A2 + A3** (compat self-check + CI canary against latest openclaw) — operational hardening
8. **Defer** C2, C6, C7, C8, C9 to follow-up commits

This is the architecture that serves the long-term goal **and** respects the constraint. No upstream wishes, just clean downstream code with a thoughtful compatibility layer.
