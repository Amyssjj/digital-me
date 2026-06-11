# @digital-me/runtime-openclaw

The openclaw runtime adapter for the digital-me brain. It wires
[`@digital-me/brain-orchestrator`](../../plugins/brain-orchestrator)'s tool
descriptors into openclaw's plugin SDK, implements the `Dispatcher` interface on
top of openclaw's subagent + exec runtime, and hosts the proactive-learning rule
engine.

This is the package the top-level README points at for "installing the brain
into openclaw."

## What gets installed

`digital-me install --runtime openclaw` materializes an **additive plugin
overlay** named `digital-me-brain` into your openclaw extensions directory. The
plugin registers these brain tools with the gateway:

| Tool | Purpose |
|---|---|
| `tasks` | goals / tasks / workflows / schedules board + dispatch |
| `agent_identify` | caller agent attribution |
| `learning_capture` | agents submit observations back to the brain |
| `traces_record` | record an agent action |
| `traces_query` | query recorded actions |
| `m1_event_record` | record an M1 (knowledge-application) event |
| `m1_score` | compute the M1 application-rate score |

The plugin reads `${DIGITAL_ME_WIKI_ROOT}/config.yaml` at load time (default
`~/digital-me`) and stores brain state in `~/.openclaw/data/brain.db` (override
via the plugin's `dbPath` config). The template lives in
[`templates/brain/`](templates/brain/) — `openclaw.plugin.json` (manifest +
config schema) and `index.mjs` (the gateway-loaded entry).

## Install

```bash
# auto-detects ~/openclaw/extensions, or $OPENCLAW_EXTENSIONS_DIR
digital-me install --runtime openclaw

# or point at a custom extensions dir
digital-me install --runtime openclaw --extensions-dir /path/to/openclaw/extensions
```

The installer:

1. Locates your openclaw extensions directory.
2. esbuild-bundles the brain plugin into a single-file entry and writes the
   `digital-me-brain` overlay (manifest + bundle) into it.
3. Leaves the overlay **untracked** relative to the openclaw checkout so a
   `git checkout <tag>` during an update preserves it.

After installing, enable the plugin in your openclaw config's `plugins.enabled`
list (if your gateway doesn't auto-discover extensions) and restart the gateway.
Verify with `digital-me doctor` — it checks for
`~/openclaw/extensions/digital-me-brain/index.mjs`.

## Keeping openclaw up to date

digital-me-os tracks openclaw with a **stock + overlay** model (no fork, no
rebase): each update checks out a fresh mature stable upstream tag, builds stock
openclaw, then re-materializes this additive overlay *after* the build.

```bash
digital-me update --runtime openclaw [--dry-run] [--skip-restart] \
                  [--repo-dir <path>] [--tag-maturity-hours <n>] [--pnpm-spec <spec>]
```

- `--dry-run` prints the plan without writing.
- `--skip-restart` leaves the gateway process untouched.
- `--repo-dir` points at your openclaw checkout (default `~/openclaw`).

Update logic lives in [`src/updater.ts`](src/updater.ts); install/overlay logic
in [`src/installer.ts`](src/installer.ts) and the CLI's `materializeOpenclawOverlay`.

## What this package also provides

- **Dispatcher** ([`src/dispatcher.ts`](src/dispatcher.ts)) — runs workflow
  `dispatch: { mode: "exec" | "spawn" }` steps via openclaw's runtime.
- **CLI-exec alias resolution** ([`src/alias-resolver.ts`](src/alias-resolver.ts))
  — materializes `cli_exec_aliases` (claude / codex / …) into
  `cli-exec-worker.mjs` invocations with prompt rendering + handoff capture.
- **Proactive-learning rule engine** ([`src/proactive-learning.ts`](src/proactive-learning.ts)).
- **Recall hooks + wiki graph** for memory-search injection.
