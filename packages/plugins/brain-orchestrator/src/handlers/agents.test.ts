import { describe, expect, it, vi } from "vitest";
import type { AgentsStore, BrainAgentRecord } from "../store/agents.js";
import {
  buildUnidentifiedCallWarning,
  identifyAgent,
  SESSION_TOKEN_TTL_MS,
  UNIDENTIFIED_SOFT_WARN_DEADLINE,
} from "./agents.js";

function makeStubStore(initialCreated: boolean): {
  store: AgentsStore;
  upserts: Array<Parameters<AgentsStore["upsert"]>[0]>;
} {
  const upserts: Array<Parameters<AgentsStore["upsert"]>[0]> = [];
  const store: AgentsStore = {
    upsert(p) {
      upserts.push(p);
      return { created: initialCreated };
    },
    get(_id: string): BrainAgentRecord | undefined {
      return undefined;
    },
    listAll(): BrainAgentRecord[] {
      return [];
    },
  };
  return { store, upserts };
}

describe("identifyAgent", () => {
  it("upserts the agent and returns a session token, server time, created flag", () => {
    const { store, upserts } = makeStubStore(true);
    const result = identifyAgent(
      {
        agents: store,
        now: () => Date.parse("2026-05-17T12:00:00Z"),
        newToken: () => "tok-abc",
      },
      {
        agentId: "agent-x",
        runtime: "claude-code",
        version: "1.0",
        capabilities: ["wiki", "tasks"],
      },
    );
    expect(result.sessionToken).toBe("tok-abc");
    expect(result.serverTime).toBe("2026-05-17T12:00:00.000Z");
    expect(result.created).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toEqual({
      agentId: "agent-x",
      runtime: "claude-code",
      version: "1.0",
      capabilities: ["wiki", "tasks"],
      sessionToken: "tok-abc",
      tokenExpiresAt: Date.parse("2026-05-17T12:00:00Z") + SESSION_TOKEN_TTL_MS,
    });
  });

  it("returns created=false when the store reports an update", () => {
    const { store } = makeStubStore(false);
    const result = identifyAgent(
      { agents: store, now: () => 0, newToken: () => "t" },
      { agentId: "a", runtime: "r" },
    );
    expect(result.created).toBe(false);
  });

  it("defaults capabilities to [] when omitted", () => {
    const { store, upserts } = makeStubStore(true);
    identifyAgent(
      { agents: store, now: () => 0, newToken: () => "t" },
      { agentId: "a", runtime: "r" },
    );
    expect(upserts[0]!.capabilities).toEqual([]);
  });

  it("defaults the clock to Date.now when none is provided", () => {
    const { store, upserts } = makeStubStore(true);
    const before = Date.now();
    identifyAgent(
      { agents: store, newToken: () => "t" },
      { agentId: "a", runtime: "r" },
    );
    const expiresAt = upserts[0]!.tokenExpiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(before + SESSION_TOKEN_TTL_MS);
  });

  it("defaults the token generator to randomUUID when none is provided", () => {
    const { store } = makeStubStore(true);
    const r1 = identifyAgent(
      { agents: store, now: () => 0 },
      { agentId: "a", runtime: "r" },
    );
    const r2 = identifyAgent(
      { agents: store, now: () => 0 },
      { agentId: "a", runtime: "r" },
    );
    // UUIDs are universally distinct.
    expect(r1.sessionToken).not.toBe(r2.sessionToken);
    expect(r1.sessionToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("calls newToken (the injected factory) exactly once per call", () => {
    const { store } = makeStubStore(true);
    const newToken = vi.fn(() => "t");
    identifyAgent(
      { agents: store, now: () => 0, newToken },
      { agentId: "a", runtime: "r" },
    );
    expect(newToken).toHaveBeenCalledTimes(1);
  });
});

describe("buildUnidentifiedCallWarning", () => {
  it("returns undefined when an agentId is present", () => {
    expect(buildUnidentifiedCallWarning("agent-x")).toBeUndefined();
  });

  it("returns a soft-warn string when agentId is undefined", () => {
    const msg = buildUnidentifiedCallWarning(undefined);
    expect(msg).toContain("Un-identified call");
    expect(msg).toContain("agent_identify");
    expect(msg).toContain(UNIDENTIFIED_SOFT_WARN_DEADLINE);
  });
});
