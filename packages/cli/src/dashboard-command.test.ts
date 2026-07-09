import { describe, expect, it } from "vitest";

import {
  DASHBOARD_COMMAND_USAGE,
  browserOpenCommand,
  dashboardInstallDir,
  parseDashboardArgs,
  planDashboardLaunch,
  resolveDashboardPort,
} from "./dashboard-command.js";

describe("parseDashboardArgs", () => {
  it("parses an empty argv to defaults", () => {
    expect(parseDashboardArgs([])).toEqual({ port: undefined, noOpen: false, help: false });
  });

  it("parses --no-open and --help/-h", () => {
    expect(parseDashboardArgs(["--no-open"])).toMatchObject({ noOpen: true });
    expect(parseDashboardArgs(["--help"])).toMatchObject({ help: true });
    expect(parseDashboardArgs(["-h"])).toMatchObject({ help: true });
  });

  it("parses --port in both '--port 4000' and '--port=4000' forms", () => {
    expect(parseDashboardArgs(["--port", "4000"])).toMatchObject({ port: 4000 });
    expect(parseDashboardArgs(["--port=4000"])).toMatchObject({ port: 4000 });
  });

  it("rejects malformed or out-of-range ports as invalid", () => {
    expect(parseDashboardArgs(["--port", "80x"]).invalid).toBe("--port 80x");
    expect(parseDashboardArgs(["--port=0"]).invalid).toBe("--port 0");
    expect(parseDashboardArgs(["--port", "70000"]).invalid).toBe("--port 70000");
    expect(parseDashboardArgs(["--port="]).invalid).toBe("--port ");
  });

  it("treats a dangling --port (no value) as an unknown flag", () => {
    expect(parseDashboardArgs(["--port"]).invalid).toBe("--port");
  });

  it("flags the first unknown argument", () => {
    expect(parseDashboardArgs(["--bogus"]).invalid).toBe("--bogus");
    expect(parseDashboardArgs(["extra"]).invalid).toBe("extra");
  });

  it("treats a sparse argv slot as an (invalid) empty argument", () => {
    // process.argv can't be sparse, but the defensive ?? "" keeps a hole from
    // crashing the parser — it surfaces as an invalid empty arg instead.
    expect(parseDashboardArgs(new Array<string>(1)).invalid).toBe("");
  });

  it("combines flags", () => {
    expect(parseDashboardArgs(["--no-open", "--port", "3999"])).toEqual({
      port: 3999,
      noOpen: true,
      help: false,
    });
  });
});

describe("resolveDashboardPort", () => {
  it("prefers the --port flag over env", () => {
    expect(resolveDashboardPort("/home/u", { DASHBOARD_PORT: "4000" }, 5000)).toBe(5000);
  });

  it("falls back to $DASHBOARD_PORT / $PORT, then the default", () => {
    expect(resolveDashboardPort("/home/u", { DASHBOARD_PORT: "4000" })).toBe(4000);
    expect(resolveDashboardPort("/home/u", { PORT: "4100" })).toBe(4100);
    expect(resolveDashboardPort("/home/u", {})).toBe(3458);
  });
});

describe("dashboardInstallDir", () => {
  it("points at the stable install symlink", () => {
    expect(dashboardInstallDir("/home/u")).toBe(
      "/home/u/.local/share/digital-me/dashboard",
    );
  });
});

describe("planDashboardLaunch", () => {
  it("opens directly when already serving", () => {
    expect(
      planDashboardLaunch({ serving: true, installDirExists: true, port: 3458 }),
    ).toEqual({ kind: "open", url: "http://localhost:3458" });
  });

  it("opens even when the install dir is gone but something serves the port", () => {
    expect(
      planDashboardLaunch({ serving: true, installDirExists: false, port: 3457 }),
    ).toEqual({ kind: "open", url: "http://localhost:3457" });
  });

  it("starts the service when installed but not serving", () => {
    expect(
      planDashboardLaunch({ serving: false, installDirExists: true, port: 3458 }),
    ).toEqual({ kind: "start-service", url: "http://localhost:3458" });
  });

  it("reports not-installed with install guidance otherwise", () => {
    const plan = planDashboardLaunch({ serving: false, installDirExists: false, port: 3458 });
    expect(plan.kind).toBe("not-installed");
    if (plan.kind === "not-installed") {
      expect(plan.hint).toContain("digital-me install --runtime dashboard");
    }
  });
});

describe("browserOpenCommand", () => {
  const url = "http://localhost:3458";

  it("uses `open` on macOS", () => {
    expect(browserOpenCommand("darwin", url)).toEqual({ cmd: "open", args: [url] });
  });

  it("uses `cmd /c start` on Windows with the title slot filled", () => {
    expect(browserOpenCommand("win32", url)).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", url],
    });
  });

  it("uses `xdg-open` on Linux", () => {
    expect(browserOpenCommand("linux", url)).toEqual({ cmd: "xdg-open", args: [url] });
  });

  it("returns null on platforms without a standard opener", () => {
    expect(browserOpenCommand("freebsd", url)).toBeNull();
  });
});

describe("DASHBOARD_COMMAND_USAGE", () => {
  it("documents the flags and the default port", () => {
    expect(DASHBOARD_COMMAND_USAGE).toContain("--port");
    expect(DASHBOARD_COMMAND_USAGE).toContain("--no-open");
    expect(DASHBOARD_COMMAND_USAGE).toContain("3458");
  });
});
