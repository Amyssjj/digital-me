/**
 * Learnings store — port of upstream task-orchestrator/src/store.ts
 * `learnings` table for the brain API v2 reflection surface.
 *
 * Each row is one captured insight from an agent: a feedback signal, a
 * project fact, a reference pointer, or a rejection signal. The dream-cycle
 * pipeline reads these later to graduate eligible items into the wiki.
 *
 * `proposedWikiPath` is a hint from the capturing agent about where the
 * graduated entry should live; the dream-cycle is free to override.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./migrations.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type LearningKind = "feedback" | "project" | "reference" | "rejection";

export type LearningRecord = {
  readonly id: string;
  readonly agentId: string;
  readonly kind: LearningKind;
  readonly text: string;
  readonly why?: string;
  readonly applyWhen?: string;
  readonly sourceContext?: string;
  readonly confidence?: number;
  readonly proposedWikiPath?: string;
  readonly createdAt: number;
};

// ── Schema migration ──────────────────────────────────────────────────────

const LEARNINGS_VERSION = 600;

export const LEARNINGS_MIGRATIONS: readonly Migration[] = [
  {
    version: LEARNINGS_VERSION,
    description: "v600: learnings table (brain reflection surface)",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS learnings (
          id                  TEXT PRIMARY KEY,
          agent_id            TEXT NOT NULL,
          kind                TEXT NOT NULL,
          text                TEXT NOT NULL,
          why                 TEXT,
          apply_when          TEXT,
          source_context      TEXT,
          confidence          REAL,
          proposed_wiki_path  TEXT,
          created_at          INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_learnings_agent ON learnings(agent_id);
        CREATE INDEX IF NOT EXISTS idx_learnings_kind ON learnings(kind);
      `);
    },
  },
];

// ── Row mapping ────────────────────────────────────────────────────────────

type LearningRow = {
  id: string;
  agent_id: string;
  kind: string;
  text: string;
  why: string | null;
  apply_when: string | null;
  source_context: string | null;
  confidence: number | null;
  proposed_wiki_path: string | null;
  created_at: number;
};

function rowToLearning(row: LearningRow): LearningRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind as LearningKind,
    text: row.text,
    why: row.why ?? undefined,
    applyWhen: row.apply_when ?? undefined,
    sourceContext: row.source_context ?? undefined,
    confidence: row.confidence ?? undefined,
    proposedWikiPath: row.proposed_wiki_path ?? undefined,
    createdAt: row.created_at,
  };
}

// ── Public factory ─────────────────────────────────────────────────────────

export type LearningsStore = {
  create(learning: LearningRecord): void;
  get(id: string): LearningRecord | undefined;
  /** All learnings for one agent, newest-first. */
  listByAgent(agentId: string): LearningRecord[];
  /** All learnings of one kind across all agents, newest-first. */
  listByKind(kind: LearningKind): LearningRecord[];
  listAll(): LearningRecord[];
};

export function createLearningsStore(deps: {
  db: DatabaseSync;
}): LearningsStore {
  const { db } = deps;

  const insertStmt = db.prepare(`
    INSERT INTO learnings
      (id, agent_id, kind, text, why, apply_when, source_context,
       confidence, proposed_wiki_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectById = db.prepare("SELECT * FROM learnings WHERE id = ?");
  const selectByAgent = db.prepare(
    "SELECT * FROM learnings WHERE agent_id = ? ORDER BY created_at DESC",
  );
  const selectByKind = db.prepare(
    "SELECT * FROM learnings WHERE kind = ? ORDER BY created_at DESC",
  );
  const selectAll = db.prepare(
    "SELECT * FROM learnings ORDER BY created_at DESC",
  );

  function create(learning: LearningRecord): void {
    insertStmt.run(
      learning.id,
      learning.agentId,
      learning.kind,
      learning.text,
      learning.why ?? null,
      learning.applyWhen ?? null,
      learning.sourceContext ?? null,
      learning.confidence ?? null,
      learning.proposedWikiPath ?? null,
      learning.createdAt,
    );
  }

  function get(id: string): LearningRecord | undefined {
    const row = selectById.get(id) as LearningRow | undefined;
    return row ? rowToLearning(row) : undefined;
  }

  function listByAgent(agentId: string): LearningRecord[] {
    return (selectByAgent.all(agentId) as LearningRow[]).map(rowToLearning);
  }

  function listByKind(kind: LearningKind): LearningRecord[] {
    return (selectByKind.all(kind) as LearningRow[]).map(rowToLearning);
  }

  function listAll(): LearningRecord[] {
    return (selectAll.all() as LearningRow[]).map(rowToLearning);
  }

  return { create, get, listByAgent, listByKind, listAll };
}
