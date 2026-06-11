import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  deriveEventId,
  isV1EventType,
  recordM1Event,
  scoreM1,
  type RecordM1EventInput,
} from "./m1.js";
import {
  M1_EVENTS_MIGRATIONS,
  createM1EventsStore,
} from "../store/m1-events.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "../store/migrations.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of M1_EVENTS_MIGRATIONS) registerMigration(m);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

function baseInput(
  overrides: Partial<RecordM1EventInput> = {},
): RecordM1EventInput {
  return {
    runtime: "hermes",
    agentId: "hermes-discord",
    sessionId: "S1",
    turnId: "T1",
    eventType: "knowledge_surfaced",
    entries: [{ path: "infrastructure/foo.md", title: "Foo", score: 0.8 }],
    t: 1700000000_000,
    ...overrides,
  };
}

describe("deriveEventId", () => {
  it("returns the same id for identical inputs (idempotent dedup key)", () => {
    const a = deriveEventId(baseInput());
    const b = deriveEventId(baseInput());
    expect(a).toBe(b);
    expect(a).toMatch(/^S1::T1::knowledge_surfaced::[0-9a-f]{12}$/);
  });
  it("differs by event_type", () => {
    expect(deriveEventId(baseInput())).not.toBe(
      deriveEventId(baseInput({ eventType: "assistant_ack" })),
    );
  });
  it("differs by turn_id", () => {
    expect(deriveEventId(baseInput({ turnId: "T1" }))).not.toBe(
      deriveEventId(baseInput({ turnId: "T2" })),
    );
  });
  it("differs by entries content", () => {
    expect(
      deriveEventId(
        baseInput({ entries: [{ path: "a.md" }] }),
      ),
    ).not.toBe(
      deriveEventId(
        baseInput({ entries: [{ path: "b.md" }] }),
      ),
    );
  });
});

describe("recordM1Event", () => {
  it("inserts and returns the derived event_id when no eventId provided", () => {
    const store = createM1EventsStore({ db });
    const r = recordM1Event({ m1Events: store }, baseInput());
    expect(r.inserted).toBe(true);
    expect(r.eventId).toMatch(/^S1::T1::knowledge_surfaced::/);
  });

  it("respects a caller-provided eventId (preferred for retry safety)", () => {
    const store = createM1EventsStore({ db });
    const r = recordM1Event(
      { m1Events: store },
      baseInput({ eventId: "my-fixed-id" }),
    );
    expect(r.eventId).toBe("my-fixed-id");
  });

  it("returns inserted=false on duplicate eventId (retry-safe)", () => {
    const store = createM1EventsStore({ db });
    const inp = baseInput({ eventId: "dup-id" });
    const r1 = recordM1Event({ m1Events: store }, inp);
    const r2 = recordM1Event({ m1Events: store }, inp);
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
  });

  it("uses now() injection for t when not provided", () => {
    const store = createM1EventsStore({ db });
    const now = 1700001234567;
    const inp = baseInput({ t: undefined });
    const { eventId } = recordM1Event(
      { m1Events: store, now: () => now },
      inp,
    );
    const events = store.query({});
    const stored = events.find((e) => e.eventId === eventId);
    expect(stored?.t).toBe(now);
  });
});

