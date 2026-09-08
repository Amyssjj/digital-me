import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEPLOYABLE_RUNTIMES,
  findNewestTmpLog,
  resolveGatewayLog,
  analyzeDeployPreflight,
  parseAheadBehind,
  expectedRecallAckMode,
  parseRecallAckMode,
  planDeployRuntimes,
} from "./deploy.js";

describe("analyzeDeployPreflight", () => {
  it("OK when clean and not ahead (behind is fine — deploy fast-forwards)", () => {
    expect(analyzeDeployPreflight({ porcelain: "", ahead: 0, behind: 0 })).toEqual({ ok: true });
    expect(analyzeDeployPreflight({ porcelain: "", ahead: 0, behind: 19 })).toEqual({ ok: true });
  });

  it("blocks a dirty working tree (stale-shadow risk)", () => {
    const r = analyzeDeployPreflight({
      porcelain: " M packages/cli/src/x.ts\n?? scratch.txt",
      ahead: 0,
      behind: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/uncommitted change/);
  });

  it("blocks when local main is ahead of origin (unpushed commits)", () => {
    const r = analyzeDeployPreflight({ porcelain: "", ahead: 2, behind: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ahead of origin/);
  });
});

describe("parseAheadBehind", () => {
  it("parses the tab-separated left-right count", () => {
    expect(parseAheadBehind("0\t19\n")).toEqual({ ahead: 0, behind: 19 });
    expect(parseAheadBehind("2\t0")).toEqual({ ahead: 2, behind: 0 });
  });
  it("defaults to 0/0 on unexpected output", () => {
    expect(parseAheadBehind("")).toEqual({ ahead: 0, behind: 0 });
    expect(parseAheadBehind("garbage")).toEqual({ ahead: 0, behind: 0 });
  });
});

describe("parseRecallAckMode", () => {
  const line = (mode: string) =>
    `2026-06-03T08:42:43 [plugins] digital-me-recall: registered hooks (boot=on, m1_emitter=on, assistant_ack=${mode}, app_rate=on)`;

  it("extracts the assistant_ack mode from the LATEST registration line", () => {
    const log = [line("agent_end"), "noise", line("agent_end+before_message_write")].join("\n");
    expect(parseRecallAckMode(log)).toBe("agent_end+before_message_write");
  });

  it("returns null when no registration line is present", () => {
    expect(parseRecallAckMode("just some gateway noise\n")).toBeNull();
  });

  it("returns null when the registration line carries no assistant_ack field (old build)", () => {
    expect(
      parseRecallAckMode(
        "2026-06-03T08:42:43 [plugins] digital-me-recall: registered hooks (boot=on, m1_emitter=on)\n",
      ),
    ).toBeNull();
  });
});

describe("planDeployRuntimes", () => {
  it("uses the explicit --runtime set, filtered to deployable ones", () => {
    expect(planDeployRuntimes(["openclaw", "claude-code", "dashboard"], [])).toEqual([
      "openclaw",
      "dashboard",
    ]);
    // non-deployable only → empty
    expect(planDeployRuntimes(["claude-code", "hermes"], ["openclaw"])).toEqual([]);
  });

  it("falls back to detected-installed deployable runtimes when none requested", () => {
    expect(planDeployRuntimes([], ["openclaw", "dashboard", "codex"])).toEqual([
      "openclaw",
      "dashboard",
    ]);
    expect(planDeployRuntimes([], [])).toEqual([]);
  });

  it("only openclaw + dashboard are deployable", () => {
    expect([...DEPLOYABLE_RUNTIMES]).toEqual(["openclaw", "dashboard"]);
  });
});

describe("expectedRecallAckMode", () => {
  it("includes agent_end only when the conversation-hook grant is present", () => {
    expect(
      expectedRecallAckMode({
        plugins: { entries: { "digital-me-recall": { hooks: { allowConversationAccess: true } } } },
      }),
    ).toBe("agent_end+before_message_write");
  });

  it("drops agent_end when the grant is absent — the host will refuse that hook", () => {
    expect(expectedRecallAckMode({})).toBe("before_message_write");
    expect(expectedRecallAckMode({ plugins: { entries: {} } })).toBe("before_message_write");
    expect(
      expectedRecallAckMode({ plugins: { entries: { "digital-me-recall": { enabled: true } } } }),
    ).toBe("before_message_write");
  });

  it("treats an explicit false as ungranted", () => {
    expect(
      expectedRecallAckMode({
        plugins: { entries: { "digital-me-recall": { hooks: { allowConversationAccess: false } } } },
      }),
    ).toBe("before_message_write");
  });

  it("agrees with what parseRecallAckMode reads off a real registration line", () => {
    // The two halves of the deploy check must speak the same vocabulary.
    const line =
      "[plugins] digital-me-recall: registered hooks (boot=on, conversation_hooks=granted, assistant_ack=agent_end+before_message_write, app_rate=on)";
    expect(parseRecallAckMode(line)).toBe(
      expectedRecallAckMode({
        plugins: { entries: { "digital-me-recall": { hooks: { allowConversationAccess: true } } } },
      }),
    );
  });
});

// ── resolveGatewayLog / findNewestTmpLog ────────────────────────────────────
// The gateway's stdout log carries no memory-subsystem lines; the debug file
// log under /tmp/openclaw is where the diagnostics land. The resolver must
// pick the NEWEST candidate and never read a frozen log.

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "dm-gateway-log-"));
}
function touch(file: string, ageSeconds: number): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
  const t = Date.now() / 1000 - ageSeconds;
  utimesSync(file, t, t);
  return file;
}
const realFs = { existsSync, readdirSync, statSync };

