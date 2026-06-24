<!--
Thanks for contributing! Keep PRs focused on one logical change.
See CONTRIBUTING.md for setup and the quality gates.
-->

## What & why

<!-- What does this change, and why is it needed? Link any related issue: Closes #123 -->

## How I verified

<!-- Commands run, behavior observed. Paste relevant output (redact personal data). -->

## Checklist

- [ ] `pnpm ci` passes locally (sanitize → build → typecheck → lint → knip → test:coverage)
- [ ] Tests added/updated for behavior changes (core packages stay at 100% coverage)
- [ ] Docs updated if a contract, CLI flag, or install step changed
- [ ] No personal data, secrets, or machine-specific paths introduced (sanitize gate)
- [ ] Conventional Commit title (e.g. `feat(cli): …`, `fix(brain): …`)
