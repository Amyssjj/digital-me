import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the brain client so getKanbanData reads from a controllable board.
// The mock receives brainBoard's options so tests can assert the window the
// dashboard asks the brain for.
const brainBoardMock = vi.fn();
vi.mock("./brain-client.mc.js", () => ({
  brainBoard: (opts: unknown) => brainBoardMock(opts),
  brainTracesQuery: vi.fn(),
  brainWorkflowList: vi.fn(),
  brainWikiStatus: vi.fn(),
}));

import { getKanbanData, getLayerHealth } from "./db.js";

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

describe("getKanbanData date-range scoping", () => {
  beforeEach(() => brainBoardMock.mockReset());

  it("drops goals last updated outside the days window", async () => {
    brainBoardMock.mockResolvedValue({
      goals: [
        goal("fresh", "pending", 2),
        goal("stale", "pending", 40),
      ],
    });

    const res = await getKanbanData({ status: "pending", days: 7 });
    const ids = res.goals.map((g) => g.id);
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("stale");
  });

  it("returns all goals when no days window is given", async () => {
    brainBoardMock.mockResolvedValue({
      goals: [
        goal("fresh", "pending", 2),
        goal("stale", "pending", 40),
      ],
    });

    const res = await getKanbanData({ status: "pending" });
    expect(res.goals.map((g) => g.id).sort()).toEqual(["fresh", "stale"]);
  });

  it("scopes the stats overview to the same window as the columns", async () => {
    brainBoardMock.mockResolvedValue({
      // No board.stats → forces the compute-from-goals path.
      goals: [
        goal("a", "pending", 2),
        goal("b", "running", 3),
        goal("c", "pending", 40), // out of a 7-day window
      ],
    });

    const res = await getKanbanData({ status: "pending", days: 7 });
    // Stats count both in-window goals (pending + running), excluding the
    // 40-day-old one — even though the column query only asked for pending.
    expect(res.stats.goals.total).toBe(2);
    expect(res.stats.goals.byStatus.pending).toBe(1);
    expect(res.stats.goals.byStatus.running).toBe(1);
  });
});

describe("board window forwarded to the brain", () => {
  beforeEach(() => brainBoardMock.mockReset());

  it("getKanbanData({days: 3}) asks the brain for a 3-day board (brainBoard derives since = now - 3d)", async () => {
    brainBoardMock.mockResolvedValue({ goals: [] });
    await getKanbanData({ days: 3 });
    expect(brainBoardMock).toHaveBeenCalledTimes(1);
    expect(brainBoardMock).toHaveBeenCalledWith({ days: 3 });
  });

  it("getKanbanData without days leaves the window to brainBoard's default", async () => {
    brainBoardMock.mockResolvedValue({ goals: [] });
    await getKanbanData({});
    expect(brainBoardMock).toHaveBeenCalledWith({ days: undefined });
  });

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
