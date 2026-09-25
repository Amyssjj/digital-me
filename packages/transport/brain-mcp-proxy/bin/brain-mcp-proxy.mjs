#!/usr/bin/env node
import { main } from "../dist/index.js";

main().catch((err) => {
  process.stderr.write(`digital-me-brain MCP proxy fatal error: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
