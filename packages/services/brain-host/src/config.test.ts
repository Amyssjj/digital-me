import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, expandHome, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("applies defaults from the home directory", () => {
    const c = loadConfig({}, "/home/j");
    expect(c.wikiRoot).toBe("/home/j/digital-me");
    expect(c.roots).toEqual([
      { dir: "/home/j/digital-me/wiki", corpus: "wiki" },
      { dir: "/home/j/digital-me/tastes", corpus: "tastes" },
    ]);
    expect(c.dbPath).toBe("/home/j/digital-me/.data/retrieval.db");
    expect(c.token).toBeUndefined();
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.host).toBe("127.0.0.1");
    expect(c.geminiApiKey).toBeUndefined();
    expect(c.embedModel).toBe("gemini-embedding-001");
    expect(c.embedDims).toBe(768);
  });

  it("honours every override and expands ~", () => {
    const c = loadConfig(
      {
        DIGITAL_ME_WIKI_ROOT: "~/dm",
        DIGITAL_ME_RETRIEVAL_DB: "~/x.db",
        DIGITAL_ME_BRAIN_TOKEN: "t",
        DIGITAL_ME_BRAIN_PORT: "1234",
        DIGITAL_ME_BRAIN_HOST: "0.0.0.0",
        GEMINI_API_KEY: "g",
        DIGITAL_ME_EMBED_MODEL: "m",
        DIGITAL_ME_EMBED_DIMS: "1536",
      },
      "/h",
    );
    expect(c).toMatchObject({ wikiRoot: "/h/dm", dbPath: "/h/x.db", token: "t", port: 1234, host: "0.0.0.0", geminiApiKey: "g", embedModel: "m", embedDims: 1536 });
  });

  it("ignores empty strings and bad numbers", () => {
    const c = loadConfig({ DIGITAL_ME_BRAIN_TOKEN: "", DIGITAL_ME_BRAIN_PORT: "abc", DIGITAL_ME_EMBED_DIMS: "-5", GEMINI_API_KEY: "", DIGITAL_ME_BRAIN_HOST: "" }, "/h");
    expect(c.token).toBeUndefined();
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.embedDims).toBe(768);
    expect(c.geminiApiKey).toBeUndefined();
    expect(c.host).toBe("127.0.0.1");
  });

  it("uses the real home directory by default", () => {
    expect(loadConfig({}).wikiRoot.endsWith("/digital-me")).toBe(true);
  });

  it("expandHome", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/a", "/h")).toBe("/h/a");
    expect(expandHome("/abs", "/h")).toBe("/abs");
  });
});
