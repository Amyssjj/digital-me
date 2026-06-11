import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkflowBranch,
  finalizeWorkflowFailure,
  finalizeWorkflowSuccess,
  removeWorkflowBranch,
  tagWorkflowOutcome,
} from "./git.js";

let tmpRoot: string;
let repoPath: string;

function sh(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
  }).trim();
}

function initRepo(repo: string): void {
  fs.mkdirSync(repo, { recursive: true });
  // -b main avoids relying on user's init.defaultBranch.
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf-8" });
  sh(repo, ["config", "user.email", "test@example.com"]);
  sh(repo, ["config", "user.name", "Test"]);
  sh(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-m", "init"]);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "git-ops-"));
  repoPath = path.join(tmpRoot, "repo");
  initRepo(repoPath);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("createWorkflowBranch", () => {
  it("creates a fresh branch + worktree in the default worktree root", () => {
    const result = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    expect(result.branchName).toBe("wf/tpl-2026-05-17-1");
    expect(result.worktreePath).toBe(
      path.join(repoPath, ".worktrees", "wf__tpl-2026-05-17-1"),
    );
    expect(fs.existsSync(result.worktreePath)).toBe(true);
    const branches = sh(repoPath, ["branch", "--list"]);
    expect(branches).toMatch(/wf\/tpl-2026-05-17-1/);
  });

  it("honors namePrefix override", () => {
    const result = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main", namePrefix: "auto" },
      templateId: "tpl",
      seq: 2,
      date: "2026-05-17",
    });
    expect(result.branchName).toBe("auto/tpl-2026-05-17-2");
  });

  it("honors worktreeRoot override", () => {
    const root = path.join(tmpRoot, "custom-wt");
    const result = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main", worktreeRoot: root },
      templateId: "tpl",
      seq: 3,
      date: "2026-05-17",
    });
    expect(result.worktreePath.startsWith(root)).toBe(true);
    expect(fs.existsSync(result.worktreePath)).toBe(true);
  });

  it("defaults date to today (YYYY-MM-DD) when not provided", () => {
    const result = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 4,
    });
    expect(result.branchName).toMatch(
      /^wf\/tpl-\d{4}-\d{2}-\d{2}-4$/,
    );
  });

  it("throws when the repo isn't a git repository", () => {
    const notARepo = path.join(tmpRoot, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });
    expect(() =>
      createWorkflowBranch({
        policy: { repoPath: notARepo, baseBranch: "main" },
        templateId: "tpl",
        seq: 1,
      }),
    ).toThrow(/not a git repository/);
  });

  it("throws when the base branch doesn't exist", () => {
    expect(() =>
      createWorkflowBranch({
        policy: { repoPath, baseBranch: "no-such-branch" },
        templateId: "tpl",
        seq: 1,
      }),
    ).toThrow(/base branch 'no-such-branch' does not exist/);
  });

  it("includes git stderr in the wrapped error when worktree add fails", () => {
    // Force conflict: create the branch first, then try again with the same name.
    createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "dup",
      seq: 1,
      date: "2026-05-17",
    });
    expect(() =>
      createWorkflowBranch({
        policy: { repoPath, baseBranch: "main" },
        templateId: "dup",
        seq: 1,
        date: "2026-05-17",
      }),
    ).toThrow(/git worktree add/);
  });
});

describe("tagWorkflowOutcome", () => {
  it("tags the branch with <branchName>/<status>", () => {
    const { branchName } = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    tagWorkflowOutcome(repoPath, branchName, "passed");
    const tags = sh(repoPath, ["tag", "--list"]);
    expect(tags).toMatch(new RegExp(`${branchName.replace(/\//g, "\\/")}/passed`));
  });

  it("throws when the underlying tag command fails", () => {
    expect(() => tagWorkflowOutcome(repoPath, "no-such-branch", "passed"),
    ).toThrow(/failed to tag/);
  });
});

