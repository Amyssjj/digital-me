# Codex Instructions

## Learning Capture

- Always prefer task-orchestrator MCP learning tools for logging reusable learnings.
- Use `learning_capture` first for feedback, project insights, references, rejection signals, workflow-design takeaways, and institutional knowledge.
- Use wiki ingest/file-back only as a fallback when `learning_capture` is unavailable, or when a richer article/concept writeup is explicitly needed.
- When useful, report the returned `learning_id` back to the user.
- **Do not also call `traces_record` with `kind: "learning_captured"`.** `learning_capture` already records the paired capture trace; a second one renders a **duplicate card** in the dashboard Feed. Put any extra context (topic, source) into `learning_capture`'s own `why`/`source_context`/`apply_when` fields instead.

<!-- BEGIN digital-me auto-generated section — DO NOT EDIT MANUALLY -->

## Digital Me Protocol

This Codex session is part of the cross-agent Digital Me knowledge fleet.
Before any non-trivial task:

1. **Browse `~/digital-me/_INDEX.md`** — domain-grouped TOC of all wiki entries.
2. **Read entries directly** when the index reveals a match (faster than blind search).
3. **Fall back to `memory_search`** MCP tool only when the index doesn't help.
4. **Active Policies are mandatory** — the section below is injected verbatim from `_INDEX.md`.

### [Digital Me] — M1 application_rate protocol

When `memory_search` returns results, you MUST acknowledge them by
**beginning your reply with a line that starts `[Digital Me]`** — whether or
not any entry applies:

- **If one or more entries apply**, write `[Digital Me] applying <entry slug
  or title>` and use their content (via `memory_get` for the full body if
  needed).
- **If none apply**, write `[Digital Me] no applicable wiki entries` and
  proceed.
- **Skipping the `[Digital Me]` prefix is a protocol violation** tracked as
  M1 (application_rate). The metric measures whether you act on the
  knowledge surfaced by your own searches; ignoring search results is
  the same signal as not searching at all.

Codex/Hermes don't have push-injected wiki context like Claude Code or
OpenClaw native agents do — you must pull via `memory_search`. The
`[Digital Me]` prefix makes that pull meaningful.

When you discover a generalizable pattern, call the `learning_capture` MCP tool
(via the `openclaw-brain` server) with `kind`, `text`, `why`, `apply_when`,
and `proposed_wiki_path`. The brain stores the capture; the next dream cycle
materializes it into the wiki. `learning_capture` records its own paired
capture trace — do **not** follow it with a `traces_record kind:
"learning_captured"` call for the same learning, or the dashboard Feed shows a
duplicate capture card.

Full protocol: `~/digital-me/wiki/knowledge-management/digital-me-protocol.md`

============================================================
## ACTIVE POLICIES (MANDATORY)

> These rules apply to all agents. Read them before any task.
> Source: entries marked `priority: always` in the wiki.

### Managed Task Execution Protocol (Worker Contract)
*[Full entry: agents/managed-task-execution-protocol-worker-contract.md]*

When executing a task managed by the `task-orchestrator`, agents must adhere to the following execution protocol to ensure visibility and prevent stalled runs.

1.  **Start immediately**: Do not ask for confirmation or summarize the plan unless the task description explicitly requires a PIMR.
2.  **Focus on the deliverable**: Do not expand scope beyond the task description.
3.  **Mandatory Checkpointing**: Call `tasks.checkpoint` at every major milestone and, at minimum, **every 10 tool calls or 5 minutes of work**.
4.  **Escalate Blockers**: If an issue cannot be resolved, call `tasks.checkpoint` with the `blocker` field populated, then call `tasks.handoff` with `deliverableState="partial"`.
5.  **No Silent Stalling**: A partial handoff with a clear blocker explanation is always preferred over silence or multiple failing attempts.

### Goal Mechanism — the structural shape of goals, tasks, and tags
*[Full entry: company/goal-mechanism.md]*

