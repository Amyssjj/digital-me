import { describe, expect, it } from "vitest";

import {
  isWorktreePath,
  resolveStableNodePath,
  resolveStableRegistrationPath,
  stabilizeRegistration,
} from "./stable-registration.js";

/** Probe stub: only the listed paths "exist". */
const only =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);
const none = () => false;
const all = () => true;

const MAIN = "/home/u/digital-me-os/packages/transport/brain-mcp-proxy/bin/brain-mcp-proxy.mjs";
const WORKTREE =
  "/home/u/digital-me-os/.claude/worktrees/my-branch-abc123/packages/transport/brain-mcp-proxy/bin/brain-mcp-proxy.mjs";

describe("resolveStableRegistrationPath", () => {
  it("rewrites a worktree path to the main checkout", () => {
    expect(resolveStableRegistrationPath(WORKTREE, only(MAIN))).toBe(MAIN);
  });

  it("leaves a non-worktree path untouched", () => {
    expect(resolveStableRegistrationPath(MAIN, all)).toBe(MAIN);
  });

  it("keeps the worktree path when the main checkout lacks the file", () => {
    // A package that exists only on the unmerged branch. Redirecting would
    // produce a path that 404s immediately — strictly worse than a path that
    // works until the worktree is removed.
    expect(resolveStableRegistrationPath(WORKTREE, none)).toBe(WORKTREE);
  });

  it("strips only the worktree segment, preserving the rest of the path", () => {
    const p = "/repo/.claude/worktrees/wt/a/b/c.mjs";
    expect(resolveStableRegistrationPath(p, only("/repo/a/b/c.mjs"))).toBe("/repo/a/b/c.mjs");
  });

  it("handles a path that ends at the worktree directory itself", () => {
    const p = "/repo/.claude/worktrees/wt";
    expect(resolveStableRegistrationPath(p, only("/repo"))).toBe("/repo");
  });

  it("does not match a directory merely named like the worktree path", () => {
    // Anchoring on the separator keeps `my.claude/worktrees` from matching.
    const p = "/repo/my.claude/worktrees/x/bin.mjs";
    expect(resolveStableRegistrationPath(p, all)).toBe(p);
  });

  it("supports windows-style separators", () => {
    const p = "C:\\repo\\.claude\\worktrees\\wt\\bin.mjs";
    expect(resolveStableRegistrationPath(p, only("C:\\repo\\bin.mjs"))).toBe("C:\\repo\\bin.mjs");
  });
});

describe("isWorktreePath", () => {
  it("identifies worktree paths without rewriting them", () => {
    expect(isWorktreePath(WORKTREE)).toBe(true);
    expect(isWorktreePath(MAIN)).toBe(false);
  });
});

describe("resolveStableNodePath", () => {
  it("de-pins a Homebrew Cellar node to the generic symlink", () => {
    expect(
      resolveStableNodePath("/opt/homebrew/Cellar/node/25.4.0/bin/node", only("/opt/homebrew/bin/node")),
    ).toBe("/opt/homebrew/bin/node");
  });

  it("handles versioned formulae like node@24", () => {
    expect(
      resolveStableNodePath("/opt/homebrew/Cellar/node@24/24.20.0/bin/node", only("/opt/homebrew/bin/node")),
    ).toBe("/opt/homebrew/bin/node");
  });

  it("derives the prefix rather than hard-coding /opt/homebrew (Intel Macs)", () => {
    expect(
      resolveStableNodePath("/usr/local/Cellar/node/24.0.0/bin/node", only("/usr/local/bin/node")),
    ).toBe("/usr/local/bin/node");
  });

  it("keeps the Cellar path when the generic symlink is absent", () => {
    const pinned = "/opt/homebrew/Cellar/node/25.4.0/bin/node";
    expect(resolveStableNodePath(pinned, none)).toBe(pinned);
  });

  it("leaves non-Homebrew interpreters alone", () => {
    // nvm, volta, system node, or a bare command — not our shaped problem.
    for (const p of ["/usr/bin/node", "/home/u/.nvm/versions/node/v24.0.0/bin/node", "node"]) {
      expect(resolveStableNodePath(p, all)).toBe(p);
    }
  });
});

describe("stabilizeRegistration", () => {
  it("applies both hardenings and explains each one", () => {
    const r = stabilizeRegistration(
      "/opt/homebrew/Cellar/node/25.4.0/bin/node",
      WORKTREE,
      only(MAIN, "/opt/homebrew/bin/node"),
    );
    expect(r.binPath).toBe(MAIN);
    expect(r.nodePath).toBe("/opt/homebrew/bin/node");
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0]).toMatch(/worktree/);
    expect(r.notes[1]).toMatch(/version-pinned/);
  });

  it("is silent when nothing needs changing", () => {
    const r = stabilizeRegistration("/opt/homebrew/bin/node", MAIN, all);
    expect(r.notes).toEqual([]);
    expect(r.binPath).toBe(MAIN);
    expect(r.nodePath).toBe("/opt/homebrew/bin/node");
  });

  it("WARNS loudly when it must register a worktree path anyway", () => {
    // The dangerous case: we cannot fix it, so the operator has to be told —
    // this is exactly the silent breakage the module exists to prevent.
    const r = stabilizeRegistration("/usr/bin/node", WORKTREE, none);
    expect(r.binPath).toBe(WORKTREE);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/WARNING/);
    expect(r.notes[0]).toMatch(/break when the worktree is removed/);
  });

  it("reports only the node rewrite when the bin path is already stable", () => {
    const r = stabilizeRegistration(
      "/opt/homebrew/Cellar/node/25.4.0/bin/node",
      MAIN,
      only(MAIN, "/opt/homebrew/bin/node"),
    );
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/version-pinned/);
  });

  it("defaults its probe to the real filesystem", () => {
    // Exercises the default parameter: a path that certainly does not exist
    // must come back untouched rather than throwing.
    const p = "/nonexistent/.claude/worktrees/wt/x.mjs";
    expect(stabilizeRegistration("/usr/bin/node", p).binPath).toBe(p);
  });
});
