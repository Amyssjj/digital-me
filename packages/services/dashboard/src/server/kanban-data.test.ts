import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the brain client so getKanbanData reads from a controllable board.
const brainBoardMock = vi.fn();
vi.mock("./brain-client.mc.js", () => ({
  brainBoard: () => brainBoardMock(),
  brainTracesQuery: vi.fn(),
  brainWorkflowList: vi.fn(),
  brainWikiStatus: vi.fn(),
}));

import { getKanbanData } from "./db.js";

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
