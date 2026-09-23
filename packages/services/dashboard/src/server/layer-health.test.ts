import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the brain client so getLayerHealth reads from a controllable board.
// The mock receives brainBoard's options so tests can assert the window the
// dashboard asks the brain for.
const brainBoardMock = vi.fn();
vi.mock("./brain-client.mc.js", () => ({
  brainBoard: (opts: unknown) => brainBoardMock(opts),
  brainTracesQuery: vi.fn(),
  brainWorkflowList: vi.fn(),
  brainWikiStatus: vi.fn(),
}));

import { getLayerHealth } from "./db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function goal(id: string, status: string, ageDays: number) {
  const ts = Date.now() - ageDays * DAY_MS;
  return {
    id,
    name: id,
    description: "",
    status,
    type: "project",
    created_at: ts,
    updated_at: ts,
    completed_at: status === "completed" ? ts : null,
    created_by: "test",
    tasks: [{ id: `${id}-t`, name: "t", task: "t", status, attempts: [] }],
  };
}

describe("layer-health board window", () => {
  beforeEach(() => brainBoardMock.mockReset());

  it("getLayerHealth needs only open goals and asks for a zero-day window", async () => {
    brainBoardMock.mockResolvedValue({
      goals: [
        { ...goal("layer", "active", 1), type: "evergreen" },
        { ...goal("proj", "running", 1), parent_goal_id: "layer" },
      ],
    });
    const res = await getLayerHealth();
    expect(brainBoardMock).toHaveBeenCalledWith({ days: 0 });
    expect(res.layers).toHaveLength(1);
    expect(res.layers[0].openProjects).toBe(1);
  });
});
