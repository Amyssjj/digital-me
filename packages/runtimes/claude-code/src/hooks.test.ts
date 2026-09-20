/**
 * Process-boundary tests for the shipped hook scripts against a brain-host
 * shaped HTTP stub.
 *
 * They spawn the REAL bash/python3 hooks from hooks/ with env-only overrides
 * (DIGITAL_ME_BRAIN_URL / DIGITAL_ME_BRAIN_TOKEN, HOME and the wiki root
 * pointed at a temp dir) and assert on what reached the stub, so three
 * contracts are locked where they actually bit in production:
 *
 *   1. Score scale — a brain-host hit whose `score` is the ~0.05 RRF sum is
 *      still injected (the hook gates on `vectorScore // score`), and a
 *      gateway-shaped hit (score only, relative path) keeps working.
 *   2. Token precedence — DIGITAL_ME_BRAIN_TOKEN beats an exported
 *      OPENCLAW_GATEWAY_TOKEN for both the search and the M1 emitter; a brain
 *      URL without a token is loud and never falls back to the gateway.
 *   3. Emitter resolution — the Stop hook finds dm_m1_emit.py next to itself,
 *      not via the cwd or ~/.claude/hooks.
 *
 * Skipped when bash / jq / curl / python3 are not on PATH (all four are on
 * every CI image this repo targets).
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOKS_DIR } from "./installer.js";

type Seen = { readonly auth: string | undefined; readonly body: Record<string, unknown> };
type RunResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };
type HookOutput = { hookSpecificOutput: { hookEventName: string; additionalContext: string } };

const REQUIRED_TOOLS = ["bash", "jq", "curl", "python3"];
const missingTools = REQUIRED_TOOLS.filter((t) => spawnSync("which", [t]).status !== 0);

const BRAIN_TOKEN = "brain-secret";
const GATEWAY_TOKEN = "gateway-secret";
const INJECT_HOOK = path.join(HOOKS_DIR, "dm_memory_search_inject.sh");
const STOP_HOOK = path.join(HOOKS_DIR, "dm_application_rate.sh");
const EMITTER = path.join(HOOKS_DIR, "dm_m1_emit.py");
const PROMPT = "why did my kanban goals vanish from the board window this week?";

const WIKI_ENTRY = `---
title: Kanban range filters by updated_at
domain: [dashboard]
tags: [kanban]
related: []
---

## Rule
Kanban scopes goals by updated_at; stale-but-open goals vanish from short windows. Use "All time".
`;

function brainHostPayload(entryPath: string, scores: { score: number; vectorScore: number; fusedScore?: number }) {
  return {
    results: [
      {
        path: entryPath,
        relPath: "wiki/dashboard/kanban.md",
        title: "Kanban range filters by updated_at",
        corpus: "wiki",
        startLine: 7,
        endLine: 8,
        ...scores,
        textScore: 1,
        snippet: "Rule: Kanban scopes goals by updated_at",
        source: "memory",
        citation: "wiki/dashboard/kanban.md#L7-L8",
      },
    ],
    provider: "gemini",
    model: "gemini-embedding-001",
    count: 1,
    query: PROMPT,
  };
}

const gatewayPayload = {
  results: [
    {
      path: "../digital-me/wiki/dashboard/kanban.md",
      score: 0.47,
      snippet: "Rule: Kanban scopes goals by updated_at",
      source: "memory",
    },
  ],
};

describe.skipIf(missingTools.length > 0)("hook scripts against a brain-host stub", () => {
  let server: http.Server;
  let brainUrl: string;
  let seen: Seen[] = [];
  let searchPayload: unknown = { results: [] };
  let tmp = "";
  const sessions: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push({ auth: req.headers.authorization, body });
        res.setHeader("Content-Type", "application/json");
        if (body.tool === "memory_search") {
          const text = JSON.stringify(searchPayload);
          res.end(JSON.stringify({ ok: true, result: { content: [{ type: "text", text }], details: searchPayload } }));
          return;
        }
        res.end(JSON.stringify({ ok: true, result: { content: [{ type: "text", text: '{"inserted":true}' }], details: { inserted: true } } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    brainUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tools/invoke`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-hooks-"));
    fs.mkdirSync(path.join(tmp, "wiki", "dashboard"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "wiki", "dashboard", "kanban.md"), WIKI_ENTRY);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    // The hooks keep per-session state in /tmp (dedup cache + once-only flag).
    for (const sid of sessions.splice(0)) {
      fs.rmSync(`/tmp/dm_hook_seen_${sid}.txt`, { force: true });
      fs.rmSync(`/tmp/dm_m1_started_${sid}`, { force: true });
    }
  });

  function newSession(): string {
    const sid = `dm-hooks-test-${process.pid}-${Date.now()}-${sessions.length}`;
    sessions.push(sid);
    return sid;
  }

  /** Sandboxed env: HOME + wiki root in tmp so no real WAL/log/config is touched. */
  function sandboxEnv(extra: Record<string, string>): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: tmp,
      DIGITAL_ME_WIKI_ROOT: tmp,
      PYTHONUTF8: "1",
      ...extra,
    };
  }

  const brainEnv = () => ({
    DIGITAL_ME_BRAIN_URL: brainUrl,
    DIGITAL_ME_BRAIN_TOKEN: BRAIN_TOKEN,
    // Exported gateway token must NOT win while the brain URL is set.
    OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
  });

  /**
   * Async spawn: the stub server lives in THIS process, so a spawnSync would
   * block the event loop and the hook's curl would hang until its timeout.
   */
  function run(cmd: string, args: string[], input: string, env: Record<string, string>): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: tmp, env: sandboxEnv(env), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        stdout += d;
      });
      child.stderr.on("data", (d: string) => {
        stderr += d;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  function runInject(sid: string, env: Record<string, string>): Promise<RunResult> {
    return run("bash", [INJECT_HOOK], JSON.stringify({ prompt: PROMPT, session_id: sid }), env);
  }

  function runEmitter(args: string[], env: Record<string, string>): Promise<RunResult> {
    return run("python3", [EMITTER, ...args], "", env);
  }

  function m1EventTypes(): unknown[] {
    return seen.filter((s) => s.body.tool === "m1_event_record").map((s) => (s.body.args as Record<string, unknown>).event_type);
  }

  it("injects a brain-host hit whose `score` is the RRF sum by gating on vectorScore, and routes M1 with the brain token", async () => {
    const sid = newSession();
    const entryPath = path.join(tmp, "wiki", "dashboard", "kanban.md");
    // Pre-fix brain-host shape: `score` ~0.04 would fail MIN_SCORE=40 on its own.
    searchPayload = brainHostPayload(entryPath, { score: 0.04, fusedScore: 0.04, vectorScore: 0.8 });

    const r = await runInject(sid, brainEnv());
    expect(r.status).toBe(0);
    expect(r.stdout).not.toBe("");
    const out = JSON.parse(r.stdout) as HookOutput;
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain(`- ${entryPath} (score=80/100`);
    expect(ctx).toContain("FULL BODY");
    expect(ctx).toContain("Kanban scopes goals by updated_at");
    expect(ctx).toContain("[Digital Me]");

    // The search and both M1 events reached brain-host with the brain token — never the gateway token.
    expect(seen.map((s) => s.body.tool)).toEqual(["memory_search", "m1_event_record", "m1_event_record"]);
    expect(seen.every((s) => s.auth === `Bearer ${BRAIN_TOKEN}`)).toBe(true);
    expect(m1EventTypes()).toEqual(["session_start", "knowledge_surfaced"]);
    const search = seen[0]!.body.args as Record<string, unknown>;
    expect(search.query).toBe(PROMPT);
    expect(search.limit).toBe(6);
    // The WAL landed under the sandboxed HOME, never the real one.
    expect(fs.existsSync(path.join(tmp, ".openclaw", "data", "m1_events_claude_code.jsonl"))).toBe(true);
  });

  it("injects the post-fix brain-host shape (score == vectorScore, fusedScore separate)", async () => {
    const sid = newSession();
    const entryPath = path.join(tmp, "wiki", "dashboard", "kanban.md");
    searchPayload = brainHostPayload(entryPath, { score: 0.78, vectorScore: 0.78, fusedScore: 0.042 });
    const r = await runInject(sid, brainEnv());
    expect(r.status).toBe(0);
    const ctx = (JSON.parse(r.stdout) as HookOutput).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(`- ${entryPath} (score=78/100`);
  });

  it("still injects a gateway-shaped hit (score only, relative ../ path)", async () => {
    const sid = newSession();
    // On the brain-host tier the hook gates at 60 (calibrated on vectorScore,
    // see hooks-env.test.ts) and falls back to `score` when vectorScore is
    // absent — so a score-only hit must clear that bar here. The 0.47 gateway
    // fixture is exercised on the gateway tier (MIN_SCORE 40) further down.
    searchPayload = { results: [{ ...gatewayPayload.results[0]!, score: 0.75 }] };
    const r = await runInject(sid, brainEnv());
    expect(r.status).toBe(0);
    const ctx = (JSON.parse(r.stdout) as HookOutput).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("- ../digital-me/wiki/dashboard/kanban.md (score=75/100");
    // `rel` is derived from the `/wiki/` suffix and resolved under DIGITAL_ME_WIKI_ROOT.
    expect(ctx).toContain("FULL BODY");
  });

  it("drops hits below MIN_SCORE on either scale and injects nothing", async () => {
    const sid = newSession();
    searchPayload = { results: [{ path: path.join(tmp, "wiki", "dashboard", "kanban.md"), score: 0.03, vectorScore: 0.2, snippet: "x" }] };
    const r = await runInject(sid, brainEnv());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(seen.map((s) => s.body.tool)).toEqual(["memory_search"]);
  });

  it("fails open but loudly when DIGITAL_ME_BRAIN_URL is set without a token — no gateway fallback", async () => {
    const sid = newSession();
    searchPayload = gatewayPayload;
    const r = await runInject(sid, { DIGITAL_ME_BRAIN_URL: brainUrl, OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/DIGITAL_ME_BRAIN_URL is set but DIGITAL_ME_BRAIN_TOKEN is not/);
    expect(seen).toEqual([]);
  });

  it("falls back to OPENCLAW_GATEWAY_HOST/PORT/TOKEN when no brain URL is set", async () => {
    const sid = newSession();
    searchPayload = gatewayPayload;
    const { hostname, port } = new URL(brainUrl);
    const r = await runInject(sid, {
      OPENCLAW_GATEWAY_HOST: hostname,
      OPENCLAW_GATEWAY_PORT: port,
      OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
    });
    expect(r.status).toBe(0);
    const ctx = (JSON.parse(r.stdout) as HookOutput).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("(score=47/100");
    // Search AND the M1 emitter both resolved the gateway tier: same host/port, gateway token.
    expect(seen.map((s) => s.body.tool)).toEqual(["memory_search", "m1_event_record", "m1_event_record"]);
    expect(seen.every((s) => s.auth === `Bearer ${GATEWAY_TOKEN}`)).toBe(true);
  });

  it("dm_m1_emit.py --selftest passes (includes the offline token-precedence checks)", async () => {
    const r = await runEmitter(["--selftest"], {});
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("DIGITAL_ME_BRAIN_TOKEN beats an exported OPENCLAW_GATEWAY_TOKEN");
    expect(r.stdout).toContain("[selftest] PASSED");
  });

  it("dm_m1_emit.py posts with DIGITAL_ME_BRAIN_TOKEN even when OPENCLAW_GATEWAY_TOKEN is exported", async () => {
    const sid = newSession();
    const wal = path.join(tmp, "wal.jsonl");
    const r = await runEmitter(
      ["knowledge_surfaced", "--session-id", sid, "--turn-id", "1", "--entries-json", '[{"path":"wiki/dashboard/kanban.md","score":0.8}]', "--wal", wal],
      brainEnv(),
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("brain=ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Bearer ${BRAIN_TOKEN}`);
    expect(seen[0]!.body.tool).toBe("m1_event_record");
    const args = seen[0]!.body.args as Record<string, unknown>;
    expect(args.event_type).toBe("knowledge_surfaced");
    expect(args.session_id).toBe(sid);
    expect(fs.readFileSync(wal, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("dm_m1_emit.py keeps the event in the WAL, posts nothing and exits 3 when the brain URL has no token", async () => {
    const sid = newSession();
    const wal = path.join(tmp, "wal.jsonl");
    const r = await runEmitter(
      ["session_end", "--session-id", sid, "--wal", wal, "--quiet"],
      { DIGITAL_ME_BRAIN_URL: brainUrl, OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN },
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/DIGITAL_ME_BRAIN_TOKEN is not/);
    expect(r.stderr).toContain("kept in WAL only");
    expect(seen).toEqual([]);
    expect(fs.readFileSync(wal, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("dm_m1_emit.py lets only an explicit --token override the env precedence", async () => {
    const sid = newSession();
    const wal = path.join(tmp, "wal.jsonl");
    const r = await runEmitter(
      ["session_end", "--session-id", sid, "--wal", wal, "--quiet", "--token", "explicit-secret"],
      brainEnv(),
    );
    expect(r.status).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe("Bearer explicit-secret");
  });

  it("dm_application_rate.sh resolves dm_m1_emit.py from its own directory and emits to brain-host", async () => {
    const sid = newSession();
    const transcript = path.join(tmp, "transcript.jsonl");
    const injected = [
      "Digital Me / openclaw-brain memory_search top hits for this prompt (auto-injected; may be stale):",
      "",
      "- /somewhere/wiki/dashboard/kanban.md (score=80/100, age=1d)",
      "  Rule: Kanban scopes goals by updated_at",
      "",
      "[Digital Me] protocol — BEGIN your reply with a line that starts `[Digital Me]`.",
    ].join("\n");
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "user", message: { content: PROMPT } }),
        JSON.stringify({ type: "attachment", attachment: { type: "hook_additional_context", content: injected } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "[Digital Me] applying Kanban range filters by updated_at" }] } }),
      ].join("\n") + "\n",
    );

    // cwd has no ./dm_m1_emit.py and the sandboxed HOME has no ~/.claude/hooks/dm_m1_emit.py,
    // so any event that reaches the stub was emitted via the hook's own directory.
    const r = await run("bash", [STOP_HOOK], JSON.stringify({ session_id: sid, transcript_path: transcript }), brainEnv());
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, ".claude", "hooks", "dm_m1_emit.py"))).toBe(false);

    const log = fs.readFileSync(path.join(tmp, ".claude", "hooks", "application_rate.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    const record = JSON.parse(log[0]!) as { session_id: string; surfaced_unique: number; hook_injections: number };
    expect(record.session_id).toBe(sid);
    expect(record.hook_injections).toBe(1);
    expect(record.surfaced_unique).toBe(1);

    expect(m1EventTypes()).toEqual(["session_end", "assistant_ack"]);
    expect(seen.every((s) => s.auth === `Bearer ${BRAIN_TOKEN}`)).toBe(true);
    const ack = seen[1]!.body.args as Record<string, unknown>;
    expect(ack.ack_signal).toBe("explicit_path");
  });
});
