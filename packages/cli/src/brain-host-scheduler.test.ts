import { describe, expect, it } from "vitest";
import type { OpenclawGatewayEvidence } from "./brain-host-live.js";
import {
  DISABLE_GATEWAY_TICK_COMMAND,
  INSTALL_BRAIN_HOST_COMMAND,
  resolveBrainHostScheduler,
  viewOpenclawGateway,
  type GatewaySchedulerView,
} from "./brain-host-scheduler.js";

const NOT_INSTALLED: GatewaySchedulerView = { kind: "not-installed" };
const ABSENT: GatewaySchedulerView = { kind: "absent" };
const STOPPED: GatewaySchedulerView = { kind: "not-running", detail: "http://127.0.0.1:18789/health: fetch failed (ECONNREFUSED)" };
const DISABLED: GatewaySchedulerView = { kind: "disabled", detail: "/logs/gateway.log" };
const TICKING: GatewaySchedulerView = { kind: "ticking", detail: "/logs/gateway.log" };
const UNCONFIRMED: GatewaySchedulerView = { kind: "unconfirmed", detail: "no openclaw gateway log found" };

const TICKING_EVIDENCE: OpenclawGatewayEvidence = {
  state: "ticking",
  decision: { ticking: true, at: "2026-10-11T03:00:31.579-07:00", logPath: "/logs/gateway.log" },
  answering: true,
  liveness: "gateway answering at http://127.0.0.1:18789/health",
};

describe("viewOpenclawGateway", () => {
  it("ignores evidence when openclaw is not installed", () => {
    expect(viewOpenclawGateway(false, undefined)).toEqual({ kind: "not-installed" });
    expect(viewOpenclawGateway(false, { state: "absent" })).toEqual({ kind: "not-installed" });
  });

  it("folds each probe the way the doctor's single-ticker row does", () => {
    expect(viewOpenclawGateway(true, undefined)).toEqual({
      kind: "unconfirmed",
      detail: "the openclaw gateway was not inspected",
    });
    expect(viewOpenclawGateway(true, { state: "absent" })).toEqual({ kind: "absent" });
    expect(
      viewOpenclawGateway(true, { state: "not-running", url: "http://127.0.0.1:18789/health", reason: "refused" }),
    ).toEqual({ kind: "not-running", detail: "http://127.0.0.1:18789/health: refused" });
    expect(
      viewOpenclawGateway(true, {
        state: "disabled",
        decision: { ticking: false, logPath: "/logs/gateway.log" },
        answering: false,
        liveness: "gateway liveness unknown: timeout",
      }),
    ).toEqual({ kind: "disabled", detail: "/logs/gateway.log" });
    expect(viewOpenclawGateway(true, TICKING_EVIDENCE)).toEqual({ kind: "ticking", detail: "/logs/gateway.log" });
    expect(viewOpenclawGateway(true, { ...TICKING_EVIDENCE, answering: false, liveness: "gateway liveness unknown: timeout" })).toEqual({
      kind: "unconfirmed",
      detail: "gateway liveness unknown: timeout; last load looked like a tick (/logs/gateway.log)",
    });
    expect(viewOpenclawGateway(true, { state: "unknown", reason: "no openclaw gateway log found" })).toEqual({
      kind: "unconfirmed",
      detail: "no openclaw gateway log found",
    });
  });
});

