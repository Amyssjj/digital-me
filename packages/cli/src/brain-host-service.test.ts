import { describe, expect, it } from "vitest";
import {
  BRAIN_HOST_DEFAULT_PORT,
  BRAIN_HOST_SERVICE_LABEL,
  brainHostInvokeUrl,
  brainHostServiceEnv,
  brainHostServiceUnitPath,
  buildBrainHostLaunchdPlist,
  buildBrainHostServiceUnit,
  buildBrainHostSystemdUnit,
  resolveBrainCallerEnv,
  resolveBrainHostServiceConfig,
} from "./brain-host-service.js";

const HOME = "/home/t";

describe("resolveBrainCallerEnv", () => {
  const cfg = { host: "127.0.0.1", port: 18791, tokenFile: "/home/t/digital-me/.data/brain-host.token" };
  const noFile = () => undefined;

  it("prefers the installer's own DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN (trimmed)", () => {
    expect(
      resolveBrainCallerEnv(
        { DIGITAL_ME_BRAIN_URL: " http://h:1/tools/invoke ", DIGITAL_ME_BRAIN_TOKEN: " tok\n" },
        cfg,
        () => "file-tok",
      ),
    ).toEqual({ brainUrl: "http://h:1/tools/invoke", brainToken: "tok" });
  });

  it("URL without token is a hard error — never a fallback to the token file or the gateway", () => {
    expect(() =>
      resolveBrainCallerEnv({ DIGITAL_ME_BRAIN_URL: "http://h:1/tools/invoke" }, cfg, () => "file-tok"),
    ).toThrow(/DIGITAL_ME_BRAIN_TOKEN/);
    expect(() =>
      resolveBrainCallerEnv({ DIGITAL_ME_BRAIN_URL: "http://h:1/tools/invoke", DIGITAL_ME_BRAIN_TOKEN: "  " }, cfg, noFile),
    ).toThrow(/set both/);
  });

  it("falls back to the always-on brain-host service when its token file exists", () => {
    const reads: string[] = [];
    const out = resolveBrainCallerEnv({}, cfg, (file) => {
      reads.push(file);
      return "abc123\n";
    });
    expect(reads).toEqual([cfg.tokenFile]);
    expect(out).toEqual({ brainUrl: "http://127.0.0.1:18791/tools/invoke", brainToken: "abc123" });
    // A blank URL counts as unset.
    expect(resolveBrainCallerEnv({ DIGITAL_ME_BRAIN_URL: "  " }, cfg, () => "abc123")).toEqual({
      brainUrl: "http://127.0.0.1:18791/tools/invoke",
      brainToken: "abc123",
    });
  });

  it("returns undefined (caller stays on the openclaw gateway) when neither env nor token file is available", () => {
    expect(resolveBrainCallerEnv({}, cfg, noFile)).toBeUndefined();
    expect(resolveBrainCallerEnv({}, cfg, () => "")).toBeUndefined();
    expect(resolveBrainCallerEnv({}, cfg, () => " \n")).toBeUndefined();
  });
});

