/**
 * Workflow branching git operations — port of upstream task-orchestrator
 * `src/git-ops.ts`.
 *
 * Implements the worktree+branch lifecycle for isolated workflow runs.
 * Each `run_workflow` instance for a template with a `branching` policy gets:
 *   1. A fresh git branch forked from `baseBranch`
 *   2. A fresh worktree at `<worktreeRoot>/<branchName>` for fs isolation
 *   3. All task commits land on that branch
 *
 * On goal completion, `finalizeWorkflowSuccess` can ff-merge, tag-only, or
 * leave. `finalizeWorkflowFailure` tags + preserves for inspection.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowBranchingPolicy } from "../store/workflows.js";

export type CreateWorkflowBranchInput = {
  readonly policy: WorkflowBranchingPolicy;
  readonly templateId: string;
  /** Sequence number to disambiguate same-day instances. */
  readonly seq: number;
  /** Optional override for the date stamp; defaults to today in YYYY-MM-DD. */
  readonly date?: string;
};

export type CreateWorkflowBranchResult = {
  readonly branchName: string;
  readonly worktreePath: string;
};

function git(repo: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    // With encoding="utf-8", Node sets err.stderr to a string (possibly "").
    const e = err as { stderr?: string; message: string };
    const detail = e.stderr && e.stderr.trim().length > 0 ? e.stderr : e.message;
    throw new Error(`git ${args.join(" ")} failed in ${repo}: ${detail}`, {
      cause: err,
    });
  }
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultWorktreeRoot(repoPath: string): string {
  return path.join(repoPath, ".worktrees");
}

/**
 * Create a fresh worktree + branch for a workflow run.
 *
 * Branch name: `<prefix>/<templateId>-<date>-<seq>`.
 * Worktree path: `<worktreeRoot>/<branchName-with-slashes-replaced>`.
 */
