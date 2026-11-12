---
name: digital-me
description: >
  Digital Me Protocol — the knowledge discovery and writeback lifecycle shared by
  every client (Claude Code, Codex, Hermes, Antigravity, and later ones). Load
  this skill before any non-trivial task to use the unified Living Knowledge wiki.
---

# Digital Me Skill

You are one of many agents connected to a shared **Living Knowledge + Project Manager** brain. Every client — Claude Code, Codex, Hermes, Antigravity, and the ones that come later — follows this same protocol. Consistent behavior across agents is the whole point.

## The Wiki

The single source of truth is `~/digital-me/wiki/` — a domain-organized Markdown wiki where one file = one concept. It is compiled from raw agent memories by a nightly Dream Cycle, maintained by LLM consolidation, and searchable via semantic embeddings.

Key paths:
- **`~/digital-me/_INDEX.md`** — master TOC with inlined Active Policies at top. Read this first.
- **`~/digital-me/wiki/<domain>/<slug>.md`** — individual entries (Rule / How it came up / Apply when)
- **`~/digital-me/_STATS.md`** — health metrics (staleness, orphans, citations)
- **`~/digital-me/_GRAPH.md`** — cross-link graph

## Access

Clients reach the brain through the `digital-me-brain` MCP server. That server talks to **brain-host** on `127.0.0.1:18791`. The bearer token is the file `<wiki-root>/.data/brain-host.token` (wiki root `~/digital-me`, or `$DIGITAL_ME_WIKI_ROOT`). `digital-me install --runtime brain-host` writes that file.

The OpenClaw gateway on `:18789` is fallback only, and only when that token file is missing. Do not point clients at `memorySearch.extraPaths`. There is no separate OpenClaw-subagent access path.

Direct filesystem access to `~/digital-me/` still works for reading and writing wiki files. Prefer MCP `memory_search` / `memory_get` when you are not sure of the path.

## The Protocol (every task)

### 1. READ before acting

```
Step 1: Read ~/digital-me/_INDEX.md
         → See Active Policies (mandatory rules inlined at top)
         → Scan domain sections for your task's topic
Step 2: If index reveals a matching entry → read it directly
         → Use Read (Claude Code) or memory_get (MCP)
Step 3: If no clear match → memory_search with specific query
         → Use terms from the task, not generic phrasing
Step 4: For each entry you read → scan its related: field
         → Follow cross-links to neighbors before re-searching
```

### 2. EXECUTE

- Apply retrieved knowledge. If it contradicts your defaults, **the wiki wins**.
- For orchestrated work, call `mcp__digital-me-brain__tasks` with `action: checkpoint` at milestones.
- If no matching knowledge exists and you're unsure, ask the user — don't guess.

### 3. WRITE back

- If you discovered a generalizable pattern, write `~/digital-me/wiki/<domain>/<slug>.md` using the entry format below.
- For orchestrated tasks: call `mcp__digital-me-brain__tasks` with `action: handoff` and structured output (`deliverableState`, `summary`, `artifactPaths`).
- Store **distilled knowledge**, not raw transcripts.

## Entry Format

```markdown
---
title: <concise, actionable title>
domain: [<domain1>, <domain2>]
tags: [<tag1>, <tag2>, <tag3>]
priority: search          # "always" only for universal policies
citations: 1
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
related: []               # Auto-populated by Dream Cycle
source: <your-agent-name>
---

## Rule
<Direct instruction. "Do X" not "we discovered X".>

## How it came up
<The surprise, bug, or user correction that led to this rule.>

## Apply when
<Multiple natural-language phrasings. Ask: "What would an agent query for this?">
```

## Domain Directories

Pick the best fit when writing a new entry:
- `agents/` — cross-agent comms, subagent behavior
- `infrastructure/` — brain-host, execution, safety, schedules
- `video-production/` — Manim, rendering, design system
- `project-management/` — workflows, tasks, scheduling
- `development/` — code patterns, Python, Git
- `content/` — writing, publishing, social media
- `knowledge-management/` — wiki maintenance, this protocol
- `communication/` — Discord, messaging, sessions
- `monitoring/` — observability, health checks, escalation
- `tools/` — exec, edit, allowed patterns

