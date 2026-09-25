/**
 * Mounts the brain-orchestrator (goals, tasks, workflows, schedules, agents,
 * learnings, traces, M1) inside brain-host: opens brain.db, runs the
 * migrations, builds the runtime-agnostic tool descriptors, and owns the
 * scheduler tick. This is the code the openclaw plugin template used to
 * host; here it runs without a plugin loader.
 *
 * Dispatch in Phase 2 is exec-only. Spawn tasks are left `ready` (returns
 * false) so nothing double-dispatches while openclaw still owns the spawn
 * path; the cli-resume dispatcher replaces it in Phase 4. Because of that, an
 * ENABLED schedule whose workflow has a spawn step can never complete under
 * brain-host (its run sits `ready` until the stall watchdog fails it), so the
 * mount lints for those at startup, warns per schedule, and lists them on
 * /health as `orchestrator.spawnSchedules`.
 *
 * The scheduler tick is OFF unless explicitly enabled: exactly one process
 * may tick a brain.db at a time, or schedules double-fire.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  AGENTS_MIGRATIONS,
  buildBrainOrchestratorTools,
  createAgentsStore,
  createGoalsStore,
  createLearningsStore,
  createM1EventsStore,
  createSchedulesStore,
  createTasksStore,
  createTracesStore,
  createWorkflowsStore,
  GOALS_MIGRATIONS,
  instantiateWorkflow as instantiateWorkflowHandler,
  LEARNINGS_MIGRATIONS,
  M1_EVENTS_MIGRATIONS,
  dispatchByMode,
  registerMigration,
  resetMigrationRegistryForTests,
  runMigrations,
  SCHEDULES_MIGRATIONS,
  TASKS_MIGRATIONS,
  tick as schedulerTick,
  TRACES_MIGRATIONS,
  WORKFLOWS_MIGRATIONS,
  type AliasResolver,
  type BrainOrchestratorPluginDeps,
  type BrainTool,
  type Dispatcher,
  type MCPToolResult,
  type SchedulerRuntime,
  type SchedulesStore,
  type TickResult,
  type WorkflowInstantiateResult,
  type WorkflowsStore,
} from "@digital-me/brain-orchestrator";
import { createOpenClawAliasResolver, createOpenClawDispatcher, defaultArtifactRoot, type CliAliasConfig } from "@digital-me/runtime-openclaw";
import * as YAML from "yaml";
import { errorMessage } from "./errors.js";
import { execRun as defaultExecRun, type ExecRunArgs, type ExecRunResult } from "./exec-run.js";

export type Logger = (level: "info" | "warn" | "error", message: string) => void;

export type OrchestratorOptions = {
  readonly db: DatabaseSync;
  /**
   * Directory containing config.yaml (cli_exec_aliases). Also the working
   * directory for exec tasks whose dispatch carries no cwd: without it the
   * child would inherit this process's cwd, which under launchd is the
   * brain-host package directory (Claude Code's working-directory policy
   * then blocks the worker's shell reads of the wiki and its staging files).
   */
  readonly wikiRoot: string;
  readonly log: Logger;
  readonly stallThresholdMs: number;
  readonly execRun?: (args: ExecRunArgs) => Promise<ExecRunResult>;
  readonly now?: () => number;
  readonly readFile?: (path: string) => string;
  readonly exists?: (path: string) => boolean;
};

export type OpenBrainDb = (path: string) => DatabaseSync;

/** The dispatcher runtime logs at four levels; brain-host's logger has three. */
export function normalizeLevel(level: "info" | "warn" | "error" | "debug"): "info" | "warn" | "error" {
  return level === "debug" ? "info" : level;
}

/** Phase 2 has no spawn engine; the dispatcher never calls this, but the runtime contract requires it. */
export async function unsupportedSpawn(): Promise<never> {
  throw new Error("spawn dispatch is not available in brain-host (Phase 2: exec only)");
}

/** Open (creating directories as needed) and migrate a brain.db. */
export function openBrainDb(dbPath: string, open: OpenBrainDb): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = open(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  resetMigrationRegistryForTests();
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
  return db;
}

/** An enabled schedule brain-host cannot complete: its workflow has spawn step(s). */
export type SpawnScheduleFinding = {
  readonly scheduleId: string;
  readonly scheduleName: string;
  readonly workflowId: string;
  readonly stepKeys: readonly string[];
};

