import { describe, expect, it, vi } from "vitest";
import {
  CODEX_MD_TEMPLATE,
  HOOK_NAMES,
  HOOKS_DIR,
  MCP_TOML_TEMPLATE,
  PACKAGE_ROOT,
  SECTION_BEGIN,
  SECTION_END,
  TEMPLATES_DIR,
  buildCodexHooksManifest,
  buildCodexMcpConfig,
  mergeCodexHooksJson,
  mergeCodexMd,
  mergeMcpServer,
} from "./installer.js";

describe("buildCodexMcpConfig", () => {
  const inputs = {
    nodeBin: "/opt/homebrew/bin/node",
    proxyBinPath:
      "/home/test/digital-me-os/packages/transport/brain-mcp-proxy/bin/brain-mcp-proxy.mjs",
    openclawHome: "/home/test/openclaw",
    agentId: "codex",
  };

  it("emits a complete [mcp_servers.openclaw-brain] block", () => {
    const toml = buildCodexMcpConfig(inputs);
    expect(toml).toContain("[mcp_servers.openclaw-brain]");
    expect(toml).toContain(`command = "${inputs.nodeBin}"`);
    expect(toml).toContain(`args = ["${inputs.proxyBinPath}"]`);
  });

  it("injects OPENCLAW_HOME and OPENCLAW_AGENT_ID into env", () => {
    const toml = buildCodexMcpConfig(inputs);
    expect(toml).toContain(`OPENCLAW_HOME = "${inputs.openclawHome}"`);
    expect(toml).toContain(`OPENCLAW_AGENT_ID = "codex"`);
  });

  it("defaults agentId to 'codex' when omitted", () => {
    const { agentId: _omit, ...rest } = inputs;
    const toml = buildCodexMcpConfig(rest);
    expect(toml).toContain(`OPENCLAW_AGENT_ID = "codex"`);
  });

  it("output is idempotent through mergeMcpServer (replaces in place)", () => {
    const v1 = buildCodexMcpConfig(inputs);
    const v2 = buildCodexMcpConfig({ ...inputs, agentId: "claude-code" });
    const after1 = mergeMcpServer("", v1);
    const after2 = mergeMcpServer(after1, v2);
    expect(after2).toContain(`OPENCLAW_AGENT_ID = "claude-code"`);
    expect(after2).not.toContain(`OPENCLAW_AGENT_ID = "codex"`);
  });

  it("escapes backslashes and quotes in path values", () => {
    const toml = buildCodexMcpConfig({
      ...inputs,
      proxyBinPath: `/path/with"quote/and\\back`,
    });
    expect(toml).toContain(`["/path/with\\"quote/and\\\\back"]`);
  });

  it("escapes control characters in TOML string values", () => {
    const toml = buildCodexMcpConfig({
      nodeBin: "/opt/node\nbin",
      proxyBinPath: "/tmp/proxy\r.mjs",
      openclawHome: "/home/test/open\tclaw",
      agentId: "codex\nBROKEN = true\r\t\u0001",
    });
    expect(toml).toContain(`command = "/opt/node\\nbin"`);
    expect(toml).toContain(`args = ["/tmp/proxy\\r.mjs"]`);
    expect(toml).toContain(`OPENCLAW_HOME = "/home/test/open\\tclaw"`);
    expect(toml).toContain(
      `OPENCLAW_AGENT_ID = "codex\\nBROKEN = true\\r\\t\\u0001"`,
    );
    expect(toml).not.toContain("codex\nBROKEN");
    expect(toml.split("\n")).toHaveLength(5);
  });

  it("escapes backspace and form-feed control characters", () => {
    // \b and \f have dedicated TOML short escapes — make sure they don't
    // fall through to the generic \uXXXX arm.
    const toml = buildCodexMcpConfig({
      ...inputs,
      agentId: "codex\b\f",
    });
    expect(toml).toContain(`OPENCLAW_AGENT_ID = "codex\\b\\f"`);
  });
});

