import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors.js";

describe("errorMessage", () => {
  it("uses the message of an Error and stringifies anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("raw")).toBe("raw");
    expect(errorMessage(42)).toBe("42");
  });
});
