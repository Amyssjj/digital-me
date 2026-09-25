import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MIN_TOKEN_LENGTH, extractBearerToken, isLoopbackHost, readJsonBody, timingSafeTokenEqual } from "./http.js";

describe("extractBearerToken", () => {
  it("returns null when the header is absent", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(extractBearerToken("Basic dXNlcjpwdw==")).toBeNull();
  });

  it("returns null for a Bearer header without a token", () => {
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer   ")).toBeNull();
  });

  it("extracts the token from a Bearer header", () => {
    expect(extractBearerToken("Bearer sekrit-token")).toBe("sekrit-token");
  });

  it("is case-insensitive about the scheme and tolerant of padding", () => {
    expect(extractBearerToken("  bearer sekrit-token  ")).toBe("sekrit-token");
    expect(extractBearerToken("Bearer  abc ")).toBe("abc");
  });
});

describe("timingSafeTokenEqual", () => {
  it("accepts an exact match", () => {
    expect(timingSafeTokenEqual("abc123", "abc123")).toBe(true);
  });

  it("rejects a mismatch", () => {
    expect(timingSafeTokenEqual("abc123", "abc124")).toBe(false);
  });

  it("rejects tokens of different lengths without throwing", () => {
    expect(timingSafeTokenEqual("abc123", "abc")).toBe(false);
    expect(timingSafeTokenEqual("abc", "abc123")).toBe(false);
    expect(timingSafeTokenEqual("abc", "")).toBe(false);
  });
});

describe("isLoopbackHost / MIN_TOKEN_LENGTH", () => {
  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["localhost", true],
    ["0.0.0.0", false],
    ["::", false],
    ["192.168.1.20", false],
  ])("classifies %s as loopback=%s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it("requires at least 16 characters", () => {
    expect(MIN_TOKEN_LENGTH).toBe(16);
  });
});

describe("readJsonBody", () => {
  function streamWith(payload: string): PassThrough {
    const stream = new PassThrough();
    stream.end(payload);
    return stream;
  }

  it("parses a valid JSON body", async () => {
    expect(await readJsonBody(streamWith('{"a":1}'), 1024)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("concatenates multiple chunks, including string chunks", async () => {
    expect(await readJsonBody(Readable.from(['{"a":', Buffer.from("2}")]), 1024)).toEqual({ ok: true, value: { a: 2 } });
  });

  it("rejects an empty body", async () => {
    expect(await readJsonBody(streamWith(""), 1024)).toEqual({ ok: false, status: 400, message: "empty request body" });
  });

  it("rejects malformed JSON", async () => {
    expect(await readJsonBody(streamWith("{nope"), 1024)).toEqual({
      ok: false,
      status: 400,
      message: "request body is not valid JSON",
    });
  });

  it("rejects a body over the byte cap with 413", async () => {
    expect(await readJsonBody(streamWith("x".repeat(64)), 10)).toEqual({
      ok: false,
      status: 413,
      message: "request body exceeds 10 bytes",
    });
  });

  it("maps a stream error (client abort) to 400 instead of rejecting", async () => {
    const stream = new PassThrough();
    const pending = readJsonBody(stream, 1024);
    stream.write('{"a":');
    stream.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
    const result = await pending;
    expect(result).toEqual({ ok: false, status: 400, message: "failed to read request body: aborted" });
  });

  it("stringifies non-Error stream failures", async () => {
    const failing: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject("raw-string-failure"),
      }),
    };
    const result = await readJsonBody(failing, 1024);
    expect(result).toEqual({ ok: false, status: 400, message: "failed to read request body: raw-string-failure" });
  });
});
