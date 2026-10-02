import { describe, expect, it } from "vitest";
import {
  CODEX_HOOK_EVENT_LABELS,
  codexHookStateKey,
  codexHookTrustHash,
  codexHookTrustStatus,
  collectCodexHookTrust,
  mergeCodexHookTrust,
  readCodexHookTrust,
  type CodexHookTrustEntry,
} from "./hook-trust.js";
import { buildCodexHooksManifest, codexManagedHookCommands } from "./installer.js";

const DIR = "/home/u/.codex/hooks";
const HOOKS_JSON = "/home/u/.codex/hooks.json";

// Golden vectors: the `currentHash` the real Codex (codex-cli 0.159.2,
// app-server `hooks/list`) reported for these exact hooks.json handlers.
const GOLDEN = {
  userPromptSubmit: "sha256:2f438f36ac3e07e2c4aee4759f17fb1b6c6c376891bbcbc4292fecdfdc539bad",
  stop: "sha256:7801d8d7db9d1dd51918f9f7912e5fe69e49234dfc1d0603bee2a7528dba1385",
  preToolUse: "sha256:e0fa9b3b20c63ab0e18855fbf0a9f7378ba9fccedc214c14724ce5449c7df8f9",
  // matcher "x", timeout 9 (clamped to 3), async true
  sessionEnd: "sha256:ada5a8f604824a4bde4e19b8b6fc9e16a82cc5b02c66b7f13edffe32bfd9b964",
};

describe("codexHookTrustHash", () => {
  it("matches the hash Codex computes for each kind of handler", () => {
    expect(
      codexHookTrustHash("UserPromptSubmit", undefined, {
        type: "command",
        command: `${DIR}/dm_memory_search_inject.sh --runtime codex`,
        timeout: 12,
        statusMessage: "Digital Me: searching brain…",
      }),
    ).toBe(GOLDEN.userPromptSubmit);
    expect(
      codexHookTrustHash("Stop", undefined, {
        type: "command",
        command: `${DIR}/dm_handoff_reminder.sh --runtime codex`,
        timeout: 5,
      }),
    ).toBe(GOLDEN.stop);
    expect(
      codexHookTrustHash("PreToolUse", "*", {
        type: "command",
        command: `${DIR}/brain_route_inject.sh --runtime codex`,
        timeout: 3,
      }),
    ).toBe(GOLDEN.preToolUse);
    expect(
      codexHookTrustHash("SessionEnd", "x", { type: "command", command: "/home/u/end.sh", timeout: 9, async: true }),
    ).toBe(GOLDEN.sessionEnd);
  });

  it("ignores the matcher on events Codex runs unconditionally", () => {
    const h = { type: "command", command: `${DIR}/dm_handoff_reminder.sh --runtime codex`, timeout: 5 };
    expect(codexHookTrustHash("Stop", "anything", h)).toBe(GOLDEN.stop);
  });

  it("normalizes timeouts like Codex: 600 s default, clamped 1-3 s on SessionEnd/Interrupt", () => {
    const cmd = { type: "command", command: "/x.sh" };
    expect(codexHookTrustHash("Stop", undefined, cmd)).toBe(codexHookTrustHash("Stop", undefined, { ...cmd, timeout: 600 }));
    expect(codexHookTrustHash("Stop", undefined, { ...cmd, timeout: 0 })).toBe(
      codexHookTrustHash("Stop", undefined, { ...cmd, timeout: 1 }),
    );
    expect(codexHookTrustHash("Interrupt", undefined, cmd)).toBe(
      codexHookTrustHash("Interrupt", undefined, { ...cmd, timeout: 1 }),
    );
    expect(codexHookTrustHash("SessionEnd", undefined, { ...cmd, timeout: 0 })).toBe(
      codexHookTrustHash("SessionEnd", undefined, { ...cmd, timeout: 1 }),
    );
    // a non-integer timeout is no timeout at all
    expect(codexHookTrustHash("Stop", undefined, { ...cmd, timeout: 2.5 })).toBe(codexHookTrustHash("Stop", undefined, cmd));
  });

  it("hashes additionalContextLimit only where Codex keeps it and it is not the default", () => {
    const cmd = { type: "command", command: "/x.sh", timeout: 5 };
    const base = codexHookTrustHash("UserPromptSubmit", undefined, cmd);
    expect(codexHookTrustHash("UserPromptSubmit", undefined, { ...cmd, additionalContextLimit: 2500 })).toBe(base);
    expect(codexHookTrustHash("UserPromptSubmit", undefined, { ...cmd, additionalContextLimit: 0 })).not.toBe(base);
    expect(codexHookTrustHash("Stop", undefined, { ...cmd, additionalContextLimit: 0 })).toBe(
      codexHookTrustHash("Stop", undefined, cmd),
    );
  });

  it("returns undefined for what Codex would not load as a command hook", () => {
    expect(codexHookTrustHash("NoSuchEvent", undefined, { type: "command", command: "/x.sh" })).toBeUndefined();
    expect(codexHookTrustHash("Stop", undefined, { type: "prompt", command: "/x.sh" })).toBeUndefined();
    expect(codexHookTrustHash("Stop", undefined, { type: "command", command: "   " })).toBeUndefined();
    expect(codexHookTrustHash("Stop", undefined, { type: "command" })).toBeUndefined();
  });

  it("covers every Codex event label", () => {
    expect(Object.values(CODEX_HOOK_EVENT_LABELS)).toContain("user_prompt_submit");
    expect(Object.keys(CODEX_HOOK_EVENT_LABELS)).toHaveLength(12);
  });
});

