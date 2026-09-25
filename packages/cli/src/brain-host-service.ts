import { existsSync } from "node:fs";
import path from "node:path";
import { resolveBrainDbPath, resolveEnvFilePath } from "@digital-me/contracts";
import { resolveServicePath } from "./service-path.js";

/**
 * Always-on service for the digital-me brain-host (retriever + orchestrator
 * tools on /tools/invoke, optional scheduler tick).
 *
 * Same invariants as the dashboard service: the unit's working directory is
 * the STABLE install symlink `~/.local/share/digital-me/brain-host`, which
 * `digital-me install --runtime brain-host` repoints, never a checkout or
 * worktree path. Secrets stay out of the unit file: the bearer token is read
 * by brain-host from `<wiki-root>/.data/brain-host.token`, and provider keys
 * come from an env file loaded with node's `--env-file-if-exists`.
 *
 * brain.db and the env file follow the contracts rule (resolveBrainDbPath /
 * resolveEnvFilePath): explicit env var → `<wiki-root>/.data/…` → the legacy
 * `~/.openclaw/…` location while only that one exists. The unit bakes the
 * resolved absolute paths in, so a later move is a re-install, never a
 * surprise at restart.
 *
 * Single-ticker rule: the scheduler is OFF unless the install explicitly
 * enables it. Exactly one process may tick a brain.db.
 */

export const BRAIN_HOST_SERVICE_LABEL = "ai.digital-me.brain-host";
export const BRAIN_HOST_DEFAULT_PORT = 18791;

export interface BrainHostServiceConfig {
  readonly label: string;
  /** Stable install symlink — the service's working directory. */
  readonly workingDir: string;
  /** Absolute path to `node` (services do not inherit a login PATH). */
  readonly nodeBin: string;
  /** Env file with provider keys (GEMINI_API_KEY); loaded if it exists. */
  readonly envFile: string;
  readonly port: number;
  readonly host: string;
  readonly wikiRoot: string;
  readonly tokenFile: string;
  readonly brainDb: string;
  readonly scheduler: "on" | "off";
  readonly home: string;
  /** Deterministic service PATH (never the installer's shell PATH); see service-path.ts. */
  readonly pathEnv: string;
  readonly stdoutLog: string;
  readonly stderrLog: string;
}

