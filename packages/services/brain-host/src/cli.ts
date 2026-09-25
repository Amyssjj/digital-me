/**
 * Process entry (excluded from coverage: wiring only). Every decision lives
 * in cli-args.ts, config.ts, runtime.ts and http-app.ts, all unit-tested.
 */

import { createRequire } from "node:module";
import { parseArgs, USAGE } from "./cli-args.js";
import { checkServeConfig, loadConfig } from "./config.js";
import { startServer } from "./http-server.js";
import { BrainHostRuntime } from "./runtime.js";

// vitest/vite does not treat node:sqlite as a builtin; require() sidesteps that.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const log = (line: string): void => {
  process.stderr.write(`[brain-host] ${line}\n`);
};

export async function main(argv: readonly string[]): Promise<number> {
  const cmd = parseArgs(argv);
  if (cmd.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (cmd.kind === "error") {
    process.stderr.write(`brain-host: ${cmd.message}\n\n${USAGE}\n`);
    return 2;
  }
  const config = loadConfig(process.env);
  const offline = cmd.kind === "status" ? true : cmd.offline;
  const runtime = new BrainHostRuntime({
    config,
    offline,
    openDb: (p) => new DatabaseSync(p),
    log,
    orchestrator: cmd.kind === "serve" && cmd.orchestrator,
  });

  switch (cmd.kind) {
    case "index": {
      const r = await runtime.index(cmd.force);
      process.stdout.write(`${JSON.stringify({ ...r, provenance: runtime.store.getProvenance(), db: config.dbPath })}\n`);
      return 0;
    }
    case "search": {
      const env = await runtime.invoke("memory_search", { query: cmd.query, limit: cmd.limit });
      if (!env.ok) {
        process.stderr.write(`brain-host: ${env.error.message}\n`);
        return 1;
      }
      if (cmd.json) {
        process.stdout.write(`${JSON.stringify(env.result.details, null, 2)}\n`);
      } else {
        const results = env.result.details.results as { relPath: string; score: number; startLine: number; endLine: number; title: string }[];
        for (const h of results) process.stdout.write(`${h.score.toFixed(4)}  ${h.relPath}#L${h.startLine}-L${h.endLine}  ${h.title}\n`);
      }
      return 0;
    }
    case "status":
      process.stdout.write(`${JSON.stringify(runtime.health(), null, 2)}\n`);
      return 0;
    case "serve": {
      const check = checkServeConfig(config);
      if (!check.ok) {
        process.stderr.write(`brain-host: ${check.message}\n`);
        return 2;
      }
      for (const warning of check.warnings) log(warning);
      const port = cmd.port ?? config.port;
      const server = await startServer({ runtime, token: check.token, host: config.host, port, log });
      runtime.startIndexRefresh();
      const toolList = ["memory_search", "memory_get", "wiki", ...(runtime.orchestrator?.tools.keys() ?? [])];
      log(`serving http://${config.host}:${port} (tools: ${toolList.join(", ")}; scheduler ${config.schedulerEnabled ? "ON" : "off"})`);
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          runtime.close();
          server.close(() => resolve());
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
  }
}
