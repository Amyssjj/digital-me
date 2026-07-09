import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_ENTRY_TEMPLATE,
  BRAIN_INSTALL_FILES,
  BRAIN_MANIFEST_TEMPLATE,
  BRAIN_PLUGIN_DIRNAME,
  EXTENSION_PACKAGE_JSON,
  PACKAGE_ROOT,
  PLUGINS,
  RECALL_ENTRY_TEMPLATE,
  RECALL_INSTALL_FILES,
  RECALL_MANIFEST_TEMPLATE,
  RECALL_PLUGIN_DIRNAME,
  TEMPLATES_DIR,
  buildExtensionPackageJson,
} from "./installer.js";

describe("installer paths — brain plugin", () => {
  it("TEMPLATES_DIR sits under PACKAGE_ROOT", () => {
    expect(TEMPLATES_DIR).toBe(`${PACKAGE_ROOT}/templates`);
  });

  it("BRAIN_MANIFEST_TEMPLATE points at a real file under templates/brain/", () => {
    expect(
      BRAIN_MANIFEST_TEMPLATE.endsWith("templates/brain/openclaw.plugin.json"),
    ).toBe(true);
    expect(fs.existsSync(BRAIN_MANIFEST_TEMPLATE)).toBe(true);
  });

  it("BRAIN_ENTRY_TEMPLATE points at a real file under templates/brain/", () => {
    expect(BRAIN_ENTRY_TEMPLATE.endsWith("templates/brain/index.mjs")).toBe(true);
    expect(fs.existsSync(BRAIN_ENTRY_TEMPLATE)).toBe(true);
  });

  it("BRAIN_PLUGIN_DIRNAME matches the manifest's id", () => {
    const manifest = JSON.parse(
      fs.readFileSync(BRAIN_MANIFEST_TEMPLATE, "utf8"),
    ) as { id: string };
    expect(BRAIN_PLUGIN_DIRNAME).toBe(manifest.id);
    expect(BRAIN_PLUGIN_DIRNAME).toBe("digital-me-brain");
  });

  it("BRAIN_INSTALL_FILES lists manifest + entry", () => {
    expect(BRAIN_INSTALL_FILES).toHaveLength(2);
    const targets = BRAIN_INSTALL_FILES.map((f) => f.target).sort();
    expect(targets).toEqual(["index.mjs", "openclaw.plugin.json"]);
  });

  it("the brain manifest declares all 7 brain tool contracts (incl. M1 universal protocol)", () => {
    const manifest = JSON.parse(
      fs.readFileSync(BRAIN_MANIFEST_TEMPLATE, "utf8"),
    ) as { contracts: { tools: string[] } };
    expect(manifest.contracts.tools.sort()).toEqual([
      "agent_identify",
      "learning_capture",
      "m1_event_record",
      "m1_score",
      "tasks",
      "traces_query",
      "traces_record",
    ]);
  });

  it("the brain entry references definePluginEntry + the brain imports", () => {
    const entry = fs.readFileSync(BRAIN_ENTRY_TEMPLATE, "utf8");
    expect(entry).toContain("definePluginEntry");
    expect(entry).toContain("@digital-me/brain-orchestrator");
    expect(entry).toContain("@digital-me/runtime-openclaw");
    expect(entry).toContain("buildOpenClawBrainTools");
    expect(entry).toContain("createOpenClawAliasResolver");
    expect(entry).toContain("createOpenClawDispatcher");
  });

  it("the brain entry wires a real instantiateWorkflow (no stub)", () => {
    const entry = fs.readFileSync(BRAIN_ENTRY_TEMPLATE, "utf8");
    // Regression guard for the bug discovered on the eve of cutover.
    expect(entry).toContain("instantiateWorkflow as instantiateWorkflowHandler");
    expect(entry).toContain("instantiateWorkflowHandler(deps");
    expect(entry).toContain("dispatcher.dispatchExecTask");
    expect(entry).toContain("dispatcher.dispatchSpawnTask");
    expect(entry).not.toContain(
      "instantiateWorkflow callback not wired in this plugin entry",
    );
  });
});