/** Pure: HOME + env + node binary → service config. */
export function resolveBrainHostServiceConfig(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  nodeBin: string,
  options: { readonly scheduler?: "on" | "off"; readonly exists?: (p: string) => boolean } = {},
): BrainHostServiceConfig {
  const wikiRoot = env.DIGITAL_ME_WIKI_ROOT ?? path.join(home, "digital-me");
  const pathDeps = { env: { ...env, DIGITAL_ME_WIKI_ROOT: wikiRoot }, home, exists: options.exists ?? existsSync };
  const portRaw = env.DIGITAL_ME_BRAIN_PORT;
  const port = portRaw ? Number.parseInt(portRaw, 10) : BRAIN_HOST_DEFAULT_PORT;
  return {
    label: BRAIN_HOST_SERVICE_LABEL,
    workingDir: path.join(home, ".local", "share", "digital-me", "brain-host"),
    nodeBin,
    envFile: resolveEnvFilePath(pathDeps).path,
    port: Number.isFinite(port) && port > 0 ? port : BRAIN_HOST_DEFAULT_PORT,
    host: env.DIGITAL_ME_BRAIN_HOST ?? "127.0.0.1",
    wikiRoot,
    tokenFile: path.join(wikiRoot, ".data", "brain-host.token"),
    brainDb: resolveBrainDbPath(pathDeps).path,
    scheduler: options.scheduler ?? (env.DIGITAL_ME_BRAIN_SCHEDULER?.toLowerCase() === "on" ? "on" : "off"),
    home,
    pathEnv: resolveServicePath(home, env, nodeBin),
    stdoutLog: path.join(home, "Library", "Logs", "digital-me-brain-host", "server.log"),
    stderrLog: path.join(home, "Library", "Logs", "digital-me-brain-host", "server.error.log"),
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The env the service runs with (shared by launchd and systemd generators). */
export function brainHostServiceEnv(cfg: BrainHostServiceConfig): Record<string, string> {
  return {
    HOME: cfg.home,
    PATH: cfg.pathEnv,
    NODE_ENV: "production",
    DIGITAL_ME_WIKI_ROOT: cfg.wikiRoot,
    DIGITAL_ME_BRAIN_PORT: String(cfg.port),
    DIGITAL_ME_BRAIN_HOST: cfg.host,
    DIGITAL_ME_BRAIN_TOKEN_FILE: cfg.tokenFile,
    DIGITAL_ME_BRAIN_DB: cfg.brainDb,
    DIGITAL_ME_BRAIN_SCHEDULER: cfg.scheduler,
  };
}

const PROGRAM_ARGS = (cfg: BrainHostServiceConfig): readonly string[] => [
  cfg.nodeBin,
  `--env-file-if-exists=${cfg.envFile}`,
  path.join(cfg.workingDir, "bin", "brain-host.mjs"),
  "serve",
];

/** macOS LaunchAgent plist: KeepAlive, RunAtLoad. */
export function buildBrainHostLaunchdPlist(cfg: BrainHostServiceConfig): string {
  const e = xmlEscape;
  const args = PROGRAM_ARGS(cfg)
    .map((a) => `    <string>${e(a)}</string>`)
    .join("\n");
  const env = Object.entries(brainHostServiceEnv(cfg))
    .map(([k, v]) => `    <key>${e(k)}</key><string>${e(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${e(cfg.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${e(cfg.workingDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${e(cfg.stdoutLog)}</string>
  <key>StandardErrorPath</key><string>${e(cfg.stderrLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
</dict>
</plist>
`;
}

/** Linux systemd --user unit. */
export function buildBrainHostSystemdUnit(cfg: BrainHostServiceConfig): string {
  const env = Object.entries(brainHostServiceEnv(cfg))
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join("\n");
  return `[Unit]
Description=digital-me brain-host (retriever + orchestrator tools)
After=network.target

[Service]
Type=simple
WorkingDirectory=${cfg.workingDir}
ExecStart=${PROGRAM_ARGS(cfg).join(" ")}
Restart=always
RestartSec=10
${env}

[Install]
WantedBy=default.target
`;
}

export type BrainHostServicePlatform = "darwin" | "linux";

export function brainHostServiceUnitPath(home: string, platform: BrainHostServicePlatform): string {
  return platform === "darwin"
    ? path.join(home, "Library", "LaunchAgents", `${BRAIN_HOST_SERVICE_LABEL}.plist`)
    : path.join(home, ".config", "systemd", "user", `${BRAIN_HOST_SERVICE_LABEL}.service`);
}

export function buildBrainHostServiceUnit(cfg: BrainHostServiceConfig, platform: BrainHostServicePlatform): string {
  return platform === "darwin" ? buildBrainHostLaunchdPlist(cfg) : buildBrainHostSystemdUnit(cfg);
}

/** The brain URL callers should export once the service is up. */
export function brainHostInvokeUrl(cfg: Pick<BrainHostServiceConfig, "host" | "port">): string {
  return `http://${cfg.host}:${cfg.port}/tools/invoke`;
}

export interface BrainCallerEnv {
  /** The brain-host `/tools/invoke` URL (DIGITAL_ME_BRAIN_URL). */
  readonly brainUrl: string;
  /**
   * Path of the file holding the bearer token (DIGITAL_ME_BRAIN_TOKEN_FILE).
   * Registrations carry the PATH, never the secret: every caller reads the
   * file itself (brain-mcp-proxy config.ts, the hooks, the Python clients).
   */
  readonly brainTokenFile: string;
}

/**
 * The DIGITAL_ME_BRAIN_URL / DIGITAL_ME_BRAIN_TOKEN_FILE pair a caller
 * registration should carry (settings.json `env`, the codex
 * `[mcp_servers.digital-me-brain]` env table, `hermes mcp add --env`) so the
 * proxy or hook that caller spawns talks to brain-host, not the openclaw
 * gateway. Registrations need the pair baked in because MCP hosts do not
 * forward the installer's shell environment.
 *
 * Precedence mirrors brain-mcp-proxy/config.ts: the installer's own
 * DIGITAL_ME_BRAIN_URL first, with the token file at DIGITAL_ME_BRAIN_TOKEN_FILE
 * (else the default `<wiki-root>/.data/brain-host.token`) — a URL whose token
 * file is missing, unreadable or blank is a hard error, never a silent
 * fallback; else the always-on brain-host service when its token file exists;
 * else `undefined` — the caller stays on the openclaw gateway.
 *
 * DIGITAL_ME_BRAIN_TOKEN in the installer's env is deliberately NOT persisted:
 * a registration must not carry the secret, so the token has to be on disk.
 */
export function resolveBrainCallerEnv(
  env: Readonly<Record<string, string | undefined>>,
  cfg: Pick<BrainHostServiceConfig, "host" | "port" | "tokenFile">,
  readTokenFile: (file: string) => string | undefined,
): BrainCallerEnv | undefined {
  const url = (env.DIGITAL_ME_BRAIN_URL ?? "").trim();
  if (url !== "") {
    const tokenFile = (env.DIGITAL_ME_BRAIN_TOKEN_FILE ?? "").trim() || cfg.tokenFile;
    if ((readTokenFile(tokenFile) ?? "").trim() === "") {
      throw new Error(
        `DIGITAL_ME_BRAIN_URL is set but no readable token file was found (looked in ${tokenFile}) — ` +
          "registrations carry DIGITAL_ME_BRAIN_TOKEN_FILE (a path), never DIGITAL_ME_BRAIN_TOKEN (the secret): " +
          "write the token to that file or point DIGITAL_ME_BRAIN_TOKEN_FILE at one, or unset the URL to fall back to the openclaw gateway",
      );
    }
    return { brainUrl: url, brainTokenFile: tokenFile };
  }
  const fileToken = (readTokenFile(cfg.tokenFile) ?? "").trim();
  if (fileToken === "") return undefined;
  return { brainUrl: brainHostInvokeUrl(cfg), brainTokenFile: cfg.tokenFile };
}