describe("collectCodexHookTrust", () => {
  it("keys our handlers by their actual position and skips everyone else's", () => {
    const hooksJson = {
      other: true,
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "/user/own.sh" }] },
          { hooks: [{ type: "command", command: `${DIR}/dm_handoff_reminder.sh --runtime codex`, timeout: 5 }] },
        ],
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: `${DIR}/brain_route_inject.sh --runtime codex`, timeout: 3 }] },
        ],
        UserPromptSubmit: "not-an-array",
        Unknown: [{ hooks: [{ type: "command", command: `${DIR}/dm_handoff_reminder.sh --runtime codex` }] }],
      },
    };
    const ours = codexManagedHookCommands(DIR);
    const entries = collectCodexHookTrust(hooksJson, HOOKS_JSON, (c) => ours.has(c));
    expect(entries).toEqual([
      { key: `${HOOKS_JSON}:stop:1:0`, hash: GOLDEN.stop, event: "Stop", command: `${DIR}/dm_handoff_reminder.sh --runtime codex` },
      { key: `${HOOKS_JSON}:pre_tool_use:0:0`, hash: GOLDEN.preToolUse, event: "PreToolUse", command: `${DIR}/brain_route_inject.sh --runtime codex` },
    ]);
  });

  it("covers the whole installer manifest and tolerates malformed shapes", () => {
    const ours = codexManagedHookCommands(DIR);
    const all = collectCodexHookTrust({ hooks: buildCodexHooksManifest(DIR) }, HOOKS_JSON, (c) => ours.has(c));
    expect(all.map((e) => e.key.slice(HOOKS_JSON.length + 1))).toEqual([
      "user_prompt_submit:0:0",
      "stop:0:0",
      "stop:0:1",
      "stop:0:2",
      "pre_tool_use:0:0",
    ]);
    expect(collectCodexHookTrust({}, HOOKS_JSON, () => true)).toEqual([]);
    expect(collectCodexHookTrust({ hooks: [] }, HOOKS_JSON, () => true)).toEqual([]);
    expect(
      collectCodexHookTrust(
        { hooks: { Stop: [null, { hooks: "x" }, { hooks: [null, { type: "prompt", command: "/p.sh" }] }] } },
        HOOKS_JSON,
        () => true,
      ),
    ).toEqual([]);
  });
});

describe("readCodexHookTrust / codexHookTrustStatus", () => {
  const entry: CodexHookTrustEntry = { key: `${HOOKS_JSON}:stop:0:0`, hash: GOLDEN.stop, event: "Stop", command: "/x" };

  it("reads trusted_hash from [hooks.state.\"<key>\"] tables, in any quoting", () => {
    const toml = [
      "model = \"x\"",
      "[hooks.state]",
      "",
      `[hooks.state."${HOOKS_JSON}:stop:0:0"]`,
      `trusted_hash = "${GOLDEN.stop}"`,
      `[ hooks . state . '${HOOKS_JSON}:stop:0:1' ]  # literal key`,
      "enabled = false",
      `trusted_hash = 'sha256:literal'`,
      `[hooks.state."C:\\\\Users\\\\u\\\\.codex\\\\hooks.json:stop:0:0"]`,
      `trusted_hash = "sha256:windows"`,
      `[hooks.state."esc\\"q\\u00e9\\U0001F600\\t\\n\\x"]`,
      `trusted_hash = "sha256:escaped"`,
      "[features]",
      `trusted_hash = "not-in-a-state-table"`,
    ].join("\n");
    const trust = readCodexHookTrust(toml);
    expect(trust.get(`${HOOKS_JSON}:stop:0:0`)).toBe(GOLDEN.stop);
    expect(trust.get(`${HOOKS_JSON}:stop:0:1`)).toBe("sha256:literal");
    expect(trust.get("C:\\Users\\u\\.codex\\hooks.json:stop:0:0")).toBe("sha256:windows");
    expect(trust.get("esc\"qé😀\t\nx")).toBe("sha256:escaped");
    expect(trust.size).toBe(4);
  });

  it("classifies trusted / modified / untrusted", () => {
    expect(codexHookTrustStatus(entry, new Map([[entry.key, GOLDEN.stop]]))).toBe("trusted");
    expect(codexHookTrustStatus(entry, new Map([[entry.key, "sha256:old"]]))).toBe("modified");
    expect(codexHookTrustStatus(entry, new Map())).toBe("untrusted");
  });
});

