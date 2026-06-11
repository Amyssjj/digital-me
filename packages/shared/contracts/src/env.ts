/**
 * Environment variable registry for digital-me-os packages.
 *
 * Every package that needs a user-specific path, port, or identifier reads
 * it through `loadConfig()` here — never via hardcoded values.
 *
 * See ../../../docs/CONTRACTS.md for the human-readable contract table.
 */

import { homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// The registry
//
// Each entry declares:
//   - default: the value to use when the env var is unset (or null if required)
//   - description: shown in error messages and `digital-me doctor`
//   - required: if true, missing -> throw at load time
// ---------------------------------------------------------------------------

type EnvSpec = {
  readonly default: string | null;
  readonly description: string;
  readonly required: boolean;
};

const HOME = homedir();

const REGISTRY = {
  DIGITAL_ME_HOME: {
    default: null, // derived from DIGITAL_ME_WIKI_ROOT when unset (legacy alias)
    description:
      "Legacy alias for DIGITAL_ME_WIKI_ROOT (the data root: wiki + config). Optional — when unset it falls back to DIGITAL_ME_WIKI_ROOT. Prefer exporting DIGITAL_ME_WIKI_ROOT.",
    required: false,
  },
  DIGITAL_ME_WIKI_DIR: {
    default: null, // resolved relative to DIGITAL_ME_HOME / DIGITAL_ME_WIKI_ROOT at load time
    description: "Directory containing your wiki .md files.",
    required: false,
  },
  DIGITAL_ME_WIKI_ROOT: {
    default: path.join(HOME, "digital-me"),
    description:
      "Canonical wiki/data root that every runtime adapter, hook, dream-cycle, and dashboard-intake reads (contains wiki/, inbox/, config.yaml). This is the variable users export; DIGITAL_ME_HOME is the contracts-layer alias.",
    required: false,
  },
  DREAM_CYCLE_HOME: {
    default: null,
    description: "Directory for the dream-cycle Python pipeline.",
    required: false,
  },
  DREAM_CYCLE_VENV: {
    default: null,
    description: "Python venv used by dream-cycle.",
    required: false,
  },
  OPENCLAW_HOME: {
    default: path.join(HOME, ".openclaw"),
    description: "Openclaw configuration and data home.",
    required: false,
  },
  OPENCLAW_DATA_DIR: {
    default: null,
    description: "Openclaw runtime data directory (SQLite stores).",
    required: false,
  },
  OPENCLAW_GATEWAY_HOST: {
    default: "127.0.0.1",
    description:
      "Host of the openclaw gateway HTTP server. Defaults to the IPv4 loopback literal (not 'localhost', which Node >=17 may resolve to ::1 and miss a 127.0.0.1-bound gateway).",
    required: false,
  },
  OPENCLAW_GATEWAY_PORT: {
    default: "18789",
    description: "Port of the openclaw gateway HTTP server.",
    required: false,
  },
  OPENCLAW_GATEWAY_TOKEN: {
    default: null,
    description:
      "Auth token for the openclaw gateway. If unset, read from $OPENCLAW_HOME/openclaw.json.",
    required: false,
  },
  BRAIN_PROXY_PATH: {
    default: null,
    description:
      "Absolute path to the brain-mcp-proxy binary. If unset, resolved via PATH.",
    required: false,
  },
  ORCHESTRATOR_DB_PATH: {
    default: null,
    description: "Path to brain-orchestrator SQLite store.",
    required: false,
  },
  DASHBOARD_PORT: {
    default: "3458",
    description: "Port the dashboard Express server listens on (loopback only).",
    required: false,
  },
  DASHBOARD_TITLE: {
    default: "Operations Dashboard",
    description: "Title shown in dashboard UI header.",
    required: false,
  },
  TEAM_WORKSPACE_ROOT: {
    default: null,
    description:
      "Optional root directory of a shared team workspace. Dashboard team views are disabled if unset.",
    required: false,
  },
  LEARNING_SOURCE_DIR: {
    default: null,
    description:
      "Optional source directory for learning artifacts to ingest into the dashboard.",
    required: false,
  },
  LEARNING_DEST_DIR: {
    default: null,
    description: "Optional destination directory for processed learning notes.",
    required: false,
  },
  OPENCLAW_AGENT_ID: {
    default: "unknown",
    description:
      "Caller agent identity for brain attribution. Set per-runtime in MCP server env block.",
    required: false,
  },
} as const satisfies Record<string, EnvSpec>;

export type EnvKey = keyof typeof REGISTRY;

// ---------------------------------------------------------------------------
// Resolution
//
// Resolution order for each key:
//   1. process.env[key]
//   2. derived default (e.g., DIGITAL_ME_WIKI_DIR := DIGITAL_ME_HOME/wiki)
//   3. spec.default
//   4. throw if required
// ---------------------------------------------------------------------------

// Keys with no literal default AND no derivation rule: loadConfig omits them
// when unset, so they are genuinely optional at runtime. Every other key either
// has a non-null default or is derived from one that does, so it always
// resolves. Typing this honestly stops the `resolved as Config` cast from
// over-promising `string` for keys that are frequently absent.
type OptionalEnvKey =
  | "OPENCLAW_GATEWAY_TOKEN"
  | "BRAIN_PROXY_PATH"
  | "TEAM_WORKSPACE_ROOT"
  | "LEARNING_SOURCE_DIR"
  | "LEARNING_DEST_DIR";

type Config = {
  readonly [K in Exclude<EnvKey, OptionalEnvKey>]: string;
} & {
  readonly [K in OptionalEnvKey]?: string;
};

class MissingRequiredEnvError extends Error {
  constructor(key: EnvKey, spec: EnvSpec) {
    super(
      `Missing required environment variable: ${key}\n  ${spec.description}`,
    );
    this.name = "MissingRequiredEnvError";
  }
}

/**
 * Compute a derived default for a key, if one applies.
 * Returns null when no derivation rule matches the key OR when a required
 * parent is unresolved (defensive — invariant violation).
 *
 * Reachable through loadConfig only along the "rule matches and parent is
 * resolved" path. The "rule matches but parent is null" branches are
 * defensive and tested via the _internal export.
 */
function deriveValue(
  key: EnvKey,
  resolved: Partial<Record<EnvKey, string>>,
): string | null {
  switch (key) {
    case "DIGITAL_ME_HOME": {
      // Legacy alias: when unset, DIGITAL_ME_HOME mirrors the canonical
      // DIGITAL_ME_WIKI_ROOT (which always resolves, having a default).
      return resolved.DIGITAL_ME_WIKI_ROOT ?? null;
    }
    case "DIGITAL_ME_WIKI_DIR": {
      // DIGITAL_ME_HOME and DIGITAL_ME_WIKI_ROOT are aliases for the same data
      // root; honour whichever resolved. WIKI_ROOT is the canonical user-facing
      // var, HOME the legacy contracts-layer name.
      const parent = resolved.DIGITAL_ME_HOME ?? resolved.DIGITAL_ME_WIKI_ROOT;
      return parent ? path.join(parent, "wiki") : null;
    }
    case "DREAM_CYCLE_HOME": {
      const parent = resolved.DIGITAL_ME_HOME;
      return parent ? path.join(parent, "dream_cycle") : null;
    }
    case "DREAM_CYCLE_VENV": {
      const parent = resolved.DREAM_CYCLE_HOME;
      return parent ? path.join(parent, ".venv") : null;
    }
    case "OPENCLAW_DATA_DIR": {
      const parent = resolved.OPENCLAW_HOME;
      return parent ? path.join(parent, "data") : null;
    }
    case "ORCHESTRATOR_DB_PATH": {
      const parent = resolved.OPENCLAW_DATA_DIR;
      return parent ? path.join(parent, "orchestrator.db") : null;
    }
    default:
      return null;
  }
}

/**
 * Resolve a single env key, applying defaults and derived defaults.
 * Returns null if the value is unset and not required.
 * Throws MissingRequiredEnvError if required-effective and unset.
 *
 * `requireOverride`, when provided, replaces the registry's `required` flag
 * for this resolution — a caller that only consumes a subset of keys can
 * say "I only require these," letting unused required keys be unset
 * without failing at startup.
 */
function resolveKey(
  key: EnvKey,
  env: NodeJS.ProcessEnv,
  resolved: Partial<Record<EnvKey, string>>,
  requireOverride?: ReadonlySet<EnvKey>,
): string | null {
  const raw = env[key];
  if (raw !== undefined && raw !== "") {
    return raw;
  }

  const derived = deriveValue(key, resolved);
  if (derived !== null) return derived;

  const spec = REGISTRY[key];
  if (spec.default !== null) return spec.default;
  const isRequired =
    requireOverride !== undefined ? requireOverride.has(key) : spec.required;
  if (isRequired) throw new MissingRequiredEnvError(key, spec);
  return null;
}

export type LoadConfigOptions = {
  /**
   * Override the per-key `required` flag. When provided, only the listed
   * keys throw if missing — everything else is best-effort. Defaults to
   * the registry's declared `required` flags.
   */
  readonly requireOverride?: readonly EnvKey[];
};

/**
 * Load the full config. Resolves in dependency order so that derived defaults
 * see their parents' values. Throws on missing required keys (or, with
 * `requireOverride`, missing keys in the override list).
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): Config {
  // Order matters — derived defaults read from already-resolved keys.
  const order: readonly EnvKey[] = [
    "DIGITAL_ME_WIKI_ROOT",
    "DIGITAL_ME_HOME",
    "DIGITAL_ME_WIKI_DIR",
    "OPENCLAW_HOME",
    "OPENCLAW_DATA_DIR",
    "DREAM_CYCLE_HOME",
    "DREAM_CYCLE_VENV",
    "ORCHESTRATOR_DB_PATH",
    "OPENCLAW_GATEWAY_HOST",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_TOKEN",
    "BRAIN_PROXY_PATH",
    "DASHBOARD_PORT",
    "DASHBOARD_TITLE",
    "TEAM_WORKSPACE_ROOT",
    "LEARNING_SOURCE_DIR",
    "LEARNING_DEST_DIR",
    "OPENCLAW_AGENT_ID",
  ];

  const requireOverride =
    options.requireOverride !== undefined
      ? new Set(options.requireOverride)
      : undefined;

  const resolved: Partial<Record<EnvKey, string>> = {};
  for (const key of order) {
    const value = resolveKey(key, env, resolved, requireOverride);
    if (value !== null) resolved[key] = value;
  }

  return resolved as Config;
}

/**
 * Describe a single key — used by `digital-me doctor` and error messages.
 */
export function describeEnv(key: EnvKey): EnvSpec {
  return REGISTRY[key];
}

/**
 * Iterate all keys — used by `digital-me doctor` to list everything.
 */
export function allEnvKeys(): readonly EnvKey[] {
  return Object.keys(REGISTRY) as EnvKey[];
}

export { MissingRequiredEnvError };

/**
 * Internal helpers exposed for unit testing only. Not part of the stable API —
 * do not import this from consumer packages.
 */
export const _internal = {
  resolveKey,
  deriveValue,
};
