import { describe, expect, it } from "vitest";

import { planBrainDbMigration, postMigrationSteps } from "./brain-db.js";

const HOME = "/home/t";
const CANON = "/home/t/digital-me/.data/brain.db";
const LEGACY = "/home/t/.openclaw/data/brain.db";

function deps(env: Record<string, string | undefined>, existing: readonly string[] = []) {
  return { env, home: HOME, exists: (p: string) => existing.includes(p) };
}

describe("planBrainDbMigration", () => {
  it("migrates when only the legacy openclaw file exists", () => {
    const plan = planBrainDbMigration(deps({}, [LEGACY]));
    expect(plan).toMatchObject({ action: "migrate", from: LEGACY, to: CANON });
    expect(plan.message).toContain(`copying it to ${CANON}`);
  });

  it("is a no-op once the canonical file exists (even with a stale legacy copy around)", () => {
    const plan = planBrainDbMigration(deps({}, [CANON, LEGACY]));
    expect(plan.action).toBe("already-canonical");
    expect(plan.from).toBeUndefined();
    expect(plan.to).toBe(CANON);
  });

  it("refuses to second-guess an explicit DIGITAL_ME_BRAIN_DB", () => {
    const plan = planBrainDbMigration(deps({ DIGITAL_ME_BRAIN_DB: "/x/brain.db" }, [LEGACY]));
    expect(plan.action).toBe("explicit-env");
    expect(plan.message).toContain("/x/brain.db");
    expect(plan.message).toContain(CANON);
  });

  it("reports no-source on a fresh machine", () => {
    const plan = planBrainDbMigration(deps({}));
    expect(plan.action).toBe("no-source");
    expect(plan.message).toContain("brain-host will create it");
  });

  it("honours DIGITAL_ME_WIKI_ROOT for the target", () => {
    expect(planBrainDbMigration(deps({ DIGITAL_ME_WIKI_ROOT: "/w" }, [LEGACY])).to).toBe("/w/.data/brain.db");
  });
});

describe("postMigrationSteps", () => {
  it("lists one re-install per installed consumer, always ending with the doctor", () => {
    const all = postMigrationSteps({ brainHostInstalled: true, dashboardInstalled: true, openclawInstalled: true });
    expect(all).toHaveLength(4);
    expect(all[0]).toContain("install --runtime brain-host");
    expect(all[1]).toContain("service dashboard install");
    expect(all[2]).toContain("install --runtime openclaw");
    expect(all[3]).toContain("digital-me doctor");
    const none = postMigrationSteps({ brainHostInstalled: false, dashboardInstalled: false, openclawInstalled: false });
    expect(none).toHaveLength(1);
  });
});
