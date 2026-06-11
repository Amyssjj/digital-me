import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cli-exec-worker-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const workerScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/cli-exec-worker.mjs",
);

function writeSpec(opts: {
  binary: string;
  args: readonly unknown[];
  task?: string;
  artifactDir: string;
  marker?: string;
}): string {
  const specPath = path.join(tmpRoot, "spec.json");
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      alias: "test-alias",
      taskId: "task-1",
      goalId: "goal-1",
      taskName: "Test task",
      task: opts.task ?? "Do the thing",
      cwd: tmpRoot,
      artifactDir: opts.artifactDir,
      timeoutMs: 30_000,
      binary: opts.binary,
      args: opts.args,
      env: {},
      prompt_template: "{{task}}\nmarker: {{marker}}",
      final_message_arg: null,
      completion_marker: opts.marker ?? "DONE_MARKER",
    }),
    "utf8",
  );
  return specPath;
}

describe("cli-exec-worker — secret redaction in worker.log", () => {
  it("redacts secrets across args, stdout, stderr, finalMessage, and handoff", () => {
    const marker = "DONE_MARKER";
    const promptBody = "UNIQUE_TASK_BODY_xyz"; // appears in task → prompt → echoed
    const flagSecret = "FLAG_SENTINEL_SECRET_abc123";
    const inlineSecret = "INLINE_SENTINEL_SECRET_xyz789";
    const bearerSecret = "BEARER_SENTINEL_SECRET_qqq";
    const artifactDir = path.join(tmpRoot, "artifacts");

    // Stub CLI: echoes the prompt + secret values back through stdout AND
    // stderr (realistic scenarios where a CLI logs the prompt body or
    // includes its argv in an error trace), then prints the completion
    // marker so the worker exits 0.
    const script = [
      `echo "running with prompt body: ${promptBody}"`,
      `echo "FLAG=${flagSecret}"`,
      `echo "INLINE=${inlineSecret}"`,
      `echo "BEARER=${bearerSecret}" 1>&2`,
      `echo "${marker}"`,
    ].join("\n");

    const specPath = writeSpec({
      binary: "/bin/sh",
      args: [
        "-c",
        script,
        "--api-key",
        flagSecret,
        `--token=${inlineSecret}`,
        "--bearer",
        bearerSecret,
        "{{prompt}}",
      ],
      task: promptBody,
      artifactDir,
      marker,
    });

    const result = spawnSync(process.execPath, [workerScript, specPath], {
      cwd: tmpRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);

    const log = fs.readFileSync(path.join(artifactDir, "worker.log"), "utf8");

    // Args field: prompt position + secret-flag values are scrubbed
    expect(log).toContain("[REDACTED:prompt]");
    expect(log).toContain("--api-key");
    expect(log).toContain("--token=[REDACTED]");
    expect(log).toContain("--bearer");
    // No raw secret value appears anywhere in worker.log
    expect(log).not.toContain(flagSecret);
    expect(log).not.toContain(inlineSecret);
    expect(log).not.toContain(bearerSecret);
    // The rendered prompt body is scrubbed from the stdout echo too
    expect(log).not.toContain(promptBody);
    // argsCount preserves the visible count for debugging
    expect(log).toMatch(/argsCount=\d+/);
  });

  it("scrubs prompt body from finalMessage and handoff sections, but NOT from on-disk handoff.json", () => {
    const marker = "DONE_MARKER";
    const promptBody = "ANOTHER_UNIQUE_PROMPT_xyz";
    const artifactDir = path.join(tmpRoot, "artifacts");

    fs.mkdirSync(artifactDir, { recursive: true });
    // Stub CLI: echoes the prompt body in its final response AND writes a
    // handoff.json containing the same body (so the worker reads it back).
    const handoffPath = path.join(artifactDir, "handoff.json");
    const script = [
      `echo "I will now do: $1"`,
      `cat > ${handoffPath} <<EOF`,
      `{"marker":"${marker}","summary":"I did: $1"}`,
      `EOF`,
      `echo "${marker}"`,
    ].join("\n");

    const specPath = writeSpec({
      binary: "/bin/sh",
      args: ["-c", script, "_", "{{prompt}}"],
      task: promptBody,
      artifactDir,
      marker,
    });

    const result = spawnSync(process.execPath, [workerScript, specPath], {
      cwd: tmpRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);

    const log = fs.readFileSync(path.join(artifactDir, "worker.log"), "utf8");
    expect(log).not.toContain(promptBody);
    expect(log).toContain("[REDACTED:prompt]");

    // The on-disk handoff.json is the source of truth for downstream task
    // tracking — it MUST NOT be scrubbed (or tasks.handoff payload breaks).
    const handoff = fs.readFileSync(handoffPath, "utf8");
    expect(handoff).toContain(promptBody);
  });
});

describe("cli-exec-worker", () => {
  it("fails when a successful CLI run omits the completion marker", () => {
    const artifactDir = path.join(tmpRoot, "artifacts");
    const marker = "DIGITAL_ME_EXEC_OK test-cli task-1";
    const specPath = path.join(tmpRoot, "spec.json");
    fs.writeFileSync(
      specPath,
      JSON.stringify(
        {
          alias: "test-cli",
          taskId: "task-1",
          goalId: "goal-1",
          taskName: "Marker regression",
          task: "Exit successfully without printing the marker.",
          cwd: tmpRoot,
          artifactDir,
          binary: "/bin/sh",
          args: ["-c", "printf 'done without marker\\n'"],
          completion_marker: marker,
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = spawnSync(process.execPath, [workerScript, specPath], {
      cwd: tmpRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`missing completion marker: ${marker}`);
    expect(fs.existsSync(path.join(artifactDir, "handoff.json"))).toBe(false);
  });

  it("appends final_message_arg so the child writes its final message to the captured path", () => {
    // Regression (S2): final_message_arg was read only when REASSEMBLING the
    // result, never appended to the spawned args — so a CLI that writes its
    // final message ONLY to the flag's path (like codex --output-last-message)
    // never produced final-message.txt and the marker check failed.
    const artifactDir = path.join(tmpRoot, "artifacts");
    const specPath = path.join(tmpRoot, "spec.json");
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        alias: "test-cli",
        taskId: "task-1",
        goalId: "goal-1",
        taskName: "final-message capture",
        task: "Write the marker only to the --output-last-message path.",
        cwd: tmpRoot,
        artifactDir,
        binary: "/bin/sh",
        // sh -c <script> sh <appended: --output-last-message <path>>
        // → $0=sh, $1=--output-last-message, $2=<finalMessagePath>.
        // Writes the marker ONLY to $2 (nothing useful on stdout).
        args: ["-c", 'printf "%s\\n" "DONE_MARKER" > "$2"', "sh"],
        final_message_arg: "--output-last-message",
        completion_marker: "DONE_MARKER",
      }, null, 2),
      "utf8",
    );

    const result = spawnSync(process.execPath, [workerScript, specPath], {
      cwd: tmpRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const finalMsg = fs.readFileSync(
      path.join(artifactDir, "final-message.txt"),
      "utf8",
    );
    expect(finalMsg).toContain("DONE_MARKER");
  });
});
