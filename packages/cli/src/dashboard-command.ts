import path from "node:path";

import {
  DASHBOARD_DEFAULT_PORT,
  resolveDashboardServiceConfig,
} from "./dashboard-service.js";

/**
 * `digital-me dashboard` — one command to get the OA dashboard in front of
 * the user. The imperative wiring (probe the port, start the service, spawn
 * the browser) lives in bin/digital-me.ts; everything decision-shaped lives
 * here so it is unit-testable:
 *
 *   parseDashboardArgs   flags → typed options (or an invalid-arg marker)
 *   resolveDashboardPort --port flag > $DASHBOARD_PORT/$PORT > default
 *   planDashboardLaunch  observed state → the one action to take
 *   browserOpenCommand   platform → the `open`/`xdg-open` argv (or null)
 */

export interface DashboardCommandArgs {
  /** Validated --port value; undefined = fall back to env/default. */
  readonly port?: number;
  /** --no-open: print the URL instead of spawning a browser. */
  readonly noOpen: boolean;
  readonly help: boolean;
  /** First flag we didn't recognize (or a malformed --port value) — the
   *  caller prints usage and exits 2. Undefined when the argv is clean. */
  readonly invalid?: string;
}

/** Parse `digital-me dashboard [--port <n>] [--no-open]`. Pure. */
export function parseDashboardArgs(argv: readonly string[]): DashboardCommandArgs {
  let port: number | undefined;
  let noOpen = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--no-open") {
      noOpen = true;
      continue;
    }
    let rawPort: string | undefined;
    if (arg.startsWith("--port=")) {
      rawPort = arg.slice("--port=".length);
    } else if (arg === "--port" && argv[i + 1] !== undefined) {
      rawPort = argv[i + 1] as string;
      i++;
    }
    if (rawPort !== undefined) {
      const parsed = Number.parseInt(rawPort, 10);
      // Reject partial parses like "80x" (parseInt would accept them) and
      // out-of-range ports so a typo fails loudly instead of probing :NaN.
      if (!/^\d+$/.test(rawPort) || parsed < 1 || parsed > 65535) {
        return { noOpen, help, invalid: `--port ${rawPort}` };
      }
      port = parsed;
      continue;
    }
    return { noOpen, help, invalid: arg };
  }
  return { port, noOpen, help };
}

/**
 * Effective dashboard port: explicit --port wins, then the service env
 * contract ($DASHBOARD_PORT / $PORT via resolveDashboardServiceConfig),
 * then the 3458 default.
 */
export function resolveDashboardPort(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  flagPort?: number,
): number {
  if (flagPort !== undefined) return flagPort;
  // npmBin is irrelevant to port resolution — pass a placeholder.
  return resolveDashboardServiceConfig(home, env, "npm").port;
}

/** Stable install symlink the always-on service runs from (see
 *  dashboard-service.ts INVARIANT). Its existence == "dashboard installed". */
export function dashboardInstallDir(home: string): string {
  return path.join(home, ".local", "share", "digital-me", "dashboard");
}

export type LaunchPlan =
  /** Already serving — just open the browser. */
  | { readonly kind: "open"; readonly url: string }
  /** Installed but not serving — start the always-on service, then open. */
  | { readonly kind: "start-service"; readonly url: string }
  /** Never installed — nothing to launch; tell the user how to get it. */
  | { readonly kind: "not-installed"; readonly hint: string };

/** Decide the one action `digital-me dashboard` takes. Pure. */
export function planDashboardLaunch(opts: {
  readonly serving: boolean;
  readonly installDirExists: boolean;
  readonly port: number;
}): LaunchPlan {
  const url = `http://localhost:${opts.port}`;
  if (opts.serving) return { kind: "open", url };
  if (opts.installDirExists) return { kind: "start-service", url };
  return {
    kind: "not-installed",
    hint:
      "dashboard: not installed yet. Run 'digital-me install --runtime dashboard' " +
      "first (or 'pnpm dashboard' from a source checkout for a dev server).",
  };
}

/** The platform command that opens `url` in the default browser, or null on
 *  platforms without a standard opener (caller prints the URL instead). */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { readonly cmd: string; readonly args: readonly string[] } | null {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  // `start` is a cmd.exe builtin; the empty "" is the window title slot so
  // the URL isn't consumed as the title.
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  if (platform === "linux") return { cmd: "xdg-open", args: [url] };
  return null;
}

export const DASHBOARD_COMMAND_USAGE = [
  "Usage: digital-me dashboard [--port <n>] [--no-open]",
  "",
  "Launch the OA dashboard: opens it in your browser if it's already",
  `serving (default port ${DASHBOARD_DEFAULT_PORT}); otherwise starts the always-on service`,
  "first. --no-open prints the URL instead of opening a browser.",
].join("\n");
