/**
 * Extract a useful value from an MCP CallToolResult.
 *
 * The brain returns its payloads as the first text entry in `content`,
 * usually JSON-encoded. This helper:
 *   1. finds the first text entry
 *   2. tries to JSON.parse it; falls back to the raw string
 *   3. if there are no text entries, returns the original result so the
 *      caller can decide how to handle it
 */

type ContentEntry = { type: string; text?: unknown };
type MaybeResult = {
  content?: unknown;
} | unknown;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function extractToolResult(result: MaybeResult): unknown {
  if (!isObject(result)) return result;
  const content = result.content;
  if (!Array.isArray(content)) return result;

  for (const raw of content) {
    const entry = raw as ContentEntry;
    if (entry.type === "text" && typeof entry.text === "string") {
      try {
        return JSON.parse(entry.text);
      } catch {
        return entry.text;
      }
    }
  }

  return result;
}