describe("resolveBrainHostServiceConfig", () => {
  it("anchors at the stable install symlink with safe defaults and the scheduler OFF", () => {
    const cfg = resolveBrainHostServiceConfig(HOME, {}, "/opt/homebrew/bin/node");
    expect(cfg.workingDir).toBe("/home/t/.local/share/digital-me/brain-host");
    expect(cfg.port).toBe(BRAIN_HOST_DEFAULT_PORT);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.wikiRoot).toBe("/home/t/digital-me");
    expect(cfg.tokenFile).toBe("/home/t/digital-me/.data/brain-host.token");
    expect(cfg.brainDb).toBe("/home/t/.openclaw/data/brain.db");
    expect(cfg.envFile).toBe("/home/t/.openclaw/.env");
    expect(cfg.scheduler).toBe("off");
    expect(cfg.pathEnv).toBe(
      "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/home/t/.local/bin:/home/t/Library/pnpm",
    );
    expect(cfg.label).toBe(BRAIN_HOST_SERVICE_LABEL);
  });

  it("builds PATH deterministically: node's dir first, ambient PATH ignored, only DIGITAL_ME_SERVICE_PATH overrides", () => {
    const ambient = { PATH: "/tmp/claude-plugins/x/bin:/tmp/claude-plugins/y/bin:/usr/bin" };
    const cfg = resolveBrainHostServiceConfig(HOME, ambient, "/nix/bin/node");
    expect(cfg.pathEnv.startsWith("/nix/bin:/opt/homebrew/bin:")).toBe(true);
    expect(cfg.pathEnv).not.toContain("claude-plugins");
    // a node inside a default dir is not listed twice
    expect(resolveBrainHostServiceConfig(HOME, ambient, "/usr/bin/node").pathEnv.split(":").filter((d) => d === "/usr/bin")).toHaveLength(1);
    expect(resolveBrainHostServiceConfig(HOME, { ...ambient, DIGITAL_ME_SERVICE_PATH: "/only/this" }, "/nix/bin/node").pathEnv).toBe("/only/this");
    expect(buildBrainHostLaunchdPlist(cfg)).toContain(`<key>PATH</key><string>${cfg.pathEnv}</string>`);
  });

  it("honours env overrides and the explicit scheduler option", () => {
    const env = {
      DIGITAL_ME_WIKI_ROOT: "/w",
      OPENCLAW_HOME: "/oc",
      DIGITAL_ME_BRAIN_PORT: "9000",
      DIGITAL_ME_BRAIN_HOST: "0.0.0.0",
      DIGITAL_ME_BRAIN_DB: "/db/brain.db",
      DIGITAL_ME_ENV_FILE: "/secrets/.env",
      DIGITAL_ME_BRAIN_SCHEDULER: "on",
      DIGITAL_ME_SERVICE_PATH: "/svc/bin:/bin",
    };
    const cfg = resolveBrainHostServiceConfig(HOME, env, "/usr/bin/node");
    expect(cfg).toMatchObject({ wikiRoot: "/w", port: 9000, host: "0.0.0.0", brainDb: "/db/brain.db", envFile: "/secrets/.env", scheduler: "on", pathEnv: "/svc/bin:/bin" });
    expect(cfg.tokenFile).toBe("/w/.data/brain-host.token");
    expect(resolveBrainHostServiceConfig(HOME, env, "/usr/bin/node", { scheduler: "off" }).scheduler).toBe("off");
    expect(resolveBrainHostServiceConfig(HOME, { DIGITAL_ME_BRAIN_PORT: "nope" }, "/usr/bin/node").port).toBe(BRAIN_HOST_DEFAULT_PORT);
  });
});

describe("unit generators", () => {
  const cfg = resolveBrainHostServiceConfig(HOME, { DIGITAL_ME_WIKI_ROOT: "/w&x" }, "/opt/homebrew/bin/node", { scheduler: "on" });

  it("launchd plist runs node with the env file, KeepAlive, no secrets, scheduler flag", () => {
    const plist = buildBrainHostLaunchdPlist(cfg);
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>--env-file-if-exists=/home/t/.openclaw/.env</string>");
    expect(plist).toContain("<string>/home/t/.local/share/digital-me/brain-host/bin/brain-host.mjs</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>DIGITAL_ME_BRAIN_SCHEDULER</key><string>on</string>");
    expect(plist).toContain("<key>DIGITAL_ME_BRAIN_TOKEN_FILE</key><string>/w&amp;x/.data/brain-host.token</string>");
    expect(plist).not.toContain("DIGITAL_ME_BRAIN_TOKEN</key>");
    expect(plist).toContain(`<key>Label</key><string>${BRAIN_HOST_SERVICE_LABEL}</string>`);
  });

  it("systemd unit restarts always and carries the same env", () => {
    const unit = buildBrainHostSystemdUnit(cfg);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("ExecStart=/opt/homebrew/bin/node --env-file-if-exists=/home/t/.openclaw/.env /home/t/.local/share/digital-me/brain-host/bin/brain-host.mjs serve");
    expect(unit).toContain("Environment=DIGITAL_ME_BRAIN_SCHEDULER=on");
    expect(brainHostServiceEnv(cfg).DIGITAL_ME_BRAIN_PORT).toBe("18791");
  });

  it("unit path and dispatcher per platform, invoke url", () => {
    expect(brainHostServiceUnitPath(HOME, "darwin")).toBe(`/home/t/Library/LaunchAgents/${BRAIN_HOST_SERVICE_LABEL}.plist`);
    expect(brainHostServiceUnitPath(HOME, "linux")).toBe(`/home/t/.config/systemd/user/${BRAIN_HOST_SERVICE_LABEL}.service`);
    expect(buildBrainHostServiceUnit(cfg, "darwin")).toContain("<?xml");
    expect(buildBrainHostServiceUnit(cfg, "linux")).toContain("[Service]");
    expect(brainHostInvokeUrl(cfg)).toBe("http://127.0.0.1:18791/tools/invoke");
  });
});
