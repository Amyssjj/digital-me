import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // node:sqlite is experimental and absent from `module.builtinModules`;
    // mark all node:* specifiers as external so Vite doesn't try to bundle.
    server: {
      deps: {
        external: [/^node:/],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/server/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/server/index.ts",
        "src/server/types.ts",
        // §0→§G migration-window modules (see server.ts header): the .mc
        // duplicates and db.ts are legacy copies whose tested rewrites
        // (data.ts, drift-status.ts, brain-client.ts) sit at 100%; all of
        // these are deleted in the §G final pass.
        "src/server/server.ts", // composition root — binds ports at import time; untestable in-process
        "src/server/lib.ts", // pure re-export barrel over drift-status.ts (no logic)
        "src/server/db.ts", // legacy reads (@ts-nocheck) replaced by data.ts; kanban-data.test.ts still exercises it
        "src/server/data.mc.ts", // legacy duplicate of data.ts (tested rewrite at 100%)
        "src/server/drift-status.mc.ts", // legacy duplicate of drift-status.ts (tested rewrite at 100%)
        "src/server/brain-client.mc.ts", // legacy duplicate of brain-client.ts (tested rewrite at 100%)
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