/**
 * Enabled schedules whose workflow_step_templates contain `mode: "spawn"`.
 * Pure read; the caller decides whether to log.
 */
export function findSpawnSchedules(schedules: SchedulesStore, workflows: WorkflowsStore): SpawnScheduleFinding[] {
  const out: SpawnScheduleFinding[] = [];
  for (const s of schedules.listAll()) {
    if (!s.enabled) continue;
    const stepKeys = workflows
      .listSteps(s.workflowId)
      .filter((step) => step.dispatch.mode === "spawn")
      .map((step) => step.stepKey);
    if (stepKeys.length === 0) continue;
    out.push({ scheduleId: s.id, scheduleName: s.name, workflowId: s.workflowId, stepKeys });
  }
  return out;
}

export function loadCliExecAliases(
  wikiRoot: string,
  log: Logger,
  io: { exists: (p: string) => boolean; readFile: (p: string) => string },
): Readonly<Record<string, CliAliasConfig>> {
  const configPath = join(wikiRoot, "config.yaml");
  if (!io.exists(configPath)) return {};
  try {
    const cfg = YAML.parse(io.readFile(configPath)) as { cli_exec_aliases?: Record<string, CliAliasConfig> } | null;
    return cfg?.cli_exec_aliases ?? {};
  } catch (err) {
    log("warn", `failed to read ${configPath}: ${errorMessage(err)}. Continuing without cli_exec_aliases.`);
    return {};
  }
}

export class Orchestrator {
  readonly tools: ReadonlyMap<string, BrainTool>;
  readonly aliasResolver: AliasResolver;
  private readonly deps: BrainOrchestratorPluginDeps;
  private readonly dispatcher: Dispatcher;
  private readonly log: Logger;
  private readonly stallThresholdMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private lastTick: TickResult | null = null;
  private lastTickError: string | null = null;
  private spawnSchedules: readonly SpawnScheduleFinding[] = [];

  constructor(opts: OrchestratorOptions) {
    this.log = opts.log;
    this.stallThresholdMs = opts.stallThresholdMs;
    const db = opts.db;
    const goals = createGoalsStore({ db });
    const tasks = createTasksStore({ db });
    const workflows = createWorkflowsStore({ db });
    const schedules = createSchedulesStore({ db });
    const agents = createAgentsStore({ db });
    const learnings = createLearningsStore({ db });
    const traces = createTracesStore({ db });
    const m1Events = createM1EventsStore({ db });
    const forward = (level: "info" | "warn" | "error" | "debug", msg: string): void => this.log(normalizeLevel(level), msg);
    const runtime: SchedulerRuntime = { log: forward };

    const execRun = opts.execRun ?? defaultExecRun;
    const inner = createOpenClawDispatcher({
      goals,
      tasks,
      now: opts.now,
      runtime: { log: forward, subagent: { run: unsupportedSpawn }, execRun },
      defaultCwd: opts.wikiRoot,
    });
    this.dispatcher = {
      dispatchSpawnTask: async (task) => {
        this.log("warn", `spawn task "${task.name}" left ready: brain-host dispatches exec tasks only`);
        return false;
      },
      dispatchExecTask: (task) => inner.dispatchExecTask(task),
      probeSessionLiveness: () => inner.probeSessionLiveness(),
    };

    const io = { exists: opts.exists ?? existsSync, readFile: opts.readFile ?? ((p: string) => readFileSync(p, "utf-8")) };
    // Per-task artifact dirs (spec.json, handoff.json) follow the shared
    // rule anchored at THIS host's wiki root: <wiki-root>/.data/task-artifacts,
    // or the legacy ~/.openclaw/task-artifacts while only that dir exists.
    this.aliasResolver = createOpenClawAliasResolver({
      aliases: loadCliExecAliases(opts.wikiRoot, this.log, io),
      defaultCwd: opts.wikiRoot,
      artifactRoot: defaultArtifactRoot(undefined, { ...process.env, DIGITAL_ME_WIKI_ROOT: opts.wikiRoot }, io.exists),
    });

    const deps: BrainOrchestratorPluginDeps & { readonly aliasResolver: AliasResolver } = {
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
      dispatcher: this.dispatcher,
      aliasResolver: this.aliasResolver,
      defaultStallThresholdMs: opts.stallThresholdMs,
      ...(opts.now ? { now: opts.now } : {}),
    };
    this.deps = deps;
    this.tools = new Map(buildBrainOrchestratorTools(deps).map((t) => [t.name, t]));
    this.lintSpawnSchedules();
  }