See `~/digital-me/_STATS.md` for the current full list.

## MCP (`digital-me-brain`)

There is one tasks tool. Call `mcp__digital-me-brain__tasks` with an `action`. Do not call `tasks.board`, `tasks.checkpoint`, or `tasks.handoff` as if they were separate tools.

The proxy (`packages/transport/brain-mcp-proxy`) decides which tools exist. Name tools the way that server names them.

Actions on `tasks`: `run_goal`, `run_workflow`, `board`, `status`, `checkpoint`, `handoff`, `approve`, `reject`, `cancel`, `claim`, `complete`, `schedule_add`, `schedule_list`, `schedule_remove`, `schedule_enable`, `schedule_disable`, `schedule_tick`, `workflow_import`, `workflow_list`, `workflow_delete`. There is no `retry` action.

| Tool | Purpose |
|---|---|
| `memory_search` | Semantic search over wiki entries |
| `memory_get` | Fetch a specific entry by path |
| `tasks` `action=board` | Active goals and task statuses |
| `tasks` `action=run_workflow` | Run a saved workflow template |
| `tasks` `action=run_goal` | Ad-hoc goal with a task plan |
| `tasks` `action=checkpoint` | Save progress at a milestone |
| `tasks` `action=handoff` | Complete a task with structured output |

Taste reads are real, and they are not MCP tools on this server. `taste_consult` (load principles before you act) and `taste_judge_prompt` (rubric after) live in `dream_cycle.bundles`. From the dream-cycle venv: `python -m dream_cycle.bundles` for consult, add `--judge` for the rubric. Do not call `mcp__digital-me-brain__taste_consult` or `mcp__digital-me-brain__taste_judge_prompt` — the proxy does not serve those names.

## Worker inputs

Dream-cycle and digest stage worker inputs under `{{wiki_root}}/.data/staging/` (compile and taste files such as `dream-cycle-compile-staging.json` and `dream-cycle-taste-staging.json`). Those files are hundreds of KB. Read the file your step names until every line is in:

- **You have a Read tool (Claude Code):** page with `offset` and `limit`. Do not use Bash (`cat`, `head`, `jq`, or an inline interpreter). Shell reads are permission-gated and, even when allowed, only a short preview reaches you.
- **You have no Read tool (Codex, running as the `codex-cli` fallback):** read only that one staging file with read-only `sed -n` chunks, such as `sed -n '1,5p' <path>`, then the next range, to the end. Use the chunk size the step prompt suggests. If the output says lines were omitted or truncated, re-read that range in smaller chunks. Run nothing else.

Never hand off an empty or partial result because the step names a tool you lack. Use the read path above that fits you.

## Forbidden

- Never start non-trivial work without reading `_INDEX.md` first.
- Never ignore an Active Policy because it contradicts your defaults — the wiki wins.
- Never complete orchestrated work without a structured `tasks` handoff (`action: handoff`).
- Never create a duplicate entry for existing knowledge — update the existing one.
- Never store raw conversation or session transcripts — only distilled, actionable knowledge.

## Evolution

This skill is the entry point. The canonical protocol lives in the wiki at `~/digital-me/wiki/knowledge-management/digital-me-protocol.md` (marked `priority: always`, so it's inlined at the top of `_INDEX.md`). When the protocol evolves, edit that wiki entry — every agent reading `_INDEX.md` picks up the new version automatically.

The nightly Dream Cycle is the package `packages/services/dream-cycle` in the digital-me checkout, installed into the venv `~/.venvs/dream-cycle`. It is not `~/digital-me/dream_cycle/run.py`. Run it with `digital-me dream-cycle` or `~/.venvs/dream-cycle/bin/python -m dream_cycle.run`. brain-host is the default scheduler even when OpenClaw is installed. The registered cron is `0 3 * * *` America/Los_Angeles. The gateway on `:18789` does not own that tick unless brain-host was left off on purpose.
