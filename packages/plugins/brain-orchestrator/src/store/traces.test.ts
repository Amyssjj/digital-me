import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  TRACES_MIGRATIONS,
  createTracesStore,
  type TraceRecord,
} from "./traces.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "./migrations.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of TRACES_MIGRATIONS) registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function baseTrace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: "tr-1",
    agentId: "a-1",
    kind: "tool_call",
    payload: {},
    t: Date.parse("2026-05-17T12:00:00Z"),
    ...overrides,
  };
}

describe("createTracesStore — create", () => {
  it("round-trips a minimal trace", () => {
    const store = createTracesStore({ db });
    store.create(baseTrace());
    const found = store.query({});
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe("tr-1");
    expect(found[0]!.agentId).toBe("a-1");
    expect(found[0]!.kind).toBe("tool_call");
    expect(found[0]!.payload).toEqual({});
    expect(found[0]!.taskId).toBeUndefined();
    expect(found[0]!.goalId).toBeUndefined();
    expect(found[0]!.durationMs).toBeUndefined();
  });

  it("round-trips every optional field", () => {
    const store = createTracesStore({ db });
    store.create(
      baseTrace({
        payload: { tool: "wiki_search", arg: "x" },
        taskId: "t-1",
        goalId: "g-1",
        durationMs: 42,
      }),
    );
    const t = store.query({})[0]!;
    expect(t.payload).toEqual({ tool: "wiki_search", arg: "x" });
    expect(t.taskId).toBe("t-1");
    expect(t.goalId).toBe("g-1");
    expect(t.durationMs).toBe(42);
  });
});

describe("createTracesStore — query filters", () => {
  function seed() {
    const store = createTracesStore({ db });
    store.create(baseTrace({ id: "1", agentId: "a", kind: "tool_call", taskId: "t1", goalId: "g1", t: 100 }));
    store.create(baseTrace({ id: "2", agentId: "a", kind: "task_start", taskId: "t1", goalId: "g1", t: 200 }));
    store.create(baseTrace({ id: "3", agentId: "b", kind: "tool_call", taskId: "t2", goalId: "g2", t: 300 }));
    store.create(baseTrace({ id: "4", agentId: "b", kind: "task_complete", taskId: "t2", goalId: "g2", t: 400 }));
    store.create(baseTrace({ id: "5", agentId: "a", kind: "session_end", t: 500 }));
    return store;
  }

  it("orders by t DESC by default and returns every row when no filters", () => {
    const store = seed();
    const ids = store.query({}).map((r) => r.id);
    expect(ids).toEqual(["5", "4", "3", "2", "1"]);
  });

  it("filters by agentId", () => {
    const store = seed();
    const ids = store.query({ agentId: "a" }).map((r) => r.id);
    expect(ids).toEqual(["5", "2", "1"]);
  });

  it("filters by goalId", () => {
    const store = seed();
    const ids = store.query({ goalId: "g2" }).map((r) => r.id);
    expect(ids).toEqual(["4", "3"]);
  });

  it("filters by taskId", () => {
    const store = seed();
    const ids = store.query({ taskId: "t1" }).map((r) => r.id);
    expect(ids).toEqual(["2", "1"]);
  });

  it("filters by kind", () => {
    const store = seed();
    const ids = store.query({ kind: "tool_call" }).map((r) => r.id);
    expect(ids).toEqual(["3", "1"]);
  });

  it("filters by since (inclusive lower bound on t)", () => {
    const store = seed();
    const ids = store.query({ since: 300 }).map((r) => r.id);
    expect(ids).toEqual(["5", "4", "3"]);
  });

  it("combines multiple filters with AND", () => {
    const store = seed();
    const ids = store
      .query({ agentId: "a", kind: "tool_call" })
      .map((r) => r.id);
    expect(ids).toEqual(["1"]);
  });

  it("honors limit", () => {
    const store = seed();
    expect(store.query({ limit: 2 }).map((r) => r.id)).toEqual(["5", "4"]);
  });

  it("clamps limit to 1000 even when caller asks for more", () => {
    const store = seed();
    // We can't observe the SQL directly, but we can verify behavior: all 5
    // rows come back when the requested limit is silly-large.
    expect(store.query({ limit: 100_000 })).toHaveLength(5);
  });

  it("defaults limit to 100 when not provided", () => {
    const store = createTracesStore({ db });
    for (let i = 0; i < 150; i++) {
      store.create(baseTrace({ id: `id-${i}`, t: i }));
    }
    expect(store.query({})).toHaveLength(100);
  });
});

describe("createTracesStore — defensive JSON parsing", () => {
  it("falls back to {} when payload JSON is malformed", () => {
    const store = createTracesStore({ db });
    store.create(baseTrace({ payload: { x: 1 } }));
    db.prepare("UPDATE traces SET payload = 'not-json' WHERE id = ?").run(
      "tr-1",
    );
    expect(store.query({})[0]!.payload).toEqual({});
  });
});

