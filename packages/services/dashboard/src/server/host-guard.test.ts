import { describe, expect, it } from "vitest";
import { extractHostname, isLoopbackHost } from "./host-guard.js";

describe("extractHostname", () => {
  it("strips the port from a named host", () => {
    expect(extractHostname("localhost:3458")).toBe("localhost");
  });

  it("returns a bare host unchanged", () => {
    expect(extractHostname("127.0.0.1")).toBe("127.0.0.1");
  });

  it("unwraps an IPv6 literal with a port", () => {
    expect(extractHostname("[::1]:3458")).toBe("::1");
  });

  it("unwraps a bare IPv6 literal", () => {
    expect(extractHostname("[::1]")).toBe("::1");
  });

  it("lowercases the hostname", () => {
    expect(extractHostname("EVIL.Example")).toBe("evil.example");
  });

  it("returns null for a malformed IPv6 literal with no closing bracket", () => {
    expect(extractHostname("[::1")).toBeNull();
  });

  it("returns null when the host is empty before the port", () => {
    expect(extractHostname(":3458")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractHostname("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(extractHostname(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(extractHostname(null)).toBeNull();
  });
});

describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "localhost:3458",
    "127.0.0.1",
    "127.0.0.1:3458",
    "[::1]",
    "[::1]:3458",
    "LOCALHOST:3458",
  ])("allows loopback host %s", (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });

  it.each([
    "evil.example",
    "evil.example:3458",
    "127.0.0.1.evil.example",
    "192.168.1.10:3458",
    "attacker.local",
    ":3458",
    "",
    undefined,
    null,
  ])("rejects non-loopback host %s", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});
