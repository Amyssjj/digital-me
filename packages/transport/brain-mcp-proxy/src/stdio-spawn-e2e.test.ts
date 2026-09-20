/**
 * Spawned-proxy end-to-end: the real bin over a real stdio pipe.
 *
 * stdio-e2e.test.ts drives the SDK wiring in-process over InMemoryTransport,
 * which has no read buffer. This file spawns bin/brain-mcp-proxy.mjs the way
 * a client does and documents the SDK's stdio message cap:
 * @modelcontextprotocol/sdk >= 1.30 rejects any single JSON-RPC message over
 * `StdioServerParameters.maxBufferSize` (default 10 MB) and CLOSES the
 * transport — the caller sees "Connection closed", not an oversize error,
 * while a client that raises maxBufferSize receives the same payload intact.
 * The dashboard's brain client hit exactly this on the ~55 MB board JSON.
 *
 * Hermetic: the proxy is pointed at an in-process fake gateway through
 * DIGITAL_ME_BRAIN_URL + DIGITAL_ME_BRAIN_TOKEN (the brain-host precedence
 * path — no openclaw.json is read), with HOME / OPENCLAW_HOME / BRAIN_DB_PATH
 * inside a temp dir so nothing touches the user's config, brain.db or
 * app-rate logs. Needs dist/ (the bin imports ../dist/index.js); `pnpm build`
 * precedes tests in `pnpm run ci`.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_RESULT_BYTES_ENV } from "./handler.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "..", "bin", "brain-mcp-proxy.mjs");
const DIST_INDEX = path.resolve(HERE, "..", "dist", "index.js");

/** SDK 1.30 `STDIO_DEFAULT_MAX_BUFFER_SIZE` (shared/stdio.js). */
const SDK_DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
/** Over the default cap, far under the 256 MiB the dashboard configures. */
const BIG_TEXT_BYTES = 12 * 1024 * 1024;
const RAISED_MAX_BUFFER = 256 * 1024 * 1024;

const TOKEN = "spawn-e2e-token";

let gateway: http.Server;
let gatewayUrl: string;
let tmp: string;
const gatewayCalls: Array<{ tool: string; authorization: string | undefined }> = [];

beforeAll(async () => {
  if (!fs.existsSync(DIST_INDEX)) {
    throw new Error(
      `${DIST_INDEX} is missing — run \`pnpm build\` first (\`pnpm run ci\` does).`,
    );
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-proxy-spawn-"));
  fs.mkdirSync(path.join(tmp, ".openclaw"), { recursive: true });

  // Fake gateway: every tool call answers with one ~12 MiB text result.
  const bigText = JSON.stringify({ goals: [], pad: "x".repeat(BIG_TEXT_BYTES) });
  gateway = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { tool: string };
      gatewayCalls.push({ tool: parsed.tool, authorization: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ ok: true, result: { content: [{ type: "text", text: bigText }] } }),
      );
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/tools/invoke`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function spawnProxy(maxBufferSize?: number): {
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
} {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: {
      ...getDefaultEnvironment(),
      HOME: tmp,
      OPENCLAW_HOME: path.join(tmp, ".openclaw"),
      BRAIN_DB_PATH: path.join(tmp, "brain.db"),
      DIGITAL_ME_BRAIN_URL: gatewayUrl,
      DIGITAL_ME_BRAIN_TOKEN: TOKEN,
      // Same exemption the dashboard sets: let the full result through so the
      // client-side cap is what decides the outcome.
      [MAX_RESULT_BYTES_ENV]: "0",
    },
    stderr: "pipe",
    ...(maxBufferSize !== undefined ? { maxBufferSize } : {}),
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
  });
  const client = new Client({ name: "stdio-spawn-e2e", version: "0.0.0" });
  return { client, transport, stderr };
}

const BOARD_CALL = { name: "tasks", arguments: { action: "board", format: "json" } };

describe("spawned brain-mcp-proxy over a real stdio pipe", () => {
  it(
    "a default SDK client loses the connection on a >10 MB result (documents the cap)",
    async () => {
      const { client, transport, stderr } = spawnProxy();
      const errors: string[] = [];
      client.onerror = (err) => {
        errors.push(err.message);
      };
      await client.connect(transport);

      await expect(client.callTool(BOARD_CALL)).rejects.toThrow(/Connection closed/);

      // The transport error names the real cause before the SDK closes it.
      expect(errors.some((m) => m.includes("ReadBuffer exceeded maximum size"))).toBe(true);
      // The proxy reached the (fake) brain-host through the DIGITAL_ME_BRAIN_*
      // precedence path, bearer-authenticated, without any openclaw.json.
      expect(gatewayCalls.at(-1)).toEqual({ tool: "tasks", authorization: `Bearer ${TOKEN}` });
      expect(stderr.join("")).toContain(`gateway: 127.0.0.1:${new URL(gatewayUrl).port}`);
      await client.close();
    },
    30_000,
  );

  it(
    "a client with maxBufferSize raised receives the same payload intact",
    async () => {
      const { client, transport } = spawnProxy(RAISED_MAX_BUFFER);
      await client.connect(transport);

      const result = await client.callTool(BOARD_CALL);
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(SDK_DEFAULT_MAX_BUFFER);
      expect((JSON.parse(text) as { goals: unknown[] }).goals).toEqual([]);
      expect(result.isError).toBeUndefined();

      await client.close();
    },
    30_000,
  );
});