describe("installer paths — recall plugin", () => {
  it("RECALL_MANIFEST_TEMPLATE points at a real file under templates/recall/", () => {
    expect(
      RECALL_MANIFEST_TEMPLATE.endsWith("templates/recall/openclaw.plugin.json"),
    ).toBe(true);
    expect(fs.existsSync(RECALL_MANIFEST_TEMPLATE)).toBe(true);
  });

  it("RECALL_ENTRY_TEMPLATE points at a real file under templates/recall/", () => {
    expect(RECALL_ENTRY_TEMPLATE.endsWith("templates/recall/index.mjs")).toBe(
      true,
    );
    expect(fs.existsSync(RECALL_ENTRY_TEMPLATE)).toBe(true);
  });

  it("RECALL_PLUGIN_DIRNAME matches the manifest's id", () => {
    const manifest = JSON.parse(
      fs.readFileSync(RECALL_MANIFEST_TEMPLATE, "utf8"),
    ) as { id: string };
    expect(RECALL_PLUGIN_DIRNAME).toBe(manifest.id);
    expect(RECALL_PLUGIN_DIRNAME).toBe("digital-me-recall");
  });

  it("the recall manifest declares a phantom 'recall_status' tool in contracts.tools", () => {
    // Regression guard (2026-05-22): openclaw 2026.5.12's plugin loader
    // silently DROPS plugins whose contracts.tools is missing or empty —
    // discovery accepts them but resolvePluginRegistrationPlan returns
    // null because the activation state evaluates to disabled. The compat
    // layer's warning ("hook-only is a supported compatibility path")
    // is misleading: discovery actually rejects them.
    //
    // Workaround: declare ONE phantom tool name in the manifest. The tool
    // doesn't need to be implemented — the loader only checks contracts
    // for discovery filtering. If it's ever invoked, gateway returns
    // "tool not registered" which is harmless.
    //
    // See wiki: infrastructure/openclaw-loader-rejects-hook-only-plugins.md
    const manifest = JSON.parse(
      fs.readFileSync(RECALL_MANIFEST_TEMPLATE, "utf8"),
    ) as { contracts?: { tools?: readonly string[] } };
    expect(manifest.contracts).toBeDefined();
    expect(manifest.contracts?.tools).toContain("recall_status");
  });

  it("the recall entry registers all four hooks + uses the SDK memory_search facade", () => {
    const entry = fs.readFileSync(RECALL_ENTRY_TEMPLATE, "utf8");
    expect(entry).toContain('api.on("before_prompt_build"');
    expect(entry).toContain('api.on("before_tool_call"');
    expect(entry).toContain('api.on("after_tool_call"');
    expect(entry).toContain("getActiveMemorySearchManager");
    expect(entry).toContain("buildRouteIndex");
    expect(entry).toContain("loadBootContext");
    expect(entry).toContain("buildMemorySearchTrace");
  });

  it("emits assistant_ack from BOTH agent_end AND before_message_write", () => {
    // Regression guard (2026-06-02): assistant_ack must be emitted from two
    // response-observation hooks because `agent_end` is dispatched ONLY by
    // openclaw's cli-runner / codex run-attempt paths. The acpx embedded
    // runtime backend (the COO agent) never fires agent_end — it dispatches
    // `before_message_write`. With agent_end only, acpx-backed agents surface
    // knowledge but never ack, pinning application_rate at 0%.
    // See wiki: infrastructure/m1-assistant-ack-via-agent-end-hook.md
    const entry = fs.readFileSync(RECALL_ENTRY_TEMPLATE, "utf8");
    expect(entry).toContain('api.on("agent_end"');
    expect(entry).toContain('api.on("before_message_write"');
    expect(entry).toContain("agent_end_reply_parse");
    expect(entry).toContain("before_message_write_reply_parse");
    // before_message_write is SYNCHRONOUS — the handler must not be async
    // (the host drops Promise returns).
    expect(entry).toContain('api.on("before_message_write", (event, ctx) =>');
    // The registration-log marker advertises both emitters.
    expect(entry).toContain("assistant_ack=agent_end+before_message_write");
  });

  it("Hook D's INSERT uses the actual traces table schema (id, agent_id, kind, payload, t)", () => {
    // Regression guard: the brain-orchestrator traces table has columns
    // (id, agent_id, kind, payload, task_id, goal_id, duration_ms, t).
    // Previously the recall entry mistakenly wrote (session_key, payload_json,
    // created_at) and the INSERT silently failed inside a try/catch.
    const entry = fs.readFileSync(RECALL_ENTRY_TEMPLATE, "utf8");
    expect(entry).toContain("INSERT INTO traces (id, agent_id, kind, payload, t)");
    expect(entry).not.toContain("payload_json");
    expect(entry).not.toContain("created_at)");
  });

  it("RECALL_INSTALL_FILES lists manifest + entry", () => {
    expect(RECALL_INSTALL_FILES).toHaveLength(2);
    const targets = RECALL_INSTALL_FILES.map((f) => f.target).sort();
    expect(targets).toEqual(["index.mjs", "openclaw.plugin.json"]);
  });

  it("the recall entry is self-contained for M1 application_rate (periodic flush + exit handlers)", () => {
    // Regression guard (2026-05-26): openclaw's `session_end` hook does
    // not fire reliably for long-running cron/daemon sessions. To keep
    // the plugin self-contained — without changing the openclaw gateway
    // source — the recall entry must trigger writes from THREE places:
    //
    //   1. session_end          (original fast path when it does fire)
    //   2. setInterval (periodic flush every appRateFlushIntervalMs)
    //   3. process exit signals + api.lifecycle.onShutdown
    //
    // See wiki: infrastructure/m1-application-rate-openclaw-hermes-hook-lifecycle.md
    const entry = fs.readFileSync(RECALL_ENTRY_TEMPLATE, "utf8");
    expect(entry).toContain('api.on("session_end"');
    expect(entry).toContain("setInterval");
    expect(entry).toContain("appRateFlushIntervalMs");
    expect(entry).toContain("appRateStaleSessionMs");
    expect(entry).toContain('process.on("exit"');
    expect(entry).toContain('process.on("SIGTERM"');
    expect(entry).toContain('process.on("SIGINT"');
    // Records carry a flush_reason so the intake / debug paths can tell
    // periodic snapshots from session_end finalisations apart.
    expect(entry).toContain("flush_reason");
    // The m1FlushAllSessions helper drives both periodic + exit flushes.
    expect(entry).toContain("m1FlushAllSessions");
    // State + timer must be module-level so they survive openclaw's
    // multi-register lifecycle (re-register on config hot reload).
    expect(entry).toContain("m1SessionStats");
    expect(entry).toContain("m1WriterInitialized");
  });

  it("the recall manifest exposes the periodic-flush tunables", () => {
    const manifest = JSON.parse(
      fs.readFileSync(RECALL_MANIFEST_TEMPLATE, "utf8"),
    ) as {
      configSchema?: { properties?: Record<string, unknown> };
    };
    const props = manifest.configSchema?.properties ?? {};
    expect(props.appRateFlushIntervalMs).toBeDefined();
    expect(props.appRateStaleSessionMs).toBeDefined();
  });
});

