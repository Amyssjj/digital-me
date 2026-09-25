import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HOOK_NAMES,
  HOOKS_DIR,
  PACKAGE_ROOT,
  SKILL_NAMES,
  SKILLS_DIR,
  buildClaudeHooksManifest,
  mergeBrainEnvIntoSettings,
  mergeHooksIntoSettings,
} from "./installer.js";

describe("PACKAGE_ROOT + paths", () => {
  it("PACKAGE_ROOT carries skills/; the hooks come from the shared agent-hooks package", () => {
    expect(SKILLS_DIR).toBe(`${PACKAGE_ROOT}/skills`);
    // One hook source for Claude Code and Codex: not under this package.
    expect(basename(HOOKS_DIR)).toBe("hooks");
    expect(basename(dirname(HOOKS_DIR))).toBe("agent-hooks");
    for (const name of HOOK_NAMES) {
      expect(existsSync(join(HOOKS_DIR, name)), name).toBe(true);
    }
  });

  it("falls back to assets/claude-code when skills/ is absent (published CLI bundle layout)", async () => {
    // In the workspace, skills/ sits at the package root so the ternary's
    // first arm wins. The published CLI bundle stages per-package assets
    // under assets/claude-code/ instead — simulate that layout by mocking
    // existsSync and re-importing the module.
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: () => false }));
    try {
      const fresh = await import("./installer.js");
      expect(fresh.PACKAGE_ROOT.endsWith("assets/claude-code")).toBe(true);
      expect(fresh.SKILLS_DIR).toBe(`${fresh.PACKAGE_ROOT}/skills`);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("exposes the 5 hooks + 2 helpers + the analyser + 1 skill name", () => {
    expect(HOOK_NAMES).toEqual([
      "dm_memory_search_inject.sh",
      "brain_route_inject.sh",
      "dm_handoff_reminder.sh",
      "dm_session_extract.sh",
      "dm_application_rate.sh",
      // Helpers, not hooks: dm_m1_emit.py is spawned by the inject and stop
      // hooks, dm_hook_lib.sh is sourced by every hook.
      "dm_m1_emit.py",
      "dm_hook_lib.sh",
      // Claude-Code-only offline analyser.
      "analyze_brain_inject.py",
    ]);
    expect(SKILL_NAMES).toEqual(["digital-me"]);
  });
});

describe("buildClaudeHooksManifest", () => {
  it("emits the canonical 3-event hook stanza", () => {
    const m = buildClaudeHooksManifest();
    expect(m.UserPromptSubmit).toHaveLength(1);
    expect(m.Stop).toHaveLength(1);
    expect(m.PreToolUse).toHaveLength(1);
    expect(m.UserPromptSubmit[0]!.hooks[0]!.command).toBe(
      "$HOME/.claude/hooks/dm_memory_search_inject.sh --runtime claude-code",
    );
    expect(m.PreToolUse[0]!.hooks[0]!.command).toBe(
      "$HOME/.claude/hooks/brain_route_inject.sh --runtime claude-code",
    );
    // Stop has three hooks: handoff reminder + session extract (async) +
    // application-rate writer (async, M1 live writer, 2026-05-22).
    expect(m.Stop[0]!.hooks).toHaveLength(3);
    expect(m.Stop[0]!.hooks[1]!.async).toBe(true);
    expect(m.Stop[0]!.hooks[2]!.command).toBe(
      "$HOME/.claude/hooks/dm_application_rate.sh --runtime claude-code",
    );
    expect(m.Stop[0]!.hooks[2]!.async).toBe(true);
  });

  it("bakes `--runtime claude-code` into every command (the scripts are shared with Codex)", () => {
    const m = buildClaudeHooksManifest();
    const all = [...m.UserPromptSubmit, ...m.Stop, ...m.PreToolUse].flatMap((s) => s.hooks);
    expect(all).toHaveLength(5);
    for (const h of all) {
      expect(h.command).toMatch(/^\$HOME\/\.claude\/hooks\/[a-z_]+\.sh --runtime claude-code$/);
    }
  });

  it("the shipped settings.json template registers exactly the manifest's commands", () => {
    const template = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "templates", "settings.json"), "utf-8"),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const m = buildClaudeHooksManifest();
    for (const event of Object.keys(m) as Array<keyof typeof m>) {
      expect(template.hooks[event]!.flatMap((s) => s.hooks.map((h) => h.command))).toEqual(
        m[event].flatMap((s) => s.hooks.map((h) => h.command)),
      );
    }
  });
});

