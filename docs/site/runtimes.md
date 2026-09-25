# Runtimes

A *runtime adapter* wires one agent CLI into the shared brain: it injects
relevant knowledge into prompts going in, and captures learnings coming out.
`digital-me setup` installs every adapter it detects; this page is the
per-runtime reference for what gets installed and how to verify it.

All adapters are installed idempotently — re-running merges into your
existing settings and never clobbers other hooks. Every adapter talks to the
same endpoint: **brain-host**, the hub below, which `setup` installs before
any adapter so each registration carries its URL and token-file path.

## brain-host (the hub)

```bash
digital-me install --runtime brain-host       # setup does this first
digital-me service brain-host status
```

The brain itself: one always-on Node service on `127.0.0.1:18791` serving
`memory_search` / `memory_get` / `wiki` from a retriever over your `wiki/` +
`tastes/` (hybrid full-text + embeddings, incremental re-index every 30 min)
and the brain-orchestrator tools (`tasks`, `agent_identify`, `learning_capture`,
`traces_record`, `traces_query`, `m1_event_record`, `m1_score`) on one
bearer-gated `POST /tools/invoke` wire. It owns `brain.db` and the scheduler
tick that fires your workflows. Installed as a `launchd` (macOS) /
`systemd --user` (Linux) service so it survives reboots.

What lands:

- `~/.local/share/digital-me/brain-host` — stable install link (the service's
  working directory)
- `~/digital-me/.data/brain-host.token` — bearer token (mode 600); adapters
  carry this *path*, never the secret
- `~/digital-me/.data/retrieval.db` — the index; `~/digital-me/.data/brain.db`
  — goals, tasks, traces, learnings
- `~/digital-me/.data/.env` — where you put `GEMINI_API_KEY`; the service loads
  it and every worker it dispatches inherits it

Verify: `curl -s -H "Authorization: Bearer $(cat ~/digital-me/.data/brain-host.token)" http://127.0.0.1:18791/health`
reports the index size, the scheduler state and which `brain.db` it opened.
Without the token, `/health` answers only `{ ok, version }` (liveness).

## Claude Code

```bash
digital-me install --runtime claude-code
```

What lands:

- `~/.claude/hooks/*` — `dm_*.sh` lifecycle hooks (UserPromptSubmit injects
  matching wiki knowledge; Stop captures session learnings)
- `~/.claude/skills/digital-me/` — the protocol skill
- merged `settings.json` — hook registrations alongside whatever you already
  had, plus the `openclaw-brain` MCP server entry (the name is historical —
  it is `brain-mcp-proxy` forwarding to brain-host)

Verify: start a session and ask about a topic you know is in your wiki — the
prompt context will show a `[Digital Me]` injection block.

## Codex

```bash
digital-me install --runtime codex
```

What lands:

- `~/.codex/CODEX.md` — protocol instructions
- the `openclaw-brain` MCP entry in `~/.codex/config.toml` (historical name;
  `brain-mcp-proxy` stdio↔HTTP transport to brain-host)
- `~/.codex/hooks/*` wired through `~/.codex/hooks.json` — UserPromptSubmit /
  Stop / PreToolUse, with M1 application-rate tracking

## Hermes

```bash
digital-me install --runtime hermes
```

What lands: `~/.hermes/SOUL.md` gains the digital-me protocol section, the
recall plugin injects matching knowledge at prompt time, and the MCP stanza in
`~/.hermes/config.yaml` registers the brain tools.

## openclaw (optional)

```bash
digital-me install --runtime openclaw
```

Only if you also run [openclaw](https://github.com/openclaw/openclaw) agents —
it is a runtime like the others, not a prerequisite. The install materializes
an **additive plugin overlay** (`digital-me-brain` + `digital-me-recall`) into
your openclaw extensions directory — stock openclaw plus an overlay, no fork,
no rebase. The overlay registers the brain tools (`tasks`, `agent_identify`,
`learning_capture`, `traces_record`, `traces_query`, `m1_event_record`,
`m1_score`) with the gateway, injects wiki knowledge at prompt time, and hosts
the proactive-learning rule engine. It opens the same `brain.db` as brain-host
and leaves the scheduler tick to brain-host whenever brain-host is installed
(exactly one process ticks a brain).

Keep openclaw current without losing the overlay:

```bash
digital-me update --runtime openclaw          # update to latest mature tag
digital-me deploy                             # merged-in-git → verified-live
```

## Dashboard (optional service)

```bash
digital-me install --runtime dashboard        # + always-on service
digital-me service dashboard status
```

A local viewer over your accumulated state — sessions, entries, application
rate, workflows, feed. Installed as a `launchd` (macOS) / `systemd --user`
(Linux) service so it survives reboots; `--no-service` skips that.

## Dream-cycle (optional, Python)

The nightly distillation pipeline that turns raw captured learnings into
clean wiki entries. Requires Python ≥ 3.11 in a venv (Homebrew/Debian enforce
PEP 668 — `digital-me doctor` prints the exact recipe for your Python).

It ships on PyPI as `digital-me-dream-cycle`:

```bash
python3 -m venv ~/.venvs/dream-cycle
~/.venvs/dream-cycle/bin/pip install digital-me-dream-cycle
digital-me dream-cycle                        # run it manually
```

Working on the pipeline itself? Install it editable from the repo instead:
`pip install -e "packages/services/dream-cycle[dev]"`.

The nightly schedule (`dream-cycle-nightly`, 3am) is registered with
brain-host's orchestrator at install time — no manual cron needed. The LLM key
comes from `~/digital-me/.data/.env` (`engine: standalone`, the default
`config.yaml`); `digital-me doctor` checks it there.

## Digest (optional, Python)

```bash
digital-me install --runtime digest
```

The 07:00 activity digest — what every agent did yesterday, what the
dream-cycle distilled — posted to Discord. Delivery is a **Discord webhook**
(no gateway needed): write the webhook URL to
`~/digital-me/.data/digest-webhook.url` (mode 600). Machines that still run an
openclaw gateway can keep `digest.delivery: openclaw` in `config.yaml` to send
through `openclaw message send` instead.

## Dispatching work to your CLIs

The brain can also drive your CLIs: workflows dispatch steps to `claude` /
`codex` through `cli_exec_aliases` in your `config.yaml`. `setup`
pre-populates aliases for the CLIs it detects; see the
[Configuration](/docs/configuration) reference for the shape.
