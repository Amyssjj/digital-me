#!/usr/bin/env node
/**
 * cli-exec-worker — generic, config-driven CLI exec wrapper for the
 * digital-me brain orchestrator. Spawns a target CLI (claude, codex, …)
 * with a prompt built from the spec, captures handoff.json + the final
 * message, and signals success via a marker line on stdout.
 *
 * Invoked by the brain-orchestrator dispatcher when a task with an
 * alias-resolved exec dispatch fires:
 *
 *   node cli-exec-worker.mjs <spec.json>
 *
 * spec.json shape (written by `createOpenClawAliasResolver`):
 *
 *   {
 *     "alias":            "claude-code-cli",
 *     "taskId":           "<uuid>",
 *     "goalId":           "<uuid>",
 *     "taskName":         "Compile inbox emissions",
 *     "task":             "<the prompt body>",
 *     "cwd":              "/abs/path",
 *     "artifactDir":      "/abs/path/.../task-artifacts/<goalId>/<taskId>",
 *     "timeoutMs":        1800000,
 *     "binary":           "claude",
 *     "args":             ["-p", "--allowedTools", "Bash,Read,Write", "{{prompt}}"],
 *     "env":              { "OPENCLAW_AGENT_ID": "claude-code" },
 *     "prompt_template":  "You are {{alias}} launched by digital-me. Task: {{task}}",
 *     "final_message_arg":  "--output-last-message" | null,
 *     "completion_marker":  "DIGITAL_ME_EXEC_OK"
 *   }
 *
 * The worker substitutes `{{alias}}`, `{{task}}`, `{{taskName}}`,
 * `{{taskId}}`, `{{goalId}}`, `{{marker}}` in `prompt_template`, then
 * substitutes `{{prompt}}` in `args` with the rendered prompt. Result
 * artifacts (handoff.json, final-message.txt, worker.log) are written
 * to `artifactDir` for the post-exec verify step + dashboard surfacing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Regex constants used by redactArgsForLog / collectSecretValues below.
// Declared at module top so the top-level call site (line ~118) doesn't
// hit the TDZ — function declarations are hoisted but const is not.
const SECRET_FLAG_RE =
  /^-{1,2}[^=\s]*(?:api[-_]?key|token|secret|password|passwd|credential|bearer|auth|access[-_]?key|private[-_]?key|oauth|pat|aws[-_]+(?:secret|key|access))[^=\s]*$/i;

const INLINE_SECRET_RE =
  /^([^=\s]*(?:api[-_]?key|token|secret|password|passwd|credential|bearer|auth|access[-_]?key|private[-_]?key|oauth|pat|aws[-_]+(?:secret|key|access))[^=\s]*)=(.*)$/i;

const [specPath] = process.argv.slice(2);
if (!specPath) {
  console.error("usage: cli-exec-worker.mjs <spec.json>");
  process.exit(64);
}

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const {
  alias,
  taskId,
  goalId,
  taskName,
  task,
  cwd,
  artifactDir,
  timeoutMs = 3_600_000,
  binary,
  args = [],
  env = {},
  prompt_template,
  final_message_arg,
  completion_marker,
} = spec;

if (!alias || !taskId || !goalId || !taskName || !task || !cwd || !artifactDir || !binary) {
  console.error("spec missing required fields (alias, taskId, goalId, taskName, task, cwd, artifactDir, binary)");
  process.exit(64);
}

mkdirSync(artifactDir, { recursive: true });

const marker = completion_marker ?? `DIGITAL_ME_EXEC_OK ${alias} ${taskId}`;
const handoffPath = join(artifactDir, "handoff.json");
const finalMessagePath = join(artifactDir, "final-message.txt");
const logPath = join(artifactDir, "worker.log");

const defaultTemplate = [
  "You are {{alias}} launched by the digital-me orchestrator.",
  "Use the openclaw-brain MCP server.",
  "First call memory_search with query: {{taskName}} {{alias}} exec worker",
  "",
  "Managed task:",
  "{{task}}",
  "",
  "Tracking:",
  "- taskId: {{taskId}}",
  "- goalId: {{goalId}}",
  "- Call tasks.checkpoint when you make meaningful progress (if the task takes more than a minute).",
  "- Call tasks.handoff when done with deliverableState=complete, summary, and artifactPaths if any.",
  "- The wrapper will write local execution artifacts after your CLI process exits.",
  "",
  "Final response:",
  "- Include this marker on its own line: {{marker}}",
].join("\n");

const prompt = interpolate(prompt_template ?? defaultTemplate, {
  alias,
  task,
  taskName,
  taskId,
  goalId,
  marker,
});

// Substitute {{prompt}} in args with the rendered prompt.
const resolvedArgs = args.map((a) =>
  typeof a === "string" ? a.replace(/\{\{prompt\}\}/g, prompt) : a,
);

// Auto-append the final-message flag + path so the child CLI actually writes
// its final message where we read it (finalMessagePath). final_message_arg was
// previously only consulted when READING the result — never passed to the
// child — so e.g. the codex alias (final_message_arg "--output-last-message")
// never wrote final-message.txt, and completion-marker detection only saw the
// handoff stream. Skip if the caller already included the flag.
if (final_message_arg && !resolvedArgs.includes(final_message_arg)) {
  resolvedArgs.push(final_message_arg, finalMessagePath);
}

// Build the set of strings that must never reach worker.log in plaintext:
// the rendered prompt body itself, plus every secret-bearing arg value
// (captured from inline `--token=VALUE` and `--api-key VALUE` patterns).
// `redactStringForLog` scrubs these from any free-form text (stdout, stderr,
// finalMessage, handoff) before the log write. Order matters: build this
// list BEFORE the spawn so we can scrub spawn output.
const logArgs = redactArgsForLog(args, resolvedArgs, prompt);
const secretValues = collectSecretValues(resolvedArgs, prompt, task);

const startedAt = new Date().toISOString();
const result = spawnSync(binary, resolvedArgs, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    NO_COLOR: "1",
    TERM: "dumb",
    ...env,
  },
  timeout: timeoutMs,
  maxBuffer: 20 * 1024 * 1024,
});

const finalMessage =
  final_message_arg && existsSync(finalMessagePath)
    ? safeRead(finalMessagePath)
    : (result.stdout ?? "");

if (!final_message_arg) {
  writeFileSync(finalMessagePath, finalMessage, "utf8");
}

let handoff = safeRead(handoffPath);

writeFileSync(
  logPath,
  [
    `startedAt=${startedAt}`,
    `endedAt=${new Date().toISOString()}`,
    `binary=${binary}`,
    `argsCount=${resolvedArgs.length}`,
    // Two-layer scrub on args: redactArgsForLog handles structural
    // patterns (--api-key VALUE, {{prompt}} position); then we run each
    // remaining arg through the value-scrubber so a script body that
    // embeds a secret literal (e.g. `-c 'curl -H "x-api-key: $SK_…"'`)
    // also gets its embedded values redacted.
    `args=${JSON.stringify(
      logArgs.map((a) =>
        typeof a === "string" ? redactStringForLog(a, secretValues) : a,
      ),
    )}`,
    `status=${result.status ?? ""}`,
    `signal=${result.signal ?? ""}`,
    `error=${redactStringForLog(result.error?.message ?? "", secretValues)}`,
    "stdout:",
    redactStringForLog(result.stdout ?? "", secretValues),
    "stderr:",
    redactStringForLog(result.stderr ?? "", secretValues),
    "finalMessage:",
    redactStringForLog(finalMessage, secretValues),
    "handoff:",
    redactStringForLog(handoff, secretValues),
  ].join("\n"),
  "utf8",
);

if (result.error) {
  console.error(`${alias} spawn failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`${alias} exited ${result.status}`);
  console.error((result.stderr || result.stdout || "").slice(0, 6000));
  process.exit(result.status ?? 1);
}
if (!finalMessage.includes(marker) && !handoff.includes(marker)) {
  console.error(`missing completion marker: ${marker}`);
  process.exit(2);
}

if (!handoff.trim()) {
  handoff = JSON.stringify(
    { marker, taskId, goalId, alias, summary: finalMessage.slice(0, 1000) },
    null,
    2,
  );
  writeFileSync(handoffPath, handoff, "utf8");
}

console.log(marker);
console.log(`handoff=${handoffPath}`);
console.log(`log=${logPath}`);
console.log(`finalMessage=${finalMessagePath}`);

function safeRead(path) {
  try {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

// ── secret-redaction for worker.log ──────────────────────────────────────
//
// worker.log is checked-in artifact under artifactDir/<goalId>/<taskId>/.
// Operators (and anyone with FS access) can read it. The CLI subprocess
// argv, the rendered prompt, any --api-key/--token values, and anything
// the CLI echoes back through stdout/stderr/finalMessage/handoff are
// candidate leak vectors. Two-layer scrub:
//
//   1. redactArgsForLog: walk the arg vector, replace prompt-bearing
//      positions with [REDACTED:prompt], inline `--api-key=VALUE` with
//      `--api-key=[REDACTED]`, and the position after a bare secret flag
//      (`--api-key VALUE`) with `[REDACTED]`.
//
//   2. redactStringForLog: scrub the same secret VALUES out of any
//      free-form text — covers the case where the CLI echoes argv on
//      error (`spawn ENOENT`, "invalid token: sk-…"), or quotes the
//      prompt back in its response ("I'll now do: <prompt>"). Replaces
//      exact-string matches with [REDACTED:prompt] / [REDACTED:secret].
//
// The secret-flag regex matches openai/anthropic/aws/gh patterns:
// api[-_]?key, token, secret, password, passwd, credential, bearer,
// auth, access[-_]?key, private[-_]?key, oauth, pat, aws[-_]*.
// (SECRET_FLAG_RE + INLINE_SECRET_RE are declared at module top to
// avoid the TDZ from the line-118 callsite.)

function redactArgsForLog(originalArgs, resolvedArgs, renderedPrompt) {
  let redactNext = false;
  return resolvedArgs.map((arg, index) => {
    if (typeof arg !== "string") return arg;

    const original = originalArgs[index];
    if (
      (typeof original === "string" && original.includes("{{prompt}}")) ||
      (renderedPrompt && arg.includes(renderedPrompt))
    ) {
      redactNext = false;
      return "[REDACTED:prompt]";
    }

    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }

    const inlineMatch = arg.match(INLINE_SECRET_RE);
    if (inlineMatch) {
      return `${inlineMatch[1]}=[REDACTED]`;
    }

    if (SECRET_FLAG_RE.test(arg)) {
      redactNext = true;
    }
    return arg;
  });
}

function collectSecretValues(resolvedArgs, renderedPrompt, taskBody) {
  const values = [];
  // Push the raw task body separately from the rendered prompt: CLIs
  // commonly echo back the user-provided task ("I'll now do: <task>")
  // without the template chrome around it, so an exact-match on
  // renderedPrompt would miss that case.
  if (taskBody && typeof taskBody === "string" && taskBody.length > 0) {
    values.push({ value: taskBody, tag: "prompt" });
  }
  if (renderedPrompt && renderedPrompt.length > 0 && renderedPrompt !== taskBody) {
    values.push({ value: renderedPrompt, tag: "prompt" });
  }
  let captureNext = false;
  for (const arg of resolvedArgs) {
    if (typeof arg !== "string") {
      captureNext = false;
      continue;
    }
    if (captureNext) {
      captureNext = false;
      if (arg.length > 0) values.push({ value: arg, tag: "secret" });
      continue;
    }
    const inlineMatch = arg.match(INLINE_SECRET_RE);
    if (inlineMatch && inlineMatch[2].length > 0) {
      values.push({ value: inlineMatch[2], tag: "secret" });
      continue;
    }
    if (SECRET_FLAG_RE.test(arg)) {
      captureNext = true;
    }
  }
  // Sort longest first so a value containing another value still scrubs cleanly.
  values.sort((a, b) => b.value.length - a.value.length);
  return values;
}

function redactStringForLog(text, secretValues) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const { value, tag } of secretValues) {
    if (value.length < 4) continue; // skip noise — too short to be meaningful
    // Plain split/join avoids regex-escape overhead and handles all-byte values.
    if (out.includes(value)) {
      out = out.split(value).join(`[REDACTED:${tag}]`);
    }
  }
  return out;
}
