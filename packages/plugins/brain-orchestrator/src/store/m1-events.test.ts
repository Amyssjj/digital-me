import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  M1_EVENTS_MIGRATIONS,
  createM1EventsStore,
  type M1EventRecord,
} from "./m1-events.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "./migrations.js";

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

function makeEvent(overrides: Partial<M1EventRecord> = {}): M1EventRecord {
  return {
    eventId: "ev1",
    schemaVersion: 1,
    metric: "m1_application_rate",
    runtime: "hermes",
    agentId: "hermes-discord",
    sessionId: "sess-A",
    turnId: "t1",
    eventType: "knowledge_surfaced",
    entries: [{ path: "infrastructure/foo.md", title: "Foo", score: 0.8 }],
    t: 1700000000_000,
    ...overrides,
  };
}

describe("M1_EVENTS_MIGRATIONS", () => {
  it("creates the m1_events table at v710", () => {
    const cols = db
      .prepare("PRAGMA table_info(m1_events)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toContain("event_id");
    expect(names).toContain("event_type");
    expect(names).toContain("session_id");
    expect(names).toContain("turn_id");
    expect(names).toContain("entries_json");
    expect(names).toContain("ack_signal");
    expect(names).toContain("t");
  });
});

describe("createM1EventsStore — create()", () => {
  it("inserts a new event and round-trips JSON columns", () => {
    const store = createM1EventsStore({ db });
    const r = store.create(makeEvent());
    expect(r.inserted).toBe(true);
    const out = store.query({ runtime: "hermes" });
    expect(out).toHaveLength(1);
    expect(out[0].entries).toEqual([
      { path: "infrastructure/foo.md", title: "Foo", score: 0.8 },
    ]);
  });

  it("is idempotent on event_id — duplicates return inserted=false", () => {
    const store = createM1EventsStore({ db });
    const r1 = store.create(makeEvent({ eventId: "same-id" }));
    const r2 = store.create(makeEvent({ eventId: "same-id" }));
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
    expect(store.query({}).length).toBe(1);
  });

  it("accepts events from any runtime + event_type without validation (forward-compat)", () => {
    const store = createM1EventsStore({ db });
    expect(
      store.create(
        makeEvent({
          eventId: "v2-future",
          runtime: "future-runtime",
          eventType: "knowledge_used", // v2 event type
        }),
      ).inserted,
    ).toBe(true);
  });

  it("persists optional ack_signal and extra payload", () => {
    const store = createM1EventsStore({ db });
    store.create(
      makeEvent({
        eventId: "ack-1",
        eventType: "assistant_ack",
        ackSignal: "explicit_path",
        extra: { turn_text_excerpt: "the M1 application_rate entry says..." },
      }),
    );
    const out = store.query({ eventType: "assistant_ack" });
    expect(out[0].ackSignal).toBe("explicit_path");
    expect(out[0].extra).toEqual({
      turn_text_excerpt: "the M1 application_rate entry says...",
    });
  });

  it("round-trips a missing turn_id as undefined", () => {
    const store = createM1EventsStore({ db });
    store.create(makeEvent({ eventId: "no-turn", turnId: undefined }));
    const out = store.query({});
    expect(out[0].turnId).toBeUndefined();
  });

  it("defaults schema_version and metric when a record omits them", () => {
    const store = createM1EventsStore({ db });
    // Runtime defensiveness: emitters go through recordM1Event (which fills
    // these), but the store's INSERT guards them independently.
    const bare = {
      ...makeEvent({ eventId: "bare" }),
      schemaVersion: undefined,
      metric: undefined,
    } as unknown as M1EventRecord;
    expect(store.create(bare).inserted).toBe(true);
    const out = store.query({});
    expect(out[0].schemaVersion).toBe(1);
    expect(out[0].metric).toBe("m1_application_rate");
  });
});

describe("createM1EventsStore — query()", () => {
  it("filters by runtime, agent, session, event_type", () => {
    const store = createM1EventsStore({ db });
    store.create(
      makeEvent({ eventId: "h1", runtime: "hermes", agentId: "hermes-discord" }),
    );
    store.create(
      makeEvent({ eventId: "c1", runtime: "claude-code", agentId: "claude-code" }),
    );
    expect(store.query({ runtime: "hermes" }).length).toBe(1);
    expect(store.query({ runtime: "claude-code" }).length).toBe(1);
    expect(store.query({ agentId: "claude-code" }).length).toBe(1);
  });

  it("filters by sessionId", () => {
    const store = createM1EventsStore({ db });
    store.create(makeEvent({ eventId: "a", sessionId: "sess-A" }));
    store.create(makeEvent({ eventId: "b", sessionId: "sess-B" }));
    const out = store.query({ sessionId: "sess-B" });
    expect(out).toHaveLength(1);
    expect(out[0].eventId).toBe("b");
  });

  it("falls back to empty entries/extra when stored JSON is corrupt", () => {
    const store = createM1EventsStore({ db });
    db.prepare(
      `INSERT INTO m1_events
         (event_id, schema_version, metric, runtime, agent_id, session_id,
          turn_id, event_type, entries_json, ack_signal, extra_json, t)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "corrupt",
      1,
      "m1_application_rate",
      "hermes",
      "a",
      "S",
      "T1",
      "knowledge_surfaced",
      "{not json", // corrupt entries_json
      null,
      "also not json", // corrupt extra_json
      100,
    );
    const out = store.query({});
    expect(out[0].entries).toEqual([]);
    expect(out[0].extra).toEqual({});
  });

  it("filters by time window", () => {
    const store = createM1EventsStore({ db });
    store.create(makeEvent({ eventId: "a", t: 100 }));
    store.create(makeEvent({ eventId: "b", t: 200 }));
    store.create(makeEvent({ eventId: "c", t: 300 }));
    expect(store.query({ since: 150, until: 300 }).length).toBe(1);
    expect(store.query({ since: 150 }).length).toBe(2);
  });

  it("orders results by t DESC", () => {
    const store = createM1EventsStore({ db });
    store.create(makeEvent({ eventId: "early", t: 100 }));
    store.create(makeEvent({ eventId: "late", t: 200 }));
    const out = store.query({});
    expect(out[0].eventId).toBe("late");
    expect(out[1].eventId).toBe("early");
  });

  it("clamps limit to the safe maximum", () => {
    const store = createM1EventsStore({ db });
    for (let i = 0; i < 50; i++) {
      store.create(makeEvent({ eventId: `e${i}`, t: i }));
    }
    expect(store.query({ limit: 99999 }).length).toBe(50);
  });
});

describe("pairSurfacedWithAck", () => {
  it("pairs surfaced events with their matching assistant_ack by (session_id, turn_id)", () => {
    const store = createM1EventsStore({ db });
    store.create(
      makeEvent({
        eventId: "s-1",
        eventType: "knowledge_surfaced",
        sessionId: "S1",
        turnId: "T1",
        t: 100,
      }),
    );
    store.create(
      makeEvent({
        eventId: "a-1",
        eventType: "assistant_ack",
        sessionId: "S1",
        turnId: "T1",
        ackSignal: "explicit_path",
        entries: [{ path: "infrastructure/foo.md" }],
        t: 105,
      }),
    );
    const pairs = store.pairSurfacedWithAck({ since: 0 });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].surfaced.eventId).toBe("s-1");
    expect(pairs[0].ack?.eventId).toBe("a-1");
    expect(pairs[0].ack?.ackSignal).toBe("explicit_path");
  });

  it("returns surfaced with ack=undefined when no matching ack exists yet", () => {
    const store = createM1EventsStore({ db });
    store.create(
      makeEvent({
        eventId: "s-only",
        eventType: "knowledge_surfaced",
        sessionId: "S2",
        turnId: "T1",
        t: 100,
      }),
    );
    const pairs = store.pairSurfacedWithAck({ since: 0 });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].ack).toBeUndefined();
  });

  it("does not cross sessions", () => {
    const store = createM1EventsStore({ db });
    store.create(
      makeEvent({
        eventId: "s-A",
        eventType: "knowledge_surfaced",
        sessionId: "SESS-A",
        turnId: "T1",
        t: 100,
      }),
    );
    // Ack with same turn id but different session — must not pair.
    store.create(
      makeEvent({
        eventId: "a-B",
        eventType: "assistant_ack",
        sessionId: "SESS-B",
        turnId: "T1",
        t: 110,
      }),
    );
    const pairs = store.pairSurfacedWithAck({ since: 0 });
    expect(pairs[0].surfaced.sessionId).toBe("SESS-A");
    expect(pairs[0].ack).toBeUndefined();
  });

  it("filters by runtime when provided", () => {
    const store = createM1EventsStore({ db });
    store.create(
      makeEvent({
        eventId: "s-h",
        eventType: "knowledge_surfaced",
        runtime: "hermes",
        sessionId: "Hsess",
        turnId: "T1",
        t: 100,
      }),
    );
    store.create(
      makeEvent({
        eventId: "s-c",
        eventType: "knowledge_surfaced",
        runtime: "claude-code",
        sessionId: "Csess",
        turnId: "T1",
        t: 100,
      }),
    );
    expect(
      store.pairSurfacedWithAck({ since: 0, runtime: "hermes" }),
    ).toHaveLength(1);
  });

  it("respects since/until time window on the surfaced side", () => {
    const store = createM1EventsStore({ db });
    store.create(
      makeEvent({
        eventId: "old",
        eventType: "knowledge_surfaced",
        sessionId: "S",
        turnId: "T1",
        t: 50,
      }),
    );
    store.create(
      makeEvent({
        eventId: "new",
        eventType: "knowledge_surfaced",
        sessionId: "S",
        turnId: "T2",
        t: 150,
      }),
    );
    expect(
      store.pairSurfacedWithAck({ since: 100 }).map((p) => p.surfaced.eventId),
    ).toEqual(["new"]);
  });
});
