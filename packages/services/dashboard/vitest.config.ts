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
        // Bootstrap only: binds real loopback ports and spawns the brain proxy
        // at import time; the app it serves is built and tested via app.ts.
        "src/server/server.ts",
        "src/server/lib.ts", // pure re-export barrel over drift-status.ts (no logic)
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