describe("paths", () => {
  it("PACKAGE_ROOT contains templates/ with the canonical filenames", () => {
    expect(TEMPLATES_DIR).toBe(`${PACKAGE_ROOT}/templates`);
    expect(HOOKS_DIR).toBe(`${PACKAGE_ROOT}/hooks`);
    expect(CODEX_MD_TEMPLATE.endsWith("templates/CODEX.md")).toBe(true);
    expect(MCP_TOML_TEMPLATE.endsWith("templates/openclaw-brain.mcp.toml")).toBe(
      true,
    );
  });

  it("falls back to assets/codex when hooks/ is absent (published CLI bundle layout)", async () => {
    // In the workspace, hooks/ sits at the package root so the ternary's
    // first arm wins. The published CLI bundle stages per-package assets
    // under assets/codex/ instead — simulate that layout by mocking
    // existsSync and re-importing the module.
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: () => false }));
    try {
      const fresh = await import("./installer.js");
      expect(fresh.PACKAGE_ROOT.endsWith("assets/codex")).toBe(true);
      expect(fresh.TEMPLATES_DIR).toBe(`${fresh.PACKAGE_ROOT}/templates`);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

describe("HOOK_NAMES", () => {
  it("ships the 5 lifecycle hooks + the dm_m1_emit.py helper", () => {
    expect(HOOK_NAMES).toEqual([
      "dm_memory_search_inject.sh",
      "brain_route_inject.sh",
      "dm_handoff_reminder.sh",
      "dm_session_extract.sh",
      "dm_application_rate.sh",
      "dm_m1_emit.py",
    ]);
  });
});

describe("buildCodexHooksManifest", () => {
  it("maps the canonical events onto the codex hooks (absolute hooksDir)", () => {
    const m = buildCodexHooksManifest("/home/me/.codex/hooks");
    expect(m.UserPromptSubmit).toHaveLength(1);
    expect(m.Stop).toHaveLength(1);
    expect(m.PreToolUse).toHaveLength(1);

    expect(m.UserPromptSubmit[0]!.hooks[0]!.command).toBe(
      "/home/me/.codex/hooks/dm_memory_search_inject.sh",
    );
    // Stop wires handoff reminder + session extract + application-rate writer.
    expect(m.Stop[0]!.hooks).toHaveLength(3);
    expect(m.Stop[0]!.hooks.map((h) => h.command)).toEqual([
      "/home/me/.codex/hooks/dm_handoff_reminder.sh",
      "/home/me/.codex/hooks/dm_session_extract.sh",
      "/home/me/.codex/hooks/dm_application_rate.sh",
    ]);
    expect(m.PreToolUse[0]!.matcher).toBe("*");
    expect(m.PreToolUse[0]!.hooks[0]!.command).toBe(
      "/home/me/.codex/hooks/brain_route_inject.sh",
    );
  });

  it("never emits `async` (codex parses but does not honour it yet)", () => {
    const m = buildCodexHooksManifest("/x/hooks");
    const all = [...m.UserPromptSubmit, ...m.Stop, ...m.PreToolUse].flatMap(
      (s) => s.hooks,
    );
    for (const h of all) {
      expect(h).not.toHaveProperty("async");
      expect(h.type).toBe("command");
    }
  });

  it("defaults hooksDir to $HOME/.codex/hooks when omitted", () => {
    const m = buildCodexHooksManifest();
    expect(m.UserPromptSubmit[0]!.hooks[0]!.command).toBe(
      "$HOME/.codex/hooks/dm_memory_search_inject.sh",
    );
  });
});

describe("mergeCodexHooksJson", () => {
  const DIR = "/home/me/.codex/hooks";

  it("adds all three events into an empty config", () => {
    const out = mergeCodexHooksJson({}, DIR) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(out.hooks).sort()).toEqual([
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  it("preserves the user's existing hooks + top-level keys", () => {
    const existing = {
      model: "gpt-5-codex",
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] },
        ],
      },
    };
    const out = mergeCodexHooksJson(existing, DIR) as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(out.model).toBe("gpt-5-codex");
    const ups = out.hooks.UserPromptSubmit!.flatMap((s) =>
      s.hooks.map((h) => h.command),
    );
    expect(ups).toContain("/usr/local/bin/mine.sh");
    expect(ups).toContain(`${DIR}/dm_memory_search_inject.sh`);
  });

  it("is idempotent — re-merging does not duplicate our command stanzas", () => {
    const once = mergeCodexHooksJson({}, DIR);
    const twice = mergeCodexHooksJson(once as Record<string, unknown>, DIR) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const stopCmds = twice.hooks.Stop!.flatMap((s) =>
      s.hooks.map((h) => h.command),
    );
    // Three distinct Stop commands, no dupes.
    expect(stopCmds).toHaveLength(3);
    expect(new Set(stopCmds).size).toBe(3);
  });
});

describe("mergeCodexMd", () => {
  it("returns just the managed section + trailing newline for an empty file", () => {
    const out = mergeCodexMd("", "managed content");
    expect(out).toContain(SECTION_BEGIN);
    expect(out).toContain("managed content");
    expect(out).toContain(SECTION_END);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("replaces the managed span when both markers are present", () => {
    const existing =
      "# User intro\nsome text\n\n" +
      SECTION_BEGIN +
      "\nOLD content\n" +
      SECTION_END +
      "\n\n# More user stuff\n";
    const out = mergeCodexMd(existing, "NEW content");
    expect(out).toContain("NEW content");
    expect(out).not.toContain("OLD content");
    expect(out).toContain("# User intro");
    expect(out).toContain("# More user stuff");
  });

  it("appends the managed section when no markers exist (file ends with newline)", () => {
    const existing = "# User stuff\nline 2\n";
    const out = mergeCodexMd(existing, "managed body");
    expect(out.startsWith("# User stuff")).toBe(true);
    expect(out).toContain(SECTION_BEGIN);
    expect(out).toContain("managed body");
  });

  it("appends with a blank-line separator when the file doesn't end with newline", () => {
    const existing = "# User stuff (no trailing newline)";
    const out = mergeCodexMd(existing, "managed body");
    expect(out).toContain("\n\n" + SECTION_BEGIN);
  });

  it("appends a fresh managed section when only the BEGIN marker exists (malformed)", () => {
    const existing = "# User stuff\n" + SECTION_BEGIN + "\nstray content\n";
    const out = mergeCodexMd(existing, "managed body");
    // Existing stray content survives; managed section appended at end.
    expect(out).toContain("stray content");
    // The new managed section's END marker should appear after the stray text.
    const endIdx = out.lastIndexOf(SECTION_END);
    expect(endIdx).toBeGreaterThan(out.indexOf("stray content"));
  });

  it("is idempotent — re-merging the same content is a no-op", () => {
    const once = mergeCodexMd("# Hi\n", "X");
    const twice = mergeCodexMd(once, "X");
    expect(twice).toBe(once);
  });
});

describe("mergeMcpServer", () => {
  const FRAGMENT = `
[mcp_servers.openclaw-brain]
command = "digital-me-brain-proxy"
args = []
`;

  it("appends the fragment when no matching header exists", () => {
    const out = mergeMcpServer("[other_section]\nfoo = 1\n", FRAGMENT);
    expect(out).toContain("[mcp_servers.openclaw-brain]");
    expect(out).toContain('command = "digital-me-brain-proxy"');
    expect(out).toContain("[other_section]");
  });

  it("appends when starting from empty input", () => {
    const out = mergeMcpServer("", FRAGMENT);
    expect(out.trim().startsWith("[mcp_servers.openclaw-brain]")).toBe(true);
  });

  it("replaces an existing block under the same header", () => {
    const existing =
      "[mcp_servers.openclaw-brain]\n" +
      'command = "old-binary"\n' +
      "args = [\"--legacy\"]\n" +
      "\n" +
      "[other_section]\n" +
      "x = 1\n";
    const out = mergeMcpServer(existing, FRAGMENT);
    expect(out).not.toContain("old-binary");
    expect(out).toContain('command = "digital-me-brain-proxy"');
    expect(out).toContain("[other_section]");
    expect(out).toContain("x = 1");
  });

  it("replaces a block at EOF (no trailing section)", () => {
    const existing =
      "[other]\nq = true\n\n" +
      "[mcp_servers.openclaw-brain]\n" +
      'command = "stale"\n';
    const out = mergeMcpServer(existing, FRAGMENT);
    expect(out).not.toContain("stale");
    expect(out).toContain('command = "digital-me-brain-proxy"');
    expect(out).toContain("[other]");
  });

  it("inserts a leading newline when replacing a block whose 'before' chunk lacks a trailing newline", () => {
    // No blank line between the preceding section and the matched header,
    // so lines.slice(0, headerIdx).join("\n") yields content without a
    // trailing newline → triggers the beforeSep branch.
    const existing =
      "[other]\nq = true\n[mcp_servers.openclaw-brain]\ncommand = \"stale\"\n";
    const out = mergeMcpServer(existing, FRAGMENT);
    expect(out).not.toContain("stale");
    expect(out).toContain("[other]");
    expect(out).toContain('command = "digital-me-brain-proxy"');
  });

  it("inserts a separator newline when appending to TOML missing a trailing newline", () => {
    const existing = "[other]\nx = 1"; // no trailing newline
    const out = mergeMcpServer(existing, FRAGMENT);
    expect(out).toContain("[mcp_servers.openclaw-brain]");
    expect(out.startsWith("[other]\nx = 1")).toBe(true);
  });

  it("returns the existing TOML unchanged when the fragment has no header", () => {
    const existing = "x = 1\n";
    const out = mergeMcpServer(existing, "just a comment line\n");
    expect(out).toBe(existing);
  });

  it("idempotent on re-merge with the same fragment", () => {
    const once = mergeMcpServer("", FRAGMENT);
    const twice = mergeMcpServer(once, FRAGMENT);
    // Content equivalent (whitespace normalization aside)
    expect(twice.trim()).toBe(once.trim());
  });
});
