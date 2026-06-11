/**
 * E2E lifecycle test for the M1 application_rate metric across all three
 * runtimes (claude-code, openclaw, hermes).
 *
 * This is the brain-side regression guard for the OpenClaw "0% application
 * rate" bug: OpenClaw surfaced knowledge but never emitted `assistant_ack`,
 * so `scoreM1` (which pairs surfaced↔ack) reported 0% for it. The
 * `runtimeEmitsNoAck` case below reproduces that failure; the per-runtime
 * cases assert that once each runtime emits an `assistant_ack` carrying the
 * `[Digital Me]` ack signal, the scorer reports a non-zero rate.
 *
 * The per-runtime ack *parsers* themselves are unit-tested in their own
 * languages:
 *   - openclaw:    packages/runtimes/openclaw/src/recall-hooks.test.ts
 *                  (parseDigitalMeAck)
 *   - hermes:      packages/runtimes/hermes/plugins/digital-me-recall-hermes/
 *                  test_parse_ack.py
 *   - claude-code: scripts/e2e_claude_code_ack.sh (transcript → assistant_ack)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  M1_EVENTS_MIGRATIONS,
  createM1EventsStore,
  type M1EventsStore,
} from "../store/m1-events.js";
import {
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
} from "../store/migrations.js";
import { recordM1Event, scoreM1 } from "./m1.js";

let db: DatabaseSync;
let store: M1EventsStore;

// A fixed base time so day-bucketing is deterministic.
const BASE_T = Date.UTC(2026, 4, 30, 18, 0, 0); // 2026-05-30T18:00:00Z

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  resetMigrationRegistryForTests();
  for (const m of M1_EVENTS_MIGRATIONS) registerMigration(m);
  runMigrations(db);
  store = createM1EventsStore({ db });
});

afterEach(() => {
  db.close();
  resetMigrationRegistryForTests();
});

/**
 * Drive one runtime's full lifecycle for a single turn:
 *   session_start → knowledge_surfaced → assistant_ack → session_end
 * The ackSignal/actedEntries are what that runtime's parser would have
 * produced from a `[Digital Me] applying <entry>` reply.
 */
function driveLifecycle(opts: {
  runtime: string;
  agentId: string;
  ackSignal: string | null;
  surfaced: Array<{ path: string; title?: string }>;
  acted: Array<{ path: string; title?: string }>;
  t?: number;
}): void {
  const { runtime, agentId, ackSignal, surfaced, acted } = opts;
  const t = opts.t ?? BASE_T;
  const sessionId = `${runtime}-sess`;
  recordM1Event(
    { m1Events: store },
    { runtime, agentId, sessionId, eventType: "session_start", t },
  );
  recordM1Event(
    { m1Events: store },
    {
      runtime,
      agentId,
      sessionId,
      turnId: "1",
      eventType: "knowledge_surfaced",
      entries: surfaced,
      t: t + 1000,
    },
  );
  if (ackSignal !== null) {
    recordM1Event(
      { m1Events: store },
      {
        runtime,
        agentId,
        sessionId,
        turnId: "1",
        eventType: "assistant_ack",
        entries: acted,
        ackSignal,
        t: t + 2000,
      },
    );
  }
  recordM1Event(
    { m1Events: store },
    {
      runtime,
      agentId,
      sessionId,
      turnId: "1",
      eventType: "session_end",
      t: t + 3000,
    },
  );
}

const SURFACED = [
  {
    path: "infrastructure/m1-universal-event-protocol.md",
    title: "M1 Universal Event Protocol",
  },
  { path: "youtube/thumbnail-rules.md", title: "Thumbnail Rules" },
];

describe("M1 application_rate — per-runtime lifecycle", () => {
  for (const rt of [
    { runtime: "claude-code", agentId: "claude-code" },
    { runtime: "openclaw", agentId: "openclaw" },
    { runtime: "hermes", agentId: "hermes-discord" },
  ]) {
    it(`${rt.runtime}: surfaced + assistant_ack → non-zero ack & use rate`, () => {
      driveLifecycle({
        ...rt,
        ackSignal: "explicit_path",
        surfaced: SURFACED,
        acted: [SURFACED[0]],
      });
      const rollups = scoreM1(
        { m1Events: store },
        { since: BASE_T - 1000, until: BASE_T + 10_000, runtime: rt.runtime },
      );
      expect(rollups).toHaveLength(1);
      const r = rollups[0];
      expect(r.runtime).toBe(rt.runtime);
      expect(r.surfacedTurns).toBe(1);
      expect(r.acknowledgedTurns).toBe(1);
      expect(r.ackRate).toBe(1);
      expect(r.useRate).toBeGreaterThan(0);
    });
  }

  it("counts a no_applicable decline as an acknowledged turn (use rate 0)", () => {
    driveLifecycle({
      runtime: "hermes",
      agentId: "hermes-discord",
      ackSignal: "no_applicable",
      surfaced: SURFACED,
      acted: [],
    });
    const [r] = scoreM1(
      { m1Events: store },
      { since: BASE_T - 1000, until: BASE_T + 10_000, runtime: "hermes" },
    );
    expect(r.acknowledgedTurns).toBe(1);
    expect(r.ackRate).toBe(1);
    expect(r.useRate).toBe(0);
  });

  it("REGRESSION: a runtime that surfaces but never acks scores 0% (the OpenClaw bug)", () => {
    // OpenClaw's pre-fix behavior: knowledge_surfaced with no assistant_ack.
    driveLifecycle({
      runtime: "openclaw",
      agentId: "openclaw",
      ackSignal: null, // <-- no assistant_ack emitted
      surfaced: SURFACED,
      acted: [],
    });
    const [r] = scoreM1(
      { m1Events: store },
      { since: BASE_T - 1000, until: BASE_T + 10_000, runtime: "openclaw" },
    );
    expect(r.surfacedTurns).toBe(1);
    expect(r.acknowledgedTurns).toBe(0);
    expect(r.ackRate).toBe(0);
  });

  it("scores all three runtimes independently in one window", () => {
    driveLifecycle({
      runtime: "claude-code",
      agentId: "claude-code",
      ackSignal: "explicit_path",
      surfaced: SURFACED,
      acted: [SURFACED[0]],
    });
    driveLifecycle({
      runtime: "openclaw",
      agentId: "openclaw",
      ackSignal: "title_match",
      surfaced: SURFACED,
      acted: [SURFACED[1]],
    });
    driveLifecycle({
      runtime: "hermes",
      agentId: "hermes-discord",
      ackSignal: "explicit_path",
      surfaced: SURFACED,
      acted: SURFACED,
    });
    const rollups = scoreM1(
      { m1Events: store },
      { since: BASE_T - 1000, until: BASE_T + 10_000 },
    );
    const byRuntime = new Map(rollups.map((r) => [r.runtime, r]));
    for (const runtime of ["claude-code", "openclaw", "hermes"]) {
      const r = byRuntime.get(runtime);
      expect(r, `expected a rollup for ${runtime}`).toBeDefined();
      expect(r!.ackRate).toBe(1);
    }
  });
});