  /**
   * Startup lint: warn once per enabled schedule that brain-host cannot
   * complete because its workflow has spawn step(s). Re-runnable; the tick
   * refreshes the list silently so /health stays current after an operator
   * disables or converts a schedule.
   */
  lintSpawnSchedules(): readonly SpawnScheduleFinding[] {
    this.spawnSchedules = findSpawnSchedules(this.deps.schedules, this.deps.workflows);
    for (const f of this.spawnSchedules) {
      this.log(
        "warn",
        `schedule "${f.scheduleName}" (${f.scheduleId}) is enabled but workflow ${f.workflowId} has spawn step(s) ${f.stepKeys.join(", ")}: ` +
          `brain-host dispatches exec only, so every run will sit ready until the stall watchdog fails it. ` +
          `Convert the step to exec + a cli_exec_aliases agentId, or disable the schedule (tasks action=schedule_disable) until Phase 4 cli-resume dispatch.`,
      );
    }
    return this.spawnSchedules;
  }

  /** Execute one orchestrator tool by name. Undefined when the tool is not ours. */
  async execute(tool: string, args: Readonly<Record<string, unknown>>): Promise<MCPToolResult | undefined> {
    const t = this.tools.get(tool);
    return t ? t.execute(args) : undefined;
  }

  /** Instantiate a workflow from a schedule and dispatch its ready exec tasks. */
  readonly instantiateWorkflow = async (
    workflowId: string,
    variables: Readonly<Record<string, string>>,
  ): Promise<WorkflowInstantiateResult> => {
    const r = await instantiateWorkflowHandler(
      { ...this.deps, aliasResolver: this.aliasResolver },
      { templateId: workflowId, variables, origin: "schedule" },
    );
    if (!r.ok) return { ok: false, error: r.error };
    let dispatched = 0;
    for (const taskId of r.readyTaskIds) {
      // Just created by instantiateWorkflow, so it exists; manual / approval /
      // notify / wake tasks are human states the scheduler leaves alone.
      const task = this.deps.tasks.get(taskId)!;
      if (task.dispatch.mode !== "spawn" && task.dispatch.mode !== "exec") continue;
      // Dispatchers report failure by returning false / logging; they do not
      // throw, and stragglers are picked up by the tick's orphan sweep.
      if (await dispatchByMode(this.dispatcher, task)) dispatched++;
    }
    return { ok: true, goalId: r.goalId, taskCount: r.taskCount, dispatched };
  };

  async tick(): Promise<TickResult> {
    const result = await schedulerTick(
      {
        goals: this.deps.goals,
        schedules: this.deps.schedules,
        tasks: this.deps.tasks,
        workflows: this.deps.workflows,
        runtime: this.deps.runtime,
        dispatcher: this.dispatcher,
        instantiateWorkflow: this.instantiateWorkflow,
        traces: this.deps.traces,
        ...(this.deps.now ? { now: this.deps.now } : {}),
      },
      this.stallThresholdMs,
    );
    this.ticks++;
    this.lastTick = result;
    this.lastTickError = null;
    this.spawnSchedules = findSpawnSchedules(this.deps.schedules, this.deps.workflows);
    return result;
  }

  /** Start the periodic tick. Idempotent. */
  startScheduler(intervalMs: number, setTimer: typeof setInterval = setInterval): void {
    if (this.timer !== null) return;
    this.timer = setTimer(() => {
      void this.tick().catch((err) => {
        this.lastTickError = errorMessage(err);
        this.log("error", `tick failed: ${this.lastTickError}`);
      });
    }, intervalMs);
    this.timer.unref();
    this.log("info", `scheduler tick every ${intervalMs}ms (single-ticker rule: make sure no other host ticks this brain.db)`);
  }

  stopScheduler(clearTimer: typeof clearInterval = clearInterval): void {
    if (this.timer === null) return;
    clearTimer(this.timer);
    this.timer = null;
  }

  status(): Record<string, unknown> {
    return {
      tools: [...this.tools.keys()],
      scheduler: this.timer !== null ? "on" : "off",
      ticks: this.ticks,
      lastTick: this.lastTick,
      lastTickError: this.lastTickError,
      spawnSchedules: this.spawnSchedules,
    };
  }
}
