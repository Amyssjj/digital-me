import { describe, expect, it } from "vitest";
import {
  DASHBOARD_DEFAULT_PORT,
  DASHBOARD_SERVICE_LABEL,
  buildDashboardServiceUnit,
  buildLaunchdPlist,
  buildSystemdUserUnit,
  dashboardServiceUnitPath,
  isTransientBootstrapError,
  resolveDashboardServiceConfig,
} from "./dashboard-service.js";

const NPM = "/opt/homebrew/bin/npm";

describe("resolveDashboardServiceConfig", () => {
  it("anchors workingDir at the STABLE install symlink, not a checkout/worktree", () => {
    const cfg = resolveDashboardServiceConfig("/home/u", {}, NPM);
    expect(cfg.workingDir).toBe("/home/u/.local/share/digital-me/dashboard");
    expect(cfg.workingDir).not.toContain("worktrees");
    expect(cfg.workingDir).not.toContain("digital-me-os/packages");
  });

  it("uses the canonical DB and default port", () => {
    const cfg = resolveDashboardServiceConfig("/home/u", {}, NPM);
    expect(cfg.db).toBe("/home/u/digital-me/.data/dashboard.db");
    expect(cfg.port).toBe(DASHBOARD_DEFAULT_PORT);
    expect(cfg.port).toBe(3458);
  });

  it("honors DASHBOARD_PORT / PORT overrides", () => {
    expect(resolveDashboardServiceConfig("/h", { DASHBOARD_PORT: "9000" }, NPM).port).toBe(9000);
    expect(resolveDashboardServiceConfig("/h", { PORT: "9100" }, NPM).port).toBe(9100);
    // invalid → falls back to default
    expect(resolveDashboardServiceConfig("/h", { PORT: "abc" }, NPM).port).toBe(3458);
  });
});

describe("buildLaunchdPlist (macOS)", () => {
  const cfg = resolveDashboardServiceConfig("/home/u", {}, NPM);
  const plist = buildLaunchdPlist(cfg);

  it("runs `npm run start` (single production server), KeepAlive + RunAtLoad", () => {
    expect(plist).toContain(`<string>${NPM}</string>`);
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
  });

  it("uses the stable symlink working dir + real DB + production env", () => {
    expect(plist).toContain(
      "<key>WorkingDirectory</key><string>/home/u/.local/share/digital-me/dashboard</string>",
    );
    expect(plist).toContain("/home/u/digital-me/.data/dashboard.db");
    expect(plist).toContain("<key>NODE_ENV</key><string>production</string>");
    expect(plist).toContain("<key>PORT</key><string>3458</string>");
    expect(plist).not.toContain("worktrees");
    expect(plist).not.toContain("/tmp/");
  });

  it("is well-formed (Label matches the canonical service label)", () => {
    expect(plist).toContain(`<string>${DASHBOARD_SERVICE_LABEL}</string>`);
    expect(plist.startsWith("<?xml")).toBe(true);
  });
});

describe("buildSystemdUserUnit (Linux)", () => {
  const cfg = resolveDashboardServiceConfig("/home/u", {}, NPM);
  const unit = buildSystemdUserUnit(cfg);

  it("restarts always, runs npm start from the stable symlink, real DB", () => {
    expect(unit).toContain("Restart=always");
    expect(unit).toContain(`ExecStart=${NPM} run start`);
    expect(unit).toContain("WorkingDirectory=/home/u/.local/share/digital-me/dashboard");
    expect(unit).toContain("Environment=DASHBOARD_DB=/home/u/digital-me/.data/dashboard.db");
    expect(unit).toContain("Environment=NODE_ENV=production");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("worktrees");
  });
});

describe("dashboardServiceUnitPath + buildDashboardServiceUnit", () => {
  it("macOS → LaunchAgents plist; Linux → systemd --user unit", () => {
    expect(dashboardServiceUnitPath("/home/u", "darwin")).toBe(
      "/home/u/Library/LaunchAgents/ai.digital-me.dashboard.plist",
    );
    expect(dashboardServiceUnitPath("/home/u", "linux")).toBe(
      "/home/u/.config/systemd/user/ai.digital-me.dashboard.service",
    );
  });

  it("dispatches to the right generator per platform", () => {
    const cfg = resolveDashboardServiceConfig("/home/u", {}, NPM);
    expect(buildDashboardServiceUnit(cfg, "darwin")).toContain("<?xml");
    expect(buildDashboardServiceUnit(cfg, "linux")).toContain("[Service]");
  });
});

describe("isTransientBootstrapError", () => {
  it("detects the opaque launchd 'Bootstrap failed: 5: Input/output error' (retry-worthy)", () => {
    expect(
      isTransientBootstrapError("Bootstrap failed: 5: Input/output error", 5),
    ).toBe(true);
    expect(isTransientBootstrapError("Input/output error", 1)).toBe(true);
    expect(isTransientBootstrapError("", 5)).toBe(true); // status alone
  });

  it("does NOT retry on real/permanent errors", () => {
    expect(isTransientBootstrapError("Bootstrap failed: 37: Operation already in progress", 37)).toBe(false);
    expect(isTransientBootstrapError("No such file or directory", 1)).toBe(false);
    expect(isTransientBootstrapError("", 0)).toBe(false);
    expect(isTransientBootstrapError(null, null)).toBe(false);
  });
});
