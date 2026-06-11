# openclaw-compat

Single seam between brain-orchestrator and the upstream openclaw plugin SDK. Every openclaw symbol we touch goes through this layer.

## Why this exists

`digital-me-os` is a **downstream consumer** of openclaw — we don't change it, we adapt to it. When upstream renames an API, removes a field, or restructures a type, the rest of the plugin shouldn't notice. This layer absorbs the shock.

See `docs/UPSTREAM-ADAPTATION-CONSTRAINT.md` for the constraint's full statement.

## Files

| File | Purpose |
|---|---|
| `types.ts` | Narrow TS types describing the openclaw SDK surface we use. Mirrors upstream shape; lets internal modules type-check without `import` from `openclaw/*`. |
| `services-bus.ts` | Typed `globalThis.__digitalMeServices` namespace for cross-plugin coupling. Replaces ad-hoc `globalThis.__brainTraceRecorder = ...` pattern. |
| `gateway-scope.ts` | The `Symbol.for("openclaw.pluginRuntimeGatewayRequestScope")` hack, isolated. Provides `runInGatewayScope` with graceful degradation when the scope is unavailable. |
| `feature-detect.ts` | Startup compatibility report — what optional openclaw features are present, what degraded. |
| `index.ts` | Barrel exports — internal modules import from `./openclaw-compat`, not from `openclaw/*` directly. |

## Discipline

**Inside brain-orchestrator, no source file outside `src/openclaw-compat/` should import from `openclaw/*` or read the gateway-scope Symbol.for key directly.** All openclaw-touching code lives here.

When upstream changes (e.g., renames `subagentRun` → `runSubagent`):

1. Compat layer adapts in one file
2. Rest of brain-orchestrator stays untouched
3. CI canary catches the upstream rename before our pinned-range CI starts failing

## What this is NOT

- Not a polyfill for upstream features (we don't fake `api.publishService` if it doesn't exist; we use a typed globalThis instead)
- Not a stable API for external consumers (it's internal; brain-orchestrator's external surface is its MCP tools)
- Not a fork of openclaw (we touch upstream symbols, we don't reimplement them)
