import { describe, expect, it } from "vitest";

import { BRAIN_SIDECAR_FILE, renderBrainSidecar } from "./brain-sidecar.js";

const URL = "http://127.0.0.1:18791/tools/invoke";
const TOKEN_FILE = "/home/t/digital-me/.data/brain-host.token";

describe("renderBrainSidecar", () => {
  it("is the file name every hook reader looks for", () => {
    expect(BRAIN_SIDECAR_FILE).toBe("digital-me-brain.env");
  });

  it("writes a comment header plus exactly the URL and token-file lines, newline-terminated", () => {
    const text = renderBrainSidecar({ brainUrl: URL, brainTokenFile: TOKEN_FILE });
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("");
    const body = lines.slice(0, -1);
    const assignments = body.filter((l) => !l.startsWith("#"));
    expect(assignments).toEqual([`DIGITAL_ME_BRAIN_URL=${URL}`, `DIGITAL_ME_BRAIN_TOKEN_FILE=${TOKEN_FILE}`]);
    // Every other line is a comment, and the header names what writes the file.
    expect(body.length).toBeGreaterThan(assignments.length);
    expect(body[0]).toMatch(/^# Written by `digital-me install`/);
  });

  it("carries the token-file PATH only — no token-shaped key, and paths with spaces stay verbatim", () => {
    const text = renderBrainSidecar({ brainUrl: URL, brainTokenFile: "/home/a b/digital-me/.data/brain-host.token" });
    expect(text).toContain("DIGITAL_ME_BRAIN_TOKEN_FILE=/home/a b/digital-me/.data/brain-host.token\n");
    expect(text).not.toMatch(/^DIGITAL_ME_BRAIN_TOKEN=/m);
  });

  it("refuses half a contract: an empty or blank URL or token file throws", () => {
    for (const values of [
      { brainUrl: "", brainTokenFile: TOKEN_FILE },
      { brainUrl: URL, brainTokenFile: "  " },
    ]) {
      expect(() => renderBrainSidecar(values)).toThrow(/must be set together/);
    }
  });

  it("refuses a line break inside a value (it would add a line to the sidecar)", () => {
    expect(() => renderBrainSidecar({ brainUrl: `${URL}\nDIGITAL_ME_BRAIN_URL=http://evil`, brainTokenFile: TOKEN_FILE })).toThrow(
      /single-line/,
    );
    expect(() => renderBrainSidecar({ brainUrl: URL, brainTokenFile: `${TOKEN_FILE}\r` })).toThrow(/single-line/);
  });
});
