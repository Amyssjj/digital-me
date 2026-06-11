#!/usr/bin/env node
/**
 * backfill-route-frontmatter.mjs
 *
 * One-shot migration: for each legacy ### entry with a `**Route:**` marker
 * in `~/.openclaw/shared_learnings.legacy/*.md`, find its already-migrated
 * wiki counterpart (by content fingerprint) and add a `route:` field to
 * the wiki entry's YAML frontmatter.
 *
 * Why this exists:
 *   The 2026-05-11 legacy retirement migrated entry CONTENT into the wiki
 *   but did not preserve the per-tool `Route:` metadata. The new
 *   `digital-me-recall` plugin's Hook C (per-tool route lookup) depends
 *   on a non-empty hashmap of `route:`-tagged entries, so we backfill the
 *   metadata before the plugin ships.
 *
 * Usage:
 *   node scripts/backfill-route-frontmatter.mjs              # dry-run
 *   node scripts/backfill-route-frontmatter.mjs --live       # apply
 *   node scripts/backfill-route-frontmatter.mjs --legacy=<path> --wiki=<path>
 *
 * Outputs (dry-run):
 *   - stdout: per-entry match decision (matched, unmatched, ambiguous, already-has-route)
 *   - /tmp/route-backfill-<ts>.diff: unified diff of proposed wiki edits
 *
 * Outputs (live):
 *   - applies in-place edits to wiki entries
 *   - stdout: summary { updated, already-had-route, unmatched, ambiguous, errors }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Map();
for (const a of process.argv.slice(2)) {
  if (a === "--live") args.set("live", "true");
  else if (a.startsWith("--legacy=")) args.set("legacy", a.slice(9));
  else if (a.startsWith("--wiki=")) args.set("wiki", a.slice(7));
  else if (a === "-h" || a === "--help") {
    console.log(
      "Usage: backfill-route-frontmatter.mjs [--live] [--legacy=<path>] [--wiki=<path>]",
    );
    process.exit(0);
  }
}

const LEGACY_DIR =
  args.get("legacy") ??
  path.join(os.homedir(), ".openclaw", "shared_learnings.legacy");
const WIKI_DIR =
  args.get("wiki") ?? path.join(os.homedir(), "digital-me", "wiki");
const LIVE = args.get("live") === "true";

const SKIP_FILES = new Set([
  "README.md",
  "CLAW_SKILLPACK.md",
  "shared_learnings_meta.md",
]);
const SKIP_PREFIXES = ["yt_"]; // yt_*_rules.md use a different format

// ─── Parse legacy entries ───────────────────────────────────────────────

function readLegacyEntries(dir) {
  const out = [];
  if (!fs.existsSync(dir)) {
    throw new Error(`Legacy dir not found: ${dir}`);
  }
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    if (SKIP_FILES.has(name)) continue;
    if (SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = path.join(dir, name);
    const text = fs.readFileSync(full, "utf-8");
    // Split on lines starting with "### " to get per-entry chunks.
    const chunks = text.split(/^### /m).slice(1);
    for (const c of chunks) {
      const titleEnd = c.indexOf("\n");
      if (titleEnd === -1) continue;
      const title = c.slice(0, titleEnd).trim();
      const routeMatch = c.match(/^[-*]?\s*\*\*Route:\*\*\s*(.+)$/m);
      if (!routeMatch) continue;
      const route = routeMatch[1].trim();
      if (route.toLowerCase() === "none") continue;
      const ruleMatch = c.match(
        /^[-*]?\s*\*\*(?:The Rule\/Workaround|The Rule|Rule\/Workaround|Rule):\*\*\s*(.+)$/m,
      );
      const rule = ruleMatch ? ruleMatch[1].trim() : "";
      out.push({ sourceFile: name, title, route, rule });
    }
  }
  return out;
}

// ─── Read wiki entries ──────────────────────────────────────────────────

function* walkMd(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkMd(full);
    } else if (
      ent.isFile() &&
      ent.name.endsWith(".md") &&
      !ent.name.startsWith("_")
    ) {
      yield full;
    }
  }
}

function readWikiEntries(dir) {
  const out = [];
  if (!fs.existsSync(dir)) throw new Error(`Wiki dir not found: ${dir}`);
  for (const f of walkMd(dir)) {
    try {
      const text = fs.readFileSync(f, "utf-8");
      out.push({ path: f, text });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

// ─── Fingerprint matching ───────────────────────────────────────────────

function tokenize(s) {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
}

function scoreMatch(needleTokens, hayContent) {
  const hay = hayContent.toLowerCase();
  let hits = 0;
  for (const w of needleTokens) {
    if (hay.includes(w)) hits++;
  }
  return hits / needleTokens.size;
}

function findBestWikiMatch(entry, wikiEntries) {
  const fingerprintSource = (entry.rule.slice(0, 100) + " " + entry.title).trim();
  const tokens = tokenize(fingerprintSource);
  if (tokens.size < 3) return { match: null, score: 0, ambiguous: false };
  // Threshold = 0.65: drops the one false positive seen at 0.63 (env-var
  // contract entry mis-tagged with a mission-control python route — too
  // much surface-word overlap, different topic) while keeping borderline
  // plausible matches at 0.65-0.70. The cost of a slightly-mismatched
  // route tag is low (Hook B / memory_search still covers the content);
  // the cost of dropping a legitimate match is similar magnitude.
  const scored = [];
  for (const we of wikiEntries) {
    const score = scoreMatch(tokens, we.text);
    if (score >= 0.65) scored.push({ we, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { match: null, score: 0, ambiguous: false };
  const best = scored[0];
  const ambiguous =
    scored.length > 1 && scored[1].score >= best.score - 0.05;
  return { match: best.we, score: best.score, ambiguous };
}

// ─── Frontmatter edit ───────────────────────────────────────────────────

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  return { raw: m[0], yaml: m[1], rest: text.slice(m[0].length) };
}

function hasRouteField(yaml) {
  return /^route:/m.test(yaml);
}

function insertRouteField(yaml, route) {
  // Insert `route: <value>` after `tags:` block if present, else before
  // `priority:` if present, else at the end.
  const lines = yaml.split("\n");
  const tagsIdx = lines.findIndex((l) => l.startsWith("tags:"));
  if (tagsIdx !== -1) {
    // Skip past inline tags or list-form tags
    let insertAt = tagsIdx + 1;
    while (
      insertAt < lines.length &&
      (lines[insertAt].startsWith("-") || lines[insertAt].startsWith("  -"))
    ) {
      insertAt++;
    }
    lines.splice(insertAt, 0, `route: ${quoteRouteIfNeeded(route)}`);
    return lines.join("\n");
  }
  const priorityIdx = lines.findIndex((l) => l.startsWith("priority:"));
  if (priorityIdx !== -1) {
    lines.splice(priorityIdx, 0, `route: ${quoteRouteIfNeeded(route)}`);
    return lines.join("\n");
  }
  lines.push(`route: ${quoteRouteIfNeeded(route)}`);
  return lines.join("\n");
}

function quoteRouteIfNeeded(route) {
  // YAML scalars containing special chars (:, ", #, etc.) need quoting.
  if (/["#:&*!|>]|^\s|\s$/.test(route)) {
    return `'${route.replace(/'/g, "''")}'`;
  }
  return route;
}

// ─── Diff emission (dry-run) ────────────────────────────────────────────

function unifiedDiff(before, after, fromName, toName) {
  // Minimal context diff — we only insert one line, so this stays small.
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const out = [`--- ${fromName}`, `+++ ${toName}`];
  // Find the first diverging line
  let i = 0;
  while (
    i < beforeLines.length &&
    i < afterLines.length &&
    beforeLines[i] === afterLines[i]
  ) {
    i++;
  }
  const ctxStart = Math.max(0, i - 2);
  const ctxBefore = beforeLines.slice(ctxStart, i);
  // Find the resync point — for a single-line insert, after-line[i+1] === before-line[i]
  const insertedLines = [];
  let j = i;
  while (j < afterLines.length && afterLines[j] !== beforeLines[i]) {
    insertedLines.push(afterLines[j]);
    j++;
  }
  const ctxAfter = beforeLines.slice(i, i + 2);
  const hunkBeforeLen = ctxBefore.length + ctxAfter.length;
  const hunkAfterLen = ctxBefore.length + insertedLines.length + ctxAfter.length;
  out.push(
    `@@ -${ctxStart + 1},${hunkBeforeLen} +${ctxStart + 1},${hunkAfterLen} @@`,
  );
  for (const l of ctxBefore) out.push(` ${l}`);
  for (const l of insertedLines) out.push(`+${l}`);
  for (const l of ctxAfter) out.push(` ${l}`);
  return out.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────

function main() {
  const legacy = readLegacyEntries(LEGACY_DIR);
  console.error(`Loaded ${legacy.length} legacy entries with Route:`);
  const wiki = readWikiEntries(WIKI_DIR);
  console.error(`Loaded ${wiki.length} wiki entries`);

  const counters = {
    updated: 0,
    alreadyHasRoute: 0,
    unmatched: 0,
    ambiguous: 0,
    noFrontmatter: 0,
    errors: 0,
  };
  const diffs = [];
  const log = [];

  for (const entry of legacy) {
    const { match, score, ambiguous } = findBestWikiMatch(entry, wiki);
    if (!match) {
      counters.unmatched++;
      log.push(`UNMATCHED  [${entry.sourceFile}] ${entry.title}`);
      continue;
    }
    const rel = path.relative(WIKI_DIR, match.path);
    if (ambiguous) {
      counters.ambiguous++;
      log.push(
        `AMBIGUOUS  [${entry.sourceFile}] ${entry.title} → ${rel} (score ${score.toFixed(2)})`,
      );
      // Skip ambiguous matches — leave for manual review
      continue;
    }
    const fm = parseFrontmatter(match.text);
    if (!fm) {
      counters.noFrontmatter++;
      log.push(`NOFRONTMATTER  ${rel}`);
      continue;
    }
    if (hasRouteField(fm.yaml)) {
      counters.alreadyHasRoute++;
      log.push(`ALREADY-HAS  ${rel}`);
      continue;
    }
    const newYaml = insertRouteField(fm.yaml, entry.route);
    const newText = `---\n${newYaml}\n---\n${fm.rest}`;

    log.push(
      `UPDATE     ${rel} (score ${score.toFixed(2)}, route: ${entry.route})`,
    );
    diffs.push(unifiedDiff(match.text, newText, `a/${rel}`, `b/${rel}`));
    if (LIVE) {
      try {
        fs.writeFileSync(match.path, newText, "utf-8");
        counters.updated++;
      } catch (err) {
        counters.errors++;
        log.push(`ERROR      ${rel}: ${(err && err.message) || err}`);
        continue;
      }
    } else {
      counters.updated++;
    }
    // Always update the in-memory copy so a subsequent legacy entry that
    // would target the same wiki file sees the route as already present
    // and reports ALREADY-HAS rather than a phantom duplicate UPDATE.
    match.text = newText;
  }

  // Emit log to stdout
  for (const l of log) console.log(l);

  // Write diff file in dry-run mode
  if (!LIVE && diffs.length > 0) {
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const diffPath = `/tmp/route-backfill-${ts}.diff`;
    fs.writeFileSync(diffPath, diffs.join("\n") + "\n", "utf-8");
    console.error(`\nDry-run diff written to: ${diffPath}`);
  }

  console.error("");
  console.error("Summary:");
  for (const [k, v] of Object.entries(counters)) {
    console.error(`  ${k}: ${v}`);
  }
  console.error(`  mode: ${LIVE ? "LIVE" : "DRY-RUN"}`);

  // Non-zero exit if there were errors or no matches at all
  if (counters.errors > 0) process.exit(1);
  if (counters.updated === 0 && counters.alreadyHasRoute === 0) process.exit(2);
}

main();
