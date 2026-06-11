/**
 * Startup compatibility report — what optional openclaw features are present,
 * which degraded, which forward-compat APIs are visible.
 *
 * Plugin entry calls `buildCompatReport(api)` on register and logs `format()`
 * so users see a clear "feature X disabled because openclaw version Y
 * doesn't have Z" message instead of mysterious silent failures.
 *
 * Forward-compat detection lets the plugin opportunistically prefer newer
 * openclaw SDK APIs when they exist (e.g. an eventual `api.publishService`)
 * without breaking on older versions.
 */

import type { OpenClawApi } from "./types.js";
import { isGatewayScopeAvailable } from "./gateway-scope.js";

export type CompatReport = {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly degradedFeatures: readonly string[];
  readonly forwardCompatFeatures: readonly string[];
  format(): string;
};

export function buildCompatReport(api: OpenClawApi): CompatReport {
  const failures: string[] = [];
  const warnings: string[] = [];
  const degradedFeatures: string[] = [];
  const forwardCompatFeatures: string[] = [];

  // ── Required features ───────────────────────────────────────────────────
  if (api.runtime === undefined) {
    failures.push("api.runtime is undefined (cannot dispatch subagents)");
  } else if (typeof api.runtime.subagent?.run !== "function") {
    // The contract requires a callable subagent.run; a present-but-malformed
    // subagent ({} or { run: "x" }) must fail the check, not just an absent one.
    failures.push(
      "api.runtime.subagent.run is not a function (cannot dispatch spawn-mode tasks)",
    );
  }
  if (typeof api.registerTool !== "function") {
    failures.push("api.registerTool is not a function (cannot register MCP tools)");
  }
  if (typeof api.resolvePath !== "function") {
    failures.push("api.resolvePath is not a function (cannot resolve plugin paths)");
  }

  // ── Optional features (degraded but not fatal) ──────────────────────────
  if (!isGatewayScopeAvailable()) {
    warnings.push(
      "gateway scope unavailable; periodic cron-tick path will run without a synthetic scope. " +
        "Cron schedules may misbehave if subagent.run depends on the scope.",
    );
    degradedFeatures.push("periodic-cron-tick");
  }

  // ── Forward-compat features (newer openclaw APIs we'd opportunistically use) ──
  const apiAny = api as unknown as Record<string, unknown>;
  if (typeof apiAny.publishService === "function") {
    forwardCompatFeatures.push("api.publishService");
  }
  if (typeof apiAny.consumeService === "function") {
    forwardCompatFeatures.push("api.consumeService");
  }
  if (typeof apiAny.runInGatewayScope === "function") {
    forwardCompatFeatures.push("api.runInGatewayScope");
  }

  const ok = failures.length === 0;

  return {
    ok,
    failures,
    warnings,
    degradedFeatures,
    forwardCompatFeatures,
    format(): string {
      const lines: string[] = [];
      lines.push("brain-orchestrator compatibility report:");
      if (ok && warnings.length === 0) {
        lines.push("  status: OK — all required features present, nothing degraded");
      } else if (ok) {
        lines.push("  status: OK with warnings");
      } else {
        lines.push("  status: FAIL — required features missing");
      }
      if (failures.length > 0) {
        lines.push("  failures:");
        for (const f of failures) lines.push(`    - ${f}`);
      }
      if (warnings.length > 0) {
        lines.push("  warnings:");
        for (const w of warnings) lines.push(`    - ${w}`);
      }
      if (degradedFeatures.length > 0) {
        lines.push("  degraded features: " + degradedFeatures.join(", "));
      }
      if (forwardCompatFeatures.length > 0) {
        lines.push(
          "  forward-compat features detected (will prefer where applicable): " +
            forwardCompatFeatures.join(", "),
        );
      }
      return lines.join("\n");
    },
  };
}
