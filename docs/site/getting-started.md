# Getting Started

Digital Me carries your intelligence — knowledge, taste, decisions — to every
agent you run. This page takes you from a clean machine to your first
capture → recall loop in about five minutes.

## Prerequisites

- **[openclaw](https://github.com/openclaw/openclaw)** — mandatory. The brain
  rides on openclaw's gateway daemon; install it first and verify
  `openclaw --version` works. `setup` hard-stops with install guidance if it's
  missing.
- **Node.js ≥ 22.5** and **pnpm** — the CLI checks and tells you if your Node
  is too old.
- **Python ≥ 3.11** — optional; only needed for the dream-cycle distillation
  pipeline (skip it with `--minimal`).

## Install

```bash
git clone https://github.com/Amyssjj/digital-me.git ~/digital-me-os
cd ~/digital-me-os && pnpm install && pnpm build

# Detect installed CLIs, scaffold ~/digital-me/, install hooks/skills/configs,
# link the `digital-me` command onto PATH, run doctor:
pnpm dm setup

# Node-only? Skip the optional services (dream-cycle venv + dashboard build):
pnpm dm setup --minimal

# Pin a custom wiki location:
pnpm dm setup --wiki-root ~/notes/brain
```

What `setup` does:

1. **Detects** `~/.claude/`, `~/.codex/`, `~/.hermes/` to figure out which
   runtimes you have.
2. **Scaffolds** the wiki root — `~/digital-me/{wiki,inbox,.cache}` plus a
   live `config.yaml` (created only if absent, never clobbered).
3. **Installs each detected runtime** — hooks, skills, MCP entries, protocol
   bundles (see [Runtimes](/docs/runtimes) for what lands where).
4. **Runs `doctor`** to confirm everything resolved.

Re-running is idempotent — installers merge into existing settings without
clobbering your other hooks.

```motus-demo
console
```

## Your first loop

The whole system exists for one loop: an agent learns something once, and
every agent knows it afterwards.

```bash
# 1. Verify the brain is reachable
digital-me doctor

# 2. In any wired agent (Claude Code, Codex, Hermes, openclaw), do real work.
#    When something reusable surfaces, the agent calls learning_capture —
#    or you ask it directly: "remember this for next time".

# 3. Watch it come back: start a NEW session, ask about the same topic.
#    The runtime adapter injects matching wiki knowledge into the prompt
#    before the model ever sees your question.
```

Behind the scenes the capture lands in your wiki repo as a reviewable
markdown entry, the nightly dream-cycle distills raw learnings into clean
entries, and `memory_search` serves them to every runtime. Nothing is hidden
in a vector store you can't read — the wiki is plain files in git.

## Where things live

| Path | What it is |
|---|---|
| `~/digital-me-os` | this repo — code, no personal data |
| `~/digital-me/` | **your** data: wiki, inbox, config (own it in a private git repo) |
| `~/.openclaw/` | openclaw gateway home (brain database, plugins) |

## Next steps

- Wire up each agent CLI you use → [Runtimes](/docs/runtimes)
- Understand the loop you just ran → [How it works](/docs/how-it-works)
- Every command and flag → [CLI reference](/docs/cli)
