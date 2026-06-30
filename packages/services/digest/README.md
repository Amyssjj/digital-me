# Digital Me — Daily Digest

A small service that, once a day, gathers the cross-agent activity from your
Digital Me ecosystem (wiki growth, taste signals, what each agent worked on),
has an LLM agent summarize it, and publishes a digest card to Discord.

It runs as three workflow steps:

```
stage ──► summarize ──► publish
(exec)    (agent)        (exec)
```

- **stage** — gather the day's raw data, write a staging file. No LLM.
- **summarize** — an agent reads the staging file and builds a `presentation`
  (title, tone, blocks) + markdown, returned via `tasks.handoff`.
- **publish** — read the handoff, **validate it against the contract**, and post
  to Discord.

## The seam contract (why this package exists)

`summarize` (an LLM agent that can be swapped on any runtime update) and
`publish` are two sides of one seam. Historically the shape that crossed that
seam was implicit, so a producer drift — e.g. the agent emitting
`{"type":"text","content":"…"}` when the publisher expected `text` — silently
produced an empty digest that nobody noticed until 7am.

This package pins that seam:

1. **A versioned contract** — [`presentation.schema.json`](src/digest/presentation.schema.json).
   The summarize prompt mirrors it (the producer is *told* the shape) and
   `validate_presentation()` enforces it on read (a violation is a loud, located
   error, not a vacuum). A test asserts the validator's enums match the schema
   file, so prompt, validator, and schema cannot drift.
2. **A tolerant reader** — `_block_text` / `_normalize_presentation` absorb
   reasonable variants (`content` as well as `text`, nested dicts, `fields`) so
   minor drift degrades instead of breaks.
3. **Fail open** — if the handoff is missing or violates the contract, publish
   renders deterministically from the staged data (no LLM); if even that is
   empty it posts a minimal "nothing to report" card. The digest is **never**
   silently dropped — only a real infra failure (Discord post) fails the step.

## Configuration (nothing personal is baked into source)

All machine-specific values resolve via `arg → env → default` (see
[`config.py`](src/digest/config.py)). Set per install:

| Value | Env var | Default |
|---|---|---|
| Wiki root | `DIGITAL_ME_WIKI_ROOT` | `~/digital-me` |
| Brain DB | `DIGITAL_ME_BRAIN_DB` | `~/.openclaw/data/brain.db` |
| Discord channel | `DIGITAL_ME_DIGEST_CHANNEL` or `config.yaml` `digest.discord_channel` | **none** (required for a real publish) |
| openclaw CLI | `OPENCLAW_CLI` | `openclaw` on `PATH` |
| Secondary memory log | `DIGITAL_ME_DIGEST_MEMORY_DIR` | none (skipped) |

## Usage

```bash
python -m digest.daily_digest --stage   /tmp/daily-digest-staging.json
python -m digest.daily_digest --publish /tmp/daily-digest-staging.json --dry-run
python -m digest.daily_digest --publish /tmp/daily-digest-staging.json
```
