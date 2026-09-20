# Retrieval benchmark

`scripts/retrieval_bench.py` measures the quality of the brain's `memory_search`
tool against whatever backend serves it. It exists so a retrieval backend can be
swapped (openclaw memory-core today, a digital-me brain-host retriever tomorrow)
with evidence that results stayed consistent or improved.

## What it measures

The script is backend-neutral. It needs only an endpoint that speaks the
`POST /tools/invoke` envelope and returns hits shaped `{path, score, startLine?}`.

Two query sets are generated fresh on every run, so there is no hand-curated
list to maintain:

| set | source | size (default) | metric |
|---|---|---|---|
| **labeled** | a seeded sample of wiki entries; the entry **title** and its first **Apply when** bullet become queries; the expected hit is that entry | 150 entries → ~300 queries | hit@1, hit@5, hit@10, MRR |
| **observed** | the most recent distinct real `memory_search` queries recorded in `brain.db` traces (90-day window) | 100 | none at run time; the snapshot keeps the ranking so a later run measures **consistency** (overlap@5, overlap@10, same top-1) |

Labeled scoring has two modes. **Strict** counts only the exact entry.
**Lenient** also accepts that domain's `_OVERVIEW.md`, because the current index
often returns the domain page instead of the entry. The gap between the two is
itself a quality signal.

Every run writes a JSON snapshot to `<wiki-root>/.data/retrieval-bench/<label>.json`
with the config, per-query rankings, latencies and the summary. Pass
`--compare <baseline.json>` to get deltas and the observed-set consistency block.

## Running

Baseline against the openclaw gateway (token and port resolve from
`OPENCLAW_GATEWAY_*` or `~/.openclaw/openclaw.json`):

```bash
python3 scripts/retrieval_bench.py --label openclaw-$(date +%F)
```

Against a different backend, compared to that baseline:

```bash
python3 scripts/retrieval_bench.py --label brain-host-v1 \
  --url http://127.0.0.1:18791/tools/invoke --token "$BRAIN_HOST_TOKEN" \
  --compare ~/digital-me/.data/retrieval-bench/openclaw-2026-09-19.json
```

Useful flags: `--sample 0` (every wiki entry), `--seed`, `--observed N`,
`--corpus memory|wiki|all`, `--agent-id` (the openclaw gateway rejects unknown
ids and only agents with a live index return results), `--dry-run`.

Read the same seed across runs. Changing the seed changes the labeled set and
makes deltas meaningless.

## Results (2026-09-19)

Same 397 queries replayed against both backends (`--compare` replays the
baseline's exact query set, so deltas are like-for-like even after the wiki or
the traces change).

| labeled (n=297) | openclaw memory-core | brain-host retriever |
|---|---|---|
| strict hit@1 | 0.12 | **0.86** |
| strict hit@5 | 0.45 | **0.98** |
| strict MRR | 0.25 | **0.91** |
| lenient hit@5 | 0.82 | **0.98** |
| title queries, strict hit@1 | 0.09 | 0.97 |
| apply-when queries, strict hit@1 | 0.15 | 0.75 |
| latency p50 / p95 | 1.25 s / 1.67 s | **0.20 s / 0.25 s** |

Observed set: 48 of the 100 recorded queries were harness payloads
(`<task-notification>` blocks the recall hook forwarded verbatim) and are
skipped as junk. On the 52 clean queries, the baseline's best non-index-page
hit is in the new top-5 for 52%; a manual read of the differences shows the new
result is the more relevant entry in most of the rest (e.g. "publish checklist"
→ an actual publish checklist instead of an engine-learnings rubric). Raw
overlap is low by design because the new index excludes `_OVERVIEW.md` pages,
which were 62% of the baseline's top-1 hits.

Snapshots: `~/digital-me/.data/retrieval-bench/openclaw-2026-09-19.json` and
`brain-host-v1-2026-09-19.json`.

## Gotchas learned on the first run (2026-09-19)

- Recall hooks send raw prompts as queries, so traces contain harness payloads.
  `is_junk_query()` drops queries that start with `<`, carry
  `<task-notification>` / `<system-reminder>` markers, or exceed 600 chars, both
  when building the observed set and when comparing.

- The gateway returns `ok: true` with an empty result list when an agent's
  memory index is **paused** (`"index provenance classifier changed"`, i.e. the
  index was built with a different embedding provider or settings). The script
  reports this as an error, not as zero hits. Check `result.details.disabled`.
- Only the agent that owns a warm, live index returns hits. On this host that was
  `main`; `claude-code` was paused and `coo` cold-opened past the 15 s deadline.
- The `agent` argument does not switch indexes; the top-level `agentId` does.
- The gateway caps results at about 6 regardless of `limit`, so hit@10 equals hit@5.
