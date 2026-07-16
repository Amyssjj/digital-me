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

## Remote access (Streamable HTTP transport)

A second entry point, `digital-me-brain-mcp-http`, exposes the same tool surface over
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http)
so MCP clients on **other machines** (a second laptop's Claude Code or Codex, a
Windows desktop, …) can use the same brain:

```
┌───────────────────────┐   HTTP MCP    ┌─────────────────────┐    HTTP POST    ┌────────────────────┐
│ remote CLI client     │ ────────────► │ brain-mcp-http      │ ──────────────► │  openclaw gateway  │
│ (second machine)      │  bearer token │ (brain machine)     │                 │  (same machine)    │
└───────────────────────┘               └─────────────────────┘                 └────────────────────┘
```

The remote client is a **remote control, not a second brain**: every call executes
on the brain machine against the single data store, and the proxy's observability
(trace rows, M1 application-rate logs) stays on the brain machine too. Nothing is
synced or duplicated.

### Server setup (brain machine)

```bash
export OPENCLAW_HOME=~/.openclaw
export BRAIN_MCP_HTTP_TOKEN="$(openssl rand -hex 32)"   # required — no default
digital-me-brain-mcp-http
```

| Env var | Default | Purpose |
|---|---|---|
| `BRAIN_MCP_HTTP_TOKEN` | (none — **required**, min 16 chars) | Shared bearer token remote clients must present |
| `BRAIN_MCP_HTTP_HOST` | `127.0.0.1` | Bind address. Loopback by default; binding a network interface is an explicit opt-in |
| `BRAIN_MCP_HTTP_PORT` | `18790` | Listen port |
| `BRAIN_MCP_HTTP_DEFAULT_AGENT_ID` | (unset) | Attribution fallback for requests that name no agent id |
| `BRAIN_MCP_HTTP_MAX_BODY_BYTES` | `2097152` | Request body cap |

Run it as a long-lived service (launchd on macOS, systemd on Linux) — unlike the
stdio transport it is not spawned per client session and has no parent-process
watchers. `GET /healthz` returns `{"ok":true}` without auth for service monitors.

### Client setup (remote machine)

Claude Code:

```bash
claude mcp add --transport http openclaw-brain "http://<brain-host>:18790/mcp" \
  -H "Authorization: Bearer <token>" \
  -H "X-Agent-Id: claude-code-laptop"
```

Codex CLI (`~/.codex/config.toml`, requires a Codex version with HTTP MCP support):

```toml
[mcp_servers.openclaw-brain]
url = "http://<brain-host>:18790/mcp?agent_id=codex-laptop"
bearer_token_env_var = "BRAIN_MCP_HTTP_TOKEN"
```

**Per-client attribution:** each remote client should identify itself so traces and
M1 metrics attribute calls correctly. Precedence: `X-Agent-Id` header →
`agent_id` URL query parameter (for clients that can't set custom headers) →
`BRAIN_MCP_HTTP_DEFAULT_AGENT_ID` → unattributed (`unknown:mcp`). When the
transport carries an explicit identity (header or query), it also overrides any
`agent_id` set inside tool arguments — the authenticated transport identity
wins, and the override is logged. A payload-declared `agent_id` is honored only
when the transport has no explicit identity of its own.

### Security model

- **Never starts unauthenticated** — a missing or short `BRAIN_MCP_HTTP_TOKEN` is a
  startup error, and every request needs the bearer token (timing-safe compare).
- **Loopback by default** — reaching it from another machine requires explicitly
  setting `BRAIN_MCP_HTTP_HOST`, and the server logs a network-exposure warning
  when bound to a non-loopback interface.
- **Prefer an overlay network over raw LAN exposure.** The token grants the full
  tool surface, including task dispatch — i.e. the ability to make the brain
  machine execute agent work. The recommended topology is a private overlay
  network (WireGuard, Tailscale or similar) between your machines, keeping the
  bearer token as a second factor. Never port-forward this endpoint to the
  internet; plain HTTP on an untrusted LAN exposes both token and content.
- **Stateless by design** — each POST builds a fresh server instance, so
  concurrent clients cannot interfere with each other and there is no session
  state to leak. (Clients that probe the optional GET/SSE notification stream get
  a spec-compliant 405 and continue normally.)

## Architecture

Testable modules + two entry points (stdio and HTTP share the same handler stack):

| Module | Responsibility | Coverage |
|---|---|---|
| `config.ts` | Resolve gateway endpoint + default agent_id | 100% |
| `tools.ts` | Static schema of the 8 brain tools | 100% |
| `gateway.ts` | HTTP forwarder with timeout + error mapping | 100% |
| `handler.ts` | CallTool: agent_id injection + attribution + invoke | 100% |
| `lifecycle.ts` | Parent-PID death watcher | 100% |
| `http-config.ts` | HTTP transport config (secure defaults) | 100% |
| `http-auth.ts` | Bearer auth (timing-safe) + agent-id resolution | 100% |
| `http-app.ts` | Stateless Streamable HTTP request handling | 100% |
| `server.ts` | Wire modules to MCP SDK + Node process (stdio entry) | excluded from coverage — exercised end-to-end |
| `http-server.ts` | Wire modules to node:http (HTTP service entry) | excluded from coverage — exercised end-to-end |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test          # vitest run
pnpm test:coverage # threshold: 100% lines/branches/functions/statements
pnpm build
```

The package contributes to the monorepo-level sanitize gate (CI fails on any personal-identifier leak) and the regression suite (Phase 1 regression test: 5 `memory_search` queries via old proxy vs this proxy must return identical results).
