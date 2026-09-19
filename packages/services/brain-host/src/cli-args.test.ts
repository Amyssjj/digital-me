import { describe, expect, it } from "vitest";
import { parseArgs, USAGE } from "./cli-args.js";

describe("parseArgs", () => {
  it("parses index", () => {
    expect(parseArgs(["index"])).toEqual({ kind: "index", force: false, offline: false });
    expect(parseArgs(["index", "--force", "--offline"])).toEqual({ kind: "index", force: true, offline: true });
  });

  it("parses search with a multi-word query and options", () => {
    expect(parseArgs(["search", "kanban", "range", "--limit", "3", "--json"])).toEqual({
      kind: "search", query: "kanban range", limit: 3, offline: false, json: true,
    });
    expect(parseArgs(["search", "q"])).toMatchObject({ limit: undefined });
    expect(parseArgs(["search"])).toEqual({ kind: "error", message: "search requires a query" });
    expect(parseArgs(["search", "q", "--limit", "zero"])).toEqual({ kind: "error", message: "--limit must be a positive integer" });
    expect(parseArgs(["search", "q", "--limit"])).toEqual({ kind: "error", message: "--limit requires a value" });
    expect(parseArgs(["search", "q", "--limit", "--json"])).toEqual({ kind: "error", message: "--limit requires a value" });
  });

  it("parses serve and status", () => {
    expect(parseArgs(["serve"])).toEqual({ kind: "serve", port: undefined, offline: false, orchestrator: true });
    expect(parseArgs(["serve", "--port", "9999", "--offline", "--no-orchestrator"])).toEqual({ kind: "serve", port: 9999, offline: true, orchestrator: false });
    expect(parseArgs(["serve", "--port", "-1"])).toEqual({ kind: "error", message: "--port must be a positive integer" });
    expect(parseArgs(["status"])).toEqual({ kind: "status" });
  });

  it("help and errors", () => {
    expect(parseArgs([])).toEqual({ kind: "help" });
    expect(parseArgs(["help"])).toEqual({ kind: "help" });
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["bogus"])).toEqual({ kind: "error", message: 'unknown command "bogus"' });
    expect(USAGE).toContain("digital-me-brain-host");
  });
});
