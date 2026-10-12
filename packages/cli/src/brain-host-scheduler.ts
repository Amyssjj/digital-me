import type { OpenclawGatewayEvidence } from "./brain-host-live.js";

/**
 * Which scheduler `digital-me install --runtime brain-host` (and
 * `digital-me service brain-host install`) writes into the service unit.
 *
 * brain-host is the default ticker, including on a machine where openclaw is
 * installed, so stopping the gateway never leaves zero schedulers. The one
 * exception is a gateway that is up and whose digital-me-brain plugin is
 * confirmed ticking: the unit stays off, because two timers must not run.
 * `DIGITAL_ME_BRAIN_SCHEDULER=off` is the opt-out for a machine that still
 * wants the gateway to own the tick.
 *
 * There is no process-level lock. `schedules.claim` (brain-orchestrator) is a
 * compare-and-swap on `schedules.next_run_at`, so two ticks cannot both
 * instantiate the same due schedule. It does not cover the rest of a tick
 * (stall sweep, orphan dispatch, retention), and `digital-me doctor` FAILs
 * when both timers are on. Install therefore refuses to start the second
 * timer when the gateway is confirmed ticking, and treats the claim as the
 * backstop only when the gateway's decision could not be read.
 */

/** Re-run this (with the opt-out unset) to make brain-host the ticker. */
export const INSTALL_BRAIN_HOST_COMMAND = "digital-me install --runtime brain-host";

/** Stop the gateway plugin ticking. Takes effect on the gateway's next load. */
export const DISABLE_GATEWAY_TICK_COMMAND =
  "set plugins.entries.digital-me-brain.config.scheduler=false in openclaw.json (or DIGITAL_ME_OPENCLAW_SCHEDULER=off in the gateway's environment) and restart the gateway";

/**
 * What install knows about the openclaw gateway's tick, folded from
 * {@link OpenclawGatewayEvidence} the same way the doctor's single-ticker
 * row does: a "ticking" decision from a gateway that did not answer just now
 * is unconfirmed, not ticking.
 */
export type GatewaySchedulerView =
  | { readonly kind: "not-installed" }
  | { readonly kind: "absent" }
  | { readonly kind: "not-running"; readonly detail: string }
  | { readonly kind: "disabled"; readonly detail: string }
  | { readonly kind: "ticking"; readonly detail: string }
  | { readonly kind: "unconfirmed"; readonly detail: string };

/** Map a gateway probe to the view the scheduler decision reads. */
export function viewOpenclawGateway(
  installed: boolean,
  evidence: OpenclawGatewayEvidence | undefined,
): GatewaySchedulerView {
  if (!installed) return { kind: "not-installed" };
  if (evidence === undefined) return { kind: "unconfirmed", detail: "the openclaw gateway was not inspected" };
  switch (evidence.state) {
    case "absent":
      return { kind: "absent" };
    case "not-running":
      return { kind: "not-running", detail: `${evidence.url}: ${evidence.reason}` };
    case "disabled":
      return { kind: "disabled", detail: evidence.decision.logPath };
    case "ticking":
      return evidence.answering
        ? { kind: "ticking", detail: evidence.decision.logPath }
        : {
            kind: "unconfirmed",
            detail: `${evidence.liveness}; last load looked like a tick (${evidence.decision.logPath})`,
          };
    case "unknown":
      return { kind: "unconfirmed", detail: evidence.reason };
  }
}

export interface BrainHostSchedulerInput {
  /** Raw `DIGITAL_ME_BRAIN_SCHEDULER`. Anything other than on/off is ignored. */
  readonly explicitEnv?: string;
  /** A caller override (unset on the install and service commands). */
  readonly requested?: "on" | "off";
  readonly gateway: GatewaySchedulerView;
}

export interface BrainHostSchedulerDecision {
  readonly scheduler: "on" | "off";
  readonly reason: "explicit-off" | "explicit-on" | "default-on" | "gateway-ticking";
  /** One line for the install / service log. */
  readonly message: string;
}

function normalizeFlag(raw: string | undefined): "on" | "off" | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "on" || v === "off" ? v : undefined;
}

function onLead(explicit: "on" | "off" | undefined, requested: "on" | "off" | undefined): string {
  if (explicit === "on") return "scheduler tick ON (DIGITAL_ME_BRAIN_SCHEDULER=on).";
  if (requested === "on") return "scheduler tick ON (caller asked for it).";
  return "scheduler tick ON (brain-host is the default ticker, including when openclaw is installed).";
}

function onDetail(gateway: Exclude<GatewaySchedulerView, { readonly kind: "ticking" }>): string {
  switch (gateway.kind) {
    case "not-installed":
      return "No openclaw install can tick brain.db.";
    case "absent":
      return "Openclaw is installed but its digital-me-brain plugin is not, so the gateway cannot tick.";
    case "not-running":
      return `The openclaw gateway is not running (${gateway.detail}).`;
    case "disabled":
      return `The gateway's plugin left its tick disabled (${gateway.detail}), so stopping the gateway leaves this scheduler running.`;
    case "unconfirmed":
      return (
        `The gateway's tick could not be confirmed (${gateway.detail}). ` +
        `If it is actually ticking, schedules.claim still lets only one tick instantiate a due schedule, ` +
        `and digital-me doctor will warn until the decision is readable. DIGITAL_ME_BRAIN_SCHEDULER=off opts out.`
      );
  }
}

/**
 * Pure. Explicit `off` always wins (the opt-out). A confirmed ticking gateway
 * keeps brain-host off even when the caller asked for on. Every other case
 * turns brain-host on.
 */
export function resolveBrainHostScheduler(input: BrainHostSchedulerInput): BrainHostSchedulerDecision {
  const explicit = normalizeFlag(input.explicitEnv);
  const choice = explicit ?? input.requested;
  if (choice === "off") {
    const who = explicit === "off" ? "DIGITAL_ME_BRAIN_SCHEDULER=off" : "the caller asked for the scheduler off";
    return {
      scheduler: "off",
      reason: "explicit-off",
      message:
        `scheduler tick OFF (${who}). The openclaw gateway keeps the tick if it has one; ` +
        `with the gateway stopped, nothing scheduled runs until you re-run ${INSTALL_BRAIN_HOST_COMMAND} without the opt-out.`,
    };
  }
  if (input.gateway.kind === "ticking") {
    const ignored =
      choice === "on" ? " An explicit on was not applied, because it would start a second ticker." : "";
    return {
      scheduler: "off",
      reason: "gateway-ticking",
      message:
        `scheduler tick left OFF — the openclaw gateway is up and its digital-me-brain plugin is ticking (${input.gateway.detail}). ` +
        `Two schedulers must not run at once. schedules.claim (compare-and-swap on next_run_at) stops a double instantiation of the same schedule, ` +
        `but the rest of a tick is not locked and digital-me doctor FAILs when both timers run.${ignored} ` +
        `Hand the tick to brain-host before you stop the gateway: ${DISABLE_GATEWAY_TICK_COMMAND}, then re-run ${INSTALL_BRAIN_HOST_COMMAND}.`,
    };
  }
  return {
    scheduler: "on",
    reason: choice === "on" ? "explicit-on" : "default-on",
    message: `${onLead(explicit, input.requested)} ${onDetail(input.gateway)}`,
  };
}
