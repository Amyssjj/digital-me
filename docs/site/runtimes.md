# Runtimes

A *runtime adapter* wires one agent CLI into the shared brain: it injects
relevant knowledge into prompts going in, and captures learnings coming out.
`digital-me setup` installs every adapter it detects; this page is the
per-runtime reference for what gets installed and how to verify it.

All adapters are installed idempotently — re-running merges into your
existing settings and never clobbers other hooks.

## Claude Code

```bash
digital-me install --runtime claude-code
```

What lands:

- `~/.claude/hooks/*` — `dm_*.sh` lifecycle hooks (UserPromptSubmit injects
  matching wiki knowledge; Stop captures session learnings)
- `~/.claude/skills/digital-me/` — the protocol skill
- merged `settings.json` — hook registrations alongside whatever you already
  had

Verify: start a session and ask about a topic you know is in your wiki — the
prompt context will show a `[Digital Me]` injection block.

## Codex

```bash
digital-me install --runtime codex
```

What lands:

- `~/.codex/CODEX.md` — protocol instructions
- openclaw-brain MCP entry in `~/.codex/config.toml` (via the
  `brain-mcp-proxy` stdio↔HTTP transport)
- `~/.codex/hooks/*` wired through `~/.codex/hooks.json` — UserPromptSubmit /
  Stop / PreToolUse, with M1 application-rate tracking

## Hermes

```bash
digital-me install --runtime hermes
```

What lands: `~/.hermes/SOUL.md` gains the digital-me protocol section, and
the chat protocol bundle registers the brain tools.

## openclaw

```bash
digital-me install --runtime openclaw
```

This is the foundation install: it materializes an **additive plugin overlay**
named `digital-me-brain` into your openclaw extensions directory — stock
openclaw plus an overlay, no fork, no rebase. The overlay registers the brain
tools (`tasks`, `agent_identify`, `learning_capture`, `traces_record`,
`traces_query`, `m1_event_record`, `m1_score`) and hosts the
proactive-learning rule engine.

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
PEP 668 — `digital-me doctor` prints the exact recipe for your Python):

```bash
python3 -m venv ~/.venvs/dream-cycle
~/.venvs/dream-cycle/bin/pip install -e "packages/services/dream-cycle[dev]"
digital-me dream-cycle                        # run it manually
```

The nightly schedule (`dream-cycle-nightly`, 3am) is registered with the
orchestrator at install time — no manual cron needed.

## Dispatching work to your CLIs

The brain can also drive your CLIs: workflows dispatch steps to `claude` /
`codex` through `cli_exec_aliases` in your `config.yaml`. `setup`
pre-populates aliases for the CLIs it detects; see the
[Configuration](/docs/configuration) reference for the shape.
