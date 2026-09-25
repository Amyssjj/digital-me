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
 *      not via the cwd or the runtime home's hooks dir.
 *
 * The scripts are shared by Claude Code and Codex, so every scenario runs for
 * both runtimes (`--runtime <id>` in argv, as the installers register them);
 * the Stop-hook transcript scenario is per runtime because the two hosts
 * write different transcripts. The last block covers the three hooks that
 * never talk to the brain (PreToolUse route inject, handoff reminder,
 * session audit) the same way.
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
import { AGENT_HOOKS_DIR as HOOKS_DIR, HOOK_RUNTIMES, type HookRuntime } from "./hooks.js";

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
const ROUTE_HOOK = path.join(HOOKS_DIR, "brain_route_inject.sh");
const HANDOFF_HOOK = path.join(HOOKS_DIR, "dm_handoff_reminder.sh");
const AUDIT_HOOK = path.join(HOOKS_DIR, "dm_session_extract.sh");

/** Per-runtime names the scripts derive from --runtime (dm_hook_lib.sh / dm_m1_emit.py). */
const RUNTIME_STATE: Record<HookRuntime, { home: string; tag: string; wal: string }> = {
  "claude-code": { home: ".claude", tag: "", wal: "m1_events_claude_code.jsonl" },
  codex: { home: ".codex", tag: "codex_", wal: "m1_events_codex.jsonl" },
};
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

