# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Report privately through GitHub's built-in advisory flow:

→ **[Report a vulnerability](https://github.com/Amyssjj/digital-me/security/advisories/new)**
(repo **Security** tab → **Advisories** → **Report a vulnerability**).

This keeps the report confidential until a fix is available and lets us collaborate
on a private advisory and patch. Please include:

- A description of the issue and its impact.
- Steps to reproduce (or a proof of concept).
- Affected version / commit, and your environment (OS, Node version, openclaw version).

We aim to acknowledge reports within **5 business days** and to keep you updated as we
work toward a fix. Please give us a reasonable window to address the issue before any
public disclosure.

## Why this matters here

Digital Me installs into and reads from sensitive locations on the user's machine, so
we take reports against the following surfaces especially seriously:

- **Credential handling** — the stack reads LLM provider keys from
  `~/.openclaw/openclaw.json` and related config. Anything that could leak, log, or
  exfiltrate those is in scope.
- **Settings merges** — installers merge into `~/.claude/`, `~/.codex/`, `~/.hermes/`
  settings and hook files. Anything that could clobber, escalate, or inject into a
  user's existing config is in scope.
- **MCP transport** — the stdio↔HTTP proxy and the brain MCP tools. Injection,
  SSRF, or auth-bypass against these is in scope.
- **CLI-exec aliases** — workflow steps that dispatch to local CLIs. Command
  injection or unintended argument expansion is in scope.

This repository contains **no personal data and no secrets** by design; all
user-specific data lives in a separate local `digital-me-data` directory. Reports of
secrets or personal paths committed to this repo are still welcome (the sanitize gate
is meant to prevent exactly that).

## Supported versions

Digital Me is in active pre-release (`0.x`). Security fixes are applied to the latest
released version on `main`. Pin to a tag for reproducibility, but expect fixes to land
on the newest version rather than being backported.

## Scope

Out of scope: vulnerabilities in upstream dependencies (report those upstream;
we'll bump once a fix is released), in **openclaw** itself (report to the
[openclaw project](https://github.com/openclaw/openclaw)), or issues requiring an
already-compromised local machine.
