import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Path hardening for values written into PERSISTENT, user-scope client config
 * (`~/.claude.json`, `~/.codex/config.toml`, `~/.hermes/config.yaml`).
 *
 * Those files outlive the process that wrote them, so any path baked into them
 * must still resolve months later. Two classes of path do not:
 *
 *  1. **Worktree paths.** `digital-me install` registers whatever checkout it
 *     runs from. Run it inside `<repo>/.claude/worktrees/<name>/` and the
 *     ephemeral worktree gets written into global config; when the worktree is
 *     removed the entry 404s and the MCP server fails to connect on every
 *     future session — with no error at install time and none at the point of
 *     failure either, since a client just reports "Connection closed".
 *
 *  2. **Version-pinned interpreters.** `process.execPath` under Homebrew is
 *     `/opt/homebrew/Cellar/node/<version>/bin/node`. That path dies on the
 *     next `brew upgrade node` — or, as happened here, when installing a
 *     second node formula moves a shared dependency out from under the old
 *     one. The generic `/opt/homebrew/bin/node` symlink follows whichever
 *     node is linked and keeps working.
 *
 * Observed 2026-09-01: all three clients were broken at once — hermes had been
 * pointing at a worktree deleted months earlier AND pinned to a since-broken
 * Cellar node, while claude-code and codex had just been re-pointed at a live
 * worktree by an install run from inside it. See wiki:
 * infrastructure/never-register-persistent-config-with-worktree-paths.
 *
 * Both helpers are pure given their injected probes, and both FAIL OPEN: if a
 * path cannot be improved with confidence it is returned untouched. Writing a
 * slightly-suboptimal path is recoverable; rewriting to a path that does not
 * exist is not.
 */

/**
 * Claude Code's worktree layout: `<repo>/.claude/worktrees/<name>/<rest>`.
 * Anchored on the separator so it cannot match a directory merely *named*
 * something like `my.claude/worktrees`.
 */
const WORKTREE_SEGMENT_RE = /[/\\]\.claude[/\\]worktrees[/\\][^/\\]+(?=[/\\]|$)/;

/**
 * Rewrite a worktree path to the equivalent path in the main checkout.
 *
 * `<repo>/.claude/worktrees/<name>/packages/x/bin/y.mjs`
 *   → `<repo>/packages/x/bin/y.mjs`
 *
 * The rewrite is applied ONLY when the resulting file actually exists, so a
 * worktree holding something the main checkout does not (a new package on an
 * unmerged branch) is left alone rather than silently redirected to a path
 * that would 404 immediately.
 *
 * Returns the input unchanged when it is not a worktree path.
 */
export function resolveStableRegistrationPath(
  p: string,
  exists: (candidate: string) => boolean = existsSync,
): string {
  const match = WORKTREE_SEGMENT_RE.exec(p);
  if (!match) return p;
  const candidate = p.slice(0, match.index) + p.slice(match.index + match[0].length);
  return exists(candidate) ? candidate : p;
}

/** True when `p` sits inside a Claude Code worktree. Exported for messaging. */
export function isWorktreePath(p: string): boolean {
  return WORKTREE_SEGMENT_RE.test(p);
}

/**
 * Homebrew's version-pinned node: `/opt/homebrew/Cellar/node@24/24.20.0/bin/node`
 * or `/opt/homebrew/Cellar/node/25.4.0/bin/node`. Captures the prefix so the
 * generic sibling can be derived rather than hard-coded (Intel Macs use
 * `/usr/local`, and a custom `--prefix` is possible).
 */
const CELLAR_NODE_RE = /^(.*)[/\\]Cellar[/\\]node(?:@[\w.]+)?[/\\][^/\\]+[/\\]bin[/\\]node$/;

/**
 * Prefer a stable node symlink over a version-pinned Cellar path.
 *
 * `/opt/homebrew/Cellar/node/25.4.0/bin/node` → `/opt/homebrew/bin/node`
 *
 * Only rewrites when the generic path exists; a Cellar path is still better
 * than a path that is not there. Non-Homebrew interpreters (nvm, volta, system
 * node, a bare `node`) are returned untouched — this is a Homebrew-shaped
 * problem and we do not guess at other layouts.
 */
export function resolveStableNodePath(
  execPath: string,
  exists: (candidate: string) => boolean = existsSync,
): string {
  const match = CELLAR_NODE_RE.exec(execPath);
  if (!match) return execPath;
  const generic = path.join(match[1]!, "bin", "node");
  return exists(generic) ? generic : execPath;
}

/** Both hardenings, plus what changed — so the installer can say so out loud. */
export interface StableRegistration {
  readonly nodePath: string;
  readonly binPath: string;
  /** Human-readable notes for each rewrite applied (empty when none). */
  readonly notes: readonly string[];
}

/**
 * Harden an (interpreter, script) pair for persistent registration.
 *
 * Callers should print `notes`: a silent rewrite is nearly as confusing as the
 * silent breakage it prevents, and the operator needs to know the global
 * config does not point at the checkout they are standing in.
 */
export function stabilizeRegistration(
  nodePath: string,
  binPath: string,
  exists: (candidate: string) => boolean = existsSync,
): StableRegistration {
  const stableNode = resolveStableNodePath(nodePath, exists);
  const stableBin = resolveStableRegistrationPath(binPath, exists);
  const notes: string[] = [];
  if (stableBin !== binPath) {
    notes.push(
      `resolved worktree path to the main checkout (${stableBin}) — a worktree ` +
        `path in global config breaks as soon as the worktree is removed`,
    );
  } else if (isWorktreePath(binPath)) {
    notes.push(
      `WARNING: registering a WORKTREE path (${binPath}) because the main ` +
        `checkout has no matching file. This registration will break when the ` +
        `worktree is removed — re-run from the main checkout once it is merged`,
    );
  }
  if (stableNode !== nodePath) {
    notes.push(
      `using ${stableNode} instead of the version-pinned ${nodePath} — a Cellar ` +
        `path dies on the next node upgrade`,
    );
  }
  return { nodePath: stableNode, binPath: stableBin, notes };
}
