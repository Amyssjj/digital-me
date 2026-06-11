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
