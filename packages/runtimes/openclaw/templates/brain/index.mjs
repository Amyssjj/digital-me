// digital-me-brain — openclaw plugin entry.
//
// Reads ${DIGITAL_ME_WIKI_ROOT}/config.yaml at plugin-load time, wires
// brain-orchestrator into openclaw via:
//   - SQLite stores at ${dbPath} (default ~/.openclaw/data/brain.db)
//   - openclaw Dispatcher (subagent.run + execRun)
//   - cli-exec AliasResolver populated from config.cli_exec_aliases
//   - Five MCP tools: tasks, agent_identify, learning_capture,
//     traces_record, traces_query — registered via api.registerTool.
//   - Scheduler tick on a periodic hook (default 60s).
//
// Copy this file + openclaw.plugin.json into your openclaw extensions
// dir (e.g. ~/openclaw/extensions/digital-me-brain/) — the
// `digital-me install --runtime openclaw` command does this for you.
//
// Prerequisites:
//   1. openclaw installed (this file imports from its plugin SDK).
//   2. @digital-me/brain-orchestrator + @digital-me/runtime-openclaw
//      installed (pnpm install at the openclaw root if you symlinked
//      digital-me-os/packages/* into openclaw's workspace, or
//      `npm install @digital-me/runtime-openclaw` once published).
//   3. DIGITAL_ME_WIKI_ROOT set, with config.yaml present.

import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// YAML parser for ${wikiRoot}/config.yaml (cli_exec_aliases). Static import so
// esbuild bundles it into the materialized overlay — a runtime `require("yaml")`
// is NOT resolvable next to the bundled index.mjs and silently disables every
// cli alias (see infra wiki: run-local-cli-as-brain-exec-worker-via-cli-exec-aliases).
import * as YAML from "yaml";

// openclaw plugin SDK (the only openclaw-side import).
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// brain-orchestrator: stores, migrations, scheduler.
import {
  GOALS_MIGRATIONS,
  TASKS_MIGRATIONS,
  WORKFLOWS_MIGRATIONS,
  SCHEDULES_MIGRATIONS,
  AGENTS_MIGRATIONS,
  LEARNINGS_MIGRATIONS,
  TRACES_MIGRATIONS,
  M1_EVENTS_MIGRATIONS,
  createGoalsStore,
  createTasksStore,
  createWorkflowsStore,
  createSchedulesStore,
  createAgentsStore,
  createLearningsStore,
  createTracesStore,
  createM1EventsStore,
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
  tick as schedulerTick,
  instantiateWorkflow as instantiateWorkflowHandler,
} from "@digital-me/brain-orchestrator";

// runtime-openclaw: Dispatcher + alias resolver + tool builder.
import {
  buildOpenClawBrainTools,
  createOpenClawAliasResolver,
  createOpenClawDispatcher,
} from "@digital-me/runtime-openclaw";

// node:sqlite is experimental — load via createRequire to satisfy Vite/TS.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const DEFAULTS = {
  dbPath: path.join(os.homedir(), ".openclaw", "data", "brain.db"),
  stallThresholdMs: 60 * 60 * 1000, // 1h
  tickIntervalMs: 60 * 1000, // 1min
};

