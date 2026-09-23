/**
 * Env-contract tests for the shipped hooks.
 *
 * Every brain call made by dm_memory_search_inject.sh (UserPromptSubmit) and
 * dm_m1_emit.py (the M1 emitter, also spawned by the inject + Stop hooks) must
 * resolve its endpoint with the same precedence as brain-mcp-proxy/config.ts:
 *
 *   DIGITAL_ME_BRAIN_URL (brain-host) with the token from DIGITAL_ME_BRAIN_TOKEN,
 *     else the trimmed contents of DIGITAL_ME_BRAIN_TOKEN_FILE, else of
 *     <DIGITAL_ME_WIKI_ROOT or ~/digital-me>/.data/brain-host.token
 *   > OPENCLAW_GATEWAY_URL | OPENCLAW_GATEWAY_HOST/PORT + OPENCLAW_GATEWAY_TOKEN
 *   > $HOME/.openclaw/openclaw.json  (gateway.auth.token)
 *
 * With no DIGITAL_ME_BRAIN_URL in the env, the installer-written sidecar
 * (digital-me-brain.env next to the script) supplies DIGITAL_ME_BRAIN_URL and
 * DIGITAL_ME_BRAIN_TOKEN_FILE and beats every OPENCLAW_GATEWAY_* source — the
 * hook host may never pass the env (Codex does not).
 *
 * A node http stub stands in for the backend so each test proves WHERE the
 * request went and which bearer it carried — and that a URL with no resolvable
 * token never falls back to the gateway. Spawns start from a scrubbed env with an
 * isolated HOME, so nothing from the developer's shell or ~/.openclaw leaks in
 * and the M1 WAL lands under the temp dir, never in the real one.
 *
 * Twin of packages/runtimes/codex/src/hooks-env.test.ts (same contract, the
 * runtime-flavoured constants differ).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BRAIN_SIDECAR_FILE, renderBrainSidecar } from "@digital-me/contracts";
import { HOOKS_DIR } from "./installer.js";

// The hooks shell out to jq/curl/python3 several times per run; give slow CI
// runners room.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const INJECT = path.join(HOOKS_DIR, "dm_memory_search_inject.sh");
const EMIT = path.join(HOOKS_DIR, "dm_m1_emit.py");
const RUNTIME = "claude-code";
// Per-session state the scripts keep under /tmp (hard-coded there by design).
const SEEN_PREFIX = "/tmp/dm_hook_seen_";
const FLAG_PREFIX = "/tmp/dm_m1_started_";
const WAL_NAME = "m1_events_claude_code.jsonl";

type Seen = { url: string; auth: string | undefined; body: any };
type Run = { status: number | null; stdout: string; stderr: string };

let server: http.Server;
let baseUrl: string;
let seen: Seen[] = [];
let cannedSearch: unknown = { results: [] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw === "" ? null : JSON.parse(raw);
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      const text =
        body?.tool === "memory_search"
          ? JSON.stringify(cannedSearch)
          : JSON.stringify({ inserted: true });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, result: { content: [{ type: "text", text }] } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${port()}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let home: string;
beforeEach(() => {
  seen = [];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dm-hooks-env-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function port(): string {
  return String((server.address() as { port: number }).port);
}

/** Scrubbed env: PATH + the isolated HOME + exactly what the test sets. */
function scrubbedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", ...extra };
}

/**
 * Async spawn: the stub server lives in this worker, so a blocking spawnSync
 * would starve it and every request from the child would time out.
 */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input = ""): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
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

function writeOpenclawJson(token: string): void {
  fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".openclaw", "openclaw.json"),
    JSON.stringify({ gateway: { auth: { token } } }),
  );
}

/** The default brain-host token file for the isolated HOME (no DIGITAL_ME_WIKI_ROOT). */
function defaultTokenFile(wikiRoot = path.join(home, "digital-me")): string {
  return path.join(wikiRoot, ".data", "brain-host.token");
}

