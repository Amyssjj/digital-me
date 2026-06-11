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
