import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Node's `node:sqlite` is experimental and isn't in `module.builtinModules`,
    // so vite tries to resolve it as a package. Mark all node:* specifiers as
    // external so Vite leaves them to Node's loader.
    server: {
      deps: {
        external: [/^node:/],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",
        "src/openclaw-compat/index.ts",
        "src/openclaw-compat/openclaw-compat-internal.ts",
        "src/openclaw-compat/types.ts",
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
