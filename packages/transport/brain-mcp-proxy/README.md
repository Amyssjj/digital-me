# @digital-me/brain-mcp-proxy

Stdio MCP server that forwards tool calls to openclaw's HTTP gateway. Lets any MCP-capable CLI (Claude Code, Codex, Hermes, future ones) reach the openclaw-brain without each CLI implementing the HTTP gateway protocol directly.

## What it does

```
┌──────────────┐    stdio MCP    ┌─────────────────────┐    HTTP POST    ┌────────────────────────┐
│  CLI client  │ ──────────────► │ brain-mcp-proxy     │ ──────────────► │  openclaw gateway      │
└──────────────┘                 └─────────────────────┘                 └────────────────────────┘
```

The proxy:
- Speaks stdio MCP JSON-RPC to its parent (the CLI)
- Forwards every CallTool request to `POST $OPENCLAW_GATEWAY_HOST:$OPENCLAW_GATEWAY_PORT/tools/invoke` with bearer-token auth
- Auto-injects `agent_id` from `OPENCLAW_AGENT_ID` env or `--agent-id=<id>` argv flag when the caller didn't set one
- Translates gateway responses back to MCP `CallToolResult` shape, stripping the `details` field that strict clients reject
- Caps each call at 1 hour (configurable in source) to prevent hangs
- Self-exits when its parent dies (signal, stdin close, or ppid change)

## Installation

```bash
npm install -g @digital-me/brain-mcp-proxy
```

The binary is installed as `digital-me-brain-mcp-proxy`.

## Usage

Register with your MCP client by pointing at the binary. For Claude Code (`~/.claude.json`):

```json
{
  "mcpServers": {
    "openclaw-brain": {
      "command": "digital-me-brain-mcp-proxy",
      "env": {
        "OPENCLAW_AGENT_ID": "claude-code-main"
      }
    }
  }
}
```

For Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.openclaw-brain]
command = "digital-me-brain-mcp-proxy"

[mcp_servers.openclaw-brain.env]
OPENCLAW_AGENT_ID = "codex-main"
```

## Configuration

Reads from environment variables (recommended) with fallback to `$OPENCLAW_HOME/openclaw.json`:

| Env var | Default | Purpose |
|---|---|---|
| `OPENCLAW_GATEWAY_HOST` | `localhost` | Gateway host |
| `OPENCLAW_GATEWAY_PORT` | `18789` (or file value) | Gateway port |
| `OPENCLAW_GATEWAY_TOKEN` | (read from openclaw.json) | Bearer token |
| `OPENCLAW_HOME` | `~/.openclaw` | Openclaw config root |
| `OPENCLAW_AGENT_ID` | (unset) | Default `agent_id` stamped on outgoing tool calls |

Token resolution falls back from env to `$OPENCLAW_HOME/openclaw.json` (`gateway.auth.token`, then `gateway.auth.password`). Throws clearly at startup if no token can be resolved.

## Architecture

Five testable modules + one entry point:

| Module | Responsibility | Coverage |
|---|---|---|
| `config.ts` | Resolve gateway endpoint + default agent_id | 100% |
| `tools.ts` | Static schema of the 8 brain tools | 100% |
| `gateway.ts` | HTTP forwarder with timeout + error mapping | 100% |
| `handler.ts` | CallTool: agent_id injection + attribution + invoke | 100% |
| `lifecycle.ts` | Parent-PID death watcher | 100% |
| `server.ts` | Wire modules to MCP SDK + Node process (entry only) | excluded from coverage — exercised end-to-end |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test          # vitest run
pnpm test:coverage # threshold: 100% lines/branches/functions/statements
pnpm build
```

The package contributes to the monorepo-level sanitize gate (CI fails on any personal-identifier leak) and the regression suite (Phase 1 regression test: 5 `memory_search` queries via old proxy vs this proxy must return identical results).
