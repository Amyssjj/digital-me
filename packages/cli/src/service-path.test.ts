import { describe, expect, it } from "vitest";
import { SERVICE_PATH_OVERRIDE_ENV, resolveServicePath } from "./service-path.js";

const HOME = "/home/t";
const SYSTEM = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const USER_DIRS = "/home/t/.local/bin:/home/t/Library/pnpm";

describe("resolveServicePath", () => {
  it("puts the resolved binary's directory first, then the fixed system list, then the user tool dirs", () => {
    expect(resolveServicePath(HOME, {}, "/nix/store/abc/bin/node")).toBe(
      `/nix/store/abc/bin:${SYSTEM}:${USER_DIRS}`,
    );
  });

  it("dedupes when the binary lives in a default dir (first occurrence wins, order preserved)", () => {
    const p = resolveServicePath(HOME, {}, "/usr/bin/node");
    expect(p).toBe(`/usr/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/bin:/usr/sbin:/sbin:${USER_DIRS}`);
    expect(p.split(":").filter((d) => d === "/usr/bin")).toHaveLength(1);
    // homebrew node: the default list already starts with /opt/homebrew/bin → no duplicate
    expect(resolveServicePath(HOME, {}, "/opt/homebrew/bin/node")).toBe(`${SYSTEM}:${USER_DIRS}`);
  });

  it("IGNORES the ambient PATH (an agent session's transient plugin bin dirs must not leak into the unit)", () => {
    const ambient = "/tmp/claude-plugins/a/bin:/tmp/claude-plugins/b/bin:/opt/homebrew/bin:/usr/bin:/bin";
    const p = resolveServicePath(HOME, { PATH: ambient }, "/opt/homebrew/bin/node");
    expect(p).not.toContain("claude-plugins");
    expect(p).toBe(resolveServicePath(HOME, {}, "/opt/homebrew/bin/node"));
  });

  it("honours ONLY the explicit DIGITAL_ME_SERVICE_PATH override, verbatim", () => {
    expect(SERVICE_PATH_OVERRIDE_ENV).toBe("DIGITAL_ME_SERVICE_PATH");
    const env = { PATH: "/ambient/bin", DIGITAL_ME_SERVICE_PATH: "/custom/bin:/usr/bin" };
    expect(resolveServicePath(HOME, env, "/opt/homebrew/bin/node")).toBe("/custom/bin:/usr/bin");
  });

  it("treats an empty / whitespace-only override as unset", () => {
    const computed = resolveServicePath(HOME, {}, "/usr/local/bin/npm");
    expect(resolveServicePath(HOME, { DIGITAL_ME_SERVICE_PATH: "" }, "/usr/local/bin/npm")).toBe(computed);
    expect(resolveServicePath(HOME, { DIGITAL_ME_SERVICE_PATH: "   " }, "/usr/local/bin/npm")).toBe(computed);
    expect(resolveServicePath(HOME, { DIGITAL_ME_SERVICE_PATH: undefined }, "/usr/local/bin/npm")).toBe(computed);
  });
});