describe("package.json metadata", () => {
  it("advertises exactly the Claude hook events the manifest wires", () => {
    // Regression: the description claimed 5 events (incl. SessionStart/SessionEnd,
    // which are internal M1 emitters, not Claude lifecycle hooks). Keep the
    // parenthesized event list in sync with the actual manifest.
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    ) as { description: string };
    const listed = (pkg.description.match(/\(([^)]+)\)/)?.[1] ?? "")
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(listed).toEqual(Object.keys(buildClaudeHooksManifest()));
  });
});

describe("mergeHooksIntoSettings", () => {
  it("adds our hooks to an empty settings object", () => {
    const merged = mergeHooksIntoSettings({});
    const hooks = merged.hooks as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual([
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  it("preserves the user's existing top-level settings", () => {
    const merged = mergeHooksIntoSettings({ model: "opus-4-7", customKey: 42 });
    expect(merged.model).toBe("opus-4-7");
    expect(merged.customKey).toBe(42);
  });

  it("preserves the user's pre-existing hooks under the same events", () => {
    const userStanza = {
      hooks: [{ type: "command" as const, command: "user-custom.sh" }],
    };
    const merged = mergeHooksIntoSettings({
      hooks: { UserPromptSubmit: [userStanza] },
    });
    const userPrompt = (merged.hooks as Record<string, unknown[]>)[
      "UserPromptSubmit"
    ]!;
    // First is the user's, second is ours.
    expect(userPrompt).toHaveLength(2);
  });

  it("is idempotent — re-merging doesn't duplicate our stanzas", () => {
    const once = mergeHooksIntoSettings({});
    const twice = mergeHooksIntoSettings(once);
    expect(
      ((twice.hooks as Record<string, unknown[]>)["UserPromptSubmit"]!).length,
    ).toBe(1);
  });

  it("preserves user hooks AND ours when the user already added one of ours by hand", () => {
    const ourCmd = "$HOME/.claude/hooks/dm_memory_search_inject.sh --runtime claude-code";
    const merged = mergeHooksIntoSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command" as const, command: ourCmd, timeout: 30 }] },
        ],
      },
    });
    const ups = (merged.hooks as Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>)[
      "UserPromptSubmit"
    ]!;
    // De-dup: user-added entry kept (with the user's timeout), ours not re-added.
    expect(ups).toHaveLength(1);
    expect(ups[0]!.hooks[0]).toEqual({ type: "command", command: ourCmd, timeout: 30 });
  });

  it("upgrades a command an older installer registered without --runtime in place instead of adding a second copy", () => {
    const legacy = "$HOME/.claude/hooks/dm_memory_search_inject.sh";
    const merged = mergeHooksIntoSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command" as const, command: "user-custom.sh" }] },
          { hooks: [{ type: "command" as const, command: legacy, timeout: 12 }] },
        ],
        Stop: [
          {
            hooks: [
              { type: "command" as const, command: "$HOME/.claude/hooks/dm_handoff_reminder.sh", timeout: 5 },
              { type: "command" as const, command: "$HOME/.claude/hooks/dm_session_extract.sh", timeout: 8, async: true },
            ],
          },
        ],
      },
    });
    const hooks = merged.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const commands = (event: string) => hooks[event]!.flatMap((s) => s.hooks.map((h) => h.command));
    expect(commands("UserPromptSubmit")).toEqual([
      "user-custom.sh",
      `${legacy} --runtime claude-code`,
    ]);
    // The two legacy Stop commands are upgraded where they were; only the
    // hook the old install lacked (dm_application_rate.sh) is appended.
    expect(commands("Stop")).toEqual([
      "$HOME/.claude/hooks/dm_handoff_reminder.sh --runtime claude-code",
      "$HOME/.claude/hooks/dm_session_extract.sh --runtime claude-code",
      "$HOME/.claude/hooks/dm_application_rate.sh --runtime claude-code",
    ]);
    // Idempotent from there on.
    expect(mergeHooksIntoSettings(merged)).toEqual(merged);
  });

  it("skips events where all our commands are already present", () => {
    const stanzas = buildClaudeHooksManifest();
    const seeded = {
      hooks: {
        UserPromptSubmit: [...stanzas.UserPromptSubmit],
        Stop: [...stanzas.Stop],
        PreToolUse: [...stanzas.PreToolUse],
      },
    };
    const merged = mergeHooksIntoSettings(seeded);
    for (const event of ["UserPromptSubmit", "Stop", "PreToolUse"]) {
      const events = (merged.hooks as Record<string, unknown[]>)[event]!;
      expect(events).toHaveLength(1);
    }
  });
});