describe("createTracesStore — deleteByGoal", () => {
  it("deletes only the traces tied to the given goal and reports the count", () => {
    const store = createTracesStore({ db });
    store.create(baseTrace({ id: "1", goalId: "g1" }));
    store.create(baseTrace({ id: "2", goalId: "g1" }));
    store.create(baseTrace({ id: "3", goalId: "g2" }));
    store.create(baseTrace({ id: "4" })); // no goal
    expect(store.deleteByGoal("g1")).toBe(2);
    const remaining = store.query({}).map((r) => r.id).sort();
    expect(remaining).toEqual(["3", "4"]);
  });

  it("returns 0 when the goal has no traces", () => {
    const store = createTracesStore({ db });
    expect(store.deleteByGoal("missing")).toBe(0);
  });

  it("also deletes task-scoped traces (task_id set, no goal_id) for the given task ids", () => {
    const store = createTracesStore({ db });
    store.create(baseTrace({ id: "1", goalId: "g1" }));
    store.create(baseTrace({ id: "2", taskId: "t1" })); // task-only — would orphan
    store.create(baseTrace({ id: "3", taskId: "t2" })); // other task — survives
    store.create(baseTrace({ id: "4" })); // unscoped — survives
    expect(store.deleteByGoal("g1", ["t1"])).toBe(2);
    const remaining = store.query({}).map((r) => r.id).sort();
    expect(remaining).toEqual(["3", "4"]);
  });
});

describe("TRACES_MIGRATIONS", () => {
  it("registers traces at stable, strictly increasing versions", () => {
    expect(TRACES_MIGRATIONS).toHaveLength(2);
    expect(TRACES_MIGRATIONS[0]!.version).toBeGreaterThan(0);
    expect(TRACES_MIGRATIONS[1]!.version).toBeGreaterThan(
      TRACES_MIGRATIONS[0]!.version,
    );
    expect(TRACES_MIGRATIONS[0]!.description).toMatch(/trace/i);
    expect(TRACES_MIGRATIONS[1]!.description).toMatch(/kind/i);
  });

  it("produces a usable traces table when applied to a fresh DB", () => {
    const fresh = new DatabaseSync(":memory:");
    for (const m of TRACES_MIGRATIONS) m.up(fresh);
    const cols = fresh
      .prepare("PRAGMA table_info(traces)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("agent_id");
    expect(names).toContain("kind");
    expect(names).toContain("payload");
    expect(names).toContain("duration_ms");
    expect(names).toContain("t");
    fresh.close();
  });

  it("creates the (kind, t) index for the dashboard's per-minute kind filter", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'traces'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_traces_kind_t");
  });

  it("applies the kind index on a shipped DB already past v710 (m1_events)", () => {
    // Simulate the REAL existing deployment state: all pre-index migrations
    // ran, leaving the shared user_version at 710 (M1_EVENTS_VERSION — the
    // global max before this index). The runner skips anything <= the DB's
    // version, so the index migration MUST be versioned above 710 or
    // upgraded installs would silently never create it.
    const shipped = new DatabaseSync(":memory:");
    resetMigrationRegistryForTests();
    registerMigration(TRACES_MIGRATIONS[0]!);
    runMigrations(shipped);
    shipped.exec("PRAGMA user_version = 710");
    let indexes = shipped
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'traces'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).not.toContain("idx_traces_kind_t");

    // Next boot registers the full set; the index migration must still apply.
    resetMigrationRegistryForTests();
    for (const m of TRACES_MIGRATIONS) registerMigration(m);
    runMigrations(shipped);
    indexes = shipped
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'traces'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_traces_kind_t");
    shipped.close();
  });

  it("versions the kind index above every other store's migrations", async () => {
    // Guard against the shared-user_version trap: a new migration must beat
    // the global max across ALL migration groups, not just its own file.
    const { GOALS_MIGRATIONS } = await import("./goals.js");
    const { TASKS_MIGRATIONS } = await import("./tasks.js");
    const { WORKFLOWS_MIGRATIONS } = await import("./workflows.js");
    const { SCHEDULES_MIGRATIONS } = await import("./schedules.js");
    const { AGENTS_MIGRATIONS } = await import("./agents.js");
    const { LEARNINGS_MIGRATIONS } = await import("./learnings.js");
    const { M1_EVENTS_MIGRATIONS } = await import("./m1-events.js");
    const others = [
      ...GOALS_MIGRATIONS,
      ...TASKS_MIGRATIONS,
      ...WORKFLOWS_MIGRATIONS,
      ...SCHEDULES_MIGRATIONS,
      ...AGENTS_MIGRATIONS,
      ...LEARNINGS_MIGRATIONS,
      ...M1_EVENTS_MIGRATIONS,
      TRACES_MIGRATIONS[0]!,
    ].map((m) => m.version);
    const indexVersion = TRACES_MIGRATIONS[1]!.version;
    expect(indexVersion).toBeGreaterThan(Math.max(...others));
  });
});
