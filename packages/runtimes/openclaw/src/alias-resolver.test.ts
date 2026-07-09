import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskDispatch } from "@digital-me/brain-orchestrator";
import {
  DEFAULT_WORKER_SCRIPT,
  createOpenClawAliasResolver,
  defaultArtifactRoot,
} from "./alias-resolver.js";

let tmpRoot: string;
let artifactRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alias-resolver-"));
  artifactRoot = path.join(tmpRoot, "task-artifacts");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const claudeAlias = {
  binary: "/usr/local/bin/claude",
  args: ["-p", "--allowedTools", "Bash,Read,Write", "{{prompt}}"],
  env: { OPENCLAW_AGENT_ID: "claude-code" },
  timeoutMs: 1_800_000,
};

const codexAlias = {
  binary: "/usr/local/bin/codex",
  args: ["exec", "--ephemeral", "{{prompt}}"],
  finalMessageArg: "--output-last-message",
};

function makeCtx(over: Partial<Parameters<ReturnType<typeof createOpenClawAliasResolver>>[1]> = {}) {
  return {
    taskId: "t-1",
    goalId: "g-1",
    taskName: "Compile inbox",
    task: "Do the thing.",
    cwd: "/tmp/workspace",
    originalDispatch: { mode: "exec" as const, command: ["raw"] },
    ...over,
  };
}

describe("DEFAULT_WORKER_SCRIPT + defaultArtifactRoot", () => {
  it("points DEFAULT_WORKER_SCRIPT at the bundled scripts/cli-exec-worker.mjs", () => {
    expect(DEFAULT_WORKER_SCRIPT.endsWith("scripts/cli-exec-worker.mjs")).toBe(
      true,
    );
  });

  it("defaultArtifactRoot expands to ~/.openclaw/task-artifacts", () => {
    expect(defaultArtifactRoot("/home/u")).toBe(
      "/home/u/.openclaw/task-artifacts",
    );
  });

  it("defaultArtifactRoot uses process.env.HOME when no arg is given", () => {
    const out = defaultArtifactRoot();
    expect(out.endsWith(".openclaw/task-artifacts")).toBe(true);
  });

  it("defaultArtifactRoot falls back to '' when HOME is unset", () => {
    const orig = process.env.HOME;
    delete process.env.HOME;
    try {
      const out = defaultArtifactRoot();
      // path.join("", ".openclaw", "task-artifacts") → ".openclaw/task-artifacts"
      expect(out).toBe(".openclaw/task-artifacts");
    } finally {
      if (orig !== undefined) process.env.HOME = orig;
    }
  });
});

