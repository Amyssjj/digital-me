# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until `1.0.0`, minor versions may include breaking changes.

## [Unreleased]

### Added
- Open-source community health files: `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, GitHub issue/PR templates, and this changelog.
- Maintenance automation: Dependabot (npm + pip + actions), `CODEOWNERS`, and
  `.editorconfig`. (CodeQL code scanning is enabled via GitHub's repo-managed
  "default setup" in Settings rather than a committed workflow.)
- `SUPPORT.md` (help-routing) and `.github/FUNDING.yml` (sponsor button).

### Changed
- Root `engines.node` raised to `>=22.5` to match all workspace packages and the
  README (the `node:sqlite` built-in used by the brain stores landed in Node 22.5.0).

## [0.1.0-pre] - 2026-06

Initial pre-release. Functional monorepo with ~1,400 unit tests (core stores and
handlers at 100% coverage); install from source — nothing published to npm yet.

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

[Unreleased]: https://github.com/Amyssjj/digital-me/compare/v0.1.0-pre...HEAD
[0.1.0-pre]: https://github.com/Amyssjj/digital-me/releases/tag/v0.1.0-pre
