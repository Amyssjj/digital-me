# Getting Started

Digital Me carries your intelligence — knowledge, taste, decisions — to every
agent you run. This page takes you from a clean machine to your first
capture → recall loop in about five minutes.

## Prerequisites

- **Node.js ≥ 22.5** — to install and run the CLI from npm. (`pnpm` is only
  needed for the *From source* path below.)
- **A Gemini API key** — `memory_search` embeds your wiki with
  `gemini-embedding-001` and the nightly dream-cycle uses the same key. You add
  it to one file right after `setup`.
- **Python ≥ 3.11** — optional; only needed for the dream-cycle distillation
  pipeline (skip it with `--minimal`).

That's the whole list. The brain — **brain-host** — ships with the CLI and
`setup` installs it as an always-on service; there is no gateway daemon to
install first. [openclaw](https://github.com/openclaw/openclaw) is one of the
supported runtimes, not a prerequisite.

## Install

```bash
# Install the CLI from npm
npm install -g digital-me

# Detect installed CLIs, scaffold ~/digital-me/, install hooks/skills/configs,
# wire every runtime, run doctor:
digital-me setup

# Node-only? Skip the optional services (dream-cycle venv + dashboard build):
digital-me setup --minimal

# Pin a custom wiki location:
digital-me setup --wiki-root ~/notes/brain
```

Then give the brain its key — one line in `~/digital-me/.data/.env`, which
brain-host loads and every nightly worker inherits:

```bash
echo 'GEMINI_API_KEY=...' >> ~/digital-me/.data/.env
digital-me doctor        # the key is seen, the brain is serving
```

What `setup` does:

1. **Detects** `~/.claude/`, `~/.codex/`, `~/.hermes/`, `~/.openclaw/` to
   figure out which runtimes you have.
2. **Scaffolds** the wiki root — `~/digital-me/{wiki,tastes,inbox,.cache,.data}`
   plus a live `config.yaml` (created only if absent, never clobbered) and a
   `.gitignore` that keeps `.data/` out of your wiki repo.
3. **Installs brain-host** — the hub: links the service, writes its bearer
   token, builds the retrieval index over `wiki/` + `tastes/`, and loads it as
   a `launchd` / `systemd --user` service on `127.0.0.1:18791`.
4. **Installs each detected runtime**, pointed at brain-host — hooks, skills,
   MCP entries, protocol bundles (see [Runtimes](/docs/runtimes) for what
   lands where).
5. **Runs `doctor`** to confirm everything resolved.

Re-running is idempotent — installers merge into existing settings without
clobbering your other hooks.

### From source

For contributors, or to run an unreleased version: clone and build, then drive
the CLI with `pnpm dm <command>` from the repo — that's the in-repo equivalent
of the `digital-me` command before it's linked onto your PATH.

```bash
git clone https://github.com/Amyssjj/digital-me.git ~/digital-me-os
cd ~/digital-me-os && pnpm install && pnpm build
pnpm dm setup        # `pnpm dm` = the CLI, run from the clone
```

> **Packaging:** the CLI installs from npm as `digital-me`; during `setup`
> it pip-installs the dream-cycle pipeline from PyPI
> ([`digital-me-dream-cycle`](https://pypi.org/project/digital-me-dream-cycle/)).

```motus-demo
console
```

## Your first loop

The whole system exists for one loop: an agent learns something once, and
every agent knows it afterwards.

```bash
# 1. Verify the brain is serving
digital-me doctor
digital-me service brain-host status

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

With the npm install, the only directory that's yours to own is `~/digital-me`
— the CLI itself lives in npm's global packages.

| Path | What it is |
|---|---|
| `~/digital-me/` | **your** data: wiki, tastes, inbox, config (own it in a private git repo) |
| `~/digital-me/.data/` | the brain's state, git-ignored: `brain.db`, the retrieval index, `brain-host.token`, your `.env` |
| `~/.local/share/digital-me/` | stable install links for the always-on services (brain-host, dashboard) |
| `~/.openclaw/` | only if you run openclaw: its home, where the `digital-me-brain` plugin is installed |

*(Installed [from source](#from-source)? The repo checkout lives at
`~/digital-me-os` — code only, no personal data.)*

## Next steps

- Wire up each agent CLI you use → [Runtimes](/docs/runtimes)
- Understand the loop you just ran → [How it works](/docs/how-it-works)
- Every command and flag → [CLI reference](/docs/cli)
