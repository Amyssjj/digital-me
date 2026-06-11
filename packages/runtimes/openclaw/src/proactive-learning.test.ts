import { describe, expect, it } from "vitest";
import {
  buildInjection,
  extractRecentMessagesText,
  loadDomainContext,
  matchDomains,
  type MessageLike,
  type ProactiveLearningConfig,
} from "./proactive-learning.js";

function cfg(
  overrides: Partial<ProactiveLearningConfig> = {},
): ProactiveLearningConfig {
  return {
    domains: {
      writing: {
        keywords: ["story", "article"],
        files: ["writing/rules.md"],
      },
      ops: {
        keywords: ["deploy", "rollback"],
        files: ["ops/runbook.md"],
        targetAgents: ["ops-bot"],
      },
    },
    ...overrides,
  };
}

const FILES: Record<string, string> = {
  "writing/rules.md": "Use active voice.\nKeep paragraphs short.",
  "ops/runbook.md": "Deploys go through canary first.",
};
const readFile = (p: string): string | undefined => FILES[p];

// ── matchDomains ──────────────────────────────────────────────────────────

describe("matchDomains", () => {
  it("returns the domain name when any keyword appears in the prompt", () => {
    expect(matchDomains("Edit the story arc", [], cfg(), "any-agent")).toEqual([
      "writing",
    ]);
  });

  it("matches keywords case-insensitively", () => {
    expect(matchDomains("STORY arc", [], cfg(), "any-agent")).toEqual([
      "writing",
    ]);
  });

  it("returns all matching domains sorted alphabetically", () => {
    expect(
      matchDomains(
        "Deploy the story",
        [],
        cfg({
          domains: {
            ops: { keywords: ["deploy"], files: ["o.md"] },
            writing: { keywords: ["story"], files: ["w.md"] },
          },
        }),
        "any",
      ),
    ).toEqual(["ops", "writing"]);
  });

  it("returns an empty list when no keyword fires", () => {
    expect(matchDomains("Pick a color", [], cfg(), "any")).toEqual([]);
  });

  it("matches keywords found only in recent messages, not the prompt", () => {
    const messages: MessageLike[] = [
      { role: "user", content: "Let's talk about the story arc" },
    ];
    expect(matchDomains("any prompt", messages, cfg(), "any")).toEqual([
      "writing",
    ]);
  });

  it("skips domains whose targetAgents excludes the caller", () => {
    expect(
      matchDomains("rollback now please", [], cfg(), "claude-code"),
    ).toEqual([]);
  });

  it("matches domains whose targetAgents includes the caller", () => {
    expect(matchDomains("rollback now please", [], cfg(), "ops-bot")).toEqual([
      "ops",
    ]);
  });

  it("ignores empty-string keywords (defensive: would otherwise match everything)", () => {
    const result = matchDomains(
      "anything",
      [],
      {
        domains: {
          d: { keywords: ["", "x"], files: ["f.md"] },
        },
      },
      "any",
    );
    expect(result).toEqual([]);
  });

  it("breaks on the first matching keyword (no duplicate domain emission)", () => {
    expect(
      matchDomains(
        "story article story article",
        [],
        cfg(),
        "any",
      ),
    ).toEqual(["writing"]);
  });
});

// ── extractRecentMessagesText ─────────────────────────────────────────────

