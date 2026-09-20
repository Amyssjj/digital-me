/**
 * End-to-end tests for scripts/verify_openclaw_hooks.sh (the post-update
 * gate `digital-me deploy` points operators at) against fixture configs and
 * gateway logs.
 *
 * The config signal needs a JSON5 parser. The gate must resolve `json5` from
 * the repo (pnpm keeps it un-hoisted under packages/cli) regardless of the
 * cwd, degrade to the runtime signal with a warn when no parser is resolvable,
 * and FAIL on config only when a parser actually read the file and found the
 * grant missing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "..", "..", "..", "scripts", "verify_openclaw_hooks.sh");

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const BASH = which("bash") ?? "/bin/bash";
const PYTHON3 = which("python3");
// node is what runs vitest, so its directory is the one PATH entry we can
// always vouch for; CI images do not all put node on the inherited PATH.
const NODE_PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`;

const GRANTED_JSON5 = `{
  // openclaw writes JSON5: comments, trailing commas, unquoted keys
  plugins: {
    entries: {
      "digital-me-recall": { enabled: true, hooks: { allowConversationAccess: true, }, },
      "digital-me-brain": { enabled: true, },
    },
  },
}
`;
const UNGRANTED_JSON5 = GRANTED_JSON5.replace("allowConversationAccess: true", "allowConversationAccess: false");
const REG_GRANTED =
  "2026-09-20T09:46:21.000Z [plugins] digital-me-recall: registered hooks (before_prompt_build, agent_end; conversation_hooks=granted)\n";
const REG_BLOCKED =
  "2026-09-20T09:46:21.000Z [plugins] digital-me-recall: registered hooks (none; conversation_hooks=BLOCKED)\n";

/** Everything the script shells out to, minus node and python3. */
const COREUTILS = ["dirname", "ls", "head", "tail", "grep", "awk", "sed"];

function restrictedPath(dir: string, extra: readonly string[] = []): string {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of [...COREUTILS, ...extra]) {
    const real = which(name);
    if (!real) throw new Error(`test needs ${name} on PATH`);
    symlinkSync(real, path.join(bin, name));
  }
  return bin;
}

type RunOpts = {
  readonly config: string;
  readonly log?: string;
  readonly PATH: string;
  readonly env?: Readonly<Record<string, string>>;
};

