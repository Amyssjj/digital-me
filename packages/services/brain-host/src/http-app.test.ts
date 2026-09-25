import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequestListener, type ListenerDeps } from "./http-app.js";
import { startServer } from "./http-server.js";
import { VERSION } from "./runtime.js";
import { okEnvelope } from "./tools.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

let server: Server;
let port: number;
let calls: { tool: string; args: Record<string, unknown>; agentId: string }[];
let logs: string[];
let deps: ListenerDeps;

beforeEach(async () => {
  calls = [];
  logs = [];
  deps = {
    token: TOKEN,
    version: "9.9.9",
    log: (l) => logs.push(l),
    health: () => ({ version: "9.9.9", entries: 3, dbPath: "/secret/retrieval.db" }),
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
const auth = { Authorization: `Bearer ${TOKEN}` };

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createRequestListener", () => {
  it("serves minimal liveness on /health without a valid token and never calls the detail probe", async () => {
    let probed = 0;
    deps.health = () => {
      probed++;
      return { entries: 3 };
    };
    expect(await call("GET", "/health")).toEqual({ status: 200, json: { ok: true, version: "9.9.9" } });
    expect(await call("GET", "/health", undefined, { Authorization: "Bearer wrong" })).toEqual({ status: 200, json: { ok: true, version: "9.9.9" } });
    expect(probed).toBe(0);
    expect((await call("POST", "/health", "{}")).status).toBe(405);
  });

  it("serves full /health detail with a valid token", async () => {
    expect(await call("GET", "/health", undefined, auth)).toEqual({
      status: 200,
      json: { ok: true, version: "9.9.9", entries: 3, dbPath: "/secret/retrieval.db" },
    });
  });

  it("404s unknown paths and 405s non-POST on invoke", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("GET", "/tools/invoke")).status).toBe(405);
  });

  it("requires a valid bearer token", async () => {
    expect((await call("POST", "/tools/invoke", "{}")).status).toBe(401);
    expect((await call("POST", "/tools/invoke", "{}", { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call("POST", "/tools/invoke", "{}", { Authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await call("POST", "/tools/invoke", "{}", { Authorization: "Basic abc" })).status).toBe(401);
  });

  it("validates the body and logs rejected bodies", async () => {
    expect((await call("POST", "/tools/invoke", "", auth)).json.error.message).toBe("empty request body");
    expect((await call("POST", "/tools/invoke", "{not json", auth)).status).toBe(400);
    expect((await call("POST", "/tools/invoke", "[1]", auth)).json.error.message).toBe("body must be a JSON object");
    expect((await call("POST", "/tools/invoke", '{"tool":""}', auth)).json.error.message).toBe("`tool` is required");
    const big = JSON.stringify({ tool: "x", args: { pad: "y".repeat(500) } });
    expect((await call("POST", "/tools/invoke", big, auth)).status).toBe(413);
    expect(logs).toContain("invoke rejected: HTTP 400 empty request body");
    expect(logs).toContain("invoke rejected: HTTP 413 request body exceeds 200 bytes");
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
    const listener = createRequestListener(deps);
    const fakeReq = Object.assign(Readable.from([]), { method: "GET", headers: {} }) as any;
    let status = 0;
    const fakeRes = { writeHead: (s: number) => { status = s; }, end: () => {} } as any;
    await listener(fakeReq, fakeRes);
    expect(status).toBe(404);
  });

  it("answers 500 when the health probe throws, and the server keeps serving", async () => {
    deps.health = () => {
      throw new Error("db locked");
    };
    const r = await call("GET", "/health", undefined, auth);
    expect(r).toEqual({ status: 500, json: { ok: false, error: { type: "internal", message: "internal server error" } } });
    expect(logs).toContain("request failed: db locked");
    expect((await call("GET", "/health")).status).toBe(200);
  });

  it("just ends the response when a failure happens after the headers went out", async () => {
    const listener = createRequestListener({ ...deps, health: () => { throw new Error("late"); } });
    const fakeReq = Object.assign(Readable.from([]), { method: "GET", url: "/health", headers: { authorization: `Bearer ${TOKEN}` } }) as any;
    let ended = 0;
    let wrote = 0;
    const fakeRes = { headersSent: true, writeHead: () => { wrote++; }, end: () => { ended++; } } as any;
    await listener(fakeReq, fakeRes);
    expect({ wrote, ended }).toEqual({ wrote: 0, ended: 1 });
  });

  it("never rejects even when the response itself cannot be written", async () => {
    const listener = createRequestListener({ ...deps, health: () => { throw "no health"; } });
    const fakeReq = Object.assign(Readable.from([]), { method: "GET", url: "/health", headers: { authorization: `Bearer ${TOKEN}` } }) as any;
    const fakeRes = {
      headersSent: false,
      writeHead: () => {
        throw new Error("socket gone");
      },
      end: () => {},
    } as any;
    await expect(listener(fakeReq, fakeRes)).resolves.toBeUndefined();
    expect(logs).toContain("request failed: no health");
  });

  it("falls back to 'unknown' agent and default body cap when deps omit them", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const listener = createRequestListener({ token: TOKEN, version: "1", log: () => {}, health: () => ({}), invoke: deps.invoke });
    server = createServer((req, res) => void listener(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    const r = await call("POST", "/tools/invoke", JSON.stringify({ tool: "wiki" }), auth);
    expect(r.json.result.details.agentId).toBe("unknown");
    const r2 = await call("POST", "/tools/invoke", JSON.stringify({ tool: "wiki", args: { pad: "y".repeat(1000) } }), auth);
    expect(r2.status).toBe(200);
  });
});

describe("startServer (real socket)", () => {
  let real: Server;
  let realLogs: string[];
  let realPort: number;

  beforeEach(async () => {
    realLogs = [];
    const runtime = {
      invoke: async (tool: string) => okEnvelope({ tool }),
      health: () => ({ version: VERSION, dbPath: "/secret/retrieval.db", wikiRoot: "/secret/wiki" }),
    };
    real = await startServer({ runtime, token: TOKEN, host: "127.0.0.1", port: 0, log: (l) => realLogs.push(l) });
    realPort = (real.address() as AddressInfo).port;
  });
  afterEach(() => new Promise<void>((r) => real.close(() => r())));

  it("survives a client that aborts mid-upload: no unhandled rejection, next request still served", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const socket = connect(realPort, "127.0.0.1");
      await new Promise<void>((r) => socket.once("connect", () => r()));
      socket.write(
        "POST /tools/invoke HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          `Authorization: Bearer ${TOKEN}\r\n` +
          "Content-Type: application/json\r\n" +
          "Content-Length: 1000\r\n\r\n" +
          '{"tool":"memory_search","args":{"query":"',
      );
      // Let the server start reading the body, then drop the connection.
      await new Promise((r) => setTimeout(r, 30));
      socket.destroy();

      await waitFor(() => realLogs.some((l) => l.includes("failed to read request body")));
      // Give any stray rejection a chance to surface before asserting.
      await new Promise((r) => setTimeout(r, 30));
      expect(rejections).toEqual([]);

      port = realPort;
      const next = await call("POST", "/tools/invoke", JSON.stringify({ tool: "wiki" }), auth);
      expect(next.status).toBe(200);
      expect(next.json.result.details).toEqual({ tool: "wiki" });
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("serves minimal /health without a token and full detail with one", async () => {
    port = realPort;
    const anon = await call("GET", "/health");
    expect(anon).toEqual({ status: 200, json: { ok: true, version: VERSION } });
    expect(JSON.stringify(anon.json)).not.toContain("/secret");
    const full = await call("GET", "/health", undefined, auth);
    expect(full.json).toEqual({ ok: true, version: VERSION, dbPath: "/secret/retrieval.db", wikiRoot: "/secret/wiki" });
  });
});
