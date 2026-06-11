# How It Works

Agents change. Your intelligence compounds. This page is the mental model —
watch each mechanism run, then read what it's doing.

## One intelligence, every agent

Your agents come and go — new models, new CLIs, new sessions. Digital Me is
the part that stays. Every agent you run connects to the same brain: one
wiki of knowledge, one set of tastes, one task board, one trace history.

```motus-demo
hub-spoke
```

The hub is not a metaphor: it's an [openclaw](https://github.com/openclaw/openclaw)
gateway daemon running on your machine. Two plugins make it a brain —
`memory-core` (retrieval: `memory_search`, `memory_get`, owned by upstream
openclaw) and `brain-orchestrator` (operations: `tasks`, `learning_capture`,
`traces_*`, owned by this repo). Each spoke is a thin runtime adapter that
wires one CLI to those tools.

## The lifecycle, in every agent

Every agent turn runs the same deterministic lifecycle: **apply** (matching
knowledge and taste inject into the prompt before the model sees it) →
**work** (the agent does the task with your context already loaded) →
**capture** (anything reusable flows back as a learning). Watch it play out
across four different agents — same brain, four very different surfaces:

```motus-demo
lifecycle
```

No re-briefing, no cold starts: the architecture exists so that a lesson paid
for once in *any* agent is owned by *every* agent.

## The closed loop

Capture alone isn't knowledge — raw learnings are noisy. The loop closes
overnight:

```motus-demo
learning-loop
```

- **Apply** — runtime adapters prepend matching wiki entries to the prompt.
- **Work** — the agent acts; everything is tracked (`tasks`, `traces_record`).
- **Capture** — noteworthy outcomes land in the inbox via `learning_capture`.
- **Distill** — the nightly dream-cycle compiles raw captures into clean,
  deduplicated wiki entries (plain markdown, reviewable in git).
- **Recall** — `memory_search` indexes the wiki; the next turn's apply step
  retrieves it.

Cut any node and the loop stops — that's the architectural test for every
package in the repo.

## The package map

Each package has one job, categorized by **where it runs and who triggers it**:

| Where it runs | Who triggers it | Package role |
|---|---|---|
| inside the openclaw gateway | a tool call from an agent | `plugins/` — brain-orchestrator |
| inside an agent CLI process | you starting your CLI | `runtimes/` — claude-code, codex, hermes, openclaw |
| in a CLI process, forwarding to openclaw | the runtime adapter | `transport/` — brain-mcp-proxy (stdio↔HTTP) |
| on the host, beside openclaw | a scheduler or you | `services/` — dashboard, dream-cycle |
| on the host, transiently | you typing `digital-me <cmd>` | `cli/` — installer/orchestrator |
| imported by other packages | other packages | `shared/` — env contracts, schemas |

## Your data stays yours

This repo contains **no personal data**. Your wiki, inbox, and config live in
a separate local directory (`~/digital-me/`, ideally a private git repo),
loaded at runtime through the documented
[environment contract](/docs/configuration). Knowledge is plain markdown
files — no opaque vector store, nothing you can't read, diff, or delete.
