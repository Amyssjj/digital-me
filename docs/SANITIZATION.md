# Sanitization Policy

This repo is open source. No file under `packages/`, `docs/`, or `scripts/` may contain personal identifiers, machine-specific paths, organization-specific names, or hardcoded agent IDs from any individual user's setup.

## What's forbidden

- **User home / machine paths**: `/Users/<name>/`, `/Volumes/<name>_SSD/`, etc.
- **Personal names**: any maintainer or user's real name, username, email handle
- **Organization names**: any specific company or team name from a private deployment
- **Personal project codenames**: agent IDs, role names, channel names that exist only in one user's setup
- **Personal cron times**: a specific schedule baked in as a default
- **Personal wiki domain registries**: the 40-domain taxonomy of any one user

The full regex list lives in [`scripts/sanitize-check.sh`](../scripts/sanitize-check.sh). The CI gate fails the build if any pattern is matched in source files.

## What's allowed

- **Generic placeholders**: `default-agent`, `main`, `<user>`, `<wiki>`, etc.
- **Config schemas**: TypeScript types defining the *shape* of user configuration
- **Example configs**: `config.example.yaml` files showing the schema with generic values
- **Documentation of patterns**: this very file lists "forbidden patterns" — that's allowed because it's the policy, not a leak

## How to handle a leak

If you find yourself wanting to write a value the sanitize gate forbids, follow this decision tree:

```
Does the value differ per user?
│
├── YES → Move it to config (load via @digital-me/contracts)
│         Add to packages/shared/contracts/src/env.ts as an env var,
│         OR to the config.yaml schema in schemas.ts.
│
└── NO  → It's universal. Use a generic placeholder.
          Examples: "default-agent", "main", "Operations Dashboard"
```

If neither path applies (the value is genuinely a meta-reference to the policy itself), add the file to `ALLOWLIST` in `scripts/sanitize-check.sh` with a one-line justification comment.

## Mechanism vs configuration — concrete examples

| Mechanism (public code) | Configuration (private `digital-me-data`) |
|---|---|
| Rule engine that matches agent + keyword → injects context | The rules themselves (which agent, which keywords, which domains) |
| Workflow template runner | The template instances (cron schedule, exec prompt) |
| Wiki indexer | The wiki content + domain taxonomy |
| Dashboard component renderer | The team workspace root + learning source paths |
| Hook script that fires `memory_search` on prompt submit | Which domains to filter to; opt-in/out flags |
| CODEX.md/AGENTS.md template renderer | User identity, preferences, custom protocol additions |

A good test: **could two different users with completely different organizations both use this code unchanged?** If yes, it's mechanism. If no, it's configuration that needs to move.

## Why this matters

Without enforcement, "open source" drifts into "the maintainer's personal setup with their name removed." With enforcement:

- The repo is genuinely usable by anyone
- The maintainer can't accidentally leak personal data even in a hurry
- The architecture stays honest: mechanisms are general, config is private
- New contributors don't need to know the maintainer's history to read the code

The gate is mechanical, not aspirational. CI fails on leaks; pre-commit hook catches them locally first.
