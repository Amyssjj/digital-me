import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveM1DirPath } from "@digital-me/contracts";
import { describe, expect, it } from "vitest";

// The recall template is a single file the gateway loads, so it inlines the
// M1 dir rule instead of importing @digital-me/contracts. Run that inlined
// copy against the shared rule so the two cannot drift.
const TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "recall",
  "index.mjs",
);

function inlinedDefaultM1Dir(): (
  env: Record<string, string | undefined>,
  home: string,
  existing: readonly string[],
) => string {
  const src = readFileSync(TEMPLATE, "utf8");
  const fn = /function defaultM1Dir\(\) \{[\s\S]*?\n\}/.exec(src)?.[0];
  if (fn === undefined) throw new Error("defaultM1Dir not found in the recall template");
  return (env, home, existing) =>
    new Function("process", "path", "os", "fs", `${fn}\nreturn defaultM1Dir();`)(
      { env },
      path,
      { homedir: () => home },
      { existsSync: (p: string) => existing.includes(p) },
    ) as string;
}

describe("recall template defaultM1Dir", () => {
  const run = inlinedDefaultM1Dir();
  const home = "/home/t";
  const cases: ReadonlyArray<[string, Record<string, string | undefined>, readonly string[]]> = [
    ["fresh machine", {}, []],
    ["legacy only", {}, ["/home/t/.openclaw/data"]],
    ["both exist", {}, ["/home/t/.openclaw/data", "/home/t/digital-me/.data/m1"]],
    ["explicit env", { DIGITAL_ME_M1_DIR: "/m" }, ["/home/t/digital-me/.data/m1"]],
    ["blank env", { DIGITAL_ME_M1_DIR: "  " }, ["/home/t/.openclaw/data"]],
    ["custom roots", { DIGITAL_ME_WIKI_ROOT: "/w", OPENCLAW_HOME: "/oc" }, ["/oc/data"]],
  ];

  it.each(cases)("matches @digital-me/contracts resolveM1DirPath: %s", (_name, env, existing) => {
    const expected = resolveM1DirPath({ env, home, exists: (p) => existing.includes(p) }).path;
    expect(run(env, home, existing)).toBe(expected);
  });
});
