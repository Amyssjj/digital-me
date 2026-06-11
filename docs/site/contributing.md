# Contributing

The studio works in the open. Issues and PRs are welcome at
[Amyssjj/digital-me](https://github.com/Amyssjj/digital-me) — this page is
the path from clone to merged.

## Dev setup

```bash
git clone https://github.com/Amyssjj/digital-me.git
cd digital-me && pnpm install && pnpm build
pnpm test
```

The repo is a pnpm workspace; see [How it works](/docs/how-it-works) for the
package map and where a change belongs.

## Quality gates

Every PR must pass all four — CI enforces them, and running them locally
first saves a round-trip:

| Gate | Command | Bar |
|---|---|---|
| Lint | `pnpm lint` | clean |
| Tests | `pnpm test` | green (~1,400 unit tests) |
| Coverage | `pnpm test:coverage` | **100% on changed files** |
| Sanitization | `pnpm sanitize:check` | no personal identifiers, user paths, or org names anywhere in code or docs |

The sanitization gate is non-negotiable: this repo ships with **no personal
data**, and the scan runs on every PR and as a pre-commit hook. If it fires,
move the value behind the [env contract](/docs/configuration), replace it
with a generic placeholder, or (rarely) allowlist it with a written
justification.

## Adding a runtime adapter

The most common contribution. An adapter for a new agent CLI is a package
under `packages/runtimes/<cli>/` that does three things:

1. **Inject** — hook the CLI's prompt-build lifecycle to prepend matching
   wiki knowledge (every CLI exposes this differently: hooks, MCP, config
   includes).
2. **Capture** — hook session end (or tool events) to submit learnings via
   `learning_capture`.
3. **Install** — an idempotent installer the CLI command can call
   (`digital-me install --runtime <cli>`), merging into user settings
   without clobbering.

Study `packages/runtimes/codex/` as the template — it shows hooks, an MCP
entry through the `brain-mcp-proxy` transport, and M1 application-rate
tracking.

## Docs

These docs are generated from the repo by `scripts/gen-docs.mjs` on every
release — reference pages (CLI, brain tools, configuration) are extracted
from the code itself; narrative pages live in `docs/site/*.md`. Fix docs the
same way you fix code: edit the source file, open a PR, and the website
rebuilds from the merged bundle. Every page on the site links back to its
source file.

## Releasing

Maintainers cut releases from `main` (squash merges only). The flow —
version bump, tag, npm artifact verification from the packed tarball, PyPI
for dream-cycle — is documented in the repo's `docs/RELEASING.md`.

## Conduct

Be the kind of contributor an agent would capture a positive learning about.
