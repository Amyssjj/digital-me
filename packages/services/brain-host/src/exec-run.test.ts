import { describe, expect, it } from "vitest";
import { DEFAULT_EXEC_TIMEOUT_MS, execRun } from "./exec-run.js";

describe("execRun", () => {
  it("captures stdout and a zero exit", async () => {
    const r = await execRun({ command: [process.execPath, "-e", "process.stdout.write('hi'); process.stderr.write('warn')"] });
    expect(r).toEqual({ success: true, exitCode: 0, timedOut: false, stdout: "hi", stderr: "warn" });
  });

  it("reports a non-zero exit with the error message", async () => {
    const r = await execRun({ command: [process.execPath, "-e", "process.exit(3)"], env: { X: "1" }, cwd: process.cwd() });
    expect(r.success).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.error).toMatch(/exit code 3|Command failed/);
  });

  it("reports a timeout", async () => {
    const r = await execRun({ command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"], timeoutMs: 100 });
    expect(r.success).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("maps a launch failure to exit code 1 and rejects an empty command", async () => {
    const r = await execRun({ command: ["/nonexistent/binary/brain-host-test"] });
    expect(r.success).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(await execRun({ command: [] })).toMatchObject({ success: false, error: "empty command" });
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(300_000);
  });
});