describe("mergeBrainEnvIntoSettings", () => {
  const brain = { url: "http://127.0.0.1:18791/tools/invoke", tokenFile: "/home/t/digital-me/.data/brain-host.token" };
  const expectedEnv = {
    DIGITAL_ME_BRAIN_URL: brain.url,
    DIGITAL_ME_BRAIN_TOKEN_FILE: brain.tokenFile,
  };

  it("writes DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN_FILE (never the secret) into a fresh env block, keeping other settings", () => {
    const merged = mergeBrainEnvIntoSettings({ model: "opus-4-7" }, brain);
    expect(merged.model).toBe("opus-4-7");
    expect(merged.env).toEqual(expectedEnv);
    expect(Object.keys(merged.env as object)).not.toContain("DIGITAL_ME_BRAIN_TOKEN");
  });

  it("preserves the user's other env entries, overwrites stale brain values and REMOVES a previously written DIGITAL_ME_BRAIN_TOKEN", () => {
    const input = { env: { FOO: "bar", DIGITAL_ME_BRAIN_TOKEN: "old-secret", DIGITAL_ME_BRAIN_URL: "http://stale/tools/invoke" } };
    const merged = mergeBrainEnvIntoSettings(input, brain);
    expect(merged.env).toEqual({ FOO: "bar", ...expectedEnv });
    expect(JSON.stringify(merged)).not.toContain("old-secret");
    // Pure: the caller's object is untouched.
    expect(input.env.DIGITAL_ME_BRAIN_TOKEN).toBe("old-secret");
  });

  it("replaces a malformed env (null / array) instead of spreading it", () => {
    expect(mergeBrainEnvIntoSettings({ env: null }, brain).env).toEqual(expectedEnv);
    expect(mergeBrainEnvIntoSettings({ env: ["x"] }, brain).env).toEqual(expectedEnv);
  });

  it("is idempotent and composes with the hooks merge", () => {
    const once = mergeBrainEnvIntoSettings(mergeHooksIntoSettings({}), brain);
    const twice = mergeBrainEnvIntoSettings(mergeHooksIntoSettings(once), brain);
    expect(twice).toEqual(once);
    expect(Object.keys(once.hooks as Record<string, unknown>).sort()).toEqual([
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  it("refuses half a contract: a URL without a token file, or a token file without a URL", () => {
    // Mirrors the callers (brain-mcp-proxy config.ts, dm_memory_search_inject.sh,
    // dm_m1_emit.py): URL with no resolvable token is a hard error, never a gateway fallback.
    expect(() => mergeBrainEnvIntoSettings({}, { url: brain.url, tokenFile: "" })).toThrow(/both/);
    expect(() => mergeBrainEnvIntoSettings({}, { url: "   ", tokenFile: brain.tokenFile })).toThrow(/both/);
  });
});
