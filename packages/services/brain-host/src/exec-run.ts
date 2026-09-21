/**
 * `execRun` for the exec dispatcher: run a command to completion and report
 * exit code / output. Same contract the openclaw plugin template implements
 * inline, extracted so brain-host owns it and it is unit-tested.
 */

import { execFile } from "node:child_process";

export type ExecRunArgs = {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

export type ExecRunResult = {
  readonly success: boolean;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

export const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export function execRun(args: ExecRunArgs): Promise<ExecRunResult> {
  return new Promise((resolve) => {
    const [cmd, ...rest] = args.command;
    if (cmd === undefined) {
      resolve({ success: false, exitCode: 1, timedOut: false, stdout: "", stderr: "", error: "empty command" });
      return;
    }
    execFile(
      cmd,
      rest,
      {
        cwd: args.cwd,
        env: args.env ? { ...process.env, ...args.env } : undefined,
        timeout: args.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        const timedOut = error?.killed === true;
        const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({
          success: error === null,
          exitCode,
          timedOut,
          stdout: String(stdout),
          stderr: String(stderr),
          ...(error !== null && !timedOut ? { error: error.message } : {}),
        });
      },
    );
  });
}
