"""HTTP client for the openclaw brain gateway.

Lets dream_cycle (Python) instantiate workflows + poll their status without
ever talking to an LLM directly. Mirrors what `@digital-me/brain-mcp-proxy`
does for non-openclaw CLIs, but as a single ~200-line stdlib module.

Two reasons we shell out via HTTP rather than via the MCP stdio proxy:

1. **Each HTTP POST is its own gateway-request context.** That matters for
   the known cron-tick spawn-dispatch bug: `runtime.subagent.run()` only
   works inside a gateway request. By making `run_workflow` and
   `schedule_tick` two back-to-back HTTP calls, both run in fresh
   gateway-request contexts and spawn dispatch should succeed.

2. **No new dependencies.** urllib + json are stdlib. The MCP client lib
   would add a dep and a subprocess.

Gateway endpoint discovery mirrors `packages/transport/brain-mcp-proxy/src/config.ts`:

  Token:  $OPENCLAW_GATEWAY_TOKEN  →  ~/.openclaw/openclaw.json:gateway.auth.token
                                  →  ~/.openclaw/openclaw.json:gateway.auth.password
  Port:   $OPENCLAW_GATEWAY_PORT   →  ~/.openclaw/openclaw.json:gateway.port  →  18789
  Host:   $OPENCLAW_GATEWAY_HOST   →  localhost

  URL constructed as `http://<host>:<port>/tools/invoke`.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


DEFAULT_HOST = "localhost"
DEFAULT_PORT = 18789
DEFAULT_TIMEOUT_S = 30.0
TERMINAL_GOAL_STATUSES = frozenset({"completed", "failed", "cancelled"})


class BrainClientError(Exception):
    """Raised for any HTTP / gateway-level failure."""


@dataclass(frozen=True)
class GatewayEndpoint:
    host: str
    port: int
    token: str

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}/tools/invoke"


def _read_openclaw_file(openclaw_home: Path) -> dict[str, Any]:
    """Read ~/.openclaw/openclaw.json. Returns {} if missing — caller decides
    what's a fatal absence vs. an env-only setup."""
    path = openclaw_home / "openclaw.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise BrainClientError(f"failed to read {path}: {e}") from e


def load_gateway(
    env: Optional[dict[str, str]] = None,
    openclaw_home: Optional[Path] = None,
) -> GatewayEndpoint:
    """Resolve gateway connection per env > openclaw.json > defaults."""
    env_ = dict(os.environ if env is None else env)
    openclaw_home = openclaw_home or Path(env_.get("OPENCLAW_HOME") or (Path.home() / ".openclaw"))
    file_shape = _read_openclaw_file(openclaw_home)
    gw_file = file_shape.get("gateway") if isinstance(file_shape, dict) else None
    gw_file = gw_file if isinstance(gw_file, dict) else {}

    host = env_.get("OPENCLAW_GATEWAY_HOST") or DEFAULT_HOST

    port_str = env_.get("OPENCLAW_GATEWAY_PORT")
    if port_str:
        try:
            port = int(port_str)
        except ValueError as e:
            raise BrainClientError(
                f"OPENCLAW_GATEWAY_PORT is not an integer: {port_str!r}"
            ) from e
    elif isinstance(gw_file.get("port"), int):
        port = gw_file["port"]
    else:
        port = DEFAULT_PORT

    token = env_.get("OPENCLAW_GATEWAY_TOKEN")
    if not token:
        auth = gw_file.get("auth") if isinstance(gw_file, dict) else None
        if isinstance(auth, dict):
            if isinstance(auth.get("token"), str) and auth["token"]:
                token = auth["token"]
            elif isinstance(auth.get("password"), str) and auth["password"]:
                token = auth["password"]
    if not token:
        raise BrainClientError(
            "gateway auth token not found — set OPENCLAW_GATEWAY_TOKEN or "
            "populate gateway.auth.token in ~/.openclaw/openclaw.json"
        )

    return GatewayEndpoint(host=host, port=port, token=token)


# `fetcher` injection makes the client testable without a live network.
# Default fetcher uses urllib so the production path stays zero-dep.
Fetcher = Any  # callable(url, body_bytes, headers, timeout_s) -> bytes


def _urllib_fetcher(
    url: str, body: bytes, headers: dict[str, str], timeout_s: float
) -> bytes:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read() if hasattr(e, "read") else b""
        raise BrainClientError(
            f"gateway returned HTTP {e.code}: {raw.decode('utf-8', errors='replace')}"
        ) from e
    except urllib.error.URLError as e:
        raise BrainClientError(f"gateway unreachable: {e.reason}") from e