for (const RUNTIME of HOOK_RUNTIMES) {
const { home: RUNTIME_HOME, tag: STATE_TAG, wal: WAL_NAME } = RUNTIME_STATE[RUNTIME];

describe.skipIf(missingTools.length > 0)(`${RUNTIME} hook scripts against a brain-host stub`, () => {
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
      fs.rmSync(`/tmp/dm_hook_seen_${STATE_TAG}${sid}.txt`, { force: true });
      fs.rmSync(`/tmp/dm_m1_started_${STATE_TAG}${sid}`, { force: true });
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
      child.stdin.on("error", () => {}); // a hook may exit before reading stdin (EPIPE)
      child.stdin.end(input);
    });
  }

  /**
   * The M1 emits run detached in the background: after an injection, wait
   * for its knowledge_surfaced (posted last) before asserting on `seen`.
   */
  async function runInject(sid: string, env: Record<string, string>): Promise<RunResult> {
    const r = await run("bash", [INJECT_HOOK, "--runtime", RUNTIME], JSON.stringify({ prompt: PROMPT, session_id: sid }), env);
    if (r.stdout !== "") {
      const deadline = Date.now() + 15_000;
      while (!m1EventTypes().includes("knowledge_surfaced") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return r;
  }

  /** The emitter as the hooks spawn it: with the DM_RUNTIME they export. */
  function runEmitter(args: string[], env: Record<string, string>): Promise<RunResult> {
    return run("python3", [EMITTER, ...args], "", { DM_RUNTIME: RUNTIME, ...env });
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
    expect(fs.existsSync(path.join(tmp, ".openclaw", "data", WAL_NAME))).toBe(true);
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

  it("fails open but loudly when DIGITAL_ME_BRAIN_URL is set with no resolvable token — no gateway fallback", async () => {
    const sid = newSession();
    searchPayload = gatewayPayload;
    // HOME + DIGITAL_ME_WIKI_ROOT are the sandbox, so the default token file
    // (<wiki-root>/.data/brain-host.token) does not exist either.
    const r = await runInject(sid, { DIGITAL_ME_BRAIN_URL: brainUrl, OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/DIGITAL_ME_BRAIN_URL is set but no token was found/);
    expect(r.stderr).toContain("DIGITAL_ME_BRAIN_TOKEN_FILE");
    expect(r.stderr).toContain(path.join(tmp, ".data", "brain-host.token"));
    expect(seen).toEqual([]);
  });

  it("reads the brain token from the default <DIGITAL_ME_WIKI_ROOT>/.data/brain-host.token file when the env var is unset", async () => {
    const sid = newSession();
    const entryPath = path.join(tmp, "wiki", "dashboard", "kanban.md");
    searchPayload = brainHostPayload(entryPath, { score: 0.78, vectorScore: 0.78, fusedScore: 0.042 });
    fs.mkdirSync(path.join(tmp, ".data"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".data", "brain-host.token"), `${BRAIN_TOKEN}\n`);
    // The exported gateway token must still lose to the token file.
    const r = await runInject(sid, { DIGITAL_ME_BRAIN_URL: brainUrl, OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN });
    expect(r.status).toBe(0);
    const ctx = (JSON.parse(r.stdout) as HookOutput).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(`- ${entryPath} (score=78/100`);
    expect(seen.map((s) => s.body.tool)).toEqual(["memory_search", "m1_event_record", "m1_event_record"]);
    expect(seen.every((s) => s.auth === `Bearer ${BRAIN_TOKEN}`)).toBe(true);
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

  it("dm_m1_emit.py keeps the event in the WAL, posts nothing and exits 3 when the brain URL has no resolvable token", async () => {
    const sid = newSession();
    const wal = path.join(tmp, "wal.jsonl");
    const r = await runEmitter(
      ["session_end", "--session-id", sid, "--wal", wal, "--quiet"],
      { DIGITAL_ME_BRAIN_URL: brainUrl, OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN },
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/DIGITAL_ME_BRAIN_URL is set but no token was found/);
    expect(r.stderr).toContain("DIGITAL_ME_BRAIN_TOKEN_FILE");
    expect(r.stderr).toContain("kept in WAL only");
    expect(seen).toEqual([]);
    expect(fs.readFileSync(wal, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("dm_m1_emit.py reads the brain token from DIGITAL_ME_BRAIN_TOKEN_FILE", async () => {
    const sid = newSession();
    const wal = path.join(tmp, "wal.jsonl");
    const tokenFile = path.join(tmp, "custom.token");
    fs.writeFileSync(tokenFile, `  ${BRAIN_TOKEN}\n`);
    const r = await runEmitter(
      ["session_end", "--session-id", sid, "--wal", wal, "--quiet"],
      { DIGITAL_ME_BRAIN_URL: brainUrl, DIGITAL_ME_BRAIN_TOKEN_FILE: tokenFile, OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Bearer ${BRAIN_TOKEN}`);
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

  it.runIf(RUNTIME === "claude-code")("dm_application_rate.sh resolves dm_m1_emit.py from its own directory and emits to brain-host", async () => {
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
    const r = await run("bash", [STOP_HOOK, "--runtime", RUNTIME], JSON.stringify({ session_id: sid, transcript_path: transcript }), brainEnv());
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, RUNTIME_HOME, "hooks", "dm_m1_emit.py"))).toBe(false);

    const log = fs.readFileSync(path.join(tmp, RUNTIME_HOME, "hooks", "application_rate.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    const record = JSON.parse(log[0]!) as { session_id: string; surfaced_unique: number; hook_injections: number; runtime: string };
    expect(record.session_id).toBe(sid);
    expect(record.hook_injections).toBe(1);
    expect(record.surfaced_unique).toBe(1);
    expect(record.runtime).toBe(RUNTIME);

    expect(m1EventTypes()).toEqual(["session_end", "assistant_ack"]);
    expect(seen.every((s) => s.auth === `Bearer ${BRAIN_TOKEN}`)).toBe(true);
    const ack = seen[1]!.body.args as Record<string, unknown>;
    expect(ack.ack_signal).toBe("explicit_path");
  });
  it.runIf(RUNTIME === "codex")("dm_application_rate.sh scores the codex session from the inject hook's SEEN_FILE + the rollout transcript and emits to brain-host", async () => {
    const sid = newSession();
    // What the inject hook recorded for this session (one line per surfaced path).
    fs.writeFileSync(
      `/tmp/dm_hook_seen_codex_${sid}.txt`,
      "/somewhere/wiki/dashboard/kanban.md\n/somewhere/wiki/infra/unrelated-entry.md\n",
    );
    const transcript = path.join(tmp, "rollout.jsonl");
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: PROMPT } }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call", name: "mcp__openclaw_brain__memory_get", arguments: JSON.stringify({ path: "dashboard/kanban.md" }) },
        }),
        JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" } }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looked it up." }] },
        }),
      ].join("\n") + "\n",
    );

    // cwd has no ./dm_m1_emit.py and the sandboxed HOME has no ~/.codex/hooks/dm_m1_emit.py,
    // so any event that reaches the stub was emitted via the hook's own directory.
    const r = await run(
      "bash",
      [STOP_HOOK, "--runtime", RUNTIME],
      JSON.stringify({ session_id: sid, transcript_path: transcript, last_assistant_message: "[Digital Me] applying kanban range filters" }),
      brainEnv(),
    );
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, ".codex", "hooks", "dm_m1_emit.py"))).toBe(false);

    const log = fs.readFileSync(path.join(tmp, ".codex", "hooks", "application_rate.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    const record = JSON.parse(log[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      session_id: sid,
      runtime: "codex",
      user_msgs: 1,
      tool_uses: 2,
      hook_injections: 2,
      surfaced_unique: 2,
      acted_unique: 1,
      application_rate: 0.5,
      // A bare memory_get path is wiki-relative: it matches the surfaced entry.
      acted_paths: ["wiki/dashboard/kanban.md"],
      ignored_paths: ["wiki/infra/unrelated-entry.md"],
    });

    expect(m1EventTypes()).toEqual(["session_end", "assistant_ack"]);
    expect(seen.every((s) => s.auth === `Bearer ${BRAIN_TOKEN}`)).toBe(true);
    const ack = seen[1]!.body.args as Record<string, unknown>;
    expect(ack.runtime).toBe("codex");
    expect(ack.ack_signal).toBe("explicit_path");
    expect(JSON.parse(ack.entries as string)).toEqual([{ path: "wiki/dashboard/kanban.md" }]);
  });

  it.runIf(RUNTIME === "codex")("dm_application_rate.sh exits quietly when the codex inject hook surfaced nothing this session", async () => {
    const sid = newSession();
    const r = await run("bash", [STOP_HOOK, "--runtime", RUNTIME], JSON.stringify({ session_id: sid }), brainEnv());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(fs.existsSync(path.join(tmp, ".codex", "hooks", "application_rate.log"))).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe.skipIf(missingTools.length > 0)(`${RUNTIME} PreToolUse / Stop hooks that never call the brain`, () => {
  let tmp = "";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-hooks-local-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runHook(script: string, input: unknown): RunResult {
    const r = spawnSync("bash", [script, "--runtime", RUNTIME], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp, DIGITAL_ME_WIKI_ROOT: tmp },
      input: JSON.stringify(input),
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function readJsonl(file: string): Array<Record<string, unknown>> {
    return fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  describe("brain_route_inject.sh", () => {
    beforeEach(() => {
      const rule = (name: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(tmp, "wiki", name)), { recursive: true });
        fs.writeFileSync(path.join(tmp, "wiki", name), `---\ntitle: x\n---\n\n## Rule\n${text}\n\n## How\nsteps\n`);
      };
      rule("tools/use-brain-tasks-for-orchestrator-writes.md", "Write through the brain tasks tool, never raw sqlite.");
      rule("agents/brain-tasks-json-output-mode.md", "Pass format=json for board/status reads.");
      rule("tools/stringify-tasks-tool-parameters.md", "Stringify tasks/variables parameters.");
    });

    const logFile = () => path.join(tmp, RUNTIME_HOME, "logs", "brain_route_inject.jsonl");

    function contextOf(r: RunResult): string {
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout) as HookOutput;
      expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      return out.hookSpecificOutput.additionalContext;
    }

    it("fires on a sqlite write to the canonical brain-host store <wiki-root>/.data/brain.db", () => {
      const r = runHook(ROUTE_HOOK, {
        tool_name: "Bash",
        tool_input: { command: `sqlite3 ${tmp}/.data/brain.db "UPDATE tasks SET status='done' WHERE id=1"` },
      });
      const ctx = contextOf(r);
      expect(ctx).toContain("protocol rule: brain-write-via-tasks");
      expect(ctx).toContain("never raw sqlite");
      expect(ctx).not.toContain("## How");
      expect(readJsonl(logFile())).toEqual([
        expect.objectContaining({ tool: "Bash", rule: "brain-write-via-tasks", injected: "yes" }),
      ]);
    });

    it("still fires on the legacy openclaw stores, and for the codex shell tool spellings", () => {
      for (const input of [
        { tool_name: "Bash", tool_input: { command: "sqlite3 ~/x/task-orchestrator.db 'INSERT INTO t VALUES (1)'" } },
        { tool_name: "Bash", tool_input: { command: "sqlite3 ~/.openclaw/data/other.db 'DELETE FROM t'" } },
        { tool_name: "exec_command", tool_input: { cmd: "sqlite3 system_monitor.db 'REPLACE INTO t VALUES (1)'" } },
        { tool_name: "shell", tool_input: { command: "sqlite3 brain.db 'UPDATE t SET a=1'" } },
      ]) {
        expect(contextOf(runHook(ROUTE_HOOK, input)), JSON.stringify(input)).toContain("brain-write-via-tasks");
      }
    });

    it("stays silent for reads of brain.db and for unrelated databases, but logs the decision", () => {
      for (const command of [`sqlite3 ${tmp}/.data/brain.db 'SELECT * FROM tasks'`, "sqlite3 app.db 'UPDATE t SET a=1'"]) {
        const r = runHook(ROUTE_HOOK, { tool_name: "Bash", tool_input: { command } });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe("");
      }
      expect(readJsonl(logFile()).map((e) => e.injected)).toEqual(["no", "no"]);
    });

    it("injects the brain tasks rules for every tasks-tool spelling", () => {
      for (const tool_name of ["mcp__openclaw-brain__tasks", "mcp__openclaw_brain__tasks", "tasks"]) {
        expect(contextOf(runHook(ROUTE_HOOK, { tool_name, tool_input: { action: "board" } })), tool_name).toContain(
          "tasks-json-format",
        );
        expect(
          contextOf(runHook(ROUTE_HOOK, { tool_name, tool_input: { action: "create", tasks: [{ title: "x" }] } })),
          tool_name,
        ).toContain("stringify-tasks");
      }
      expect(runHook(ROUTE_HOOK, { tool_name: "tasks", tool_input: { action: "board", format: "json" } }).stdout).toBe("");
    });

    it(`logs under ~/${RUNTIME_HOME}/logs only`, () => {
      runHook(ROUTE_HOOK, { tool_name: "Read", tool_input: { file_path: "/x" } });
      expect(readJsonl(logFile())).toEqual([expect.objectContaining({ tool: "Read", rule: "", injected: "no" })]);
      const other = RUNTIME_HOME === ".codex" ? ".claude" : ".codex";
      expect(fs.existsSync(path.join(tmp, other))).toBe(false);
    });
  });

  describe("dm_handoff_reminder.sh", () => {
    function transcript(lines: unknown[]): string {
      const file = path.join(tmp, "t.jsonl");
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return file;
    }

    const ccWork = [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__openclaw-brain__tasks", input: { action: "run_goal" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/x" } }] } },
    ];
    const codexWork = [
      { type: "response_item", payload: { type: "function_call", name: "mcp__openclaw_brain__tasks", arguments: JSON.stringify({ action: "checkpoint" }) } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" } },
    ];

    it("blocks once when a dispatched task session changed files without a handoff (both transcript formats), naming this runtime's tools", () => {
      for (const lines of [ccWork, codexWork]) {
        const r = runHook(HANDOFF_HOOK, { transcript_path: transcript(lines), stop_hook_active: false });
        expect(r.status).toBe(0);
        const out = JSON.parse(r.stdout) as { decision: string; reason: string };
        expect(out.decision).toBe("block");
        expect(out.reason).toContain(RUNTIME === "codex" ? "(apply_patch)" : "(Edit/Write/NotebookEdit)");
        expect(out.reason).toContain(RUNTIME === "codex" ? "no openclaw-brain tasks action=handoff" : "no mcp__openclaw-brain__tasks action=handoff");
      }
    });

    it("stays silent after a handoff, on the re-entrant stop, and for ad-hoc sessions", () => {
      const handedOff = transcript([...ccWork, { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__openclaw-brain__tasks", input: { action: "handoff" } }] } }]);
      expect(runHook(HANDOFF_HOOK, { transcript_path: handedOff }).stdout).toBe("");
      expect(runHook(HANDOFF_HOOK, { transcript_path: transcript(codexWork), stop_hook_active: true }).stdout).toBe("");
      const adHoc = transcript([{ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: {} }] } }]);
      expect(runHook(HANDOFF_HOOK, { transcript_path: adHoc }).stdout).toBe("");
      expect(runHook(HANDOFF_HOOK, {}).stdout).toBe("");
    });
  });

  describe("dm_session_extract.sh", () => {
    const auditFile = () => path.join(tmp, RUNTIME_HOME, "audit", "dm_sessions.jsonl");

    it(`appends one audit line per Stop to ~/${RUNTIME_HOME}/audit, detecting memory_search in either transcript format`, () => {
      const cc = path.join(tmp, "cc.jsonl");
      fs.writeFileSync(cc, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__openclaw-brain__memory_search", input: { action: "handoff" } }] } }) + "\n");
      const codex = path.join(tmp, "codex.jsonl");
      fs.writeFileSync(
        codex,
        [
          { type: "response_item", payload: { type: "function_call", name: "memory_search", arguments: "{}" } },
          // Codex: arguments is a JSON string, so its quotes are escaped in the rollout line.
          { type: "response_item", payload: { type: "function_call", name: "tasks", arguments: JSON.stringify({ action: "handoff" }) } },
        ].map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      expect(runHook(AUDIT_HOOK, { session_id: "s1", transcript_path: cc, cwd: "/w" }).stdout).toBe("");
      runHook(AUDIT_HOOK, { session_id: "s2", transcript_path: codex });
      // No transcript: still audited, every signal false.
      runHook(AUDIT_HOOK, { session_id: "s3" });
      // No session id: nothing to record.
      runHook(AUDIT_HOOK, { transcript_path: cc });
      expect(readJsonl(auditFile())).toEqual([
        expect.objectContaining({ session_id: "s1", cwd: "/w", memory_search: true, handoff: true, task_session: false }),
        expect.objectContaining({ session_id: "s2", memory_search: true, handoff: true, task_session: false }),
        expect.objectContaining({ session_id: "s3", memory_search: false, handoff: false, task_session: false }),
      ]);
    });
  });
});
}
