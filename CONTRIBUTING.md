# Contributing to Digital Me

Thanks for your interest in improving Digital Me. This guide covers how to set up
your environment, the quality gates every change must pass, and how we review and
release.

## Ground rules

- **This repo contains no personal data.** All user-specific content (wiki entries,
  config, credentials) lives in your local `digital-me-data` directory and is loaded
  at runtime via the env-var contract. Never commit personal data, API keys, machine
  paths, or other host-specific values. The sanitize gate (below) enforces this.
- Be respectful — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- For security issues, **do not open a public issue** — see [SECURITY.md](SECURITY.md).

## Prerequisites

- **Node.js ≥ 22.5** — the code depends on the built-in `node:sqlite` module, which
  landed in 22.5.0. Older 22.x will not work.
- **pnpm** (the repo pins a version via `packageManager`; run `corepack enable` to
  get the matching one automatically).
- **[openclaw](https://github.com/openclaw/openclaw)** — required to run the full
  stack locally, though most unit tests run without it.
- **Python ≥ 3.11** — only needed when working on the dream-cycle service.

## Setup

```bash
git clone https://github.com/Amyssjj/digital-me.git
cd digital-me
pnpm install
pnpm build      # workspace deps must emit dist/ before typecheck/test resolve them
```

## Quality gates

Every change must pass the full CI aggregate **before** you push:

```bash
pnpm ci
```

That runs, in order:

1. `pnpm sanitize:check` — forbidden-pattern scan (personal paths, secrets, etc.).
   **Must pass before any commit.** See [docs/SANITIZATION.md](docs/SANITIZATION.md).
2. `pnpm build` — builds all workspace packages.
3. `pnpm typecheck` — TypeScript, no emit.
4. `pnpm lint` — ESLint (flat config).
5. `pnpm knip` — dead-code / unused-dependency guard.
6. `pnpm test:coverage` — Vitest with **100% coverage thresholds** on core packages
   (cli, codex, brain-orchestrator, …). New code in those packages must keep them at 100%.

A husky pre-commit hook runs the sanitize check automatically, but run `pnpm ci`
yourself before opening a PR — it's exactly what GitHub Actions runs.

Working on the Python dream-cycle service:

```bash
python3 -m venv ~/.venvs/dream-cycle
~/.venvs/dream-cycle/bin/pip install -e "packages/services/dream-cycle[dev]"
~/.venvs/dream-cycle/bin/pytest -q packages/services/dream-cycle
```

## Commits & pull requests

- **Conventional Commits** — e.g. `feat(cli): …`, `fix(brain): …`, `docs(site): …`,
  `ci: …`. The scope is usually the package or area you touched.
- Branch off `main`; open the PR against `main`.
- Keep PRs focused. One logical change per PR makes review (and revert) tractable.
- Fill out the PR template — describe what changed, why, and how you verified it.
- Add or update tests for any behavior change. Update docs when you change a contract,
  CLI flag, or install step.
- All CI checks must be green before merge.

## Architecture orientation

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the five package roles and how
they fit together, and [docs/CONTRACTS.md](docs/CONTRACTS.md) for the env-var contract
between this repo and your data directory. If your change touches how Digital Me adapts
to upstream openclaw, read [docs/UPSTREAM-ADAPTATION-CONSTRAINT.md](docs/UPSTREAM-ADAPTATION-CONSTRAINT.md)
first.

## Releasing

Releases are tag-driven and documented in [docs/RELEASING.md](docs/RELEASING.md).
Maintainers cut releases; contributors don't need to.
