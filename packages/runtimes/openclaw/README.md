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
# auto-detects ~/.openclaw/extensions, or $OPENCLAW_EXTENSIONS_DIR
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
`~/.openclaw/extensions/digital-me-brain/index.mjs`.

## Keeping openclaw up to date

**Always update openclaw with `digital-me update --runtime openclaw` — not
`openclaw update`.** On a git checkout, openclaw's own updater tracks the `main`
branch, which silently moves you onto unreleased/dev commits. The digital-me
updater instead checks out a fresh **mature stable tag** (a real release, ≥24h
old, never `*-alpha/-beta/-rc`), builds stock openclaw, then re-materializes this
additive overlay *after* the build — a **stock + overlay** model (no fork, no
rebase).

```bash
digital-me update --runtime openclaw [--dry-run] [--skip-restart] \
                  [--repo-dir <path>] [--tag-maturity-hours <n>] [--pnpm-spec <spec>]
```

- `--dry-run` prints the plan without writing.
- `--skip-restart` leaves the gateway process untouched.
- `--repo-dir` points at your openclaw checkout (default `~/openclaw`).
- `--pnpm-spec` overrides the pnpm used for install/build.

**pnpm is handled for you.** The updater runs install/build under the pnpm
version openclaw itself pins for the target tag (its `package.json`
`packageManager`), so a pnpm-major bump upstream (e.g. v10→v11) can't strand you
on the wrong major. It also runs non-interactively with the node_modules purge
pre-confirmed, so an upgrade never hangs on pnpm's `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
prompt. If you ever update openclaw by hand, mirror this with
`CI=1 pnpm install` (or `pnpm install --config.confirm-modules-purge=false`).

### Compatibility contract

Each overlay plugin declares the openclaw range it supports. The **floor** is
enforced by openclaw: `package.json` `install.minHostVersion` makes the gateway
refuse to load the plugin on an older host. The **ceiling** is a warn-only
boot-time check — running on an openclaw newer than the verified range logs a
warning but never blocks. Both, plus the documented `compat` block in each
`openclaw.plugin.json`, read from one source of truth:
[`src/compat.ts`](src/compat.ts). Re-verify against a new openclaw stable, then
bump `MAX_TESTED_OPENCLAW_VERSION` (and `MIN_OPENCLAW_VERSION` when dropping old
support) there.

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
