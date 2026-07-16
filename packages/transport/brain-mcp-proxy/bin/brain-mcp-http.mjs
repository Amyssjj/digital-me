#!/usr/bin/env node
import { mainHttp } from "../dist/index.js";

mainHttp().catch((err) => {
  process.stderr.write(`openclaw-brain MCP HTTP transport fatal error: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