function run(dir: string, opts: RunOpts): { status: number | null; out: string } {
  const cfgPath = path.join(dir, "openclaw.json");
  writeFileSync(cfgPath, opts.config);
  const logPath = path.join(dir, "gateway.log");
  writeFileSync(logPath, opts.log ?? "");
  const r = spawnSync(BASH, [SCRIPT], {
    // cwd is a scratch dir on purpose: a bare require('json5') from here fails,
    // which is the exact false-red the resolver has to survive.
    cwd: dir,
    encoding: "utf8",
    env: {
      HOME: dir,
      PATH: opts.PATH,
      DIGITAL_ME_OPENCLAW_CONFIG: cfgPath,
      OPENCLAW_GATEWAY_LOG: logPath,
      ...opts.env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => (dir = mkdtempSync(path.join(tmpdir(), "dm-hooks-gate-")));

describe("verify_openclaw_hooks.sh config signal", () => {
  it("resolves json5 from the repo (not the cwd) and passes a granted JSON5 config", () => {
    const r = run(scratch(), { config: GRANTED_JSON5, log: REG_GRANTED, PATH: NODE_PATH });
    expect(r.out).toContain("ok      digital-me-recall: allowConversationAccess=true");
    expect(r.out).toContain("ok      recall self-check reported conversation_hooks=granted");
    expect(r.out).not.toContain("FAIL");
    expect(r.out).not.toContain("warn");
    expect(r.status).toBe(0);
  });

  it("FAILs (exit 1) when a parser read the config and the grant is absent", () => {
    const r = run(scratch(), { config: UNGRANTED_JSON5, log: REG_GRANTED, PATH: NODE_PATH });
    expect(r.out).toContain("FAIL    digital-me-recall: plugins.entries.digital-me-recall.hooks.allowConversationAccess is not true");
    expect(r.out).toContain("FAIL openclaw-hooks");
    expect(r.status).toBe(1);
  });

  it("warns (not FAIL) when a parser exists but the config does not parse", () => {
    const r = run(scratch(), { config: "{ plugins: [ this is not json5", log: REG_GRANTED, PATH: NODE_PATH });
    expect(r.out).toContain("warn    digital-me-recall: could not parse");
    expect(r.out).toContain("ok      recall self-check reported conversation_hooks=granted");
    expect(r.out).not.toContain("FAIL");
    expect(r.status).toBe(0);
  });

  it("degrades to the runtime signal with a warn when neither node+json5 nor python3+pyjson5 is resolvable", () => {
    const d = scratch();
    const r = run(d, { config: GRANTED_JSON5, log: REG_GRANTED, PATH: restrictedPath(d) });
    expect(r.out).toContain("warn    digital-me-recall: no JSON5 parser resolvable");
    expect(r.out).toContain("ok      recall self-check reported conversation_hooks=granted");
    expect(r.out).not.toContain("FAIL");
    expect(r.out).not.toContain("UNVERIFIED");
    expect(r.status).toBe(0);
  });

  it("still FAILs on the runtime signal when no parser is resolvable", () => {
    const d = scratch();
    const r = run(d, { config: GRANTED_JSON5, log: REG_BLOCKED, PATH: restrictedPath(d) });
    expect(r.out).toContain("FAIL    recall self-check reported conversation_hooks=BLOCKED");
    expect(r.status).toBe(1);
  });

  it("says UNVERIFIED (exit 0) when neither the config nor the runtime signal could be read", () => {
    const d = scratch();
    const r = run(d, { config: GRANTED_JSON5, log: "", PATH: restrictedPath(d) });
    expect(r.out).toContain("warn    digital-me-recall: no JSON5 parser resolvable");
    expect(r.out).toContain("warn    UNVERIFIED");
    expect(r.out).toContain("OK openclaw-hooks: no dropped conversation hooks detected (UNVERIFIED");
    expect(r.status).toBe(0);
  });

  it("SKIPs when there is no config at all", () => {
    const d = scratch();
    const r = spawnSync(BASH, [SCRIPT], {
      cwd: d,
      encoding: "utf8",
      env: { HOME: d, PATH: NODE_PATH, DIGITAL_ME_OPENCLAW_CONFIG: path.join(d, "missing.json") },
    });
    expect(r.stdout).toContain("SKIP openclaw-hooks: no config");
    expect(r.status).toBe(0);
  });
});

describe("verify_openclaw_hooks.sh python3 fallback", () => {
  // A stand-in pyjson5 on PYTHONPATH makes the python branch deterministic
  // whether or not the real package is installed on the host.
  function pythonPath(d: string, moduleSource: string): Record<string, string> {
    const lib = path.join(d, "pylib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(path.join(lib, "pyjson5.py"), moduleSource);
    return { PYTHONPATH: lib };
  }
  const FAKE_PYJSON5 = [
    "import json, re",
    "def load(fh):",
    "    text = fh.read()",
    "    text = re.sub(r'//[^\\n]*', '', text)",
    "    text = re.sub(r',(\\s*[}\\]])', r'\\1', text)",
    "    text = re.sub(r'([{,]\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*:', r'\\1\"\\2\":', text)",
    "    return json.loads(text)",
    "",
  ].join("\n");
  const BROKEN_PYJSON5 = "raise ImportError('shadowed for the test')\n";

  it.skipIf(PYTHON3 === null)("passes a granted config through pyjson5 when node is absent", () => {
    const d = scratch();
    const r = run(d, { config: GRANTED_JSON5, log: REG_GRANTED, PATH: restrictedPath(d, ["python3"]), env: pythonPath(d, FAKE_PYJSON5) });
    expect(r.out).toContain("ok      digital-me-recall: allowConversationAccess=true");
    expect(r.out).not.toContain("warn");
    expect(r.status).toBe(0);
  });

  it.skipIf(PYTHON3 === null)("FAILs an ungranted config through pyjson5 when node is absent", () => {
    const d = scratch();
    const r = run(d, { config: UNGRANTED_JSON5, log: REG_GRANTED, PATH: restrictedPath(d, ["python3"]), env: pythonPath(d, FAKE_PYJSON5) });
    expect(r.out).toContain("FAIL    digital-me-recall: plugins.entries.digital-me-recall.hooks.allowConversationAccess is not true");
    expect(r.status).toBe(1);
  });

  it.skipIf(PYTHON3 === null)("warns when python3 is present but pyjson5 is not importable", () => {
    const d = scratch();
    const r = run(d, { config: GRANTED_JSON5, log: REG_GRANTED, PATH: restrictedPath(d, ["python3"]), env: pythonPath(d, BROKEN_PYJSON5) });
    expect(r.out).toContain("warn    digital-me-recall: no JSON5 parser resolvable");
    expect(r.out).not.toContain("FAIL");
    expect(r.status).toBe(0);
  });

  it.skipIf(PYTHON3 === null)("warns when pyjson5 cannot parse the config", () => {
    const d = scratch();
    const r = run(d, { config: "{ nope", log: REG_GRANTED, PATH: restrictedPath(d, ["python3"]), env: pythonPath(d, FAKE_PYJSON5) });
    expect(r.out).toContain("warn    digital-me-recall: could not parse");
    expect(r.out).not.toContain("FAIL");
    expect(r.status).toBe(0);
  });
});
