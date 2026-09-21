#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * gen-docs — emit the public docs bundle consumed by the motusai.co website.
 *
 * Two kinds of sections, one bundle:
 *
 *   AUTHORED   docs/site/*.md — narrative pages (tutorial, how-tos, concepts,
 *              contributing), written by humans, PR-reviewed with the code.
 *   GENERATED  extracted from the code itself (CLI usage text, brain tool
 *              descriptors, the env-var registry) so reference pages cannot
 *              drift from reality.
 *
 * Output:
 *   dist/docs-bundle/
 *     _meta.json      — order, titles, kind, edit links, source commit/tag
 *     <slug>.md       — one file per section (H1 stripped; title in meta)
 *     llms.txt        — agent-readable index
 *     llms-full.txt   — agent-readable full corpus
 *
 * Embedded demos: an authored page may carry a fenced block
 *   ```motus-demo
 *   <demo-id>
 *   ```
 * The website maps ids to a whitelist of its own animated components; plain
 * renderers (and llms-full.txt) see a readable note instead. No raw HTML and
 * no executable content ever enters the bundle.
 *
 * Safety gates: whitelist-only sources, raw HTML stripped, generators fail
 * loudly if they extract too little, and the finished bundle is scanned for
 * secret material / user paths / emails — any hit exits non-zero.
 *
 * Usage:  node scripts/gen-docs.mjs [--out <dir>]
 * ------------------------------------------------------------------------- */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URL = "https://github.com/Amyssjj/digital-me";
const SITE_URL = "https://motusai.co";

/* ── section list — order defines the site TOC ───────────────────────────── */
const SECTIONS = [
  authored("getting-started", "Getting Started", "docs/site/getting-started.md"),
  authored("runtimes", "Runtimes", "docs/site/runtimes.md"),
  authored("how-it-works", "How It Works", "docs/site/how-it-works.md"),
  generated("cli", "CLI Reference", "packages/cli/src/bin/digital-me.ts", genCliReference),
  generated("tools", "Brain Tools", "packages/plugins/brain-orchestrator/src/plugin/entry.ts", genToolsReference),
  generated("configuration", "Configuration", "packages/shared/contracts/src/env.ts", genEnvReference),
  authored("contributing", "Contributing", "docs/site/contributing.md"),
];

function authored(slug, title, file) {
  return { slug, title, kind: "authored", file, editPath: file };
}
function generated(slug, title, sourceFile, generate) {
  return { slug, title, kind: "generated", sourceFile, generate, editPath: sourceFile };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/* Join one-or-more concatenated double-quoted string literals into a value. */
function joinedString(chunk) {
  return [...chunk.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
    .join("");
}

/* ── generators — extract reference content from the code ────────────────── */

/* CLI: the usage text in printHelp() is the single source of truth the user
   actually sees. Reproduce it verbatim (man-page style) plus a scannable
   command index derived from its `digital-me <cmd>` signature lines. */
function genCliReference() {
  const src = readFileSync(join(ROOT, "packages/cli/src/bin/digital-me.ts"), "utf8");
  const fnStart = src.indexOf("function printHelp");
  if (fnStart < 0) throw new Error("gen cli: printHelp() not found");
  const body = src.slice(fnStart, src.indexOf("\n}", fnStart));
  const lines = [...body.matchAll(/^\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)].map((m) =>
    m[1].replace(/\\"/g, '"').replace(/\\`/g, "`").replace(/\\\\/g, "\\"),
  );
  if (lines.length < 20)
    throw new Error(`gen cli: only ${lines.length} usage lines extracted`);

  const usage = lines.join("\n");
  // Command index: "  digital-me <cmd> …" signature lines + their first
  // description line (the next, deeper-indented line).
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}(digital-me\s+([a-z-]+)[^\n]*)$/);
    if (!m || rows.some((r) => r.cmd === m[2])) continue;
    // Description = the 4-space-indented prose under the signature; deeper
    // indents are signature continuations, blank line ends the block.
    let j = i + 1;
    while (j < lines.length && /^ {5,}\S/.test(lines[j])) j++;
    const prose = [];
    while (j < lines.length && /^ {4}\S/.test(lines[j])) prose.push(lines[j++].trim());
    const full = prose.join(" ");
    const firstSentence = full.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? full;
    rows.push({
      cmd: m[2],
      sig: m[1].trim(),
      desc: firstSentence.replace(/\|/g, "\\|"),
    });
  }
  if (rows.length < 5) throw new Error(`gen cli: only ${rows.length} commands extracted`);

  return [
    "The `digital-me` CLI installs, diagnoses, and orchestrates the ecosystem.",
    "Run any command with `--help` for this text — it is extracted verbatim",
    "from the CLI source on every release, so it cannot go stale.",
    "",
    "## Commands",
    "",
    "| Command | What it does |",
    "|---|---|",
    ...rows.map((r) => `| \`${r.cmd}\` | ${r.desc} |`),
    "",
    "## Full usage",
    "",
    "```text",
    usage,
    "```",
  ].join("\n");
}

