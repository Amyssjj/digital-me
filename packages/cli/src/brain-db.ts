import path from "node:path";
import { brainDataDirOf, resolveBrainDbPath, type BrainPathDeps } from "@digital-me/contracts";

/**
 * `digital-me brain-db migrate` — move brain.db from the legacy openclaw
 * location to its canonical home beside the wiki (`<wiki-root>/.data/brain.db`).
 *
 * Pure planner: decides what (if anything) to do from the same contracts rule
 * every reader applies, so the command can never move a database that the
 * services would not pick up afterwards. The copy itself (SQLite `VACUUM
 * INTO`, a consistent single-file snapshot) and the "is anything serving it"
 * probe live in the bin.
 */

export type BrainDbMigrationAction =
  /** The legacy file is the live one and the canonical path is free: copy it. */
  | "migrate"
  /** brain.db already resolves to the canonical path. */
  | "already-canonical"
  /** DIGITAL_ME_BRAIN_DB pins an explicit path; the rule is bypassed on purpose. */
  | "explicit-env"
  /** No brain.db exists anywhere yet — a fresh install creates it canonically. */
  | "no-source";

export interface BrainDbMigrationPlan {
  readonly action: BrainDbMigrationAction;
  readonly from?: string;
  readonly to: string;
  readonly message: string;
}

export function planBrainDbMigration(deps: BrainPathDeps): BrainDbMigrationPlan {
  const to = path.join(brainDataDirOf(deps.env, deps.home), "brain.db");
  const resolved = resolveBrainDbPath(deps);
  switch (resolved.source) {
    case "env":
      return {
        action: "explicit-env",
        to,
        message:
          `DIGITAL_ME_BRAIN_DB is set explicitly (${resolved.path}); nothing to migrate. ` +
          `Unset it (or point it at ${to}) if you want the canonical location.`,
      };
    case "legacy-openclaw":
      return {
        action: "migrate",
        from: resolved.path,
        to,
        message: `brain.db lives at the legacy openclaw location ${resolved.path}; copying it to ${to}.`,
      };
    case "canonical":
      return deps.exists(to)
        ? { action: "already-canonical", to, message: `brain.db is already at its canonical location ${to}.` }
        : {
            action: "no-source",
            to,
            message: `No brain.db found (canonical ${to} or a legacy ~/.openclaw copy); brain-host will create it at ${to} on first start.`,
          };
  }
}

/** What to re-run after a successful move so every service picks the new path up. */
export function postMigrationSteps(opts: {
  readonly brainHostInstalled: boolean;
  readonly dashboardInstalled: boolean;
  readonly openclawInstalled: boolean;
}): readonly string[] {
  const steps: string[] = [];
  if (opts.brainHostInstalled) {
    steps.push("digital-me install --runtime brain-host   # rewrites the service unit with the canonical path and restarts it");
  }
  if (opts.dashboardInstalled) {
    steps.push("digital-me service dashboard install     # same for the dashboard's readers");
  }
  if (opts.openclawInstalled) {
    steps.push("digital-me install --runtime openclaw     # the gateway plugin re-resolves brain.db on its next restart");
  }
  steps.push(`then remove the legacy copy once everything is green: digital-me doctor`);
  return steps;
}
