/**
 * Pure helpers for `digital-me deploy` — the one command that turns "merged in
 * git" into "verified live". Orchestration (git/pnpm/launchctl/curl) lives in
 * the bin; everything decidable from data lives here so it is unit-testable.
 *
 * The whole command exists to kill the failure shape behind every deploy
 * incident: SILENT DIVERGENCE — the running system quietly executing stale code
 * because a step (pull / rebuild / reinstall-to-canonical-dir / restart) was
 * skipped. deploy runs them all, then verifies the live fingerprint matches.
 */

/** Runtimes that have a *running system* to redeploy + verify (a daemon/service). */
export type DeployRuntime = "openclaw" | "dashboard";
export const DEPLOYABLE_RUNTIMES: readonly DeployRuntime[] = ["openclaw", "dashboard"];

export interface GitDeployState {
  /** `git status --porcelain` output (git-ignored build output never appears). */
  readonly porcelain: string;
  /** commits local `main` is AHEAD of `origin/main`. */
  readonly ahead: number;
  /** commits local `main` is BEHIND `origin/main`. */
  readonly behind: number;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Decide whether the deploy SOURCE checkout is safe to deploy from. The source
 * (`~/digital-me-os` on `main`) must be pristine and not ahead of origin — a
 * dirty tree is a stale-shadow risk, and unpushed commits mean "deploying code
 * that isn't on origin yet". Being BEHIND is fine: deploy fast-forwards.
 */
export function analyzeDeployPreflight(s: GitDeployState): PreflightResult {
  const dirty = s.porcelain
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);
  if (dirty.length > 0) {
    return {
      ok: false,
      reason:
        `the deploy source (~/digital-me-os) has ${dirty.length} uncommitted ` +
        `change(s). Commit/stash on a feature branch (never deploy from a dirty main), then re-run.`,
    };
  }
  if (s.ahead > 0) {
    return {
      ok: false,
      reason:
        `local main is ${s.ahead} commit(s) ahead of origin/main — land them via PR first, ` +
        `so deploy reflects what's actually on origin.`,
    };
  }
  return { ok: true };
}

/** Parse `git rev-list --left-right --count main...origin/main` ("A\tB") → {ahead, behind}. */
export function parseAheadBehind(revListOutput: string): { ahead: number; behind: number } {
  const m = revListOutput.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return { ahead: 0, behind: 0 };
  return { ahead: Number.parseInt(m[1]!, 10), behind: Number.parseInt(m[2]!, 10) };
}

/**
 * Extract the digital-me-recall `assistant_ack=<mode>` value from the most
 * recent registration line in a gateway.log tail — the LIVE fingerprint of
 * which recall build the gateway actually loaded. null if no registration line.
 */
export function parseRecallAckMode(logText: string): string | null {
  const lines = logText
    .split("\n")
    .filter((l) => l.includes("digital-me-recall: registered hooks"));
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1]!;
  const m = last.match(/assistant_ack=([^,)\s]+)/);
  return m ? m[1]!.trim() : null;
}

/**
 * The `assistant_ack=` marker digital-me-recall SHOULD log on this host,
 * derived from the openclaw config the same way the plugin derives it.
 *
 * The plugin emits `agent_end` and `before_message_write` as ack sources,
 * minus any the host will refuse. openclaw drops a conversation hook from a
 * non-bundled plugin unless `plugins.entries.digital-me-recall.hooks
 * .allowConversationAccess` is true — and `agent_end` is in that gated set,
 * `before_message_write` is not. So the marker is a function of the grant.
 *
 * This replaced a regex over the deployed bundle's SOURCE. That worked only
 * while the marker was a string literal; once it became a template
 * expression the grep captured `${ackSources.join(` and every deploy reported
 * a false divergence. Fingerprinting the build was never the point —
 * comparing what the host actually registered against what it should have
 * registered is, and that also turns a missing grant into a deploy failure
 * instead of a silent recall outage.
 */
export function expectedRecallAckMode(cfg: Readonly<Record<string, unknown>>): string {
  const plugins = cfg.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const recall = entries?.["digital-me-recall"] as Record<string, unknown> | undefined;
  const hooks = recall?.hooks as Record<string, unknown> | undefined;
  const granted = hooks?.allowConversationAccess === true;
  return granted ? "agent_end+before_message_write" : "before_message_write";
}

/**
 * Which runtimes to deploy: the explicit `--runtime` set (filtered to the
 * deployable ones), else every deployable runtime detected as installed.
 */
export function planDeployRuntimes(
  requested: readonly string[],
  installed: readonly string[],
): DeployRuntime[] {
  const isDeployable = (r: string): r is DeployRuntime =>
    (DEPLOYABLE_RUNTIMES as readonly string[]).includes(r);
  if (requested.length > 0) return [...new Set(requested.filter(isDeployable))];
  return [...new Set(installed.filter(isDeployable))];
}
