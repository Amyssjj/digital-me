/**
 * argv → command. Kept separate from cli.ts (process wiring) so every parse
 * decision is unit-tested.
 */

export type Command =
  | { readonly kind: "index"; readonly force: boolean; readonly offline: boolean }
  | { readonly kind: "search"; readonly query: string; readonly limit: number | undefined; readonly offline: boolean; readonly json: boolean }
  | { readonly kind: "serve"; readonly port: number | undefined; readonly offline: boolean }
  | { readonly kind: "status" }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export const USAGE = `digital-me-brain-host <command> [options]

Commands
  index   [--force] [--offline]        build or refresh the retrieval index
  search  <query> [--limit N] [--json] [--offline]
  serve   [--port N] [--offline]       serve /tools/invoke + /health
  status                               index size and provenance

Environment (see config.ts): DIGITAL_ME_WIKI_ROOT, DIGITAL_ME_RETRIEVAL_DB,
DIGITAL_ME_BRAIN_TOKEN, DIGITAL_ME_BRAIN_PORT, GEMINI_API_KEY.
--offline uses the deterministic hash embedder (tests / smoke only).`;

export function parseArgs(argv: readonly string[]): Command {
  const [cmd, ...rest] = argv;
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--limit" || a === "--port") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return { kind: "error", message: `${a} requires a value` };
      values.set(a, v);
      i++;
    } else if (a.startsWith("--")) {
      flags.add(a);
    } else {
      positional.push(a);
    }
  }
  const offline = flags.has("--offline");
  const num = (key: string): number | undefined | null => {
    const raw = values.get(key);
    if (raw === undefined) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  switch (cmd) {
    case "index":
      return { kind: "index", force: flags.has("--force"), offline };
    case "search": {
      const query = positional.join(" ").trim();
      if (query === "") return { kind: "error", message: "search requires a query" };
      const limit = num("--limit");
      if (limit === null) return { kind: "error", message: "--limit must be a positive integer" };
      return { kind: "search", query, limit, offline, json: flags.has("--json") };
    }
    case "serve": {
      const port = num("--port");
      if (port === null) return { kind: "error", message: "--port must be a positive integer" };
      return { kind: "serve", port, offline };
    }
    case "status":
      return { kind: "status" };
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    default:
      return { kind: "error", message: `unknown command "${cmd}"` };
  }
}