describe("findNewestTmpLog", () => {
  it("returns [] when the tmp dir does not exist", () => {
    expect(findNewestTmpLog(path.join(scratch(), "missing"))).toEqual([]);
  });

  it("returns only the newest openclaw-*.log, ignoring other files", () => {
    const dir = scratch();
    const old = touch(path.join(dir, "openclaw-2026-09-01.log"), 3600);
    const newest = touch(path.join(dir, "openclaw-2026-09-02.log"), 10);
    touch(path.join(dir, "other.log"), 0);
    touch(path.join(dir, "openclaw-notes.txt"), 0);
    expect(findNewestTmpLog(dir)).toEqual([newest]);
    expect(findNewestTmpLog(dir)).not.toContain(old);
  });

  it("returns [] when the dir holds no matching logs", () => {
    const dir = scratch();
    touch(path.join(dir, "other.log"), 0);
    expect(findNewestTmpLog(dir)).toEqual([]);
  });

  it("keeps going when a stat fails mid-sort and when readdir fails", () => {
    const dir = scratch();
    const a = touch(path.join(dir, "openclaw-a.log"), 100);
    const b = touch(path.join(dir, "openclaw-b.log"), 50);
    const flakyStat = {
      ...realFs,
      statSync: (p: Parameters<typeof statSync>[0]) => {
        if (String(p).endsWith("openclaw-a.log")) throw new Error("EACCES");
        return statSync(p);
      },
    } as typeof realFs;
    // The comparator swallows the error (returns 0) — the result is still a
    // single entry from the directory, never a throw.
    const picked = findNewestTmpLog(dir, flakyStat);
    expect(picked).toHaveLength(1);
    expect([a, b]).toContain(picked[0]);
    const badReaddir = {
      ...realFs,
      readdirSync: () => {
        throw new Error("EIO");
      },
    } as unknown as typeof realFs;
    expect(findNewestTmpLog(dir, badReaddir)).toEqual([]);
  });
});

describe("resolveGatewayLog", () => {
  it("honours an explicit OPENCLAW_GATEWAY_LOG override without touching the disk", () => {
    expect(
      resolveGatewayLog({ OPENCLAW_GATEWAY_LOG: "/x/y.log" }, scratch(), { tmpLogDir: "/nope" }),
    ).toBe("/x/y.log");
  });

  it("defaults to /tmp/openclaw for the debug log when no tmpLogDir is given (fake fs, no disk)", () => {
    const seen: string[] = [];
    const fs = {
      existsSync: (p: Parameters<typeof existsSync>[0]) => {
        seen.push(String(p));
        return false;
      },
      readdirSync,
      statSync,
    } as unknown as typeof realFs;
    expect(resolveGatewayLog({}, "/nonexistent-home", { fs })).toBeNull();
    expect(seen[0]).toBe("/tmp/openclaw");
  });

  it("returns null when no candidate exists", () => {
    const home = scratch();
    expect(resolveGatewayLog({}, home, { tmpLogDir: path.join(home, "no-tmp") })).toBeNull();
  });

  it("picks the NEWEST candidate across the tmp log, launchd log, legacy and XDG paths", () => {
    const home = scratch();
    const tmp = path.join(home, "tmp-openclaw");
    const launchd = touch(path.join(home, "Library", "Logs", "openclaw", "gateway.log"), 3600);
    touch(path.join(home, ".openclaw", "logs", "gateway.log"), 7200);
    const xdg = touch(path.join(home, "xdg", "openclaw", "gateway.log"), 30);
    const env = { XDG_STATE_HOME: path.join(home, "xdg") };
    expect(resolveGatewayLog(env, home, { tmpLogDir: tmp })).toBe(xdg);
    // A newer debug file log wins over all of them.
    const debug = touch(path.join(tmp, "openclaw-2026-09-02.log"), 1);
    expect(resolveGatewayLog(env, home, { tmpLogDir: tmp })).toBe(debug);
    // OPENCLAW_HOME redirects the legacy candidate.
    const custom = touch(path.join(home, "custom-home", "logs", "gateway.log"), 0);
    expect(
      resolveGatewayLog({ ...env, OPENCLAW_HOME: path.join(home, "custom-home") }, home, {
        tmpLogDir: path.join(home, "no-tmp"),
      }),
    ).toBe(custom);
    expect(launchd).toBeTruthy();
  });

  it("skips a candidate whose stat fails instead of throwing", () => {
    const home = scratch();
    const launchd = touch(path.join(home, "Library", "Logs", "openclaw", "gateway.log"), 10);
    const legacy = touch(path.join(home, ".openclaw", "logs", "gateway.log"), 5);
    const fs = {
      ...realFs,
      statSync: (p: Parameters<typeof statSync>[0]) => {
        if (String(p) === legacy) throw new Error("EACCES");
        return statSync(p);
      },
    } as typeof realFs;
    expect(resolveGatewayLog({}, home, { tmpLogDir: path.join(home, "no-tmp"), fs })).toBe(launchd);
  });
});

