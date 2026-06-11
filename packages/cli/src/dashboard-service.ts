import path from "node:path";

/**
 * Cross-platform always-on service for the digital-me dashboard.
 *
 * The dashboard server (`npm run start` = `tsx src/server/server.ts`) serves
 * BOTH the API and the Vite-built client (`express.static(dist)` + SPA
 * fallback) on a single port — so one long-running process is the whole
 * dashboard. This module generates the OS service unit that keeps it up
 * without a terminal, on macOS (launchd) and Linux (systemd --user).
 *
 * INVARIANT (learned the hard way, 2026-06-03): the unit's working dir MUST be
 * the STABLE install symlink `~/.local/share/digital-me/dashboard`, never an
 * absolute checkout/worktree path — a worktree path goes stale when the
 * worktree is removed and the service then exits EX_CONFIG (code 78) forever.
 * The symlink is repointed by `digital-me install`, so it never goes stale.
 */

export const DASHBOARD_SERVICE_LABEL = "ai.digital-me.dashboard";
export const DASHBOARD_DEFAULT_PORT = 3458;

export interface DashboardServiceConfig {
  /** launchd Label / systemd unit basename. */
  readonly label: string;
  /** Stable install symlink — the service's working directory. */
  readonly workingDir: string;
  /** Absolute path to the `npm` binary (services don't inherit a login PATH). */
  readonly npmBin: string;
  /** Canonical dashboard DB. */
  readonly db: string;
  /** Single port the server binds (API + built client). */
  readonly port: number;
  /** Absolute HOME for the service env. */
  readonly home: string;
  /** PATH for the service env (services start with a minimal PATH). */
  readonly pathEnv: string;
  /** macOS log destinations (systemd uses journald, ignores these). */
  readonly stdoutLog: string;
  readonly stderrLog: string;
}

/**
 * Resolve the service config from HOME + env. Pure (no fs / process access
 * beyond the passed-in values) so it is unit-testable.
 */
export function resolveDashboardServiceConfig(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  npmBin: string,
): DashboardServiceConfig {
  const portRaw = env.DASHBOARD_PORT ?? env.PORT;
  const port = portRaw ? Number.parseInt(portRaw, 10) : DASHBOARD_DEFAULT_PORT;
  return {
    label: DASHBOARD_SERVICE_LABEL,
    workingDir: path.join(home, ".local", "share", "digital-me", "dashboard"),
    npmBin,
    db: path.join(home, "digital-me", ".data", "dashboard.db"),
    port: Number.isFinite(port) ? port : DASHBOARD_DEFAULT_PORT,
    home,
    pathEnv:
      env.PATH ??
      "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    stdoutLog: path.join(home, "Library", "Logs", "digital-me-dashboard", "server.log"),
    stderrLog: path.join(home, "Library", "Logs", "digital-me-dashboard", "server.error.log"),
  };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** macOS LaunchAgent plist. Runs `npm run start`, KeepAlive, RunAtLoad. */
export function buildLaunchdPlist(cfg: DashboardServiceConfig): string {
  const e = xmlEscape;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${e(cfg.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${e(cfg.npmBin)}</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${e(cfg.workingDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${e(cfg.stdoutLog)}</string>
  <key>StandardErrorPath</key><string>${e(cfg.stderrLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${e(cfg.home)}</string>
    <key>PATH</key><string>${e(cfg.pathEnv)}</string>
    <key>NODE_ENV</key><string>production</string>
    <key>PORT</key><string>${cfg.port}</string>
    <key>DASHBOARD_DB</key><string>${e(cfg.db)}</string>
  </dict>
</dict>
</plist>
`;
}

/** Linux systemd --user unit. Restart=always; logs go to journald. */
export function buildSystemdUserUnit(cfg: DashboardServiceConfig): string {
  return `[Unit]
Description=digital-me dashboard (always-on)
After=network.target

[Service]
Type=simple
WorkingDirectory=${cfg.workingDir}
ExecStart=${cfg.npmBin} run start
Restart=always
RestartSec=10
Environment=HOME=${cfg.home}
Environment=PATH=${cfg.pathEnv}
Environment=NODE_ENV=production
Environment=PORT=${cfg.port}
Environment=DASHBOARD_DB=${cfg.db}

[Install]
WantedBy=default.target
`;
}

export type ServicePlatform = "darwin" | "linux";

/** Where the generated unit file lives, per platform. */
export function dashboardServiceUnitPath(
  home: string,
  platform: ServicePlatform,
): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "LaunchAgents", `${DASHBOARD_SERVICE_LABEL}.plist`);
  }
  return path.join(
    home,
    ".config",
    "systemd",
    "user",
    `${DASHBOARD_SERVICE_LABEL}.service`,
  );
}

/** Generate the right unit content for the platform. */
export function buildDashboardServiceUnit(
  cfg: DashboardServiceConfig,
  platform: ServicePlatform,
): string {
  return platform === "darwin"
    ? buildLaunchdPlist(cfg)
    : buildSystemdUserUnit(cfg);
}

/**
 * True when a `launchctl bootstrap` failure is TRANSIENT — i.e. the previous
 * job hasn't finished draining yet — and the bootstrap should be retried once
 * the old job is gone. launchd reports this as the famously opaque
 * `Bootstrap failed: 5: Input/output error`. Pure so it is unit-testable.
 */
export function isTransientBootstrapError(
  stderr: string | null | undefined,
  status: number | null | undefined,
): boolean {
  const s = stderr ?? "";
  return (
    status === 5 ||
    /input\/output error/i.test(s) ||
    /bootstrap failed:\s*5\b/i.test(s)
  );
}
