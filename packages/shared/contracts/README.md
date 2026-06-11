# @digital-me/contracts

Env-var registry and config-schema definitions shared across digital-me-os packages.

## Why this package exists

Every other package needs to read user-specific values: paths, ports, identifiers, injection rules. Without a shared contract, each package would reinvent its own config loading — and `/Users/<name>/...` would leak in dozens of places.

This package is the single seam between **user-specific data** (which lives in the private `digital-me-data` repo) and **public package code** (which lives here).

## Usage

```ts
import { loadConfig } from "@digital-me/contracts";

const cfg = loadConfig();
console.log(cfg.DIGITAL_ME_HOME);    // ~/digital-me-data
console.log(cfg.OPENCLAW_GATEWAY_PORT); // "18789"
```

If a required env var is missing, `loadConfig()` throws `MissingRequiredEnvError` at startup with a clear "set X" message.

## What's defined here

- **`env.ts`** — environment variables, defaults, derived defaults, resolution logic
- **`schemas.ts`** — TypeScript types for the `config.yaml` shape consumed by various packages

## Adding a new variable

1. Add a row to `REGISTRY` in `env.ts` with description and default.
2. Add a row to the table in `docs/CONTRACTS.md`.
3. (Optional) Add a derived default in `resolveKey()` if it depends on another var.
4. Add to the resolution order in `loadConfig()` if order matters.

## Adding a new config.yaml field

1. Add the type to `schemas.ts`.
2. Document the shape in the consuming package's README.
3. (Optional) Update a top-level `DigitalMeConfig` field.

## Testing

Tests live under `test/` (to be added when consumers exist). For now, this package is purely declarative — types and a small resolver.