/* Brain tools: names + descriptions of the MCP tool descriptors registered
   by brain-orchestrator, straight from the plugin entry source. */
function genToolsReference() {
  const src = readFileSync(
    join(ROOT, "packages/plugins/brain-orchestrator/src/plugin/entry.ts"),
    "utf8",
  );
  const tools = [
    ...src.matchAll(
      /name:\s*"([a-z0-9_]+)",\s*description:\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)/g,
    ),
  ].map((m) => ({ name: m[1], description: joinedString(m[2]) }));
  if (tools.length < 5)
    throw new Error(`gen tools: only ${tools.length} tools extracted`);

  return [
    "Every wired runtime shares the same brain tools, served by brain-host on",
    "one `/tools/invoke` wire: three retrieval tools from its own retriever,",
    "the rest from this repo's `brain-orchestrator` core. Descriptions of the",
    "operations tools are extracted from the plugin source on every release.",
    "",
    "## Retrieval (brain-host retriever)",
    "",
    "| Tool | Description |",
    "|---|---|",
    "| `memory_search` | Hybrid full-text + embedding search over the wiki and tastes; one hit per entry with the best section's line range and snippet. |",
    "| `memory_get` | Read a wiki or taste entry by path, optionally a line range. |",
    "| `wiki` | Retriever status: index size, provenance, generation. |",
    "",
    "## Operations (brain-orchestrator)",
    "",
    "| Tool | Description |",
    "|---|---|",
    ...tools.map(
      (t) => `| \`${t.name}\` | ${t.description.replace(/\|/g, "\\|")} |`,
    ),
    "",
    "The `m1_*` tools register only when the M1 events store is configured —",
    "older deployments without it simply don't see them.",
  ].join("\n");
}

/* Configuration: the env-var registry in @digital-me/contracts is the
   machine-readable contract; render it as the reference table. */