describe("extractRecentMessagesText", () => {
  it("returns empty for an empty message list", () => {
    expect(extractRecentMessagesText([])).toBe("");
  });

  it("formats string content with the role label", () => {
    const msgs: MessageLike[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    expect(extractRecentMessagesText(msgs)).toBe(
      "[user]: hello\n[assistant]: world",
    );
  });

  it("uses 'unknown' when role is missing", () => {
    const msgs: MessageLike[] = [{ content: "hello" }];
    expect(extractRecentMessagesText(msgs)).toBe("[unknown]: hello");
  });

  it("flattens text content blocks from an array body", () => {
    const msgs: MessageLike[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "first block" },
          { type: "image", text: "ignored — wrong type" },
          { type: "text", text: "second block" },
        ],
      },
    ];
    expect(extractRecentMessagesText(msgs)).toBe(
      "[user]: first block\n[user]: second block",
    );
  });

  it("only considers the last N messages (default 3)", () => {
    const msgs: MessageLike[] = Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: `m${i}`,
    }));
    expect(extractRecentMessagesText(msgs)).toBe(
      "[user]: m7\n[user]: m8\n[user]: m9",
    );
  });

  it("respects an explicit count override", () => {
    const msgs: MessageLike[] = Array.from({ length: 5 }, (_, i) => ({
      role: "user",
      content: `m${i}`,
    }));
    expect(extractRecentMessagesText(msgs, 1)).toBe("[user]: m4");
  });

  it("skips array content blocks with non-string or missing text", () => {
    const msgs: MessageLike[] = [
      {
        role: "user",
        content: [
          { type: "text" }, // missing text
          { type: "text", text: "kept" },
        ],
      },
    ];
    expect(extractRecentMessagesText(msgs)).toBe("[user]: kept");
  });
});

// ── loadDomainContext ─────────────────────────────────────────────────────

describe("loadDomainContext", () => {
  it("returns empty for an empty matched-domain list", () => {
    expect(loadDomainContext([], cfg(), readFile)).toBe("");
  });

  it("renders the proactive-learnings envelope when content is found", () => {
    const out = loadDomainContext(["writing"], cfg(), readFile);
    expect(out).toContain("<proactive-learnings>");
    expect(out).toContain("## Domain: writing");
    expect(out).toContain("# Source: writing/rules.md");
    expect(out).toContain("Use active voice.");
    expect(out).toContain("</proactive-learnings>");
  });

  it("silently skips missing files (returns empty if all missing)", () => {
    const c = cfg({
      domains: {
        ghost: { keywords: ["x"], files: ["does-not-exist.md"] },
      },
    });
    expect(loadDomainContext(["ghost"], c, readFile)).toBe("");
  });

  it("silently skips unknown domain names", () => {
    expect(loadDomainContext(["unknown"], cfg(), readFile)).toBe("");
  });

  it("truncates files past maxCharsPerDomain", () => {
    const big = "x".repeat(10000);
    const out = loadDomainContext(
      ["d"],
      {
        domains: { d: { keywords: ["k"], files: ["big.md"] } },
        maxCharsPerDomain: 100,
      },
      () => big,
    );
    expect(out).toContain("…[truncated at 100 chars]");
    // The slice should be 100 chars + the truncation footer.
    expect(out.length).toBeLessThan(big.length);
  });

  it("falls back to 4000 chars when maxCharsPerDomain is unset", () => {
    const big = "x".repeat(5000);
    const out = loadDomainContext(
      ["d"],
      { domains: { d: { keywords: ["k"], files: ["big.md"] } } },
      () => big,
    );
    expect(out).toContain("…[truncated at 4000 chars]");
  });

  it("merges multiple domains in order under one envelope", () => {
    const out = loadDomainContext(["writing", "ops"], cfg(), readFile);
    const writingIdx = out.indexOf("## Domain: writing");
    const opsIdx = out.indexOf("## Domain: ops");
    expect(writingIdx).toBeGreaterThanOrEqual(0);
    expect(opsIdx).toBeGreaterThan(writingIdx);
  });
});

// ── buildInjection ────────────────────────────────────────────────────────

describe("buildInjection", () => {
  it("returns empty when no domain matches", () => {
    expect(
      buildInjection("hello there", [], "any", cfg(), readFile),
    ).toBe("");
  });

  it("matches + loads in one call", () => {
    const out = buildInjection(
      "Edit the story arc",
      [],
      "any",
      cfg(),
      readFile,
    );
    expect(out).toContain("Use active voice.");
  });
});
