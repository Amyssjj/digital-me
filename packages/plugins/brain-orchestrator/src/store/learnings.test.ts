import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  LEARNINGS_MIGRATIONS,
  createLearningsStore,
  type LearningRecord,
} from "./learnings.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "./migrations.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of LEARNINGS_MIGRATIONS) registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function baseLearning(
  overrides: Partial<LearningRecord> = {},
): LearningRecord {
  return {
    id: "l-1",
    agentId: "a-1",
    kind: "feedback",
    text: "always use UTC",
    createdAt: Date.parse("2026-05-17T12:00:00Z"),
    ...overrides,
  };
}

describe("createLearningsStore — create + get", () => {
  it("round-trips a minimal learning", () => {
    const store = createLearningsStore({ db });
    store.create(baseLearning());
    const l = store.get("l-1");
    expect(l).toBeDefined();
    expect(l!.id).toBe("l-1");
    expect(l!.agentId).toBe("a-1");
    expect(l!.kind).toBe("feedback");
    expect(l!.text).toBe("always use UTC");
    expect(l!.why).toBeUndefined();
    expect(l!.applyWhen).toBeUndefined();
    expect(l!.sourceContext).toBeUndefined();
    expect(l!.confidence).toBeUndefined();
    expect(l!.proposedWikiPath).toBeUndefined();
  });

  it("returns undefined for an unknown id", () => {
    const store = createLearningsStore({ db });
    expect(store.get("missing")).toBeUndefined();
  });

  it("round-trips every optional field", () => {
    const store = createLearningsStore({ db });
    store.create(
      baseLearning({
        why: "DST is a footgun",
        applyWhen: "scheduling cron jobs",
        sourceContext: "issue #42",
        confidence: 0.8,
        proposedWikiPath: "wiki/ops/timezones.md",
      }),
    );
    const l = store.get("l-1")!;
    expect(l.why).toBe("DST is a footgun");
    expect(l.applyWhen).toBe("scheduling cron jobs");
    expect(l.sourceContext).toBe("issue #42");
    expect(l.confidence).toBe(0.8);
    expect(l.proposedWikiPath).toBe("wiki/ops/timezones.md");
  });
});

describe("createLearningsStore — list operations", () => {
  function seed() {
    const store = createLearningsStore({ db });
    store.create(baseLearning({ id: "l1", agentId: "a", kind: "feedback", createdAt: 100 }));
    store.create(baseLearning({ id: "l2", agentId: "a", kind: "project", createdAt: 200 }));
    store.create(baseLearning({ id: "l3", agentId: "b", kind: "feedback", createdAt: 300 }));
    store.create(baseLearning({ id: "l4", agentId: "b", kind: "reference", createdAt: 400 }));
    store.create(baseLearning({ id: "l5", agentId: "a", kind: "rejection", createdAt: 500 }));
    return store;
  }

  it("listByAgent returns one agent's learnings newest-first", () => {
    const store = seed();
    const ids = store.listByAgent("a").map((l) => l.id);
    expect(ids).toEqual(["l5", "l2", "l1"]);
  });

  it("listByAgent returns empty for an unknown agent", () => {
    const store = seed();
    expect(store.listByAgent("missing")).toEqual([]);
  });

  it("listByKind returns one kind across agents newest-first", () => {
    const store = seed();
    const ids = store.listByKind("feedback").map((l) => l.id);
    expect(ids).toEqual(["l3", "l1"]);
  });

  it("listAll returns every learning newest-first", () => {
    const store = seed();
    const ids = store.listAll().map((l) => l.id);
    expect(ids).toEqual(["l5", "l4", "l3", "l2", "l1"]);
  });

  it("listAll returns empty when the table is empty", () => {
    const store = createLearningsStore({ db });
    expect(store.listAll()).toEqual([]);
  });
});

describe("LEARNINGS_MIGRATIONS", () => {
  it("registers learnings at a stable version", () => {
    expect(LEARNINGS_MIGRATIONS).toHaveLength(1);
    expect(LEARNINGS_MIGRATIONS[0]!.version).toBeGreaterThan(0);
    expect(LEARNINGS_MIGRATIONS[0]!.description).toMatch(/learning/i);
  });

  it("produces a usable learnings table when applied to a fresh DB", () => {
    const fresh = new DatabaseSync(":memory:");
    for (const m of LEARNINGS_MIGRATIONS) m.up(fresh);
    const cols = fresh
      .prepare("PRAGMA table_info(learnings)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("agent_id");
    expect(names).toContain("kind");
    expect(names).toContain("apply_when");
    expect(names).toContain("proposed_wiki_path");
    fresh.close();
  });
});
