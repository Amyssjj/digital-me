import path from "node:path";

/**
 * Which brain the adapters on this machine can talk to.
 *
 * brain-host is the hub: `digital-me setup` installs it before any adapter,
 * and its bearer token file (`<wiki-root>/.data/brain-host.token`) is the
 * durable marker of an install — the service unit and every caller
 * registration are derived from it. An openclaw gateway is the legacy hub:
 * still honoured when present, never required.
 *
 * Pure: every probe is injected so the policy is unit-tested without a home
 * directory.
 */

export type BrainEndpointKind = "brain-host" | "openclaw-gateway" | "none";

export interface BrainEndpoint {
  readonly kind: BrainEndpointKind;
  /** Human-readable evidence (token-file path or the openclaw marker). */
  readonly detail: string;
}

export interface BrainEndpointProbe {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fileExists: (p: string) => boolean;
  readonly which: (bin: string) => string | undefined;
}

/** `DIGITAL_ME_BRAIN_TOKEN_FILE` → `<wiki-root>/.data/brain-host.token`. */
export function brainHostTokenFileOf(probe: Pick<BrainEndpointProbe, "home" | "env">): string {
  const explicit = (probe.env.DIGITAL_ME_BRAIN_TOKEN_FILE ?? "").trim();
  if (explicit !== "") return explicit;
  const wikiRoot = probe.env.DIGITAL_ME_WIKI_ROOT ?? path.join(probe.home, "digital-me");
  return path.join(wikiRoot, ".data", "brain-host.token");
}

/** An openclaw install: the binary on PATH or its config/data home. */
export function isOpenclawInstalled(probe: Pick<BrainEndpointProbe, "home" | "env" | "fileExists" | "which">): boolean {
  return (
    probe.which("openclaw") !== undefined ||
    probe.fileExists(probe.env.OPENCLAW_HOME ?? path.join(probe.home, ".openclaw"))
  );
}

export function detectBrainEndpoint(probe: BrainEndpointProbe): BrainEndpoint {
  const tokenFile = brainHostTokenFileOf(probe);
  if (probe.fileExists(tokenFile)) {
    return { kind: "brain-host", detail: tokenFile };
  }
  if (isOpenclawInstalled(probe)) {
    return { kind: "openclaw-gateway", detail: "openclaw detected (binary on PATH or ~/.openclaw present)" };
  }
  return { kind: "none", detail: `no brain-host token at ${tokenFile}, no openclaw install` };
}

/**
 * The message printed when an install would wire adapters to nothing.
 * `context` names what was being installed ("the requested runtimes").
 */
export function noBrainEndpointMessage(context: string, tokenFile: string): string {
  return [
    ``,
    `[STOP] no brain endpoint on this machine — ${context} would have nothing to connect to.`,
    ``,
    `The hub is brain-host (retriever + orchestrator on http://127.0.0.1:18791/tools/invoke).`,
    `Install it first, then re-run:`,
    ``,
    `  digital-me install --runtime brain-host`,
    `  (or simply: digital-me setup — it installs brain-host before the adapters)`,
    ``,
    `Looked for its token file at ${tokenFile}.`,
    `A legacy openclaw gateway (openclaw on PATH or ~/.openclaw) is also accepted as the endpoint.`,
    ``,
  ].join("\n");
}

/**
 * Runtimes that need a brain endpoint to be useful. brain-host IS the
 * endpoint and the openclaw plugin materializes into openclaw's own tree, so
 * neither is gated.
 */
export function runtimesNeedingBrain(runtimes: readonly string[]): readonly string[] {
  return runtimes.filter((r) => r !== "brain-host" && r !== "openclaw");
}

/**
 * Install order: the hub first, so the adapters that follow in the same
 * invocation see its token file and bake the brain-host URL in.
 */
export function orderRuntimesHubFirst<T extends string>(runtimes: readonly T[]): T[] {
  return [...runtimes].sort((a, b) => Number(b === "brain-host") - Number(a === "brain-host"));
}
