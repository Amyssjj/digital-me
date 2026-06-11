import { describe, expect, it } from "vitest";
import { resolveOpenclawExtensionsDir } from "./openclaw-paths.js";

describe("resolveOpenclawExtensionsDir", () => {
  it("defaults to the STATE dir (~/.openclaw/extensions), NOT the overlay", () => {
    expect(resolveOpenclawExtensionsDir("/home/u", {})).toBe(
      "/home/u/.openclaw/extensions",
    );
    // explicitly NOT the old overlay default
    expect(resolveOpenclawExtensionsDir("/home/u", {})).not.toBe(
      "/home/u/openclaw/extensions",
    );
  });

  it("honors $OPENCLAW_HOME for the state dir", () => {
    expect(
      resolveOpenclawExtensionsDir("/home/u", { OPENCLAW_HOME: "/var/oc" }),
    ).toBe("/var/oc/extensions");
  });

  it("$OPENCLAW_EXTENSIONS_DIR overrides the state-dir default", () => {
    expect(
      resolveOpenclawExtensionsDir("/home/u", {
        OPENCLAW_EXTENSIONS_DIR: "/custom/ext",
        OPENCLAW_HOME: "/var/oc",
      }),
    ).toBe("/custom/ext");
  });

  it("an explicit arg wins over everything", () => {
    expect(
      resolveOpenclawExtensionsDir(
        "/home/u",
        { OPENCLAW_EXTENSIONS_DIR: "/custom/ext", OPENCLAW_HOME: "/var/oc" },
        "/explicit/ext",
      ),
    ).toBe("/explicit/ext");
  });

  it("precedence: explicit > OPENCLAW_EXTENSIONS_DIR > OPENCLAW_HOME > ~/.openclaw", () => {
    // only home → state dir under home
    expect(resolveOpenclawExtensionsDir("/h", {})).toBe("/h/.openclaw/extensions");
    // + OPENCLAW_HOME
    expect(resolveOpenclawExtensionsDir("/h", { OPENCLAW_HOME: "/s" })).toBe(
      "/s/extensions",
    );
    // + OPENCLAW_EXTENSIONS_DIR beats OPENCLAW_HOME
    expect(
      resolveOpenclawExtensionsDir("/h", {
        OPENCLAW_HOME: "/s",
        OPENCLAW_EXTENSIONS_DIR: "/e",
      }),
    ).toBe("/e");
  });
});
