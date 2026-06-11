#!/usr/bin/env node
import { main } from "../dist/index.js";

main().catch((err) => {
  process.stderr.write(`openclaw-brain MCP proxy fatal error: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
