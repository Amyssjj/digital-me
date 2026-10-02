# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until `1.0.0`, minor versions may include breaking changes.

## [Unreleased]

### Fixed

- Codex: `digital-me install --runtime codex` now records Codex's hook trust
  (`[hooks.state."…"].trusted_hash` in `~/.codex/config.toml`) for the hooks
  it writes. Codex silently skips any hook whose definition changed since it
  was approved, so the upgrade that appended `--runtime codex` to every
  command took all Digital Me hooks offline for Codex — no recall injection,
  no M1 events, no error. `digital-me doctor` gains a `codex: hook trust`
  check that names each hook Codex would skip.
- Hook upgrades now raise a timeout on one of our hooks that is below the
  manifest's (Codex installs kept an 8 s inject timeout, under the hook's own
  12 s brain request).
- `CODEX.md` / `SOUL.md`: only the template's marked span is managed; its
  preamble (Codex header, Hermes default persona) no longer lands inside the
  managed block on every install. The nightly dream-cycle refresh of
  `CODEX.md` keeps the installer's protocol text — which carries the
  `[Digital Me]` acknowledgement rule — and updates only the Active Policies.

### Security

- brain-host: a client aborting mid-upload can no longer crash the process
  (unhandled rejection); `/health` without a bearer token now returns only
  `{ ok, version }` — paths, index and orchestrator detail need the token;
  `serve` rejects tokens shorter than 16 characters and warns on a
  non-loopback `DIGITAL_ME_BRAIN_HOST`; the token compare no longer leaks the
  token length. The HTTP helpers are now shared with brain-mcp-proxy via
  `@digital-me/contracts`.

## [0.1.0] - 2026-06-26

Initial public release. Published to npm as `digital-me` (with provenance) and to
PyPI as `digital-me-dream-cycle`. Functional monorepo with 1,500+ unit tests (core
stores and handlers at 100% coverage). Pre-1.0 — minor versions may include breaking
changes.

### Added
- `digital-me` CLI: `setup`, `init`, `install --runtime <id>`, `doctor`,
  `dream-cycle` — idempotent installer/orchestrator that detects runtimes, scaffolds
  the wiki root, and wires each detected CLI.
- Brain orchestrator plugin (`@digital-me/brain-orchestrator`): `tasks`,
  `agent_identify`, `learning_capture`, `traces_record`, `traces_query`,
  `m1_event_record`, `m1_score`.
- Per-runtime adapters: openclaw, claude-code, codex, hermes.
- Transport: stdio↔HTTP MCP proxy (`@digital-me/brain-mcp-proxy`).
- Services: dashboard viewer and the Python dream-cycle distillation pipeline
  (`digital-me-dream-cycle` on PyPI).
- Tag-driven release automation for the npm CLI bundle (with provenance) and the
  dream-cycle PyPI package.
- Open-source community health files: `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `SUPPORT.md`, GitHub issue/PR templates, and this changelog.
- Maintenance automation: Dependabot (npm + pip + actions), `CODEOWNERS`,
  `.editorconfig`, and `.github/FUNDING.yml`. (CodeQL via GitHub's repo-managed
  "default setup" in Settings rather than a committed workflow.)

### Changed
- Root `engines.node` raised to `>=22.5` to match all workspace packages and the
  README (the `node:sqlite` built-in used by the brain stores landed in Node 22.5.0).

[Unreleased]: https://github.com/Amyssjj/digital-me/compare/cli-v0.1.0...HEAD
[0.1.0]: https://github.com/Amyssjj/digital-me/releases/tag/cli-v0.1.0