describe("resolveBrainHostScheduler", () => {
  it("defaults ON when nothing else can tick, and when openclaw is installed but not ticking", () => {
    for (const gateway of [NOT_INSTALLED, ABSENT, STOPPED, DISABLED, UNCONFIRMED]) {
      const decision = resolveBrainHostScheduler({ gateway });
      expect(decision.scheduler).toBe("on");
      expect(decision.reason).toBe("default-on");
      expect(decision.message).toContain("brain-host is the default ticker, including when openclaw is installed");
    }
    expect(resolveBrainHostScheduler({ gateway: NOT_INSTALLED }).message).toContain("No openclaw install can tick");
    expect(resolveBrainHostScheduler({ gateway: ABSENT }).message).toContain("digital-me-brain plugin is not");
    expect(resolveBrainHostScheduler({ gateway: STOPPED }).message).toContain("not running (http://127.0.0.1:18789/health: fetch failed (ECONNREFUSED))");
    expect(resolveBrainHostScheduler({ gateway: DISABLED }).message).toContain("left its tick disabled (/logs/gateway.log)");
    expect(resolveBrainHostScheduler({ gateway: DISABLED }).message).toContain("stopping the gateway leaves this scheduler running");
    const unconfirmed = resolveBrainHostScheduler({ gateway: UNCONFIRMED });
    expect(unconfirmed.message).toContain("could not be confirmed (no openclaw gateway log found)");
    expect(unconfirmed.message).toContain("schedules.claim");
    expect(unconfirmed.message).toContain("DIGITAL_ME_BRAIN_SCHEDULER=off opts out");
  });

  it("treats a blank or unrecognized env value as unset, so the default still applies", () => {
    for (const explicitEnv of [undefined, "", "  ", "yes", "ONN"]) {
      expect(resolveBrainHostScheduler({ explicitEnv, gateway: DISABLED }).scheduler).toBe("on");
    }
    expect(resolveBrainHostScheduler({ explicitEnv: " ON ", gateway: DISABLED })).toMatchObject({
      scheduler: "on",
      reason: "explicit-on",
    });
    expect(resolveBrainHostScheduler({ explicitEnv: "Off", gateway: NOT_INSTALLED }).scheduler).toBe("off");
  });

  it("stays OFF while the gateway is confirmed ticking, even when both schedulers are present and the caller asked for on", () => {
    const deferred = resolveBrainHostScheduler({ gateway: TICKING });
    expect(deferred).toMatchObject({ scheduler: "off", reason: "gateway-ticking" });
    expect(deferred.message).toContain("left OFF");
    expect(deferred.message).toContain("/logs/gateway.log");
    expect(deferred.message).toContain("schedules.claim");
    expect(deferred.message).toContain(DISABLE_GATEWAY_TICK_COMMAND);
    expect(deferred.message).toContain(INSTALL_BRAIN_HOST_COMMAND);
    expect(deferred.message).not.toContain("explicit on was not applied");

    for (const asked of [
      { explicitEnv: "on" },
      { requested: "on" as const },
      { explicitEnv: "on", requested: "off" as const },
    ]) {
      const forced = resolveBrainHostScheduler({ ...asked, gateway: TICKING });
      expect(forced.scheduler).toBe("off");
      expect(forced.reason).toBe("gateway-ticking");
      expect(forced.message).toContain("explicit on was not applied");
    }
  });

  it("honours an explicit off (the opt-out), and a caller off, over the default and over a ticking gateway", () => {
    const envOff = resolveBrainHostScheduler({ explicitEnv: "off", requested: "on", gateway: DISABLED });
    expect(envOff).toMatchObject({ scheduler: "off", reason: "explicit-off" });
    expect(envOff.message).toContain("DIGITAL_ME_BRAIN_SCHEDULER=off");
    expect(envOff.message).toContain(INSTALL_BRAIN_HOST_COMMAND);

    const callerOff = resolveBrainHostScheduler({ requested: "off", gateway: TICKING });
    expect(callerOff).toMatchObject({ scheduler: "off", reason: "explicit-off" });
    expect(callerOff.message).toContain("the caller asked for the scheduler off");

    expect(resolveBrainHostScheduler({ explicitEnv: "  off  ", gateway: NOT_INSTALLED }).reason).toBe("explicit-off");
  });

  it("records an explicit on when the gateway is not ticking", () => {
    const fromEnv = resolveBrainHostScheduler({ explicitEnv: "on", gateway: NOT_INSTALLED });
    expect(fromEnv).toMatchObject({ scheduler: "on", reason: "explicit-on" });
    expect(fromEnv.message).toContain("DIGITAL_ME_BRAIN_SCHEDULER=on");

    const fromCaller = resolveBrainHostScheduler({ requested: "on", gateway: ABSENT });
    expect(fromCaller).toMatchObject({ scheduler: "on", reason: "explicit-on" });
    expect(fromCaller.message).toContain("caller asked for it");
    expect(fromCaller.message).toContain("plugin is not");
  });
});