class BrainClient:
    """Thin wrapper around POST /tools/invoke. One instance per dream-cycle run."""

    def __init__(
        self,
        gateway: Optional[GatewayEndpoint] = None,
        fetcher: Optional[Fetcher] = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ):
        self.gateway = gateway or load_gateway()
        self.fetcher = fetcher or _urllib_fetcher
        self.timeout_s = timeout_s

    def _invoke(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps({"tool": tool, "args": args}).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.gateway.token}",
        }
        raw = self.fetcher(self.gateway.url, body, headers, self.timeout_s)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise BrainClientError(f"gateway returned non-JSON body: {raw[:200]!r}") from e
        if data.get("ok") is False:
            err = data.get("error") or {}
            msg = err.get("message") if isinstance(err, dict) else None
            raise BrainClientError(
                f"gateway error from {tool}: {msg or json.dumps(err)}"
            )
        result = data.get("result")
        if not isinstance(result, dict):
            raise BrainClientError(
                f"gateway response missing 'result' object: {data!r}"
            )
        # Some action handlers (e.g. workflow_import) wrap user-visible
        # errors as `{result: {isError: true, content: [{type: 'text',
        # text: '...'}]}}` instead of `{ok: false}`. Surface those too —
        # otherwise callers see a "success" envelope wrapping an error
        # message and silently misbehave.
        if result.get("isError") is True:
            content = result.get("content") or []
            msg = ""
            if isinstance(content, list) and content:
                first = content[0]
                if isinstance(first, dict):
                    msg = str(first.get("text") or "")
            raise BrainClientError(
                f"gateway error from {tool}: {msg or 'isError=true with no message'}"
            )
        return result

    # ── tasks tool actions ─────────────────────────────────────────────────

    def run_workflow(
        self,
        template_id: str,
        variables: Optional[dict[str, str]] = None,
        force: bool = False,
    ) -> dict[str, Any]:
        """Instantiate a workflow as a goal. Returns the parsed gateway result —
        callers care about `goalId`, `goalName`, `taskCount`, `readyTaskIds`."""
        args: dict[str, Any] = {"action": "run_workflow", "templateId": template_id}
        if variables:
            args["variables"] = variables
        if force:
            args["force"] = True
        return self._invoke("tasks", args)

    def import_workflow(self, template: dict[str, Any]) -> dict[str, Any]:
        """Import a workflow template into the brain's `workflow_templates`
        table. The gateway's `workflow_import` action expects a stringified
        JSON blob in `workflowJson` (NOT a dict), so we serialize here.

        Returns the parsed gateway result on success. Raises BrainClientError
        if the workflow id already exists or any validation fails — note
        the brain rejects same-id imports rather than upserting, so callers
        wanting overwrite semantics must `delete_workflow` first."""
        return self._invoke(
            "tasks",
            {"action": "workflow_import", "workflowJson": json.dumps(template)},
        )

    def delete_workflow(self, template_id: str) -> dict[str, Any]:
        """Delete a workflow template by id. Raises BrainClientError if
        the template doesn't exist OR if any enabled schedule references
        the workflow (the brain refuses to leave dangling schedules).
        Caller can catch + ignore for idempotent re-install."""
        return self._invoke(
            "tasks",
            {"action": "workflow_delete", "templateId": template_id},
        )

    def schedule_add(
        self,
        schedule_id: str,
        template_id: str,
        cron_expr: str,
        variables: Optional[dict[str, str]] = None,
        enabled: bool = True,
        timezone: Optional[str] = None,
    ) -> dict[str, Any]:
        """Register a cron-style schedule that ticks the named workflow
        template. Used by install_workflows so a fresh `digital-me install`
        lands a ticking schedule alongside the bundled workflow — no
        manual `tasks.schedule_add` step required.

        `timezone` is an IANA name (e.g. "America/Los_Angeles"). When omitted
        the brain defaults the schedule to UTC — so a workflow that wants a
        local-time cron MUST pass it, or `0 7 * * *` silently fires at 7am UTC
        instead of 7am local. Re-install path is idempotent: callers should
        `schedule_remove` first when overwriting, since the brain rejects
        duplicate ids."""
        args: dict[str, Any] = {
            "action": "schedule_add",
            "scheduleId": schedule_id,
            "templateId": template_id,
            "cronExpr": cron_expr,
            "enabled": enabled,
        }
        if variables:
            args["variables"] = variables
        if timezone:
            args["timezone"] = timezone
        return self._invoke("tasks", args)

    def schedule_remove(self, schedule_id: str) -> dict[str, Any]:
        """Remove a schedule by id. Raises BrainClientError if not found;
        callers can swallow that error for idempotent re-install paths."""
        return self._invoke(
            "tasks", {"action": "schedule_remove", "scheduleId": schedule_id}
        )

    def schedule_list(self) -> list[dict[str, Any]]:
        """List all registered schedules. Returns a list of dicts, each
        carrying at least {id, name, workflowId, cronExpr, enabled}.

        Used by install_workflows for robust idempotent re-install: enumerate
        schedules, find any whose workflowId references the workflow we're
        about to delete, and remove them — even if the sibling
        <name>.schedule.json's `scheduleId` doesn't match what's currently
        in the brain (e.g. a legacy install renamed the schedule)."""
        result = self._invoke("tasks", {"action": "schedule_list", "format": "json"})
        # The MCP tool returns {content: [...], details: {json: {schedules:
        # [...]}}}. Walk to the list payload. Be defensive across envelope
        # variants: some actions return the list directly under .json, this
        # one nests it under .schedules.
        details = result.get("details") if isinstance(result, dict) else None
        if isinstance(details, dict):
            payload = details.get("json")
            if isinstance(payload, list):
                return payload
            if isinstance(payload, dict):
                schedules = payload.get("schedules")
                if isinstance(schedules, list):
                    return schedules
        # Fallback: empty list rather than raising — caller's idempotent
        # logic gracefully handles "no schedules to clean up".
        return []

    def schedule_tick(self) -> dict[str, Any]:
        """Force one scheduler tick. Critical for the agent-driven dream-cycle:
        this call provides the gateway-request context needed for spawn dispatch
        (the cron-tick bug only affects ticks fired from non-gateway timers)."""
        return self._invoke("tasks", {"action": "schedule_tick"})

    def task_status(self, task_id: str) -> dict[str, Any]:
        """Return current status of a single task (the `status` MCP action
        takes a taskId, not a goalId — that was a design assumption I got
        wrong in the first cut; `goal_status` does the goal-level lookup)."""
        return self._invoke("tasks", {"action": "status", "taskId": task_id})

    def goal_status(self, goal_id: str) -> Optional[dict[str, Any]]:
        """Return the full goal record (with tasks[] + attempts) by listing
        the active board and filtering by goal id. Returns None if the
        goal isn't on the active board — either it was never created or
        it's already been pruned. The board takes `format='json'` to get
        a structured payload."""
        result = self._invoke("tasks", {"action": "board", "format": "json"})
        details = result.get("details") if isinstance(result, dict) else None
        json_payload = details.get("json") if isinstance(details, dict) else None
        goals = (
            json_payload.get("goals")
            if isinstance(json_payload, dict) and isinstance(json_payload.get("goals"), list)
            else []
        )
        for g in goals:
            if isinstance(g, dict) and g.get("id") == goal_id:
                return g
        return None

    # ── wait helper ────────────────────────────────────────────────────────

    def wait_for_goal(
        self,
        goal_id: str,
        timeout_s: float = 3600.0,
        poll_interval_s: float = 5.0,
        sleep: Any = time.sleep,
        now: Any = time.monotonic,
    ) -> dict[str, Any]:
        """Poll goal_status until the goal reaches a terminal state. Returns
        the final goal payload (with `tasks[]` and per-task `attempts[]`).
        Raises BrainClientError on timeout OR if the goal disappears from
        the active board mid-poll.

        `sleep` + `now` injection makes this testable without real wall-clock."""
        deadline = now() + timeout_s
        last_status: Optional[str] = None
        while True:
            goal = self.goal_status(goal_id)
            if goal is None:
                raise BrainClientError(
                    f"goal {goal_id} not found on the active board "
                    f"(last seen status: {last_status})"
                )
            last_status = goal.get("status") if isinstance(goal, dict) else None
            if last_status in TERMINAL_GOAL_STATUSES:
                return goal
            if now() >= deadline:
                raise BrainClientError(
                    f"goal {goal_id} did not finish within {timeout_s:.0f}s "
                    f"(last status: {last_status})"
                )
            sleep(poll_interval_s)
