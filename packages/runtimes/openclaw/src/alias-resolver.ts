/**
 * `createOpenClawAliasResolver` — config-driven alias resolver. Plugs
 * into brain-orchestrator's `aliasResolver` dep (`AliasResolver` type)
 * so that workflow / goal plans declaring `dispatch.agentId` get
 * rewritten into a CLI-exec worker invocation at task-creation time.
 *
 * Why at task-creation, not dispatch-time: the stored task carries the
 * full materialized `command` array. That preserves upstream's
 * behavior — the dashboard, the watchdog, and `task.dispatch` snapshots
 * all see the real command without having to re-resolve aliases.
 *
 * Effects (when an alias matches):
 *   1. Creates `<artifactRoot>/<goalId>/<taskId>/` on disk.
 *   2. Writes `spec.json` describing the CLI invocation.
 *   3. Returns a new `TaskDispatch` whose `command` invokes the worker
 *      script with that spec path, plus a `verify` step that gates on
 *      `handoff.json` existing.
 *
 * Owner-specific shortcuts are kept OUT of this file — everything
 * (binary path, args, env, prompt template) comes from the alias
 * config the caller supplies.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AliasResolver,
  TaskDispatch,
} from "@digital-me/brain-orchestrator";

export type CliAliasConfig = {
  /** Absolute path or PATH-resolvable binary name (e.g. "claude"). */
  readonly binary: string;
  /**
   * Argument array. `{{prompt}}` is substituted with the rendered prompt
   * at worker time (allows passing the prompt as a positional arg, an
   * `--input` flag value, etc.).
   */
  readonly args: readonly string[];
  /** Extra env vars merged into the worker's spawn environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Default timeout (ms) when the dispatch doesn't override it. */
  readonly timeoutMs?: number;
  /**
   * Mustache-style prompt template. Supported placeholders:
   *   {{alias}}, {{task}}, {{taskName}}, {{taskId}}, {{goalId}}, {{marker}}.
   * Omit for the worker's default template.
   */
  readonly promptTemplate?: string;
  /**
   * If set, indicates the CLI writes its final message to a file path
   * passed as a flag (codex's `--output-last-message`). The worker
   * reads that file instead of stdout when this is configured.
   */
  readonly finalMessageArg?: string;
};

export type AliasResolverOptions = {
  /** Map of alias name → CLI config. */
  readonly aliases: Readonly<Record<string, CliAliasConfig>>;
  /**
   * Where to write per-task spec.json + handoff artifacts. Each task
   * gets its own subdirectory `<artifactRoot>/<goalId>/<taskId>/`.
   * Defaults to `${HOME}/.openclaw/task-artifacts`.
   */
  readonly artifactRoot?: string;
  /**
   * Absolute path to the cli-exec-worker.mjs script. Defaults to the
   * bundled script in this package — usually no need to override.
   */
  readonly workerScript?: string;
  /**
   * Path to the Node interpreter used to run the worker. Defaults to
   * the running `process.execPath` so the worker uses the same Node as
   * the orchestrator gateway.
   */
  readonly nodeBinary?: string;
};

const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Workspace layout: this module compiles to <pkg>/dist/*.js, so MODULE_ROOT
// is the package root, which carries scripts/ directly. Published CLI
// bundle: esbuild inlines every workspace module into <npm-pkg>/bin/*.js, so
// MODULE_ROOT is the npm package root for EVERY package — per-package assets
// are staged by scripts/build-cli-bundle.mjs under assets/openclaw/ to
// avoid cross-package collisions (e.g. claude-code and codex both ship hooks/).
const PACKAGE_ROOT = fs.existsSync(path.join(MODULE_ROOT, "scripts"))
  ? MODULE_ROOT
  : path.join(MODULE_ROOT, "assets", "openclaw");

export const DEFAULT_WORKER_SCRIPT = path.join(
  PACKAGE_ROOT,
  "scripts",
  "cli-exec-worker.mjs",
);

export function defaultArtifactRoot(home: string = process.env.HOME ?? ""): string {
  return path.join(home, ".openclaw", "task-artifacts");
}

export function createOpenClawAliasResolver(
  opts: AliasResolverOptions,
): AliasResolver {
  const aliases = opts.aliases;
  const artifactRoot = opts.artifactRoot ?? defaultArtifactRoot();
  const workerScript = opts.workerScript ?? DEFAULT_WORKER_SCRIPT;
  const nodeBinary = opts.nodeBinary ?? process.execPath;

  return (agentId, ctx): TaskDispatch | undefined => {
    const rule = aliases[agentId];
    if (!rule) return undefined;

    const taskArtifactDir = path.join(artifactRoot, ctx.goalId, ctx.taskId);
    // The artifact dir contains spec.json (full prompt + raw args + env)
    // and worker.log (redacted, but still sensitive). Owner-only.
    fs.mkdirSync(taskArtifactDir, { recursive: true, mode: 0o700 });
    try {
      // mkdirSync(recursive: true) ignores `mode` on dirs that already
      // exist. Force the tightening every time.
      fs.chmodSync(taskArtifactDir, 0o700);
    } catch {
      // Best-effort — chmod can fail on filesystems that ignore mode
      // bits (e.g. some network mounts). Falling through is correct: the
      // dir at least won't be wider than the previous run's mode.
    }
    const specPath = path.join(taskArtifactDir, "spec.json");
    const handoffPath = path.join(taskArtifactDir, "handoff.json");

    const timeoutMs =
      (ctx.originalDispatch.mode === "exec" &&
        ctx.originalDispatch.timeoutMs) ||
      rule.timeoutMs ||
      3_600_000;

    const cwd =
      (ctx.originalDispatch.mode === "exec" && ctx.originalDispatch.cwd) ||
      ctx.cwd ||
      process.cwd();

    const spec = {
      alias: agentId,
      taskId: ctx.taskId,
      goalId: ctx.goalId,
      taskName: ctx.taskName,
      task: ctx.task,
      cwd,
      artifactDir: taskArtifactDir,
      timeoutMs,
      binary: rule.binary,
      args: rule.args,
      env: rule.env ?? {},
      prompt_template: rule.promptTemplate,
      final_message_arg: rule.finalMessageArg ?? null,
      completion_marker: `DIGITAL_ME_EXEC_OK ${agentId} ${ctx.taskId}`,
    };
    // spec.json carries the raw prompt + unredacted args + env. The worker
    // reads it back, so we can't sanitize the on-disk content — but we can
    // ensure only the owner can read it.
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      // writeFileSync only honors `mode` when creating the file. Re-tighten
      // for the case where spec.json already existed (rerun of same task).
      fs.chmodSync(specPath, 0o600);
    } catch {
      // see mkdir comment above
    }

    return {
      mode: "exec",
      agentId,
      command: [nodeBinary, workerScript, specPath],
      cwd,
      env: rule.env,
      timeoutMs: timeoutMs + 300_000, // grace period for worker overhead
      verify: {
        command: ["/bin/test", "-s", handoffPath],
        cwd,
        timeoutMs: 30_000,
        expectedExitCode: 0,
      },
    };
  };
}