Goals, tasks, and tags form the structural implementation of the four-layer operating model. Every unit of work lives in this one mechanism.

### Goal types and Visibility

- **`project`**: Finite work with a clear done state. Surfaced in `listActiveGoals()` and default dashboard views when `pending` or `running`.
- **`evergreen`**: Continuous concerns (Knowledge, Validation, Operation, Evaluation, Triage). **Excluded from `listActiveGoals()`** to prevent cluttering the project delivery pipeline. Use `listAllGoals()` or explicit type filters to retrieve them.

### Implementation Constraints

1.  **Status Derivation**: `evergreen` goals bypass the automatic status-refresh logic used for projects. Project status is derived from child task states; Evergreen status is a "health" metric (`healthy`|`degraded`) driven by SLA breaches or manual overrides.
2.  **Tagging Requirement**: Tasks under `evergreen` goals MUST carry tags from the layer's controlled vocabulary. Tags act as pointers to investigation workflows.
3.  **Active Set Filtering**: The `tasks.board` and `listActiveGoals` functions must explicitly filter `type = 'project'` to maintain focus on delivery.

### The 5 Seed Evergreen Goals

| Slug | Name | Layer | Purpose |
|---|---|---|---|
| `knowledge` | Knowledge | Layer 1 | Accumulation and currency of wiki/docs. |
| `validation` | Validation | Layer 2 | Sanity checking and logic verification. |
| `operation` | Operation | Layer 3 | Day-to-day execution and cleanup. |
| `evaluation` | Evaluation | Layer 4 | Integrity of metrics and instruments. |
| `triage` | Triage | Meta | Intake buffer for unclassified concerns. |

### Edit my-extensions plugins directly in src
*[Full entry: development/edit-my-extensions-plugins-directly.md]*

You are permitted and expected to edit the source code (`src/`) of the `task-orchestrator` and `proactive-learning` plugins directly. These are not read-only core assets; they are local extensions hosted on the `my-extensions` branch.

When fixing bugs in these plugins:
1. Edit the `.ts` files in `extensions/task-orchestrator/src/` or `extensions/proactive-learning/src/`.
2. Do not attempt to work around architectural flaws via external scripts if a fix in `scheduler.ts` or `store.ts` is more appropriate.
3. Always verify you are on the `my-extensions` branch before committing.

### Mandatory Preference Domain White-listing
*[Full entry: knowledge-management/mandatory-preference-domain-white-listing.md]*

Partition all "taste" and "preference" knowledge into a hardcoded whitelist of four domains. Do not create new top-level preference domains without manual intervention.

The whitelist is:
1.  **infra**: Technical infrastructure, debugging, architecture, API design, safety.
2.  **knowledge**: Wiki maintenance, distillation, "Digital Me" protocols, memory management.
3.  **storytelling**: Decks, narrative sequence, content strategy, "the smoking gun."
4.  **design**: Minimalist style, elegant motion, Apple-style aesthetics.

### Taste Skills as Judge-Shape Rubrics
*[Full entry: knowledge-management/taste-skills-as-judge-shape-rubrics.md]*

Design agent "taste" skills as **evaluative judges** (generators) rather than project logs or "how-to" manuals. A taste skill must enable an agent to predict a user's verdict on a new proposal.

Every judge-shape skill must include:
1.  **Principle**: A surface-stripped, one-sentence mental model (e.g., "Telemetry is not knowledge").
2.  **Discriminator**: A specific question the agent can ask to confirm the principle applies.
3.  **Evidence**: At least two cited projects/incidents that triangulate the same principle to distinguish it from project-specific noise.
4.  **Near-miss**: An example that looks like a violation but is actually acceptable, with a specific reason.
5.  **Signature**: Surface features in a draft that should trigger the agent to invoke this specific judge.
6.  **Rubric Items**: Scored checklist items used to evaluate an artifact.

============================================================

<!-- END digital-me auto-generated section -->
