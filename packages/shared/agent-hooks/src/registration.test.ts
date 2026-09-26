import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_HOOKS_DIR,
  AGENT_HOOKS_ROOT,
  CLAUDE_CODE_ONLY_HOOK_FILES,
  HOOK_RUNTIMES,
  SHARED_HOOK_FILES,
  hookCommand,
  legacyHookCommand,
  mergeHookManifest,
  runtimeArg,
} from "./hooks.js";

describe("hook source layout", () => {
  it("AGENT_HOOKS_DIR is this package's hooks/ and holds every file the runtimes install", () => {
    expect(AGENT_HOOKS_DIR).toBe(path.join(AGENT_HOOKS_ROOT, "hooks"));
    for (const name of [...SHARED_HOOK_FILES, ...CLAUDE_CODE_ONLY_HOOK_FILES]) {
      expect(existsSync(path.join(AGENT_HOOKS_DIR, name)), name).toBe(true);
    }
  });

  it("every hook is executable; the sourced lib is not a hook", () => {
    for (const name of SHARED_HOOK_FILES) {
      const mode = statSync(path.join(AGENT_HOOKS_DIR, name)).mode;
      if (name === "dm_hook_lib.sh") continue;
      expect(mode & 0o111, name).not.toBe(0);
    }
  });

  it("every runtime id is known to the bash lib and the M1 emitter", () => {
    const lib = readFileSync(path.join(AGENT_HOOKS_DIR, "dm_hook_lib.sh"), "utf-8");
    const emit = readFileSync(path.join(AGENT_HOOKS_DIR, "dm_m1_emit.py"), "utf-8");
    for (const runtime of HOOK_RUNTIMES) {
      expect(lib).toContain(`    ${runtime})`);
      expect(emit).toContain(`    "${runtime}": {`);
    }
  });

  it("falls back to assets/agent-hooks when hooks/ is absent (published CLI bundle layout)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: () => false }));
    try {
      const fresh = await import("./hooks.js");
      expect(fresh.AGENT_HOOKS_ROOT.endsWith(path.join("assets", "agent-hooks"))).toBe(true);
      expect(fresh.AGENT_HOOKS_DIR).toBe(path.join(fresh.AGENT_HOOKS_ROOT, "hooks"));
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

describe("hookCommand / legacyHookCommand", () => {
  it("bakes the runtime into the command line and strips it back off", () => {
    expect(runtimeArg("codex")).toBe("--runtime codex");
    const cmd = hookCommand("/h/.codex/hooks/dm_session_extract.sh", "codex");
    expect(cmd).toBe("/h/.codex/hooks/dm_session_extract.sh --runtime codex");
    expect(legacyHookCommand(cmd)).toBe("/h/.codex/hooks/dm_session_extract.sh");
    expect(legacyHookCommand("$HOME/.claude/hooks/x.sh")).toBe("$HOME/.claude/hooks/x.sh");
  });
});

type Handler = { type: "command"; command: string; timeout?: number };
type Stanza = { matcher?: string; hooks: Handler[] };

describe("mergeHookManifest", () => {
  const ours = (runtime: "claude-code" | "codex"): Record<string, Stanza[]> => ({
    UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand("/d/inject.sh", runtime), timeout: 12 }] }],
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("/d/route.sh", runtime) }] }],
  });

  it("adds our stanzas (keeping stanza keys such as matcher) and leaves other events alone", () => {
    const merged = mergeHookManifest<Handler, Stanza>(
      { SessionStart: [{ hooks: [{ type: "command", command: "mine.sh" }] }] },
      ours("codex"),
    );
    expect(merged).toEqual({
      SessionStart: [{ hooks: [{ type: "command", command: "mine.sh" }] }],
      ...ours("codex"),
    });
  });

  it("upgrades a legacy bare-path registration in place, keeping the user's tuning, and stays idempotent", () => {
    const existing: Record<string, Stanza[]> = {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "mine.sh" }] },
        { hooks: [{ type: "command", command: "/d/inject.sh", timeout: 30 }] },
      ],
    };
    const merged = mergeHookManifest<Handler, Stanza>(existing, ours("claude-code"));
    expect(merged.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "mine.sh" }] },
      { hooks: [{ type: "command", command: "/d/inject.sh --runtime claude-code", timeout: 30 }] },
    ]);
    expect(merged.PreToolUse).toEqual(ours("claude-code").PreToolUse);
    expect(mergeHookManifest<Handler, Stanza>(merged, ours("claude-code"))).toEqual(merged);
    // Pure: the input is untouched.
    expect(existing.UserPromptSubmit![1]!.hooks[0]!.command).toBe("/d/inject.sh");
  });

  it("does not treat an unrelated command that merely shares a prefix as ours", () => {
    const merged = mergeHookManifest<Handler, Stanza>(
      { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/d/inject.sh --verbose" }] }] },
      ours("codex"),
    );
    expect(merged.UserPromptSubmit!.flatMap((s) => s.hooks.map((h) => h.command))).toEqual([
      "/d/inject.sh --verbose",
      "/d/inject.sh --runtime codex",
    ]);
  });

  it("ignores manifest handlers that carry no --runtime (nothing to upgrade from)", () => {
    const manifest: Record<string, Stanza[]> = { Stop: [{ hooks: [{ type: "command", command: "/d/plain.sh" }] }] };
    const merged = mergeHookManifest<Handler, Stanza>({ Stop: [{ hooks: [{ type: "command", command: "/d/plain.sh" }] }] }, manifest);
    expect(merged.Stop).toEqual([{ hooks: [{ type: "command", command: "/d/plain.sh" }] }]);
  });
});
