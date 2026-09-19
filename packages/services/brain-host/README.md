# @digital-me/brain-host

The digital-me brain host. Phase 1 serves the brain's retrieval tools —
`memory_search`, `memory_get`, `wiki` (status) — from a retriever that lives in
this repo, on the same `POST /tools/invoke` wire the openclaw gateway speaks.
Every existing caller (brain-mcp-proxy, the Claude Code / Codex / Hermes hooks,
the dashboard) keeps working; only the host, port and token change.

Phase 2 mounts the brain-orchestrator on the same server: `tasks`,
`agent_identify`, `learning_capture`, `traces_record`, `traces_query`,
`m1_event_record`, `m1_score` are served from brain.db (opened and migrated by
brain-host, exactly as the openclaw plugin template did), and the scheduler
tick runs here when enabled. That makes the tool surface identical to what
`brain-mcp-proxy` advertises, so the proxy can be pointed at brain-host instead
of the gateway.

**Single-ticker rule.** The scheduler tick is OFF by default
(`DIGITAL_ME_BRAIN_SCHEDULER=on` enables it). Exactly one process may tick a
brain.db; while the openclaw `digital-me-brain` plugin still ticks, leave this
off or schedules double-fire. Dispatch in Phase 2 is exec-only: `spawn` tasks
are left `ready` and logged, never failed.

## What the retriever indexes

`~/digital-me/wiki/**/*.md` and `~/digital-me/tastes/**/*.md`. Nothing else:
no session transcripts, no `_INDEX.md` / `_OVERVIEW.md` navigation pages (they
were 62% of the openclaw index's top-1 hits and never the answer).

The **entry is the retrieval unit**. Each file gets one *entry vector*
(title + domain + tags + `Rule` + `Apply when` for wiki; title + principle +
discriminator + fire signature for tastes) and one *section vector* per `##`
heading. Search fuses three rankings with reciprocal rank: entry vectors,
section vectors rolled up to their entry, and FTS5 bm25 over the full entry
text. One hit per entry; the best section supplies `startLine`/`endLine` and the
snippet.

Embeddings: Gemini `gemini-embedding-001` at 768 dimensions by default, with
provenance (provider, model, dims) stored in the index. A mismatched embedder
is refused **as an error**, never as an empty result list.

Size on 2026-09-19: 1,380 entries, 5,916 vectors, ~18 MB, indexed in 61 s;
search p50 0.20 s including the query embedding call.

## Usage

```bash
# one-time / incremental (only changed files are re-embedded)
node --env-file=~/.openclaw/.env packages/services/brain-host/bin/brain-host.mjs index

# ad hoc query
node --env-file=~/.openclaw/.env packages/services/brain-host/bin/brain-host.mjs search "kanban goals vanished" --limit 5

# serve
DIGITAL_ME_BRAIN_TOKEN=<secret> node --env-file=~/.openclaw/.env \
  packages/services/brain-host/bin/brain-host.mjs serve --port 18791
```

`serve` mounts the orchestrator unless `--no-orchestrator` is passed.

Environment: `DIGITAL_ME_BRAIN_DB` (default `<OPENCLAW_HOME or ~/.openclaw>/data/brain.db`
until the Phase 3 move), `DIGITAL_ME_BRAIN_SCHEDULER` (`on`|`off`, default off),
`DIGITAL_ME_TICK_MS` (60000), `DIGITAL_ME_STALL_MS` (3600000),
`DIGITAL_ME_WIKI_ROOT` (default `~/digital-me`),
`DIGITAL_ME_RETRIEVAL_DB` (default `<wiki-root>/.data/retrieval.db`),
`DIGITAL_ME_BRAIN_TOKEN`, `DIGITAL_ME_BRAIN_PORT` (18791),
`DIGITAL_ME_BRAIN_HOST` (127.0.0.1), `GEMINI_API_KEY`, `DIGITAL_ME_EMBED_MODEL`,
`DIGITAL_ME_EMBED_DIMS`. `--offline` swaps in a deterministic hash embedder for
tests and smoke runs.

## Wire

```
POST /tools/invoke   Authorization: Bearer <token>
{ "tool": "memory_search", "agentId": "claude-code", "args": { "query": "…", "limit": 6 } }
→ { "ok": true, "result": { "content": [{ "type": "text", "text": "<json>" }], "details": { "results": [...], "provider", "model", "count" } } }
→ { "ok": false, "error": { "type": "search_unavailable" | "invalid_request" | "unknown_tool" | …, "message" } }

GET /health → { ok, version, provenance, lastIndexAt, entries, sections, byCorpus }
```

Hits carry `path`, `relPath`, `title`, `corpus`, `startLine`, `endLine`,
`score`, `vectorScore`, `textScore`, `snippet`, `source: "memory"`, `citation`.

## Quality gate

`scripts/retrieval_bench.py` (repo root) measures hit@k / MRR against the
openclaw baseline snapshot; see `docs/RETRIEVAL-BENCHMARK.md` for the numbers.
