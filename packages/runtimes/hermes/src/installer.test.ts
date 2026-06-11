import { describe, expect, it } from "vitest";
import {
  PACKAGE_ROOT,
  SECTION_BEGIN,
  SECTION_END,
  SOUL_MD_TEMPLATE,
  TEMPLATES_DIR,
  mergeSoulMd,
} from "./installer.js";

describe("paths", () => {
  it("TEMPLATES_DIR sits under PACKAGE_ROOT", () => {
    expect(TEMPLATES_DIR).toBe(`${PACKAGE_ROOT}/templates`);
    expect(SOUL_MD_TEMPLATE.endsWith("templates/SOUL.md")).toBe(true);
  });
});

describe("mergeSoulMd", () => {
  it("returns just the managed section + trailing newline for an empty file", () => {
    const out = mergeSoulMd("", "protocol content");
    expect(out).toContain(SECTION_BEGIN);
    expect(out).toContain("protocol content");
    expect(out).toContain(SECTION_END);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("replaces the managed span when both markers are present", () => {
    const existing =
      "# Hermes\nYou are kawaii.\n" +
      SECTION_BEGIN +
      "\nOLD protocol\n" +
      SECTION_END +
      "\nMore persona text.\n";
    const out = mergeSoulMd(existing, "NEW protocol");
    expect(out).toContain("NEW protocol");
    expect(out).not.toContain("OLD protocol");
    expect(out).toContain("# Hermes");
    expect(out).toContain("More persona text.");
  });

  it("appends the managed section when no markers exist (trailing-newline file)", () => {
    const out = mergeSoulMd("# Hermes\nYou are direct.\n", "protocol body");
    expect(out.startsWith("# Hermes")).toBe(true);
    expect(out).toContain("protocol body");
  });

  it("appends with a blank-line separator when the file doesn't end with newline", () => {
    const out = mergeSoulMd("# Hermes (no newline)", "protocol body");
    expect(out).toContain("\n\n" + SECTION_BEGIN);
  });

  it("throws when only the BEGIN marker exists", () => {
    const existing = "# Hermes\n" + SECTION_BEGIN + "\ncustom user text\n";
    expect(() => mergeSoulMd(existing, "protocol body")).toThrow(
      "malformed digital-me managed section markers",
    );
  });

  it("throws when only the END marker exists", () => {
    const existing = "# Hermes\ncustom user text\n" + SECTION_END + "\n";
    expect(() => mergeSoulMd(existing, "protocol body")).toThrow(
      "malformed digital-me managed section markers",
    );
  });

  it("throws when the END marker appears before the BEGIN marker", () => {
    const existing =
      "# Hermes\n" +
      SECTION_END +
      "\ncustom user text\n" +
      SECTION_BEGIN +
      "\n";
    expect(() => mergeSoulMd(existing, "protocol body")).toThrow(
      "malformed digital-me managed section markers",
    );
  });

  it("is idempotent — re-merging the same content is a no-op", () => {
    const once = mergeSoulMd("# Hi\n", "X");
    const twice = mergeSoulMd(once, "X");
    expect(twice).toBe(once);
  });
});

// ── digital-me-recall-hermes plugin shipping (2026-05-22) ───────────────

import { existsSync, readFileSync } from "node:fs";
import {
  PLUGINS_DIR,
  RECALL_PLUGIN_NAME,
  RECALL_PLUGIN_SRC_DIR,
  RECALL_PLUGIN_FILES,
  RECALL_PLUGIN_ENABLE_COMMAND,
} from "./installer.js";

describe("digital-me-recall-hermes plugin shipping", () => {
  it("PLUGINS_DIR sits under PACKAGE_ROOT", () => {
    expect(PLUGINS_DIR).toBe(`${PACKAGE_ROOT}/plugins`);
  });

  it("RECALL_PLUGIN_SRC_DIR resolves to the plugin's own folder", () => {
    expect(RECALL_PLUGIN_SRC_DIR).toBe(
      `${PLUGINS_DIR}/${RECALL_PLUGIN_NAME}`,
    );
  });

  it("RECALL_PLUGIN_FILES lists the two files the installer must copy", () => {
    expect(RECALL_PLUGIN_FILES).toEqual(["plugin.yaml", "__init__.py"]);
  });

  it("the plugin's source files exist on disk", () => {
    for (const f of RECALL_PLUGIN_FILES) {
      const p = `${RECALL_PLUGIN_SRC_DIR}/${f}`;
      expect(existsSync(p)).toBe(true);
    }
  });

  it("plugin.yaml declares the four hooks the plugin promises", () => {
    const yaml = readFileSync(
      `${RECALL_PLUGIN_SRC_DIR}/plugin.yaml`,
      "utf8",
    );
    expect(yaml).toContain("pre_llm_call");
    expect(yaml).toContain("pre_tool_call");
    expect(yaml).toContain("post_tool_call");
    expect(yaml).toContain("on_session_end");
    // Plugin name in manifest must match the directory name (Hermes
    // requirement — see hermes_cli/plugins.py PluginManifest).
    expect(yaml).toContain(`name: ${RECALL_PLUGIN_NAME}`);
  });

  it("__init__.py exposes the `register(ctx)` entry point Hermes calls", () => {
    const src = readFileSync(
      `${RECALL_PLUGIN_SRC_DIR}/__init__.py`,
      "utf8",
    );
    expect(src).toContain("def register(ctx)");
    expect(src).toContain('ctx.register_hook("pre_llm_call"');
    expect(src).toContain('ctx.register_hook("on_session_end"');
    expect(src).toContain('ctx.register_hook("post_tool_call"');
  });

  it("__init__.py writes per-session JSONL records to the canonical M1 log path", () => {
    const src = readFileSync(
      `${RECALL_PLUGIN_SRC_DIR}/__init__.py`,
      "utf8",
    );
    // Same shape as ~/.claude/hooks/application_rate.log and the OpenClaw
    // ~/.openclaw/data/application_rate_openclaw.log: one JSON object per session.
    expect(src).toContain("application_rate_hermes.log");
    expect(src).toContain('"surface": "hermes"');
  });

  it("__init__.py is self-contained for M1 application_rate (periodic flush + atexit)", () => {
    // Regression guard (2026-05-26): Hermes' `on_session_end` doesn't
    // fire reliably for daemon-style runtimes (Discord bot, long-lived
    // gateway processes). To keep the plugin self-contained — without
    // changing the hermes source — the M1 writer must trigger from
    // THREE places:
    //
    //   1. on_session_end                    (original fast path)
    //   2. threading.Timer-driven flush loop (periodic snapshots)
    //   3. atexit handler                    (process shutdown)
    //
    // See wiki: infrastructure/m1-application-rate-openclaw-hermes-hook-lifecycle.md
    const src = readFileSync(
      `${RECALL_PLUGIN_SRC_DIR}/__init__.py`,
      "utf8",
    );
    expect(src).toContain("import atexit");
    expect(src).toContain("import threading");
    expect(src).toContain("_flush_all_sessions");
    expect(src).toContain("_flush_loop");
    expect(src).toContain("_ensure_flush_thread");
    expect(src).toContain("atexit.register(_atexit_flush)");
    expect(src).toContain("PERIODIC_FLUSH_SEC");
    expect(src).toContain("STALE_SESSION_SEC");
    // Records carry a flush_reason so the intake / debug paths can tell
    // periodic snapshots from session_end finalisations apart.
    expect(src).toContain('"flush_reason"');
    // The flush thread reads/writes shared state under a single lock so
    // hook callbacks and the background flush thread don't race.
    expect(src).toContain("_STATE_LOCK");
  });

  it("RECALL_PLUGIN_ENABLE_COMMAND tells the user the activation step", () => {
    // Hermes plugins are opt-in by design — the install summary must
    // surface this command so users know what to run next.
    expect(RECALL_PLUGIN_ENABLE_COMMAND).toBe(
      `hermes plugins enable ${RECALL_PLUGIN_NAME}`,
    );
  });
});