describe("scoreM1", () => {
  it("computes ack_rate per (day, runtime, agent) from surfaced+ack pairs", () => {
    const store = createM1EventsStore({ db });
    // Day 2026-05-27: 3 surfaced turns for hermes-discord, 2 with acks.
    const t = new Date("2026-05-27T10:00:00Z").getTime();
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "s1", sessionId: "S", turnId: "T1",
      eventType: "knowledge_surfaced", t,
      entries: [{ path: "p/a.md" }],
    }));
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "a1", sessionId: "S", turnId: "T1",
      eventType: "assistant_ack", ackSignal: "explicit_path",
      entries: [{ path: "p/a.md" }],
      t: t + 1000,
    }));
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "s2", sessionId: "S", turnId: "T2",
      eventType: "knowledge_surfaced", t: t + 2000,
      entries: [{ path: "p/b.md" }, { path: "p/c.md" }],
    }));
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "a2", sessionId: "S", turnId: "T2",
      eventType: "assistant_ack", ackSignal: "title_match",
      entries: [{ path: "p/b.md" }],
      t: t + 3000,
    }));
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "s3", sessionId: "S", turnId: "T3",
      eventType: "knowledge_surfaced", t: t + 4000,
      entries: [{ path: "p/d.md" }],
    }));
    // T3 has no ack → counts as surfaced but not acknowledged.

    const rollups = scoreM1(
      { m1Events: store },
      { since: 0, until: t + 10_000 },
    );
    expect(rollups).toHaveLength(1);
    const r = rollups[0];
    expect(r.day).toBe("2026-05-27");
    expect(r.runtime).toBe("hermes");
    expect(r.surfacedTurns).toBe(3);
    expect(r.acknowledgedTurns).toBe(2);
    expect(r.ackRate).toBeCloseTo(2 / 3);
    expect(r.surfacedEntries).toBe(4); // a, b, c, d
    expect(r.actedEntries).toBe(2); // a, b
    expect(r.useRate).toBeCloseTo(2 / 4);
  });

  it("treats 'no_applicable' as an acknowledgment (acted=0 but turn counted)", () => {
    const store = createM1EventsStore({ db });
    const t = 1700000000_000;
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "s", sessionId: "S", turnId: "T1",
      eventType: "knowledge_surfaced", t,
      entries: [{ path: "p/a.md" }],
    }));
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "a", sessionId: "S", turnId: "T1",
      eventType: "assistant_ack", ackSignal: "no_applicable",
      entries: [], // explicit no acted
      t: t + 1000,
    }));
    const r = scoreM1({ m1Events: store }, { since: 0, until: t + 10_000 })[0];
    expect(r.acknowledgedTurns).toBe(1);
    expect(r.actedEntries).toBe(0);
    expect(r.ackRate).toBe(1);
    expect(r.useRate).toBe(0);
  });

  it("treats 'no_acknowledgement' as NOT an ack", () => {
    const store = createM1EventsStore({ db });
    const t = 1700000000_000;
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "s", sessionId: "S", turnId: "T1",
      eventType: "knowledge_surfaced", t,
      entries: [{ path: "p/a.md" }],
    }));
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "a", sessionId: "S", turnId: "T1",
      eventType: "assistant_ack", ackSignal: "no_acknowledgement",
      entries: [],
      t: t + 1000,
    }));
    const r = scoreM1({ m1Events: store }, { since: 0, until: t + 10_000 })[0];
    expect(r.acknowledgedTurns).toBe(0);
    expect(r.ackRate).toBe(0);
  });

  it("partitions rollups by runtime + agent_id", () => {
    const store = createM1EventsStore({ db });
    const t = 1700000000_000;
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "h", runtime: "hermes", agentId: "hermes-discord",
      sessionId: "S1", turnId: "T1",
      eventType: "knowledge_surfaced", t,
      entries: [{ path: "p/a.md" }],
    }));
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "c", runtime: "claude-code", agentId: "claude-code",
      sessionId: "S2", turnId: "T1",
      eventType: "knowledge_surfaced", t,
      entries: [{ path: "p/b.md" }],
    }));
    const rollups = scoreM1({ m1Events: store }, { since: 0, until: t + 10_000 });
    expect(rollups).toHaveLength(2);
    expect(new Set(rollups.map((r) => r.runtime))).toEqual(
      new Set(["hermes", "claude-code"]),
    );
  });

  it("respects the runtime filter", () => {
    const store = createM1EventsStore({ db });
    const t = 1700000000_000;
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "h", runtime: "hermes", sessionId: "S1", turnId: "T1",
      eventType: "knowledge_surfaced", t,
      entries: [{ path: "p/a.md" }],
    }));
    recordM1Event({ m1Events: store }, baseInput({
      eventId: "c", runtime: "claude-code", sessionId: "S2", turnId: "T1",
      eventType: "knowledge_surfaced", t,
      entries: [{ path: "p/b.md" }],
    }));
    const rollups = scoreM1(
      { m1Events: store },
      { since: 0, until: t + 10_000, runtime: "hermes" },
    );
    expect(rollups).toHaveLength(1);
    expect(rollups[0].runtime).toBe("hermes");
  });

  it("returns empty array when no events in window", () => {
    const store = createM1EventsStore({ db });
    expect(scoreM1({ m1Events: store }, { since: 0, until: 1 })).toEqual([]);
  });
});

describe("isV1EventType", () => {
  it("accepts the five v1 event types", () => {
    for (const k of [
      "session_start",
      "knowledge_surfaced",
      "assistant_ack",
      "session_snapshot",
      "session_end",
    ]) {
      expect(isV1EventType(k)).toBe(true);
    }
  });
  it("rejects unknown / v2 / malformed values", () => {
    expect(isV1EventType("knowledge_used")).toBe(false);
    expect(isV1EventType("turn_complete")).toBe(false);
    expect(isV1EventType(42)).toBe(false);
    expect(isV1EventType(undefined)).toBe(false);
  });
});