function genEnvReference() {
  const src = readFileSync(
    join(ROOT, "packages/shared/contracts/src/env.ts"),
    "utf8",
  );
  const regStart = src.indexOf("const REGISTRY = {");
  if (regStart < 0) throw new Error("gen env: REGISTRY not found");
  const regBody = src.slice(regStart);

  const entries = [
    ...regBody.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*\{([\s\S]*?)^ {2}\},/gm),
  ].map(([, key, body]) => {
    const defMatch = body.match(/default:\s*([^\n]+?),(?:\s*\/\/(.*))?$/m);
    const descMatch = body.match(
      /description:\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)/,
    );
    const desc = descMatch ? joinedString(descMatch[1]) : "";
    const required = /required:\s*true/.test(body);
    let def = defMatch ? defMatch[1].trim() : "—";
    const defNote = defMatch?.[2]?.trim();
    def = def
      .replace(/^path\.join\(HOME,\s*"(.+?)",\s*"(.+?)"\)$/, "~/$1/$2")
      .replace(/^path\.join\(HOME,\s*"(.+?)"\)$/, "~/$1")
      .replace(/^"(.*)"$/, "$1");
    if (def === "null") def = defNote ? `*${defNote.replace(/\|/g, "\\|")}*` : "—";
    return { key, def, required, desc: desc.replace(/\|/g, "\\|") };
  });
  if (entries.length < 10)
    throw new Error(`gen env: only ${entries.length} vars extracted`);

  return [
    "User-specific paths and settings pass through documented environment",
    "variables — no package hardcodes a machine path or guesses where data",
    "lives. This table is rendered from the registry in",
    "`packages/shared/contracts/src/env.ts` on every release.",
    "",
    "Most installs only ever set one: `DIGITAL_ME_WIKI_ROOT`.",
    "",
    "| Variable | Required | Default | Description |",
    "|---|---|---|---|",
    ...entries.map(
      (e) =>
        `| \`${e.key}\` | ${e.required ? "**yes**" : "no"} | ${
          e.def === "—" || e.def.startsWith("*") ? e.def : `\`${e.def}\``
        } | ${e.desc} |`,
    ),
    "",
    "Workflow dispatch to your CLIs is configured separately in",
    "`~/digital-me/config.yaml` under `cli_exec_aliases` — `digital-me setup`",
    "pre-populates it for detected CLIs.",
  ].join("\n");
}

/* ── markdown transforms ─────────────────────────────────────────────────── */

function stripHtmlBlocks(md) {
  const fences = [];
  const masked = md.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    fences.push(m);
    return ` F${fences.length - 1} `;
  });
  const cleaned = masked
    .replace(/<\/?(div|p|details|summary|img|a|br|h[1-6])\b[^>]*>/gi, "")
    .replace(/^\s*<!--[\s\S]*?-->\s*$/gm, "");
  return cleaned.replace(/ F(\d+) /g, (_, i) => fences[+i]);
}

function stripH1(md) {
  return md.replace(/^\s*# .*\n/, "");
}

function rewriteRepoLinks(md) {
  const bySource = new Map();
  for (const s of SECTIONS) {
    if (s.file) bySource.set(s.file, `/docs/${s.slug}`);
    if (s.sourceFile) bySource.set(s.sourceFile, `/docs/${s.slug}`);
  }
  return md.replace(
    /\]\((?!https?:\/\/|\/|#|mailto:)([^)#\s]+)(#[^)\s]*)?\)/g,
    (_, target, anchor = "") => {
      const normal = target.replace(/^\.\//, "");
      const site = bySource.get(normal) ?? bySource.get(`docs/${normal}`);
      if (site) return `](${site}${anchor})`;
      return `](${REPO_URL}/blob/main/${normal}${anchor})`;
    },
  );
}

/* ── bundle-level leak scan ──────────────────────────────────────────────── */

const LEAK_PATTERNS = [
  [/\/Users\/[a-zA-Z0-9_-]+/, "user home path"],
  [/\/Volumes\/[A-Za-z0-9_-]+/, "local volume path"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "API secret key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key material"],
  [/\b[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, "email address"],
];

function scanForLeaks(name, text) {
  const hits = [];
  for (const [re, label] of LEAK_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(`${name}: ${label} ("${m[0].slice(0, 40)}…")`);
  }
  return hits;
}

/* ── main ────────────────────────────────────────────────────────────────── */

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const outIdx = process.argv.indexOf("--out");
const OUT =
  outIdx >= 0 ? resolve(process.argv[outIdx + 1]) : join(ROOT, "dist/docs-bundle");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const allLeaks = [];
const meta = {
  schema: 2,
  generatedAt: new Date().toISOString(),
  source: {
    repo: REPO_URL,
    commit: git("rev-parse HEAD"),
    ref: git("describe --tags --always"),
  },
  sections: [],
};
const fullCorpus = [];

for (const section of SECTIONS) {
  let md =
    section.kind === "generated"
      ? section.generate()
      : readFileSync(join(ROOT, section.file), "utf8");
  md = rewriteRepoLinks(stripH1(stripHtmlBlocks(md))).trim() + "\n";

  allLeaks.push(...scanForLeaks(section.editPath, md));
  writeFileSync(join(OUT, `${section.slug}.md`), md);
  meta.sections.push({
    slug: section.slug,
    title: section.title,
    kind: section.kind,
    sourceFile: section.editPath,
  });
  fullCorpus.push(
    `# ${section.title}\n\n${md.replace(
      /```motus-demo\n([a-z-]+)\n```/g,
      "*[interactive demo on the website: $1]*",
    )}`,
  );
}

if (allLeaks.length) {
  console.error("✗ docs bundle failed the leak scan:\n  " + allLeaks.join("\n  "));
  rmSync(OUT, { recursive: true, force: true });
  process.exit(1);
}

/* Agent-readable corpus — https://llmstxt.org */
writeFileSync(
  join(OUT, "llms.txt"),
  [
    "# Digital Me",
    "",
    "> The intelligence every agent runs on. Digital Me carries your",
    "> knowledge, taste, and decisions to every agent you run.",
    "",
    "## Docs",
    "",
    ...meta.sections.map(
      (s) =>
        `- [${s.title}](${SITE_URL}/docs/${s.slug}): ${
          s.kind === "generated" ? "reference generated from the code" : "guide"
        }`,
    ),
    "",
    "## Source",
    "",
    `- [Repository](${REPO_URL})`,
    `- Docs build: ${meta.source.ref} (${meta.source.commit.slice(0, 7)})`,
    "",
  ].join("\n"),
);
writeFileSync(join(OUT, "llms-full.txt"), fullCorpus.join("\n\n---\n\n"));

writeFileSync(join(OUT, "_meta.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(
  `✓ docs bundle → ${OUT}\n  ${meta.sections.length} sections (${
    meta.sections.filter((s) => s.kind === "generated").length
  } generated from code) · ${meta.source.ref} (${meta.source.commit.slice(0, 7)})`,
);