export default definePluginEntry({
  id: "digital-me-brain",
  name: "Digital Me Brain",
  description:
    "brain-orchestrator MCP tools (tasks, agent_identify, learning_capture, traces_record, traces_query) plus the scheduler tick.",
  register(api) {
    if (!api.runtime?.subagent) {
      api.logger.info("digital-me-brain: skip register — subagent runtime not available (build-time scan)");
      return;
    }

    // 1. Load config — env var or pluginConfig override.
    const wikiRoot =
      api.pluginConfig?.wikiRoot ||
      process.env.DIGITAL_ME_WIKI_ROOT ||
      path.join(os.homedir(), "digital-me");
    const dbPath = api.pluginConfig?.dbPath || DEFAULTS.dbPath;
    const stallThresholdMs =
      api.pluginConfig?.stallThresholdMs || DEFAULTS.stallThresholdMs;
    const tickIntervalMs =
      api.pluginConfig?.tickIntervalMs || DEFAULTS.tickIntervalMs;

    const configPath = path.join(wikiRoot, "config.yaml");
    let cliExecAliases = {};
    if (fs.existsSync(configPath)) {
      // Parse only when config is present. Keeps the plugin loadable on
      // systems where the wiki hasn't been initialized yet. YAML is bundled
      // (static import above) so this can't fail on a missing module.
      try {
        const cfg = YAML.parse(fs.readFileSync(configPath, "utf8"));
        cliExecAliases = cfg?.cli_exec_aliases ?? {};
      } catch (err) {
        api.logger.warn(
          `digital-me-brain: failed to read ${configPath}: ${err.message}. Continuing without cli_exec_aliases.`,
        );
      }
    }

    // 2. Open DB + run migrations.
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    resetMigrationRegistryForTests(); // safe — only no-op if no migrations registered
    for (const m of [
      ...GOALS_MIGRATIONS,
      ...TASKS_MIGRATIONS,
      ...WORKFLOWS_MIGRATIONS,
      ...SCHEDULES_MIGRATIONS,
      ...AGENTS_MIGRATIONS,
      ...LEARNINGS_MIGRATIONS,
      ...TRACES_MIGRATIONS,
      ...M1_EVENTS_MIGRATIONS,
    ]) {
      registerMigration(m);
    }
    runMigrations(db);

    // 3. Construct per-domain stores.
    const goals = createGoalsStore({ db });
    const tasks = createTasksStore({ db });
    const workflows = createWorkflowsStore({ db });
    const schedules = createSchedulesStore({ db });
    const agents = createAgentsStore({ db });
    const learnings = createLearningsStore({ db });
    const traces = createTracesStore({ db });
    const m1Events = createM1EventsStore({ db });

    // 4. Dispatcher + alias resolver (openclaw runtime).
    const runtime = {
      log: (level, msg) => api.logger[level === "debug" ? "info" : level](`digital-me-brain: ${msg}`),
    };
    const openClawDispatcherRuntime = {
      subagent: api.runtime.subagent,
      log: runtime.log,
      execRun: (params) =>
        new Promise((resolve) => {
          const [cmd, ...args] = params.command;
          execFile(
            cmd,
            args,
            {
              cwd: params.cwd ?? undefined,
              env: params.env ? { ...process.env, ...params.env } : undefined,
              timeout: params.timeoutMs ?? 300_000,
              maxBuffer: 10 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
              const timedOut = error?.killed === true;
              resolve({
                exitCode:
                  error?.code !== undefined ? (typeof error.code === "number" ? error.code : 1) : 0,
                timedOut,
                success: !error,
                stdout: stdout ?? "",
                stderr: stderr ?? "",
                error: error && !timedOut ? error.message : undefined,
              });
            },
          );
        }),
    };
    const dispatcher = createOpenClawDispatcher({
      goals,
      tasks,
      runtime: openClawDispatcherRuntime,
    });
    const aliasResolver = createOpenClawAliasResolver({
      aliases: cliExecAliases,
    });

    // 5. Compose deps + build tools + register them.
    const deps = {
      db,
      goals,
      tasks,
      workflows,
      schedules,
      agents,
      learnings,
      traces,
      m1Events,
      runtime,
      dispatcher,
      aliasResolver,
    };
    const tools = buildOpenClawBrainTools(deps);
    for (const tool of tools) {
      api.registerTool(tool);
    }
    api.logger.info(`digital-me-brain: registered ${tools.length} tools`);

    // 6. The scheduler's `instantiateWorkflow` callback: given a
    //    (workflowId, vars), create the goal + tasks via brain-orchestrator's
    //    handler, then dispatch the ready ones via openclaw's Dispatcher.
    //    Matches the pattern in `@digital-me/brain-orchestrator`'s router.ts
    //    schedule_tick handler so the standalone tools and the scheduler
    //    share semantics.
    const instantiateWorkflow = async (workflowId, vars) => {
      const r = await instantiateWorkflowHandler(deps, {
        templateId: workflowId,
        variables: vars,
        // Mark schedule-triggered runs (created_by = 'scheduler') so the
        // retention sweep never touches manual run_workflow goals.
        origin: "schedule",
      });
      if (!r.ok) return { ok: false, error: r.error };
      let dispatched = 0;
      for (const taskId of r.readyTaskIds) {
        const task = tasks.get(taskId);
        if (!task) continue;
        if (task.dispatch.mode !== "spawn" && task.dispatch.mode !== "exec") {
          continue;
        }
        try {
          const ok =
            task.dispatch.mode === "exec"
              ? await dispatcher.dispatchExecTask(task)
              : await dispatcher.dispatchSpawnTask(task);
          if (ok) dispatched++;
        } catch (err) {
          // Don't fail the whole instantiation on per-task dispatch error;
          // the scheduler's orphan-dispatch sweep will pick stragglers up.
          api.logger.warn(
            `digital-me-brain: dispatch failed for "${task.name}": ${err.message}`,
          );
        }
      }
      return {
        ok: true,
        goalId: r.goalId,
        taskCount: r.taskCount,
        dispatched,
      };
    };

    // 7. Scheduler tick. We use a simple setInterval — openclaw plugins
    //    that need fancier scheduling (per-host, leader-elected) can
    //    override by registering on the gateway's heartbeat event
    //    instead.
    const tickHandle = setInterval(async () => {
      try {
        await schedulerTick(
          {
            goals,
            schedules,
            tasks,
            workflows,
            runtime,
            dispatcher,
            instantiateWorkflow,
            // Retention sweep deps: traces lets the hourly sweep also drop
            // trace rows of expired cron goals; the window defaults to 7d.
            traces,
            cronGoalRetentionMs: api.pluginConfig?.cronGoalRetentionMs,
          },
          stallThresholdMs,
        );
      } catch (err) {
        api.logger.error(`digital-me-brain: tick failed: ${err.message}`);
      }
    }, tickIntervalMs);
    tickHandle.unref?.();

    // 8. Cleanup on plugin teardown.
    api.lifecycle?.onShutdown?.(() => {
      clearInterval(tickHandle);
      try {
        db.close();
      } catch {
        // best-effort
      }
      api.logger.info("digital-me-brain: shutdown clean");
    });
  },
});