describe("mergeCodexHookTrust", () => {
  const e = (h: number, hash: string): CodexHookTrustEntry => ({
    key: codexHookStateKey(HOOKS_JSON, "stop", 0, h),
    hash,
    event: "Stop",
    command: `/x${h}`,
  });

  it("rewrites a stale hash in place, keeps sibling keys, and appends missing tables", () => {
    const before = [
      "[hooks.state]",
      "",
      `[hooks.state."${HOOKS_JSON}:stop:0:0"]`,
      "enabled = false",
      `trusted_hash = "sha256:stale"`,
      "",
      `[hooks.state."${HOOKS_JSON}:stop:0:1"]`,
      "enabled = true",
      "",
      "[shell_environment_policy.set]",
      `A = "1"`,
      "",
    ].join("\n");
    const after = mergeCodexHookTrust(before, [e(0, "sha256:new0"), e(1, "sha256:new1"), e(2, "sha256:new2")]);
    expect(after).toBe(
      [
        "[hooks.state]",
        "",
        `[hooks.state."${HOOKS_JSON}:stop:0:0"]`,
        "enabled = false",
        `trusted_hash = "sha256:new0"`,
        "",
        `[hooks.state."${HOOKS_JSON}:stop:0:1"]`,
        `trusted_hash = "sha256:new1"`,
        "enabled = true",
        "",
        "[shell_environment_policy.set]",
        `A = "1"`,
        "",
        `[hooks.state."${HOOKS_JSON}:stop:0:2"]`,
        `trusted_hash = "sha256:new2"`,
        "",
      ].join("\n"),
    );
    // idempotent, and what it wrote reads back
    expect(mergeCodexHookTrust(after, [e(0, "sha256:new0"), e(1, "sha256:new1"), e(2, "sha256:new2")])).toBe(after);
    expect([...readCodexHookTrust(after).values()]).toEqual(["sha256:new0", "sha256:new1", "sha256:new2"]);
  });

  it("writes into an empty file without a leading blank line and leaves a file alone when nothing changes", () => {
    expect(mergeCodexHookTrust("", [e(0, "sha256:a"), e(1, "sha256:b")])).toBe(
      `[hooks.state."${HOOKS_JSON}:stop:0:0"]\ntrusted_hash = "sha256:a"\n\n` +
        `[hooks.state."${HOOKS_JSON}:stop:0:1"]\ntrusted_hash = "sha256:b"\n`,
    );
    expect(mergeCodexHookTrust("model = \"x\"\n", [])).toBe("model = \"x\"\n");
  });

  it("escapes keys that need it so they read back unchanged", () => {
    const odd: CodexHookTrustEntry = { key: 'C:\\u\\"q"\u0001\u007f:stop:0:0', hash: "sha256:o", event: "Stop", command: "/o" };
    const out = mergeCodexHookTrust("", [odd]);
    expect(out).toContain('[hooks.state."C:\\\\u\\\\\\"q\\"\\u0001\\u007f:stop:0:0"]');
    expect(readCodexHookTrust(out).get(odd.key)).toBe("sha256:o");
  });

  it("refuses to define a key a second time when it is spelled outside a table header", () => {
    const dotted = `[hooks.state]\n"${HOOKS_JSON}:stop:0:0".trusted_hash = "sha256:x"\n`;
    expect(() => mergeCodexHookTrust(dotted, [e(0, "sha256:y")])).toThrow(/outside a \[hooks.state/);
    const literal = `[hooks]\nstate = { '${HOOKS_JSON}:stop:0:0' = { trusted_hash = "sha256:x" } }\n`;
    expect(() => mergeCodexHookTrust(literal, [e(0, "sha256:y")])).toThrow(/outside a \[hooks.state/);
  });
});
