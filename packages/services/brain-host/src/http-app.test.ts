import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequestListener, extractBearer, readJsonBody, tokenEqual, type ListenerDeps } from "./http-app.js";
import { okEnvelope } from "./tools.js";

let server: Server;
let port: number;
let calls: { tool: string; args: Record<string, unknown>; agentId: string }[];
let logs: string[];
let deps: ListenerDeps;

beforeEach(async () => {
  calls = [];
  logs = [];
  deps = {
    token: "secret",
    log: (l) => logs.push(l),
    health: () => ({ entries: 3 }),
    invoke: async (tool, args, agentId) => {
      calls.push({ tool, args, agentId });
      if (tool === "boom") throw new Error("kaboom");
      if (tool === "boom-string") throw "raw failure";
      return okEnvelope({ tool, agentId });
    },
    maxBodyBytes: 200,
    defaultAgentId: "default-agent",
  };
  const listener = createRequestListener(deps);
  server = createServer((req, res) => void listener(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

function call(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, json: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const auth = { Authorization: "Bearer secret" };

describe("createRequestListener", () => {
  it("serves health without auth and rejects non-GET", async () => {
    expect(await call("GET", "/health")).toEqual({ status: 200, json: { ok: true, entries: 3 } });
    expect((await call("POST", "/health", "{}")).status).toBe(405);
  });

  it("404s unknown paths and 405s non-POST on invoke", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("GET", "/tools/invoke")).status).toBe(405);
  });

  it("requires a valid bearer token", async () => {
    expect((await call("POST", "/tools/invoke", "{}")).status).toBe(401);
    expect((await call("POST", "/tools/invoke", "{}", { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call("POST", "/tools/invoke", "{}", { Authorization: "Basic abc" })).status).toBe(401);
  });

  it("validates the body", async () => {
    expect((await call("POST", "/tools/invoke", "", auth)).json.error.message).toBe("empty request body");
    expect((await call("POST", "/tools/invoke", "{not json", auth)).status).toBe(400);
    expect((await call("POST", "/tools/invoke", "[1]", auth)).json.error.message).toBe("body must be a JSON object");
    expect((await call("POST", "/tools/invoke", '{"tool":""}', auth)).json.error.message).toBe("`tool` is required");
    const big = JSON.stringify({ tool: "x", args: { pad: "y".repeat(500) } });
    expect((await call("POST", "/tools/invoke", big, auth)).status).toBe(413);
  });

  it("invokes with args and agent id, defaulting both, and logs", async () => {
    const r1 = await call("POST", "/tools/invoke", JSON.stringify({ tool: "memory_search", agentId: "cc", args: { query: "q" } }), auth);
    expect(r1.status).toBe(200);
    expect(r1.json.result.details).toEqual({ tool: "memory_search", agentId: "cc" });
    const r2 = await call("POST", "/tools/invoke", JSON.stringify({ tool: "wiki", args: [1] }), auth);
    expect(r2.json.result.details.agentId).toBe("default-agent");
    expect(calls[1]).toEqual({ tool: "wiki", args: {}, agentId: "default-agent" });
    expect(logs.some((l) => l.startsWith("invoke memory_search agent=cc ok=true"))).toBe(true);
  });

  it("turns a throwing tool into a 500 and logs it", async () => {
    const r = await call("POST", "/tools/invoke", JSON.stringify({ tool: "boom" }), auth);
    expect(r.status).toBe(500);
    expect(r.json.error.type).toBe("internal");
    expect(logs.some((l) => l.includes("kaboom"))).toBe(true);
  });

  it("logs non-Error throws and treats a missing url as /", async () => {
    const r = await call("POST", "/tools/invoke", JSON.stringify({ tool: "boom-string", agentId: "" }), auth);
    expect(r.status).toBe(500);
    expect(logs.some((l) => l.includes("agent=default-agent threw: raw failure"))).toBe(true);
    const { Readable } = await import("node:stream");
    const listener = createRequestListener(deps);
    const fakeReq = Object.assign(Readable.from([]), { method: "GET", headers: {} }) as any;
    let status = 0;
    const fakeRes = { writeHead: (s: number) => { status = s; }, end: () => {} } as any;
    await listener(fakeReq, fakeRes);
    expect(status).toBe(404);
  });

  it("falls back to 'unknown' agent and default body cap when deps omit them", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const listener = createRequestListener({ token: "secret", log: () => {}, health: () => ({}), invoke: deps.invoke });
    server = createServer((req, res) => void listener(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    const r = await call("POST", "/tools/invoke", JSON.stringify({ tool: "wiki" }), auth);
    expect(r.json.result.details.agentId).toBe("unknown");
    const r2 = await call("POST", "/tools/invoke", JSON.stringify({ tool: "wiki", args: { pad: "y".repeat(1000) } }), auth);
    expect(r2.status).toBe(200);
  });
});

describe("helpers", () => {
  it("extractBearer and tokenEqual", () => {
    expect(extractBearer("Bearer  abc ")).toBe("abc");
    expect(extractBearer("bearer x")).toBe("x");
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("Token x")).toBeNull();
    expect(tokenEqual("a", "a")).toBe(true);
    expect(tokenEqual("a", "b")).toBe(false);
    expect(tokenEqual("a", "ab")).toBe(false);
  });

  it("readJsonBody handles a request stream directly", async () => {
    const { Readable } = await import("node:stream");
    const ok = await readJsonBody(Readable.from([Buffer.from('{"a":1}')]) as any, 100);
    expect(ok).toEqual({ ok: true, value: { a: 1 } });
  });
});
