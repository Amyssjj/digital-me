// Flat ESLint config for the digital-me-os monorepo.
//
// Pragmatic initial rollout on a pre-1.0 codebase: keep the recommended
// *correctness* rules as errors (real bugs fail CI) but downgrade the
// high-churn *stylistic* rules to warnings so the harness lands green and can
// be tightened incrementally. Type-aware linting is intentionally NOT enabled
// (no parserOptions.project) to keep `pnpm lint` fast and project-config-free.
// `parserOptions.tsconfigRootDir` IS pinned below, but only so the parser never
// has to guess the repo root; it does not turn type-aware linting on.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      // Claude Code / the Claude desktop app keep git worktrees under
      // `.claude/worktrees/<name>/`. ESLint flat config does not ignore
      // dot-directories by default, so without this `eslint .` also lints
      // every worktree's copy of the repo and typescript-eslint sees several
      // candidate tsconfig roots ("Parsing error: No tsconfigRootDir was set,
      // and multiple candidate TSConfigRootDirs are present"). GitHub CI never
      // hits this because its checkout has no nested worktrees.
      ".claude/**",
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/*.config.{js,cjs,mjs,ts}",
      "**/vite-env.d.ts",
      "eslint.config.js",
      // esbuild-generated overlay bundles materialized into openclaw — these
      // are build outputs (minified import aliases), not hand-authored source.
      "packages/runtimes/openclaw/templates/**",
      // npm publish staging — the esbuild-bundled CLI artifact (build output).
      "packages/cli/npm-dist/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // Pin the TSConfig root to this config's own directory so
        // typescript-eslint never infers it from the files being linted (a
        // nested worktree would otherwise offer a second candidate root).
        // This is NOT `parserOptions.project`; type-aware linting stays off.
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Dead bindings are the cleanliness signal the audit asked for. The repo
      // is mid-cutover (legacy db.ts / *.mc.ts files + dead frontend are being
      // removed in parallel PRs), so surface these as WARNINGS for the initial
      // rollout rather than blocking CI on files that are already being deleted.
      // Tighten to "error" once the cutover lands.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      // High-churn stylistic rules → warnings for the initial rollout.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      // Empty catch blocks are an intentional "best-effort, ignore failure"
      // pattern in several spots; allow them, flag other empty blocks.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The dashboard cutover left a few legacy files marked `@ts-nocheck`
      // on purpose (db.ts, *.mc.ts); allow the directive rather than fail.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-nocheck": false, "ts-expect-error": "allow-with-description" },
      ],
    },
  },
  // Dashboard frontend runs in the browser.
  {
    files: ["packages/services/dashboard/src/frontend/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },
  // Test files lean on `any` for fixtures/mocks.
  {
    files: ["**/*.test.{ts,tsx}", "**/tests/**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