/** Write a token file the way `digital-me install --runtime brain-host` does (trailing newline). */
function writeTokenFile(file: string, contents: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

/**
 * Install copies of the inject hook + emitter into a temp hooks dir, the way
 * `digital-me install` does, optionally with a sidecar beside them. The
 * scripts look for the sidecar next to their own path, so this is how a test
 * controls it without any test-only switch in production code.
 */
function installHooks(sidecar?: string): { inject: string; emit: string; sidecar: string } {
  const dir = path.join(home, "installed-hooks");
  fs.mkdirSync(dir, { recursive: true });
  for (const src of [INJECT, EMIT]) {
    const dst = path.join(dir, path.basename(src));
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  }
  const sidecarPath = path.join(dir, BRAIN_SIDECAR_FILE);
  if (sidecar !== undefined) fs.writeFileSync(sidecarPath, sidecar);
  return {
    inject: path.join(dir, path.basename(INJECT)),
    emit: path.join(dir, path.basename(EMIT)),
    sidecar: sidecarPath,
  };
}

/** Exactly what `digital-me install` writes for a brain-host at `url` whose token is in `tokenFile`. */
function sidecarFor(url: string, tokenFile: string): string {
  return renderBrainSidecar({ brainUrl: url, brainTokenFile: tokenFile });
}

// ─── dm_m1_emit.py ─────────────────────────────────────────────────────────

async function runEmit(env: Record<string, string>, extraArgs: string[] = [], script = EMIT) {
  const wal = path.join(home, "wal.jsonl");
  const r = await run(
    "python3",
    [script, "knowledge_surfaced", "--session-id", "t", "--wal", wal, ...extraArgs],
    scrubbedEnv(env),
  );
  const walLines = fs.existsSync(wal)
    ? fs.readFileSync(wal, "utf-8").trim().split("\n")
    : [];
  return { ...r, walLines };
}

describe(`${RUNTIME} dm_m1_emit.py — endpoint + token precedence`, () => {
  it("passes --selftest (offline idempotency checks)", async () => {
    const r = await run("python3", [EMIT, "--selftest"], scrubbedEnv({}));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("[selftest] PASSED");
  });

  it("DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN → POSTs m1_event_record to brain-host with that bearer", async () => {
    const r = await runEmit({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN: "t",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/tools/invoke");
    expect(seen[0]!.auth).toBe("Bearer t");
    expect(seen[0]!.body.tool).toBe("m1_event_record");
    expect(seen[0]!.body.args.event_type).toBe("knowledge_surfaced");
    expect(seen[0]!.body.args.runtime).toBe(RUNTIME);
    expect(r.stdout).toContain("brain=ok");
    expect(r.walLines).toHaveLength(1);
  });

  it("brain-host wins over gateway env when both are set (URL and token)", async () => {
    const r = await runEmit({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/brain/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN: "t-brain",
      OPENCLAW_GATEWAY_URL: `${baseUrl}/gateway/tools/invoke`,
      OPENCLAW_GATEWAY_TOKEN: "t-gateway",
      OPENCLAW_GATEWAY_HOST: "127.0.0.1",
      OPENCLAW_GATEWAY_PORT: port(),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/brain/tools/invoke");
    expect(seen[0]!.auth).toBe("Bearer t-brain");
  });

  it("DIGITAL_ME_BRAIN_URL with no token anywhere is a hard error: no request, no gateway-token fallback, WAL still written, stderr names both token vars", async () => {
    writeOpenclawJson("file-tok"); // available gateway tokens must NOT be used
    const r = await runEmit({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      OPENCLAW_GATEWAY_TOKEN: "t-gateway",
    });
    expect(r.status).toBe(3); // exit-code contract: WAL written, but brain misconfigured → 3
    expect(seen).toHaveLength(0);
    expect(r.stderr).toContain("DIGITAL_ME_BRAIN_TOKEN,");
    expect(r.stderr).toContain("DIGITAL_ME_BRAIN_TOKEN_FILE");
    expect(r.stderr).toContain(defaultTokenFile()); // where it looked
    expect(r.stderr).toContain("kept in WAL only");
    expect(r.walLines).toHaveLength(1);
  });

  it("DIGITAL_ME_BRAIN_URL + the default token file (<HOME>/digital-me/.data/brain-host.token) → bearer is the trimmed file contents", async () => {
    writeTokenFile(defaultTokenFile(), "  file-secret\n");
    const r = await runEmit({ DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke` });
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe("Bearer file-secret");
    expect(r.stdout).toContain("brain=ok");
  });

  it("DIGITAL_ME_WIKI_ROOT relocates the default token file", async () => {
    const wikiRoot = path.join(home, "elsewhere");
    writeTokenFile(defaultTokenFile(wikiRoot), "relocated-secret\n");
    writeTokenFile(defaultTokenFile(), "wrong-secret\n"); // the ~/digital-me default must be ignored
    const r = await runEmit({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(seen[0]!.auth).toBe("Bearer relocated-secret");
  });

  it("DIGITAL_ME_BRAIN_TOKEN_FILE names an explicit file that beats the default one", async () => {
    writeTokenFile(defaultTokenFile(), "default-secret\n");
    const explicit = writeTokenFile(path.join(home, "custom.token"), "explicit-secret\n");
    const r = await runEmit({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN_FILE: explicit,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(seen[0]!.auth).toBe("Bearer explicit-secret");
  });

  it("DIGITAL_ME_BRAIN_TOKEN (env) wins over both token files", async () => {
    writeTokenFile(defaultTokenFile(), "default-secret\n");
    const explicit = writeTokenFile(path.join(home, "custom.token"), "explicit-secret\n");
    const r = await runEmit({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN: "env-secret",
      DIGITAL_ME_BRAIN_TOKEN_FILE: explicit,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(seen[0]!.auth).toBe("Bearer env-secret");
  });

  it("an empty token file counts as no token: exit 3, no request, stderr names DIGITAL_ME_BRAIN_TOKEN_FILE and the file", async () => {
    const explicit = writeTokenFile(path.join(home, "empty.token"), "  \n");
    writeOpenclawJson("file-tok");
    const r = await runEmit({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN_FILE: explicit,
      OPENCLAW_GATEWAY_TOKEN: "t-gateway",
    });
    expect(r.status).toBe(3);
    expect(seen).toHaveLength(0);
    expect(r.stderr).toContain("DIGITAL_ME_BRAIN_TOKEN_FILE");
    expect(r.stderr).toContain(explicit);
    expect(r.walLines).toHaveLength(1);
  });

  it("OPENCLAW_GATEWAY_URL + OPENCLAW_GATEWAY_TOKEN still work (legacy gateway env)", async () => {
    const r = await runEmit({
      OPENCLAW_GATEWAY_URL: `${baseUrl}/tools/invoke`,
      OPENCLAW_GATEWAY_TOKEN: "g",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe("Bearer g");
    expect(seen[0]!.body.tool).toBe("m1_event_record");
  });

  it("OPENCLAW_GATEWAY_HOST/PORT/TOKEN compose the gateway URL", async () => {
    const r = await runEmit({
      OPENCLAW_GATEWAY_HOST: "127.0.0.1",
      OPENCLAW_GATEWAY_PORT: port(),
      OPENCLAW_GATEWAY_TOKEN: "g2",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/tools/invoke");
    expect(seen[0]!.auth).toBe("Bearer g2");
  });

  it("falls back to $HOME/.openclaw/openclaw.json for the gateway token", async () => {
    writeOpenclawJson("file-tok");
    const r = await runEmit({ OPENCLAW_GATEWAY_HOST: "127.0.0.1", OPENCLAW_GATEWAY_PORT: port() });
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe("Bearer file-tok");
  });

  it("--gateway / --token flags override the environment", async () => {
    const r = await runEmit(
      { DIGITAL_ME_BRAIN_URL: `${baseUrl}/env/tools/invoke`, DIGITAL_ME_BRAIN_TOKEN: "env-tok" },
      ["--gateway", `${baseUrl}/flag/tools/invoke`, "--token", "flag-tok"],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/flag/tools/invoke");
    expect(seen[0]!.auth).toBe("Bearer flag-tok");
  });
});

describe(`${RUNTIME} dm_m1_emit.py — installer-written sidecar (${BRAIN_SIDECAR_FILE})`, () => {
  it("no DIGITAL_ME_BRAIN_URL in the env: POSTs to the sidecar URL with the bearer from the sidecar's token file, whatever DIGITAL_ME_WIKI_ROOT says", async () => {
    const token = writeTokenFile(path.join(home, "secrets", "brain-host.token"), "sidecar-secret\n");
    const { emit } = installHooks(sidecarFor(`${baseUrl}/sidecar/tools/invoke`, token));
    // The live hook env: no brain URL and a WRONG wiki root (the wiki dir
    // itself), so the default token file cannot be found either.
    const r = await runEmit({ DIGITAL_ME_WIKI_ROOT: path.join(home, "digital-me", "wiki") }, [], emit);
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/sidecar/tools/invoke");
    expect(seen[0]!.auth).toBe("Bearer sidecar-secret");
    expect(seen[0]!.body.tool).toBe("m1_event_record");
    expect(r.stdout).toContain("brain=ok");
  });

  it("an exported DIGITAL_ME_BRAIN_URL beats the sidecar", async () => {
    const token = writeTokenFile(path.join(home, "secrets", "brain-host.token"), "sidecar-secret\n");
    const { emit } = installHooks(sidecarFor(`${baseUrl}/sidecar/tools/invoke`, token));
    const r = await runEmit(
      { DIGITAL_ME_BRAIN_URL: `${baseUrl}/env/tools/invoke`, DIGITAL_ME_BRAIN_TOKEN: "env-secret" },
      [],
      emit,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/env/tools/invoke");
    expect(seen[0]!.auth).toBe("Bearer env-secret");
  });

  it("the sidecar beats OPENCLAW_GATEWAY_* env and openclaw.json", async () => {
    writeOpenclawJson("file-tok");
    const token = writeTokenFile(path.join(home, "secrets", "brain-host.token"), "sidecar-secret\n");
    const { emit } = installHooks(sidecarFor(`${baseUrl}/sidecar/tools/invoke`, token));
    const r = await runEmit(
      {
        OPENCLAW_GATEWAY_URL: `${baseUrl}/gateway/tools/invoke`,
        OPENCLAW_GATEWAY_HOST: "127.0.0.1",
        OPENCLAW_GATEWAY_PORT: port(),
        OPENCLAW_GATEWAY_TOKEN: "t-gateway",
      },
      [],
      emit,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/sidecar/tools/invoke");
    expect(seen[0]!.auth).toBe("Bearer sidecar-secret");
  });

  it("a missing or garbage sidecar leaves today's behaviour: the gateway env is used", async () => {
    const env = { OPENCLAW_GATEWAY_URL: `${baseUrl}/gateway/tools/invoke`, OPENCLAW_GATEWAY_TOKEN: "t-gateway" };
    const { emit, sidecar } = installHooks();
    const missing = await runEmit(env, [], emit);
    expect(missing.status, missing.stderr).toBe(0);
    fs.writeFileSync(sidecar, Buffer.from([0xff, 0xfe, 0x00, 0x0a, 0x6e, 0x6f, 0x3d, 0x0a])); // not UTF-8
    const garbage = await runEmit(env, [], emit);
    expect(garbage.status, garbage.stderr).toBe(0);
    fs.writeFileSync(sidecar, "just words\nDIGITAL_ME_BRAIN_URL=\nOTHER_KEY=http://elsewhere\n");
    const empty = await runEmit(env, [], emit);
    expect(empty.status, empty.stderr).toBe(0);
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.url).toBe("/gateway/tools/invoke");
      expect(s.auth).toBe("Bearer t-gateway");
    }
  });

  it("a sidecar URL whose token file is missing is a hard error naming the sidecar: exit 3, no request, WAL kept", async () => {
    writeOpenclawJson("file-tok");
    const missing = path.join(home, "secrets", "missing.token");
    const { emit, sidecar } = installHooks(sidecarFor(`${baseUrl}/sidecar/tools/invoke`, missing));
    const r = await runEmit({ OPENCLAW_GATEWAY_TOKEN: "t-gateway" }, [], emit);
    expect(r.status).toBe(3);
    expect(seen).toHaveLength(0);
    expect(r.stderr).toContain(sidecar);
    expect(r.stderr).toContain(missing);
    expect(r.walLines).toHaveLength(1);
  });

  it("--selftest stays isolated from a live sidecar next to the script", async () => {
    const token = writeTokenFile(path.join(home, "secrets", "brain-host.token"), "sidecar-secret\n");
    const { emit } = installHooks(sidecarFor(`${baseUrl}/sidecar/tools/invoke`, token));
    const r = await run("python3", [emit, "--selftest"], scrubbedEnv({}));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("[selftest] brain sidecar");
    expect(r.stdout).toContain("[selftest] PASSED");
    expect(seen).toHaveLength(0);
  });
});

// ─── dm_memory_search_inject.sh ────────────────────────────────────────────

const PROMPT = "how should I rebase a dependabot pull request safely?";

function seedWiki(): { wikiRoot: string; entryPath: string } {
  const wikiRoot = path.join(home, "digital-me");
  const dir = path.join(wikiRoot, "wiki", "dev");
  fs.mkdirSync(dir, { recursive: true });
  const entryPath = path.join(dir, "rebase-rule.md");
  fs.writeFileSync(
    entryPath,
    [
      "---",
      "title: Rebase rule",
      "related: []",
      "---",
      "",
      "## Rule",
      "Comment @dependabot rebase; never push to its branch.",
      "",
    ].join("\n"),
  );
  return { wikiRoot, entryPath };
}

function hit(entryPath: string, scores: { score: number; vectorScore?: number }) {
  return {
    path: entryPath,
    relPath: "wiki/dev/rebase-rule.md",
    title: "Rebase rule",
    corpus: "wiki",
    startLine: 6,
    endLine: 7,
    snippet: "Rule: comment @dependabot rebase",
    source: "memory",
    citation: "wiki/dev/rebase-rule.md#L6-L7",
    textScore: 1,
    ...scores,
  };
}

async function runInject(
  env: Record<string, string>,
  { script = INJECT, prompt = PROMPT }: { script?: string; prompt?: string } = {},
): Promise<Run> {
  const sid = randomUUID();
  const r = await run(
    "bash",
    [script],
    scrubbedEnv(env),
    JSON.stringify({ prompt, session_id: sid }),
  );
  fs.rmSync(`${SEEN_PREFIX}${sid}.txt`, { force: true });
  fs.rmSync(`${FLAG_PREFIX}${sid}`, { force: true });
  return r;
}

function parseContext(stdout: string): string {
  const out = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  return out.hookSpecificOutput.additionalContext;
}

describe(`${RUNTIME} dm_memory_search_inject.sh — endpoint, token and score gate`, () => {
  it("brain-host env: memory_search + both M1 events reach brain-host with the brain bearer; vectorScore gates; context is emitted", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    // Real brain-host shape: RRF-fused `score` ≈ 0.04 (fails any 0-100 gate),
    // cosine vectorScore 0.77 (a relevant hit on the live index).
    cannedSearch = {
      provider: "gemini",
      count: 1,
      results: [hit(entryPath, { score: 0.042, vectorScore: 0.77 })],
    };
    const r = await runInject({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN: "t",
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status, r.stderr).toBe(0);
    const ctx = parseContext(r.stdout);
    expect(ctx).toContain(entryPath);
    expect(ctx).toContain("score=77/100");
    expect(ctx).toContain("never push to its branch"); // top-1 body inlined from the wiki file
    expect(ctx).toContain("[Digital Me]");

    const search = seen.filter((s) => s.body.tool === "memory_search");
    expect(search).toHaveLength(1);
    expect(search[0]!.url).toBe("/tools/invoke");
    expect(search[0]!.auth).toBe("Bearer t");
    expect(search[0]!.body.args.query).toBe(PROMPT);

    // The emitter subprocess inherits the same contract: session_start +
    // knowledge_surfaced reached brain-host with the brain bearer too.
    const m1 = seen.filter((s) => s.body.tool === "m1_event_record");
    expect(m1.map((s) => s.body.args.event_type)).toEqual([
      "session_start",
      "knowledge_surfaced",
    ]);
    for (const s of m1) expect(s.auth).toBe("Bearer t");
    expect(m1[1]!.body.args.runtime).toBe(RUNTIME);
    // The durable WAL landed under the isolated HOME, not the developer's.
    expect(fs.existsSync(path.join(home, ".openclaw", "data", WAL_NAME))).toBe(true);
  });

  it("brain-host env: a hit whose vectorScore is below the gate (off-topic ~0.52) is dropped", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    cannedSearch = { results: [hit(entryPath, { score: 0.03, vectorScore: 0.52 })] };
    const r = await runInject({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN: "t",
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(seen.filter((s) => s.body.tool === "memory_search")).toHaveLength(1);
    expect(seen.filter((s) => s.body.tool === "m1_event_record")).toHaveLength(0);
  });

  it("DIGITAL_ME_HOOK_MIN_SCORE overrides the brain-host gate", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    cannedSearch = { results: [hit(entryPath, { score: 0.03, vectorScore: 0.52 })] };
    const r = await runInject({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN: "t",
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
      DIGITAL_ME_HOOK_MIN_SCORE: "50",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(parseContext(r.stdout)).toContain("score=52/100");
  });

  it("DIGITAL_ME_BRAIN_URL with no token anywhere: no request, fail-open with a stderr diagnostic naming both token vars", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    writeOpenclawJson("file-tok"); // a gateway token IS available — it must not be used
    cannedSearch = { results: [hit(entryPath, { score: 0.9, vectorScore: 0.9 })] };
    const r = await runInject({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      OPENCLAW_GATEWAY_TOKEN: "g",
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("DIGITAL_ME_BRAIN_TOKEN,");
    expect(r.stderr).toContain("DIGITAL_ME_BRAIN_TOKEN_FILE");
    expect(r.stderr).toContain(defaultTokenFile(wikiRoot));
    expect(seen).toHaveLength(0);
  });

  it("brain-host env with the token in the default file (<DIGITAL_ME_WIKI_ROOT>/.data/brain-host.token): search + both M1 events carry the file bearer", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    writeTokenFile(defaultTokenFile(wikiRoot), "file-secret\n");
    cannedSearch = { results: [hit(entryPath, { score: 0.042, vectorScore: 0.77 })] };
    const r = await runInject({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(parseContext(r.stdout)).toContain("score=77/100");
    expect(seen.map((s) => s.body.tool)).toEqual(["memory_search", "m1_event_record", "m1_event_record"]);
    for (const s of seen) expect(s.auth).toBe("Bearer file-secret");
  });

  it("DIGITAL_ME_BRAIN_TOKEN_FILE names an explicit file (trimmed) that beats the default one", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    writeTokenFile(defaultTokenFile(wikiRoot), "default-secret\n");
    const explicit = writeTokenFile(path.join(home, "custom.token"), "\n  explicit-secret  \n");
    cannedSearch = { results: [hit(entryPath, { score: 0.9, vectorScore: 0.9 })] };
    const r = await runInject({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN_FILE: explicit,
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status, r.stderr).toBe(0);
    parseContext(r.stdout);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.auth).toBe("Bearer explicit-secret");
  });

  it("DIGITAL_ME_BRAIN_TOKEN (env) wins over the token file", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    const explicit = writeTokenFile(path.join(home, "custom.token"), "explicit-secret\n");
    cannedSearch = { results: [hit(entryPath, { score: 0.9, vectorScore: 0.9 })] };
    const r = await runInject({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN: "env-secret",
      DIGITAL_ME_BRAIN_TOKEN_FILE: explicit,
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status, r.stderr).toBe(0);
    parseContext(r.stdout);
    for (const s of seen) expect(s.auth).toBe("Bearer env-secret");
  });

  it("an empty token file counts as no token: no request, stderr names DIGITAL_ME_BRAIN_TOKEN_FILE and the file", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    const explicit = writeTokenFile(path.join(home, "empty.token"), "   \n\n");
    writeOpenclawJson("file-tok");
    cannedSearch = { results: [hit(entryPath, { score: 0.9, vectorScore: 0.9 })] };
    const r = await runInject({
      DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
      DIGITAL_ME_BRAIN_TOKEN_FILE: explicit,
      OPENCLAW_GATEWAY_TOKEN: "g",
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("DIGITAL_ME_BRAIN_TOKEN_FILE");
    expect(r.stderr).toContain(explicit);
    expect(seen).toHaveLength(0);
  });

  it("gateway env (OPENCLAW_GATEWAY_HOST/PORT/TOKEN): request carries the gateway bearer and the gate reads the 0-1 hybrid `score`", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    cannedSearch = { results: [hit(entryPath, { score: 0.455, vectorScore: 0.2 })] };
    const r = await runInject({
      OPENCLAW_GATEWAY_HOST: "127.0.0.1",
      OPENCLAW_GATEWAY_PORT: port(),
      OPENCLAW_GATEWAY_TOKEN: "g",
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(parseContext(r.stdout)).toContain("score=45/100");
    const search = seen.filter((s) => s.body.tool === "memory_search");
    expect(search).toHaveLength(1);
    expect(search[0]!.auth).toBe("Bearer g");
    const m1 = seen.filter((s) => s.body.tool === "m1_event_record");
    expect(m1.length).toBeGreaterThan(0);
    for (const s of m1) expect(s.auth).toBe("Bearer g");
  });

  it("gateway env: a brain-host-shaped hit (score 0.04) is dropped because the gateway gate reads `score`", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    cannedSearch = { results: [hit(entryPath, { score: 0.042, vectorScore: 0.77 })] };
    const r = await runInject({
      OPENCLAW_GATEWAY_HOST: "127.0.0.1",
      OPENCLAW_GATEWAY_PORT: port(),
      OPENCLAW_GATEWAY_TOKEN: "g",
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(seen.filter((s) => s.body.tool === "memory_search")).toHaveLength(1);
  });

  it("gateway token falls back to $HOME/.openclaw/openclaw.json", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    writeOpenclawJson("file-tok");
    cannedSearch = { results: [hit(entryPath, { score: 0.5 })] };
    const r = await runInject({
      OPENCLAW_GATEWAY_HOST: "127.0.0.1",
      OPENCLAW_GATEWAY_PORT: port(),
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status, r.stderr).toBe(0);
    parseContext(r.stdout);
    expect(seen[0]!.body.tool).toBe("memory_search");
    expect(seen[0]!.auth).toBe("Bearer file-tok");
  });

  it("no token anywhere: exits 0 silently without contacting any backend", async () => {
    const { wikiRoot } = seedWiki();
    const r = await runInject({
      OPENCLAW_GATEWAY_HOST: "127.0.0.1",
      OPENCLAW_GATEWAY_PORT: port(),
      DIGITAL_ME_WIKI_ROOT: wikiRoot,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(seen).toHaveLength(0);
  });
});

describe(`${RUNTIME} dm_memory_search_inject.sh — installer-written sidecar (${BRAIN_SIDECAR_FILE})`, () => {
  it("no DIGITAL_ME_BRAIN_URL in the env (the live hook env, wrong DIGITAL_ME_WIKI_ROOT too): search + both M1 events go to the sidecar URL with the sidecar token-file bearer", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    const token = writeTokenFile(path.join(home, "secrets", "brain-host.token"), "sidecar-secret\n");
    const { inject } = installHooks(sidecarFor(`${baseUrl}/sidecar/tools/invoke`, token));
    cannedSearch = { results: [hit(entryPath, { score: 0.042, vectorScore: 0.77 })] };
    const r = await runInject({ DIGITAL_ME_WIKI_ROOT: path.join(wikiRoot, "wiki") }, { script: inject });
    expect(r.status, r.stderr).toBe(0);
    const ctx = parseContext(r.stdout);
    expect(ctx).toContain(entryPath);
    expect(ctx).toContain("score=77/100"); // brain-host gate: vectorScore, not the RRF score
    expect(seen.map((s) => s.body.tool)).toEqual(["memory_search", "m1_event_record", "m1_event_record"]);
    for (const s of seen) {
      expect(s.url).toBe("/sidecar/tools/invoke");
      expect(s.auth).toBe("Bearer sidecar-secret");
    }
  });

  it("an exported DIGITAL_ME_BRAIN_URL beats the sidecar", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    const token = writeTokenFile(path.join(home, "secrets", "brain-host.token"), "sidecar-secret\n");
    const { inject } = installHooks(sidecarFor(`${baseUrl}/sidecar/tools/invoke`, token));
    cannedSearch = { results: [hit(entryPath, { score: 0.9, vectorScore: 0.9 })] };
    const r = await runInject(
      { DIGITAL_ME_BRAIN_URL: `${baseUrl}/env/tools/invoke`, DIGITAL_ME_BRAIN_TOKEN: "env-secret", DIGITAL_ME_WIKI_ROOT: wikiRoot },
      { script: inject },
    );
    expect(r.status, r.stderr).toBe(0);
    parseContext(r.stdout);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.url).toBe("/env/tools/invoke");
      expect(s.auth).toBe("Bearer env-secret");
    }
  });

  it("the sidecar beats OPENCLAW_GATEWAY_* env and openclaw.json (and switches the gate to vectorScore)", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    writeOpenclawJson("file-tok");
    const token = writeTokenFile(path.join(home, "secrets", "brain-host.token"), "sidecar-secret\n");
    const { inject } = installHooks(sidecarFor(`${baseUrl}/sidecar/tools/invoke`, token));
    // Dropped in gateway mode (score 0.042), injected in brain-host mode.
    cannedSearch = { results: [hit(entryPath, { score: 0.042, vectorScore: 0.77 })] };
    const r = await runInject(
      { OPENCLAW_GATEWAY_HOST: "127.0.0.1", OPENCLAW_GATEWAY_PORT: port(), OPENCLAW_GATEWAY_TOKEN: "g", DIGITAL_ME_WIKI_ROOT: wikiRoot },
      { script: inject },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(parseContext(r.stdout)).toContain("score=77/100");
    const search = seen.filter((s) => s.body.tool === "memory_search");
    expect(search).toHaveLength(1);
    expect(search[0]!.url).toBe("/sidecar/tools/invoke");
    expect(search[0]!.auth).toBe("Bearer sidecar-secret");
  });

  it("parses the sidecar line by line: quotes, CRLF, comments and unknown keys are handled, a token in it is never read", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    const token = writeTokenFile(path.join(home, "secret dir", "brain-host.token"), "quoted-secret\n");
    const { inject } = installHooks(
      [
        "# DIGITAL_ME_BRAIN_URL=http://127.0.0.1:1/commented-out",
        "",
        "no equals sign on this line",
        "DIGITAL_ME_BRAIN_TOKEN=inline-secrets-are-never-read",
        "OPENCLAW_GATEWAY_URL=http://127.0.0.1:1/not-honoured",
        `  DIGITAL_ME_BRAIN_URL = "${baseUrl}/sidecar/tools/invoke"  `,
        `DIGITAL_ME_BRAIN_TOKEN_FILE='${token}'`,
      ].join("\r\n"), // no trailing newline on the last line either
    );
    cannedSearch = { results: [hit(entryPath, { score: 0.9, vectorScore: 0.9 })] };
    const r = await runInject({ DIGITAL_ME_WIKI_ROOT: wikiRoot }, { script: inject });
    expect(r.status, r.stderr).toBe(0);
    parseContext(r.stdout);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.url).toBe("/sidecar/tools/invoke");
      expect(s.auth).toBe("Bearer quoted-secret");
    }
  });

  it("a missing or garbage sidecar leaves today's behaviour: gateway env, gateway `score` gate", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    const env = { OPENCLAW_GATEWAY_HOST: "127.0.0.1", OPENCLAW_GATEWAY_PORT: port(), OPENCLAW_GATEWAY_TOKEN: "g", DIGITAL_ME_WIKI_ROOT: wikiRoot };
    cannedSearch = { results: [hit(entryPath, { score: 0.455, vectorScore: 0.2 })] };
    const { inject, sidecar } = installHooks();
    const missing = await runInject(env, { script: inject });
    expect(parseContext(missing.stdout)).toContain("score=45/100");
    fs.writeFileSync(sidecar, Buffer.from([0xff, 0xfe, 0x00, 0x0a, 0x3d, 0x3d, 0x0a]));
    const garbage = await runInject(env, { script: inject });
    expect(parseContext(garbage.stdout)).toContain("score=45/100");
    fs.writeFileSync(sidecar, "DIGITAL_ME_BRAIN_URL=\nDIGITAL_ME_BRAIN_TOKEN_FILE=''\n");
    const empty = await runInject(env, { script: inject });
    expect(parseContext(empty.stdout)).toContain("score=45/100");
    const search = seen.filter((s) => s.body.tool === "memory_search");
    expect(search).toHaveLength(3);
    for (const s of seen) {
      expect(s.url).toBe("/tools/invoke");
      expect(s.auth).toBe("Bearer g");
    }
  });

  it("a sidecar URL whose token file is missing: no request, fail-open with a stderr diagnostic naming the sidecar", async () => {
    const { wikiRoot } = seedWiki();
    writeOpenclawJson("file-tok"); // a gateway token IS available — it must not be used
    const missing = path.join(home, "secrets", "missing.token");
    const { inject, sidecar } = installHooks(sidecarFor(`${baseUrl}/sidecar/tools/invoke`, missing));
    const r = await runInject({ OPENCLAW_GATEWAY_TOKEN: "g", DIGITAL_ME_WIKI_ROOT: wikiRoot }, { script: inject });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(sidecar);
    expect(r.stderr).toContain(missing);
    expect(seen).toHaveLength(0);
  });
});

describe(`${RUNTIME} dm_memory_search_inject.sh — slash-command prompts`, () => {
  const brainEnv = (wikiRoot: string) => ({
    DIGITAL_ME_BRAIN_URL: `${baseUrl}/tools/invoke`,
    DIGITAL_ME_BRAIN_TOKEN: "t",
    DIGITAL_ME_WIKI_ROOT: wikiRoot,
  });

  it("'/goal <task>' is a real prompt: the command token is dropped and the rest is searched and injected", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    cannedSearch = { results: [hit(entryPath, { score: 0.042, vectorScore: 0.77 })] };
    const task = "hey, looks like our digital-me is off? the dashboard shows no data";
    const r = await runInject(brainEnv(wikiRoot), { prompt: `/goal ${task}` });
    expect(r.status, r.stderr).toBe(0);
    expect(parseContext(r.stdout)).toContain("score=77/100");
    const search = seen.filter((s) => s.body.tool === "memory_search");
    expect(search).toHaveLength(1);
    expect(search[0]!.body.args.query).toBe(task);
  });

  it("the whitespace after the command may be newlines", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    cannedSearch = { results: [hit(entryPath, { score: 0.042, vectorScore: 0.77 })] };
    const r = await runInject(brainEnv(wikiRoot), { prompt: "/goal\n\n  fix the rebase flow for dependabot" });
    expect(r.status, r.stderr).toBe(0);
    parseContext(r.stdout);
    expect(seen.find((s) => s.body.tool === "memory_search")!.body.args.query).toBe("fix the rebase flow for dependabot");
  });

  it("a bare command or one with a short argument ('/clear', '/compact', '/model opus') never calls the brain", async () => {
    const { wikiRoot, entryPath } = seedWiki();
    cannedSearch = { results: [hit(entryPath, { score: 0.9, vectorScore: 0.9 })] };
    for (const prompt of ["/clear", "/compact", "/model opus", "/goal   ", "/a-very-long-command-name-without-arguments"]) {
      const r = await runInject(brainEnv(wikiRoot), { prompt });
      expect(r.status, prompt).toBe(0);
      expect(r.stdout, prompt).toBe("");
    }
    expect(seen).toHaveLength(0);
  });
});
