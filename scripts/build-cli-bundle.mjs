#!/usr/bin/env node
/**
 * Build a self-contained, publishable npm artifact for `@digital-me/cli`.
 *
 * The CLI depends on sibling `workspace:*` packages that are NOT published to
 * npm. Instead of publishing the whole monorepo, we esbuild-bundle the bin
 * entry with every workspace dep INLINED, leaving only `esbuild` external
 * (it's used at runtime to bundle the openclaw plugin overlay, and ships its
 * own platform binary, so it must stay a real dependency).
 *
 * Output: packages/cli/npm-dist/ — a staging dir with the bundle + a trimmed
 * package.json (no workspace:* deps) ready for `npm publish` / `npm pack`.
 *
 * Usage: node scripts/build-cli-bundle.mjs
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = path.join(repoRoot, "packages", "cli");
const outDir = path.join(cliRoot, "npm-dist");
const srcPkg = JSON.parse(readFileSync(path.join(cliRoot, "package.json"), "utf-8"));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "bin"), { recursive: true });

await build({
  entryPoints: [path.join(cliRoot, "src", "bin", "digital-me.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // esbuild ships a native binary + is used at runtime → keep it a real dep,
  // don't inline it. Node builtins are auto-externalized for platform=node.
  external: ["esbuild"],
  outfile: path.join(outDir, "bin", "digital-me.js"),
  legalComments: "none",
  logLevel: "info",
});

// The source bin carries the shebang; esbuild preserves it. Ensure +x.
chmodSync(path.join(outDir, "bin", "digital-me.js"), 0o755);

// Trimmed, registry-ready manifest: workspace:* deps are inlined into the
// bundle, so the published package only needs esbuild at install time.
const publishPkg = {
  // Published as the unscoped product name (`npm i -g digital-me`); the
  // workspace package keeps its internal @digital-me/cli name.
  name: "digital-me",
  version: srcPkg.version,
  description: srcPkg.description,
  license: srcPkg.license,
  type: "module",
  bin: { "digital-me": "./bin/digital-me.js" },
  files: ["bin"],
  engines: srcPkg.engines ?? { node: ">=22.5" },
  dependencies: { esbuild: srcPkg.dependencies?.esbuild ?? "^0.28.0" },
  publishConfig: { access: "public", provenance: true },
  // Carry repository metadata through only if the source package declares it —
  // never hardcode an owner here (keeps the sanitize gate + forks clean).
  ...(srcPkg.repository ? { repository: srcPkg.repository } : {}),
};
writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(publishPkg, null, 2) + "\n",
  "utf-8",
);

for (const f of ["README.md", "LICENSE"]) {
  const from = existsSync(path.join(cliRoot, f)) ? path.join(cliRoot, f) : path.join(repoRoot, f);
  if (existsSync(from)) copyFileSync(from, path.join(outDir, f));
}

console.log(`[build-cli-bundle] wrote ${outDir} (bin + trimmed package.json)`);
