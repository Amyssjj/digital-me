/**
 * Transcript source descriptor. Self-describes where this runtime
 * writes session transcripts so install-time setup can wire it into
 * `config.yaml`'s `sources:` list. Consumers (digest, dashboard,
 * dream-cycle) read from the config rather than hardcoding paths.
 */
export const TRANSCRIPT_SOURCE = {
  id: "claude-code-transcripts",
  path: "$HOME/.claude/projects",
  format: "claude-code-jsonl",
} as const;