export function createWorkflowBranch(
  input: CreateWorkflowBranchInput,
): CreateWorkflowBranchResult {
  const { policy, templateId, seq } = input;
  const date = input.date ?? todayYmd();
  const prefix = policy.namePrefix ?? "wf";
  const branchName = `${prefix}/${templateId}-${date}-${seq}`;
  const root = policy.worktreeRoot ?? defaultWorktreeRoot(policy.repoPath);
  const safeName = branchName.replace(/\//g, "__");
  const worktreePath = path.join(root, safeName);

  if (!fs.existsSync(path.join(policy.repoPath, ".git"))) {
    throw new Error(
      `createWorkflowBranch: ${policy.repoPath} is not a git repository`,
    );
  }
  try {
    git(policy.repoPath, [
      "rev-parse",
      "--verify",
      `refs/heads/${policy.baseBranch}`,
    ]);
  } catch {
    throw new Error(
      `createWorkflowBranch: base branch '${policy.baseBranch}' does not exist in ${policy.repoPath}`,
    );
  }
  fs.mkdirSync(root, { recursive: true });
  git(policy.repoPath, [
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
    policy.baseBranch,
  ]);
  return { branchName, worktreePath };
}

/**
 * Tag the head of a workflow branch with `<branchName>/<status>`.
 * Idempotent — overwrites an existing tag of the same name.
 */
export function tagWorkflowOutcome(
  repoPath: string,
  branchName: string,
  status: "passed" | "failed",
): void {
  const tagName = `${branchName}/${status}`;
  try {
    git(repoPath, ["tag", "-f", tagName, branchName]);
  } catch (err) {
    throw new Error(
      `tagWorkflowOutcome: failed to tag ${tagName}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * Finalize a successful workflow run by applying the configured onSuccess
 * policy. Returns a human-readable summary of what was done.
 *
 * Safety checks before ff-merge:
 *   - Refuses to ff-merge if baseBranch is the main checkout's current HEAD
 *     (auto-ref-update would corrupt its working tree).
 *   - Refuses to ff-merge if the worktree has uncommitted changes (those
 *     would be silently left behind).
 *   - Refuses to ff-merge if baseBranch has advanced past the branch's
 *     fork point (no longer fast-forwardable).
 */
export function finalizeWorkflowSuccess(
  policy: WorkflowBranchingPolicy,
  branchName: string,
  worktreePath: string,
): string {
  tagWorkflowOutcome(policy.repoPath, branchName, "passed");

  const onSuccess = policy.onSuccess ?? "ff-merge";
  if (onSuccess === "leave") {
    return `tagged ${branchName}/passed; left worktree+branch untouched per policy`;
  }
  if (onSuccess === "tag-only") {
    return `tagged ${branchName}/passed; left worktree+branch for review per tag-only policy`;
  }

  try {
    let currentBranch = "";
    try {
      currentBranch = git(policy.repoPath, ["symbolic-ref", "--short", "HEAD"]);
    } catch {
      // Detached HEAD or no HEAD — proceed; ff is still safe.
    }
    if (currentBranch === policy.baseBranch) {
      return (
        `tagged ${branchName}/passed; ff-merge skipped — main checkout is currently on ` +
        `${policy.baseBranch} (auto-ref-update would corrupt its working tree). ` +
        `Merge manually when convenient: ` +
        `git -C ${policy.repoPath} merge --ff-only ${branchName}`
      );
    }

    let worktreeDirty = false;
    try {
      const porcelain = git(worktreePath, ["status", "--porcelain"]);
      worktreeDirty = porcelain.length > 0;
    } catch {
      // If status fails (worktree gone, etc.) treat as dirty — better to leak
      // than to silently misadvance baseBranch with an incomplete commit set.
      worktreeDirty = true;
    }
    if (worktreeDirty) {
      return (
        `tagged ${branchName}/passed; ff-merge SKIPPED — worktree at ${worktreePath} ` +
        `has uncommitted changes that would be left behind (only committed work would land on ${policy.baseBranch}). ` +
        `Inspect: \`git -C ${worktreePath} status\`. Once you've committed or discarded those changes, ` +
        `merge manually: \`git -C ${policy.repoPath} merge --ff-only ${branchName}\` then ` +
        `\`git -C ${policy.repoPath} worktree remove ${worktreePath}\`.`
      );
    }

    const baseSha = git(policy.repoPath, [
      "rev-parse",
      `refs/heads/${policy.baseBranch}`,
    ]);
    const branchSha = git(policy.repoPath, [
      "rev-parse",
      `refs/heads/${branchName}`,
    ]);
    try {
      git(policy.repoPath, [
        "merge-base",
        "--is-ancestor",
        baseSha,
        branchSha,
      ]);
    } catch {
      return (
        `tagged ${branchName}/passed; ff-merge skipped — ` +
        `${policy.baseBranch} advanced past the workflow branch's fork point. ` +
        `Manual merge or rebase required.`
      );
    }
    git(policy.repoPath, [
      "update-ref",
      `refs/heads/${policy.baseBranch}`,
      branchSha,
      baseSha,
    ]);
    git(policy.repoPath, ["worktree", "remove", "--force", worktreePath]);
    git(policy.repoPath, ["branch", "-D", branchName]);
    return `tagged ${branchName}/passed; ff-merged into ${policy.baseBranch}; removed worktree+branch`;
  } catch (err) {
    return `tagged ${branchName}/passed; ff-merge failed: ${(err as Error).message}`;
  }
}

/**
 * Finalize a failed workflow run. Tags the branch as failed and leaves the
 * worktree + branch in place for inspection. No auto-cleanup — failed
 * workflows are debugging surface.
 */
export function finalizeWorkflowFailure(
  policy: WorkflowBranchingPolicy,
  branchName: string,
): string {
  try {
    tagWorkflowOutcome(policy.repoPath, branchName, "failed");
    return `tagged ${branchName}/failed; left worktree+branch for inspection`;
  } catch (err) {
    return `finalize-failure: tag write failed: ${(err as Error).message}`;
  }
}

/**
 * Hard-remove a workflow branch + its worktree. Best-effort — swallows
 * errors and returns a summary so caller doesn't mask the original failure.
 *
 * Used by the orphan-cleanup path when goal/task creation fails AFTER the
 * worktree+branch were created.
 */
export function removeWorkflowBranch(
  repoPath: string,
  branchName: string,
  worktreePath: string,
): string {
  const errors: string[] = [];
  try {
    git(repoPath, ["worktree", "remove", "--force", worktreePath]);
  } catch (err) {
    errors.push(`worktree remove failed: ${(err as Error).message}`);
  }
  try {
    git(repoPath, ["branch", "-D", branchName]);
  } catch (err) {
    errors.push(`branch delete failed: ${(err as Error).message}`);
  }
  return errors.length === 0
    ? `removed orphan worktree ${worktreePath} and branch ${branchName}`
    : `partial cleanup: ${errors.join("; ")}`;
}
