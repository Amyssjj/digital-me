#!/usr/bin/env node
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`brain-host: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
