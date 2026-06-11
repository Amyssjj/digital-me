import { describe, expect, it } from "vitest";
import * as barrel from "./index.js";

// Regression: the public barrel re-exported every sibling scheduler pass EXCEPT
// reconcileCompletedDependencies, so external consumers of
// @digital-me/brain-orchestrator couldn't import it.
describe("public barrel exports", () => {
  it("re-exports reconcileCompletedDependencies (scheduler reconciliation pass)", () => {
    expect(typeof barrel.reconcileCompletedDependencies).toBe("function");
  });

  it("re-exports the sibling scheduler passes alongside it", () => {
    expect(typeof barrel.tick).toBe("function");
    expect(typeof barrel.reconcileStaleRuns).toBe("function");
    expect(typeof barrel.finalizeTerminalGoals).toBe("function");
    expect(typeof barrel.scanSchedules).toBe("function");
  });
});