describe("finalizeWorkflowSuccess", () => {
  it("with policy=leave, tags and leaves the worktree+branch", () => {
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    const msg = finalizeWorkflowSuccess(
      { repoPath, baseBranch: "main", onSuccess: "leave" },
      wf.branchName,
      wf.worktreePath,
    );
    expect(msg).toMatch(/left worktree\+branch untouched per policy/);
    expect(fs.existsSync(wf.worktreePath)).toBe(true);
  });

  it("with policy=tag-only, tags and leaves the worktree+branch", () => {
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    const msg = finalizeWorkflowSuccess(
      { repoPath, baseBranch: "main", onSuccess: "tag-only" },
      wf.branchName,
      wf.worktreePath,
    );
    expect(msg).toMatch(/tag-only policy/);
    expect(fs.existsSync(wf.worktreePath)).toBe(true);
  });

  it("ff-merge: succeeds when base is behind and worktree is clean", () => {
    // Detach the main checkout so currentBranch !== baseBranch.
    sh(repoPath, ["checkout", "--detach"]);
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    // Add a commit on the workflow branch via the worktree.
    fs.writeFileSync(path.join(wf.worktreePath, "x.txt"), "hello");
    sh(wf.worktreePath, ["add", "."]);
    sh(wf.worktreePath, ["commit", "-m", "work"]);
    const msg = finalizeWorkflowSuccess(
      { repoPath, baseBranch: "main" },
      wf.branchName,
      wf.worktreePath,
    );
    expect(msg).toMatch(/ff-merged into main/);
    // Worktree and branch should be gone.
    expect(fs.existsSync(wf.worktreePath)).toBe(false);
    const branches = sh(repoPath, ["branch", "--list"]);
    expect(branches).not.toMatch(new RegExp(wf.branchName.replace(/\//g, "\\/")));
  });

  it("ff-merge: refuses when main checkout is on baseBranch (HEAD === baseBranch)", () => {
    // Main checkout is on main (initRepo's default).
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    fs.writeFileSync(path.join(wf.worktreePath, "x.txt"), "hello");
    sh(wf.worktreePath, ["add", "."]);
    sh(wf.worktreePath, ["commit", "-m", "work"]);
    const msg = finalizeWorkflowSuccess(
      { repoPath, baseBranch: "main" },
      wf.branchName,
      wf.worktreePath,
    );
    expect(msg).toMatch(/auto-ref-update would corrupt/);
  });

  it("ff-merge: refuses when worktree is dirty", () => {
    sh(repoPath, ["checkout", "--detach"]);
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    // Leave an uncommitted change in the worktree.
    fs.writeFileSync(path.join(wf.worktreePath, "dirty.txt"), "uncommitted");
    const msg = finalizeWorkflowSuccess(
      { repoPath, baseBranch: "main" },
      wf.branchName,
      wf.worktreePath,
    );
    expect(msg).toMatch(/ff-merge SKIPPED.*uncommitted changes/);
  });

  it("ff-merge: treats a removed worktree as dirty", () => {
    sh(repoPath, ["checkout", "--detach"]);
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    // Remove the worktree directory out from under us.
    fs.rmSync(wf.worktreePath, { recursive: true, force: true });
    const msg = finalizeWorkflowSuccess(
      { repoPath, baseBranch: "main" },
      wf.branchName,
      wf.worktreePath,
    );
    expect(msg).toMatch(/ff-merge SKIPPED/);
  });

  it("ff-merge: refuses when base has advanced past the workflow branch's fork point", () => {
    sh(repoPath, ["checkout", "--detach"]);
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    // Add a commit on the workflow branch first.
    fs.writeFileSync(path.join(wf.worktreePath, "x.txt"), "hello");
    sh(wf.worktreePath, ["add", "."]);
    sh(wf.worktreePath, ["commit", "-m", "work"]);
    // Advance main past the branch's fork point with an unrelated commit.
    sh(repoPath, ["checkout", "main"]);
    fs.writeFileSync(path.join(repoPath, "main-extra.txt"), "extra");
    sh(repoPath, ["add", "."]);
    sh(repoPath, ["commit", "-m", "main-extra"]);
    // Detach again so the currentBranch !== baseBranch check passes.
    sh(repoPath, ["checkout", "--detach"]);
    const msg = finalizeWorkflowSuccess(
      { repoPath, baseBranch: "main" },
      wf.branchName,
      wf.worktreePath,
    );
    expect(msg).toMatch(/main advanced past/);
  });

  it("ff-merge: returns a wrapped 'ff-merge failed' message when a step throws", () => {
    sh(repoPath, ["checkout", "--detach"]);
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    fs.writeFileSync(path.join(wf.worktreePath, "x.txt"), "hello");
    sh(wf.worktreePath, ["add", "."]);
    sh(wf.worktreePath, ["commit", "-m", "work"]);
    // Corrupt the base branch ref so rev-parse fails inside the try block.
    fs.rmSync(path.join(repoPath, ".git", "refs", "heads", "main"), {
      force: true,
    });
    fs.writeFileSync(
      path.join(repoPath, ".git", "refs", "heads", "main"),
      "not-a-real-sha\n",
    );
    const msg = finalizeWorkflowSuccess(
      { repoPath, baseBranch: "main" },
      wf.branchName,
      wf.worktreePath,
    );
    expect(msg).toMatch(/ff-merge failed/);
  });
});

describe("finalizeWorkflowFailure", () => {
  it("tags and leaves the worktree+branch", () => {
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    const msg = finalizeWorkflowFailure(
      { repoPath, baseBranch: "main" },
      wf.branchName,
    );
    expect(msg).toMatch(/tagged.*\/failed/);
    expect(fs.existsSync(wf.worktreePath)).toBe(true);
  });

  it("returns a tag-write-failed message when tagging throws", () => {
    const msg = finalizeWorkflowFailure(
      { repoPath, baseBranch: "main" },
      "no-such-branch",
    );
    expect(msg).toMatch(/finalize-failure: tag write failed/);
  });
});

describe("removeWorkflowBranch", () => {
  it("removes both the worktree and the branch on the happy path", () => {
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    const msg = removeWorkflowBranch(repoPath, wf.branchName, wf.worktreePath);
    expect(msg).toMatch(/removed orphan/);
    expect(fs.existsSync(wf.worktreePath)).toBe(false);
    const branches = sh(repoPath, ["branch", "--list"]);
    expect(branches).not.toMatch(new RegExp(wf.branchName.replace(/\//g, "\\/")));
  });

  it("reports a partial cleanup when only the worktree removal fails", () => {
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    // Remove the real worktree out of the way so the branch is no longer
    // checked out anywhere — git branch -D would otherwise refuse.
    sh(repoPath, ["worktree", "remove", "--force", wf.worktreePath]);
    const msg = removeWorkflowBranch(
      repoPath,
      wf.branchName,
      path.join(tmpRoot, "no-such-worktree"),
    );
    expect(msg).toMatch(/partial cleanup/);
    expect(msg).toMatch(/worktree remove failed/);
    const branches = sh(repoPath, ["branch", "--list"]);
    expect(branches).not.toMatch(new RegExp(wf.branchName.replace(/\//g, "\\/")));
  });

  it("reports a partial cleanup when only the branch deletion fails", () => {
    const wf = createWorkflowBranch({
      policy: { repoPath, baseBranch: "main" },
      templateId: "tpl",
      seq: 1,
      date: "2026-05-17",
    });
    const msg = removeWorkflowBranch(
      repoPath,
      "no-such-branch",
      wf.worktreePath,
    );
    expect(msg).toMatch(/partial cleanup/);
    expect(msg).toMatch(/branch delete failed/);
    expect(fs.existsSync(wf.worktreePath)).toBe(false);
  });

  it("reports a partial cleanup listing both failures", () => {
    const msg = removeWorkflowBranch(
      repoPath,
      "no-such-branch",
      path.join(tmpRoot, "no-such-worktree"),
    );
    expect(msg).toMatch(/partial cleanup/);
    expect(msg).toMatch(/worktree remove failed[\s\S]*branch delete failed/);
  });
});
