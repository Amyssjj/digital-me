import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HOOK_NAMES,
  HOOKS_DIR,
  PACKAGE_ROOT,
  SKILL_NAMES,
  SKILLS_DIR,
  buildClaudeHooksManifest,
  mergeHooksIntoSettings,
} from "./installer.js";

describe("PACKAGE_ROOT + paths", () => {
  it("PACKAGE_ROOT points at a directory that contains hooks/ and skills/", () => {
    // We don't actually access the filesystem here — just verify the
    // path string shape so downstream tooling can rely on the layout.
    expect(HOOKS_DIR).toBe(`${PACKAGE_ROOT}/hooks`);
    expect(SKILLS_DIR).toBe(`${PACKAGE_ROOT}/skills`);
  });

  it("falls back to assets/claude-code when hooks/ is absent (published CLI bundle layout)", async () => {
    // In the workspace, hooks/ sits at the package root so the ternary's
    // first arm wins. The published CLI bundle stages per-package assets
    // under assets/claude-code/ instead — simulate that layout by mocking
    // existsSync and re-importing the module.
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: () => false }));
    try {
      const fresh = await import("./installer.js");
      expect(fresh.PACKAGE_ROOT.endsWith("assets/claude-code")).toBe(true);
      expect(fresh.HOOKS_DIR).toBe(`${fresh.PACKAGE_ROOT}/hooks`);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("exposes the 6 hooks + 1 helper script + 1 skill name", () => {
    expect(HOOK_NAMES).toEqual([
      "dm_memory_search_inject.sh",
      "brain_route_inject.sh",
      "dm_handoff_reminder.sh",
      "dm_session_extract.sh",
      "dm_application_rate.sh",
      "analyze_brain_inject.py",
      // dm_m1_emit.py is a helper called as a subprocess by the inject
      // and stop hooks — not a hook itself, but ships with them.
      "dm_m1_emit.py",
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
      "$HOME/.claude/hooks/dm_memory_search_inject.sh",
    );
    expect(m.PreToolUse[0]!.hooks[0]!.command).toBe(
      "$HOME/.claude/hooks/brain_route_inject.sh",
    );
    // Stop has three hooks: handoff reminder + session extract (async) +
    // application-rate writer (async, M1 live writer, 2026-05-22).
    expect(m.Stop[0]!.hooks).toHaveLength(3);
    expect(m.Stop[0]!.hooks[1]!.async).toBe(true);
    expect(m.Stop[0]!.hooks[2]!.command).toBe(
      "$HOME/.claude/hooks/dm_application_rate.sh",
    );
    expect(m.Stop[0]!.hooks[2]!.async).toBe(true);
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
    const ourCmd = "$HOME/.claude/hooks/dm_memory_search_inject.sh";
    const merged = mergeHooksIntoSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command" as const, command: ourCmd }] },
        ],
      },
    });
    const ups = (merged.hooks as Record<string, unknown[]>)[
      "UserPromptSubmit"
    ]!;
    // De-dup: user-added entry kept, ours not re-added.
    expect(ups).toHaveLength(1);
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
