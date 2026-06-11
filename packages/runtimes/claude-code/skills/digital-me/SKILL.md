---
name: digital-me
description: >
  Digital Me Protocol — the knowledge discovery and writeback lifecycle shared by
  all agents (Claude Code, OpenClaw subagents, Hermes, Antigravity). Load this
  skill before any non-trivial task to use the unified Living Knowledge wiki.
---

# Digital Me Skill

You are one of many agents connected to a shared **Living Knowledge + Project Manager** brain. Every agent — Claude Code, OpenClaw subagents, Hermes, Antigravity, future agents — follows this same protocol. Consistent behavior across agents is the whole point.

## The Wiki

The single source of truth is `~/digital-me/wiki/` — a domain-organized Markdown wiki where one file = one concept. It is compiled from raw agent memories by a nightly Dream Cycle, maintained by LLM consolidation, and searchable via semantic embeddings.

Key paths:
- **`~/digital-me/_INDEX.md`** — master TOC with inlined Active Policies at top. Read this first.
- **`~/digital-me/wiki/<domain>/<slug>.md`** — individual entries (Rule / How it came up / Apply when)
- **`~/digital-me/_STATS.md`** — health metrics (staleness, orphans, citations)
- **`~/digital-me/_GRAPH.md`** — cross-link graph

## Access Paths

| Agent type | Access method |
|---|---|
| Claude Code | `Read`/`Write` tools on `~/digital-me/` + `memory_search`/`memory_get` via `openclaw-brain` MCP |
| OpenClaw subagents | `memory_search`/`memory_get` tools (wiki is in `memorySearch.extraPaths`) |
| Hermes Agent | `memory_search`/`memory_get` via `openclaw-brain` MCP |
| Antigravity | Direct filesystem access to `~/digital-me/` |

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
- For orchestrated work, call `tasks.checkpoint` at milestones.
- If no matching knowledge exists and you're unsure, ask the user — don't guess.

### 3. WRITE back

- If you discovered a generalizable pattern, write `~/digital-me/wiki/<domain>/<slug>.md` using the entry format below.
- For orchestrated tasks: call `tasks.handoff` with structured output (deliverableState, summary, artifactPaths).
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
- `infrastructure/` — OpenClaw gateway, execution, safety, cron
- `video-production/` — Manim, rendering, design system
- `project-management/` — workflows, tasks, scheduling
- `development/` — code patterns, Python, Git
- `content/` — writing, publishing, social media
- `knowledge-management/` — wiki maintenance, this protocol
- `communication/` — Discord, messaging, sessions
- `monitoring/` — observability, health checks, escalation
- `tools/` — exec, edit, allowed patterns

See `~/digital-me/_STATS.md` for the current full list.

## MCP Tools (openclaw-brain)

| Tool | Purpose |
|---|---|
| `memory_search` | Semantic search over wiki entries |
| `memory_get` | Fetch a specific entry by path |
| `tasks.board` | Active goals and task statuses |
| `tasks.run_workflow` | Run a saved workflow template |
| `tasks.run_goal` | Ad-hoc goal with task plan |
| `tasks.checkpoint` | Save progress at a milestone |
| `tasks.handoff` | Complete a task with structured output |
| `tasks.retry` | Retry failed/stalled tasks |

## Forbidden

- Never start non-trivial work without reading `_INDEX.md` first.
- Never ignore an Active Policy because it contradicts your defaults — the wiki wins.
- Never complete orchestrated work without a structured `tasks.handoff`.
- Never create a duplicate entry for existing knowledge — update the existing one.
- Never store raw conversation or session transcripts — only distilled, actionable knowledge.

## Evolution

This skill is the entry point. The canonical protocol lives in the wiki at `~/digital-me/wiki/knowledge-management/digital-me-protocol.md` (marked `priority: always`, so it's inlined at the top of `_INDEX.md`). When the protocol evolves, edit that wiki entry — every agent reading `_INDEX.md` picks up the new version automatically.

The nightly Dream Cycle (`~/digital-me/dream_cycle/run.py`) maintains the wiki: compiles new sources, re-indexes, cross-links, lints for staleness and contradictions, consolidates duplicates. Runs at 2:47am via OpenClaw task-orchestrator.
