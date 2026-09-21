import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      // Process wiring only: the CLI entry and the listen() call. Every
      // decision they make lives in cli-args.ts / http-app.ts and is covered.
      exclude: ["src/**/*.test.ts", "src/**/test-fixtures.ts", "src/index.ts", "src/cli.ts", "src/http-server.ts"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
