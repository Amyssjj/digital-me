import { describe, expect, it } from "vitest";
import { extractToolResult } from "./parse.js";

describe("extractToolResult", () => {
  it("returns parsed JSON from the first text content entry", () => {
    const r = extractToolResult({
      content: [{ type: "text", text: '{"x":1}' }],
    });
    expect(r).toEqual({ x: 1 });
  });

  it("returns raw text when the text isn't valid JSON", () => {
    const r = extractToolResult({
      content: [{ type: "text", text: "not-json" }],
    });
    expect(r).toBe("not-json");
  });

  it("skips non-text entries and uses the first matching text entry", () => {
    const r = extractToolResult({
      content: [
        { type: "image", url: "x" },
        { type: "text", text: '"second"' },
      ],
    });
    expect(r).toBe("second");
  });

  it("returns the raw result when content is absent", () => {
    const r = extractToolResult({ foo: "bar" });
    expect(r).toEqual({ foo: "bar" });
  });

  it("returns the raw result when content is not an array", () => {
    const r = extractToolResult({ content: "weird" });
    expect(r).toEqual({ content: "weird" });
  });

  it("returns the raw result when content array has no text entries", () => {
    const r = extractToolResult({
      content: [{ type: "image", url: "x" }],
    });
    expect(r).toEqual({ content: [{ type: "image", url: "x" }] });
  });

  it("skips a text entry whose .text is not a string", () => {
    const r = extractToolResult({
      content: [
        { type: "text", text: 42 as unknown as string },
        { type: "text", text: '"ok"' },
      ],
    });
    expect(r).toBe("ok");
  });

  it("returns the raw input when given null", () => {
    expect(extractToolResult(null)).toBeNull();
  });

  it("returns the raw input when given a non-object primitive", () => {
    expect(extractToolResult("plain")).toBe("plain");
  });
});