describe("createOpenClawAliasResolver", () => {
  it("returns undefined for an unknown alias (leaves the dispatch unchanged)", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
    });
    expect(resolver("unknown-cli", makeCtx())).toBeUndefined();
    expect(fs.existsSync(artifactRoot)).toBe(false);
  });

  it("writes spec.json + returns a wrapped exec dispatch for a known alias", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
      workerScript: "/abs/worker.mjs",
      nodeBinary: "/abs/node",
    });
    const result = resolver("claude-code-cli", makeCtx()) as TaskDispatch;
    expect(result.mode).toBe("exec");
    if (result.mode !== "exec") throw new Error();
    const specPath = path.join(artifactRoot, "g-1", "t-1", "spec.json");
    expect(fs.existsSync(specPath)).toBe(true);
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(spec.alias).toBe("claude-code-cli");
    expect(spec.taskId).toBe("t-1");
    expect(spec.goalId).toBe("g-1");
    expect(spec.binary).toBe("/usr/local/bin/claude");
    expect(spec.args).toEqual([
      "-p",
      "--allowedTools",
      "Bash,Read,Write",
      "{{prompt}}",
    ]);
    expect((spec.env as Record<string, string>).OPENCLAW_AGENT_ID).toBe(
      "claude-code",
    );
    expect(result.command).toEqual(["/abs/node", "/abs/worker.mjs", specPath]);
    expect(result.cwd).toBe("/tmp/workspace");
    expect(result.verify).toBeDefined();
    expect(result.verify!.command).toEqual([
      "/bin/test",
      "-s",
      path.join(artifactRoot, "g-1", "t-1", "handoff.json"),
    ]);
  });

  it("writes spec.json mode 0600 and chmods the artifact dir to 0700", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
      workerScript: "/abs/worker.mjs",
      nodeBinary: "/abs/node",
    });
    resolver("claude-code-cli", makeCtx());
    const artifactDir = path.join(artifactRoot, "g-1", "t-1");
    const specPath = path.join(artifactDir, "spec.json");
    // Mask off the file-type bits so we compare only mode bits.
    const dirMode = fs.statSync(artifactDir).mode & 0o777;
    const fileMode = fs.statSync(specPath).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("re-tightens spec.json and the artifact dir when they already exist with looser modes", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
      workerScript: "/abs/worker.mjs",
      nodeBinary: "/abs/node",
    });
    // Pre-create the dir + a stale spec.json with world-readable modes,
    // simulating a re-run from a prior version that didn't tighten.
    const artifactDir = path.join(artifactRoot, "g-1", "t-1");
    fs.mkdirSync(artifactDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(artifactDir, 0o755);
    const specPath = path.join(artifactDir, "spec.json");
    fs.writeFileSync(specPath, "stale", { encoding: "utf8", mode: 0o644 });
    fs.chmodSync(specPath, 0o644);

    resolver("claude-code-cli", makeCtx());

    const dirMode = fs.statSync(artifactDir).mode & 0o777;
    const fileMode = fs.statSync(specPath).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("honors dispatch-level timeoutMs over alias default", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
    });
    const ctx = makeCtx({
      originalDispatch: {
        mode: "exec" as const,
        command: ["raw"],
        timeoutMs: 60_000,
      },
    });
    const result = resolver("claude-code-cli", ctx) as TaskDispatch;
    if (result.mode !== "exec") throw new Error();
    // Outer timeout = task timeout + 5 min grace.
    expect(result.timeoutMs).toBe(60_000 + 300_000);
    const spec = JSON.parse(
      fs.readFileSync(
        path.join(artifactRoot, "g-1", "t-1", "spec.json"),
        "utf8",
      ),
    ) as { timeoutMs: number };
    expect(spec.timeoutMs).toBe(60_000);
  });

  it("falls back to alias-default timeout when dispatch doesn't supply one", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
    });
    const result = resolver("claude-code-cli", makeCtx()) as TaskDispatch;
    if (result.mode !== "exec") throw new Error();
    expect(result.timeoutMs).toBe(1_800_000 + 300_000);
  });

  it("falls back to 1h default when neither dispatch nor alias supply timeout", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: {
        "bare": {
          binary: "/bin/echo",
          args: ["{{prompt}}"],
        },
      },
      artifactRoot,
    });
    const result = resolver("bare", makeCtx()) as TaskDispatch;
    if (result.mode !== "exec") throw new Error();
    expect(result.timeoutMs).toBe(3_600_000 + 300_000);
  });

  it("uses dispatch-level cwd when present, falling back to ctx.cwd", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
    });
    const ctx = makeCtx({
      originalDispatch: {
        mode: "exec" as const,
        command: ["raw"],
        cwd: "/explicit/cwd",
      },
    });
    const result = resolver("claude-code-cli", ctx) as TaskDispatch;
    if (result.mode !== "exec") throw new Error();
    expect(result.cwd).toBe("/explicit/cwd");
  });

  it("falls back to process.cwd() when neither dispatch.cwd nor ctx.cwd is set", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
    });
    const ctx = makeCtx({
      cwd: undefined,
      originalDispatch: { mode: "exec" as const, command: ["raw"] },
    });
    const result = resolver("claude-code-cli", ctx) as TaskDispatch;
    if (result.mode !== "exec") throw new Error();
    expect(result.cwd).toBe(process.cwd());
  });

  it("forwards finalMessageArg + promptTemplate into the spec.json", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: {
        "codex-cli": {
          ...codexAlias,
          promptTemplate: "Hello {{alias}}, task is {{task}}",
        },
      },
      artifactRoot,
    });
    resolver("codex-cli", makeCtx());
    const spec = JSON.parse(
      fs.readFileSync(
        path.join(artifactRoot, "g-1", "t-1", "spec.json"),
        "utf8",
      ),
    ) as { final_message_arg: string; prompt_template: string };
    expect(spec.final_message_arg).toBe("--output-last-message");
    expect(spec.prompt_template).toBe("Hello {{alias}}, task is {{task}}");
  });

  it("defaults env to {} in the spec when the alias has no env", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "bare": { binary: "/bin/echo", args: ["{{prompt}}"] } },
      artifactRoot,
    });
    resolver("bare", makeCtx());
    const spec = JSON.parse(
      fs.readFileSync(
        path.join(artifactRoot, "g-1", "t-1", "spec.json"),
        "utf8",
      ),
    ) as { env: Record<string, string> };
    expect(spec.env).toEqual({});
  });

  it("uses process.execPath as default nodeBinary, and the bundled worker script", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
    });
    const result = resolver("claude-code-cli", makeCtx()) as TaskDispatch;
    if (result.mode !== "exec") throw new Error();
    expect(result.command[0]).toBe(process.execPath);
    expect(result.command[1]).toBe(DEFAULT_WORKER_SCRIPT);
  });

  it("emits a stable completion_marker keyed on alias + taskId", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
    });
    resolver("claude-code-cli", makeCtx());
    const spec = JSON.parse(
      fs.readFileSync(
        path.join(artifactRoot, "g-1", "t-1", "spec.json"),
        "utf8",
      ),
    ) as { completion_marker: string };
    expect(spec.completion_marker).toBe("DIGITAL_ME_EXEC_OK claude-code-cli t-1");
  });

  it("creates the artifact subdir if it doesn't exist", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
    });
    expect(fs.existsSync(path.join(artifactRoot, "g-1", "t-1"))).toBe(false);
    resolver("claude-code-cli", makeCtx());
    expect(fs.existsSync(path.join(artifactRoot, "g-1", "t-1"))).toBe(true);
  });

  it("defaults artifactRoot to ~/.openclaw/task-artifacts when omitted", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "bare": { binary: "/bin/true", args: [] } },
    });
    // Just verify construction doesn't throw — we don't want to actually
    // write to ~/.openclaw/. Use a non-matching alias to avoid disk writes.
    expect(resolver("unknown", makeCtx())).toBeUndefined();
  });

  it("proceeds best-effort when chmod is unsupported (network mounts ignoring mode bits)", () => {
    // Both tighten-up chmods (artifact dir 0700 + spec.json 0600) are
    // best-effort: a filesystem that rejects chmod must not break dispatch.
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });
    try {
      const resolver = createOpenClawAliasResolver({
        aliases: { "claude-code-cli": claudeAlias },
        artifactRoot,
        workerScript: "/abs/worker.mjs",
        nodeBinary: "/abs/node",
      });
      const result = resolver("claude-code-cli", makeCtx()) as TaskDispatch;
      expect(result.mode).toBe("exec");
      // Dir + spec chmod were both attempted (and both swallowed).
      expect(chmodSpy).toHaveBeenCalledTimes(2);
      // spec.json was still written despite the chmod failures.
      expect(
        fs.existsSync(path.join(artifactRoot, "g-1", "t-1", "spec.json")),
      ).toBe(true);
    } finally {
      chmodSpy.mockRestore();
    }
  });

  it("works with a non-exec originalDispatch (still resolves the alias)", () => {
    const resolver = createOpenClawAliasResolver({
      aliases: { "claude-code-cli": claudeAlias },
      artifactRoot,
    });
    // Hypothetical: spawn dispatch routed through with agentId — alias
    // resolver still rewrites it. (brain-orchestrator gates this — only
    // calls aliasResolver for exec dispatches with agentId — but the
    // resolver itself should be robust.)
    const result = resolver(
      "claude-code-cli",
      makeCtx({
        originalDispatch: {
          mode: "spawn" as const,
          agentId: "claude-code-cli",
        },
      }),
    ) as TaskDispatch;
    expect(result.mode).toBe("exec");
  });
});

describe("PACKAGE_ROOT resolution — published CLI bundle layout", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("resolves DEFAULT_WORKER_SCRIPT under assets/openclaw when scripts/ is absent", async () => {
    // In the published CLI bundle, esbuild inlines this module into
    // <npm-pkg>/bin/*.js — MODULE_ROOT then has no scripts/ dir and the
    // per-package assets are staged under assets/openclaw/ instead.
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: () => false,
        default: { ...actual, existsSync: () => false },
      };
    });
    const bundled = await import("./alias-resolver.js");
    expect(
      bundled.DEFAULT_WORKER_SCRIPT.endsWith(
        "/assets/openclaw/scripts/cli-exec-worker.mjs",
      ),
    ).toBe(true);
  });
});