describe("PLUGINS catalog", () => {
  it("lists both brain and recall in install order", () => {
    expect(PLUGINS.map((p) => p.pluginDirname)).toEqual([
      "digital-me-brain",
      "digital-me-recall",
    ]);
  });

  it("each PLUGINS entry references real install files", () => {
    for (const p of PLUGINS) {
      for (const f of p.installFiles) {
        expect(fs.existsSync(f.src)).toBe(true);
      }
    }
  });
});

describe("PACKAGE_ROOT resolution — published CLI bundle layout", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("falls back to <MODULE_ROOT>/assets/openclaw when templates/ is absent", async () => {
    // In the published CLI bundle, esbuild inlines this module into
    // <npm-pkg>/bin/*.js — MODULE_ROOT then has no templates/ dir and the
    // per-package assets live under assets/openclaw/ instead.
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: () => false,
        default: { ...actual, existsSync: () => false },
      };
    });
    const bundled = await import("./installer.js");
    expect(bundled.PACKAGE_ROOT.endsWith("/assets/openclaw")).toBe(true);
    expect(bundled.TEMPLATES_DIR.endsWith("/assets/openclaw/templates")).toBe(
      true,
    );
  });
});

describe("buildExtensionPackageJson", () => {
  it("EXTENSION_PACKAGE_JSON is the literal 'package.json' filename", () => {
    expect(EXTENSION_PACKAGE_JSON).toBe("package.json");
  });

  it("emits brain-flavored package.json by default", () => {
    const out = buildExtensionPackageJson({
      brainOrchestrator: "/abs/brain",
      runtimeOpenclaw: "/abs/runtime",
      contracts: "/abs/contracts",
    });
    expect(out.name).toBe("digital-me-brain-extension");
    expect(out.private).toBe(true);
    expect(out.type).toBe("module");
    // Regression guard: hooks-only plugins (no contracts.tools) fail to
    // be discovered by openclaw 2026.5+ unless package.json declares
    // openclaw.extensions. We always emit it.
    expect((out.openclaw as { extensions: string[] }).extensions).toEqual([
      "./index.mjs",
    ]);
    const deps = out.dependencies as Record<string, string>;
    expect(deps["@digital-me/brain-orchestrator"]).toBe("file:/abs/brain");
    expect(deps["@digital-me/runtime-openclaw"]).toBe("file:/abs/runtime");
    expect(deps["@digital-me/contracts"]).toBe("file:/abs/contracts");
    expect(deps.yaml).toMatch(/^\^?\d/);
    // Enforced compatibility floor: openclaw refuses to load the plugin on a
    // host older than this. Keep the ">=x.y.z" shape openclaw's loader expects.
    expect((out.install as { minHostVersion: string }).minHostVersion).toMatch(
      /^>=\d+\.\d+\.\d+$/,
    );
  });

  it("emits recall-flavored package.json when pluginDirname is recall", () => {
    const out = buildExtensionPackageJson(
      {
        brainOrchestrator: "/a",
        runtimeOpenclaw: "/b",
        contracts: "/c",
      },
      "digital-me-recall",
    );
    expect(out.name).toBe("digital-me-recall-extension");
  });
});
